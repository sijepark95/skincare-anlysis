import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  AppError,
  type AccountNext,
  type AccountStatus,
  type DeviceContext,
  type Repository,
  type StaffContext,
} from "@/application/contracts";
import { requiredEnv } from "./config";

export type IdentityKind = "staff" | "device";
export type SupabaseIdentity =
  | { kind: "staff"; client: SupabaseClient; context: StaffContext }
  | { kind: "device"; client: SupabaseClient; context: DeviceContext };

const staffSchema = z.object({
  organization_id: z.string().uuid(),
  organization_name: z.string().min(1).max(120),
  role: z.enum(["owner", "manager", "viewer"]),
  stores: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      currency: z.string().length(3),
      location: z.string().optional(),
    }),
  ),
});
const deviceSchema = z.object({
  organization_id: z.string().uuid(),
  store_id: z.string().uuid(),
  device_id: z.string().uuid(),
});

function unavailable(): AppError {
  return new AppError(
    503,
    "authentication_unavailable",
    "Authentication is temporarily unavailable.",
  );
}

function authActionError(
  error: { status?: number; code?: string; name?: string },
  kind: IdentityKind,
): AppError | null {
  if (error.status === 0 || error.name === "AuthRetryableFetchError")
    return unavailable();
  if (error.status === 429 || error.code === "over_request_rate_limit")
    return new AppError(
      429,
      "authentication_rate_limited",
      "Too many attempts. Wait a few minutes before trying again.",
    );
  if (kind === "staff" && error.code === "email_not_confirmed")
    return new AppError(
      403,
      "email_confirmation_required",
      "Verify your email before signing in. Open Create account to enter your confirmation code or request another.",
    );
  if (kind === "staff" && error.code === "email_provider_disabled")
    return new AppError(
      503,
      "staff_setup_required",
      "Staff sign-in is not available yet. Ask your workspace owner to complete connection setup.",
    );
  if (
    kind === "device" &&
    [
      "anonymous_provider_disabled",
      "signup_disabled",
      "captcha_failed",
    ].includes(error.code ?? "")
  )
    return new AppError(
      503,
      "device_setup_required",
      "Device setup is not available yet. Ask your workspace owner to complete connection setup.",
    );
  return null;
}

function cookieBelongsTo(name: string, namespace: string): boolean {
  return (
    name === namespace ||
    name.startsWith(`${namespace}.`) ||
    name.startsWith(`${namespace}-`)
  );
}

/** A fresh JWT-scoped client per request, with completely separate staff/device cookies. */
export async function createCookieSupabaseClient(
  kind: IdentityKind,
): Promise<SupabaseClient> {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const namespace = `senmiva-${kind}`;
  const cookieStore = await cookies();
  try {
    return createServerClient(url, key, {
      cookieOptions: {
        name: namespace,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        getAll: () =>
          cookieStore
            .getAll()
            .filter((cookie) => cookieBelongsTo(cookie.name, namespace)),
        setAll: (values) => {
          // Auth-sensitive reads and writes run in Route Handlers, where refresh cookies
          // are writable. Do not hide a persistence failure and report a false login.
          for (const { name, value, options } of values) {
            if (!cookieBelongsTo(name, namespace)) throw unavailable();
            cookieStore.set(name, value, {
              ...options,
              httpOnly: true,
              secure: process.env.NODE_ENV === "production",
              sameSite: "lax",
              path: "/",
            });
          }
        },
      },
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
      },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

/** Validate the token with Supabase before deriving tenant context through authorized RPCs. */
export async function getSupabaseIdentity(
  kind: IdentityKind,
): Promise<SupabaseIdentity | null> {
  const client = await createCookieSupabaseClient(kind);
  try {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError) {
      if (
        userError.status === 400 ||
        userError.status === 401 ||
        userError.status === 403 ||
        userError.name === "AuthSessionMissingError"
      )
        return null;
      throw unavailable();
    }
    const user = userData.user;
    if (
      !user ||
      (kind === "staff" && user.is_anonymous) ||
      (kind === "device" && !user.is_anonymous)
    )
      return null;
    const { data, error } = await client.rpc(
      kind === "staff" ? "staff_context" : "device_context",
    );
    if (error) {
      if (error.code === "42501") return null;
      throw unavailable();
    }
    if (kind === "staff") {
      const parsed = staffSchema.safeParse(data);
      if (!parsed.success) throw unavailable();
      return {
        kind,
        client,
        context: {
          organizationId: parsed.data.organization_id,
          organizationName: parsed.data.organization_name,
          role: parsed.data.role,
          stores: parsed.data.stores.map((store) => ({
            ...store,
            location: store.location ?? "",
          })),
        },
      };
    }
    const parsed = deviceSchema.safeParse(data);
    if (!parsed.success) throw unavailable();
    return {
      kind,
      client,
      context: {
        organizationId: parsed.data.organization_id,
        storeId: parsed.data.store_id,
        deviceId: parsed.data.device_id,
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function getStaffContext(): Promise<StaffContext | null> {
  const identity = await getSupabaseIdentity("staff");
  return identity?.kind === "staff" ? identity.context : null;
}

export async function getDeviceContext(): Promise<DeviceContext | null> {
  const identity = await getSupabaseIdentity("device");
  return identity?.kind === "device" ? identity.context : null;
}

export async function loginStaff(
  email: string,
  password: string,
): Promise<{ next: AccountNext }> {
  const client = await createCookieSupabaseClient("staff");
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.user || data.user.is_anonymous) {
      if (error) {
        const actionError = authActionError(error, "staff");
        if (actionError) throw actionError;
      }
      if (error && (error.status ?? 0) >= 500) throw unavailable();
      throw new AppError(
        401,
        "invalid_credentials",
        "Unable to sign in with those credentials.",
      );
    }
    const account = await readAccount(client);
    if (!account.authenticated) throw unavailable();
    return { next: account.needsWorkspace ? "setup" : "management" };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

function staffContextFrom(data: unknown): StaffContext {
  const parsed = staffSchema.safeParse(data);
  if (!parsed.success) throw unavailable();
  return {
    organizationId: parsed.data.organization_id,
    organizationName: parsed.data.organization_name,
    role: parsed.data.role,
    stores: parsed.data.stores.map((store) => ({
      ...store,
      location: store.location ?? "",
    })),
  };
}

async function readAccount(client: SupabaseClient): Promise<AccountStatus> {
  const { data, error } = await client.auth.getUser();
  if (error) {
    if (
      [400, 401, 403].includes(error.status ?? 0) ||
      error.name === "AuthSessionMissingError"
    )
      return { authenticated: false, needsWorkspace: false, staff: null };
    throw unavailable();
  }
  if (!data.user || data.user.is_anonymous)
    return { authenticated: false, needsWorkspace: false, staff: null };
  if (!data.user.email_confirmed_at)
    throw new AppError(
      403,
      "email_confirmation_required",
      "Verify your email before setting up your workspace.",
    );
  const membership = await client.rpc("staff_context");
  if (membership.error?.code === "42501") {
    const eligibility = await client.rpc("owner_setup_eligible");
    if (eligibility.error || typeof eligibility.data !== "boolean")
      throw unavailable();
    if (!eligibility.data)
      throw new AppError(
        403,
        "membership_required",
        "Your account does not have active workspace access. Contact your organization owner to restore access.",
      );
    return { authenticated: true, needsWorkspace: true, staff: null };
  }
  if (membership.error) throw unavailable();
  return {
    authenticated: true,
    needsWorkspace: false,
    staff: staffContextFrom(membership.data),
  };
}

export async function getOwnerAccount(): Promise<AccountStatus> {
  try {
    return await readAccount(await createCookieSupabaseClient("staff"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

function signupError(error: {
  status?: number;
  code?: string;
  name?: string;
}): AppError {
  const actionError = authActionError(error, "staff");
  if (actionError) return actionError;
  if (
    ["signup_disabled", "email_provider_disabled", "captcha_failed"].includes(
      error.code ?? "",
    ) ||
    error.status === 403
  )
    return new AppError(
      503,
      "signup_setup_required",
      "Account registration is not available yet. Contact support to check the authentication setup.",
    );
  if (error.code === "weak_password")
    return new AppError(
      422,
      "weak_password",
      "Use a stronger password with at least 12 characters.",
    );
  if ((error.status ?? 0) >= 500) return unavailable();
  return new AppError(
    400,
    "registration_failed",
    "Unable to create your account. Check your email and password and try again.",
  );
}

/** Register an Auth identity only. Workspace authority comes from the verified RPC. */
export async function signupOwner(
  email: string,
  password: string,
): Promise<{ next: AccountNext | "verify_email" }> {
  try {
    const client = await createCookieSupabaseClient("staff");
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) {
      // Confirmation-enabled Supabase also obscures existing account registration.
      if (["user_already_exists", "email_exists"].includes(error.code ?? ""))
        return { next: "verify_email" };
      throw signupError(error);
    }
    if (!data.session) return { next: "verify_email" };
    const account = await readAccount(client);
    if (!account.authenticated) throw unavailable();
    return { next: account.needsWorkspace ? "setup" : "management" };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function verifyOwnerEmail(
  email: string,
  token: string,
): Promise<{ next: AccountNext }> {
  try {
    const client = await createCookieSupabaseClient("staff");
    const { data, error } = await client.auth.verifyOtp({
      email,
      token,
      type: "signup",
    });
    if (error || !data.session) {
      if (
        error &&
        (error.status === 0 ||
          error.name === "AuthRetryableFetchError" ||
          error.status === 429 ||
          (error.status ?? 0) >= 500)
      )
        throw signupError(error);
      throw new AppError(
        400,
        "invalid_confirmation_code",
        "This confirmation code is invalid or expired. Request a new code and try again.",
      );
    }
    const account = await readAccount(client);
    if (!account.authenticated) throw unavailable();
    return { next: account.needsWorkspace ? "setup" : "management" };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function resendOwnerConfirmation(email: string): Promise<void> {
  try {
    const client = await createCookieSupabaseClient("staff");
    const { error } = await client.auth.resend({ type: "signup", email });
    if (error) {
      if (["user_not_found", "email_not_confirmed"].includes(error.code ?? ""))
        return;
      throw signupError(error);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function createOwnerWorkspace(
  organizationName: string,
  storeName: string,
): Promise<StaffContext> {
  try {
    const client = await createCookieSupabaseClient("staff");
    const account = await readAccount(client);
    if (!account.authenticated)
      throw new AppError(
        401,
        "sign_in_required",
        "Sign in before setting up your workspace.",
      );
    const { data, error } = await client.rpc("create_owner_workspace", {
      p_organization_name: organizationName,
      p_store_name: storeName,
    });
    if (error) {
      if (error.code === "42501")
        throw new AppError(
          403,
          "workspace_creation_forbidden",
          "This account cannot create a new workspace. Contact your organization owner for access.",
        );
      if (error.code === "23505")
        throw new AppError(
          409,
          "workspace_exists",
          "Your workspace has already been created. Return to sign in to continue.",
        );
      if (error.code === "22023")
        throw new AppError(
          422,
          "invalid_workspace",
          "Check your company and store names.",
        );
      throw unavailable();
    }
    return staffContextFrom(data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function logoutStaff(): Promise<void> {
  const client = await createCookieSupabaseClient("staff");
  try {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) throw unavailable();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function pairDevice(code: string): Promise<DeviceContext> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(normalized))
    throw new AppError(
      400,
      "invalid_code",
      "Enter the 16-character pairing code from management.",
    );
  const client = await createCookieSupabaseClient("device");
  try {
    const existing = await client.auth.getUser();
    if (
      existing.error &&
      ![400, 401, 403].includes(existing.error.status ?? 0) &&
      existing.error.name !== "AuthSessionMissingError"
    )
      throw unavailable();
    if (existing.data.user && !existing.data.user.is_anonymous)
      throw new AppError(
        409,
        "device_identity_conflict",
        "This browser has an incompatible device session.",
      );
    const cookieStore = await cookies();
    const pendingName = "senmiva-device-unpaired";
    const pendingIdentity = cookieStore
      .getAll()
      .find((cookie) => cookie.name === pendingName)?.value;
    let needsIdentity = !existing.data.user;
    if (existing.data.user) {
      const context = await client.rpc("device_context");
      if (context.error && context.error.code !== "42501") throw unavailable();
      if (!context.error && !deviceSchema.safeParse(context.data).success)
        throw unavailable();
      if (!context.error)
        throw new AppError(
          409,
          "device_already_paired",
          "This browser is already paired. Open the kiosk, or revoke its current access in your workspace before pairing it again.",
        );
      // An enrolled but revoked device cannot be paired again under its old auth user.
      // A server-only pending marker prevents creating a fresh user on every bad-code retry.
      if (
        context.error?.code === "42501" &&
        pendingIdentity !== existing.data.user.id
      ) {
        const signedOut = await client.auth.signOut({ scope: "local" });
        if (signedOut.error) throw unavailable();
        needsIdentity = true;
      }
    }
    if (needsIdentity) {
      const signed = await client.auth.signInAnonymously();
      if (signed.error) {
        const actionError = authActionError(signed.error, "device");
        if (actionError) throw actionError;
      }
      if (signed.error || !signed.data.user?.is_anonymous) throw unavailable();
      cookieStore.set(pendingName, signed.data.user.id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
    }
    const { data, error } = await client.rpc("pair_device", {
      p_code: normalized,
    });
    if (error) {
      if (error.code === "22023")
        throw new AppError(
          400,
          "invalid_code",
          "This code is invalid, expired or already used. Create a new code in your store workspace and try again.",
        );
      if (error.code === "42501")
        throw new AppError(
          409,
          "pairing_unavailable",
          "This device cannot be paired. Check its status in management.",
        );
      throw unavailable();
    }
    const parsed = deviceSchema.safeParse(data);
    if (!parsed.success) throw unavailable();
    cookieStore.set(pendingName, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return {
      organizationId: parsed.data.organization_id,
      storeId: parsed.data.store_id,
      deviceId: parsed.data.device_id,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

/** Public composition helper; defer the writer adapter until a repository is actually needed. */
export async function makeSupabaseRepository(
  kind: IdentityKind,
): Promise<
  Repository &
    import("@/application/personal-color").PersonalColorRepository &
    import("@/application/beauty-consultations").BeautyRepository
> {
  const repository = await import("./supabase-repository");
  return repository.makeSupabaseRepository(kind);
}
