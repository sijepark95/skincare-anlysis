import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signInAnonymously: vi.fn(),
  signUp: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  getAllCookies: vi.fn(),
  setCookie: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: harness.createServerClient,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: harness.getAllCookies,
    set: harness.setCookie,
  }),
}));

import {
  createCookieSupabaseClient,
  getDeviceContext,
  getStaffContext,
  loginStaff,
  logoutStaff,
  pairDevice,
  getOwnerAccount,
  signupOwner,
  verifyOwnerEmail,
  resendOwnerConfirmation,
  createOwnerWorkspace,
} from "@/infrastructure/supabase-auth";
import { makeSupabaseRepository } from "@/infrastructure/supabase-repository";
import {
  OPENAI_SKIN_DISCLAIMER,
  VISION_NOTICE_VERSION,
} from "@/domain/skin-vision";

const org = "11111111-1111-4111-8111-111111111111";
const store = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const variantId = "55555555-5555-4555-8555-555555555555";
const otherOrg = "99999999-9999-4999-8999-999999999999";
const device = { organizationId: org, storeId: store, deviceId };
const staffRow = {
  organization_id: org,
  organization_name: "Test Retail",
  role: "owner",
  stores: [
    { id: store, name: "Test Store", currency: "USD", location: "Seoul" },
  ],
};
const deviceRow = {
  organization_id: org,
  store_id: store,
  device_id: deviceId,
};
const catalogRow = {
  id: variantId,
  organization_id: org,
  store_id: store,
  brand: "Test Brand",
  name: "Test Serum",
  category: "serum",
  sku: "TEST-01",
  price_minor: 2400,
  currency: "USD",
  stock: 4,
  visible: true,
  status: "published",
  ingredients: ["Water", "Glycerin"],
  skin_types: ["dry"],
  formulation_complete: true,
};
const sessionRow = {
  id: sessionId,
  organization_id: org,
  store_id: store,
  device_id: deviceId,
  status: "active",
  created_at: "2026-10-10T12:00:00Z",
  consent: { accepted: true, policy_version: "2026-10-mvp" },
  answers: {
    skinType: "dry",
    concerns: ["dehydration"],
    excludedIngredients: [],
    sensitive: true,
  },
  analysis: {
    id: "66666666-6666-4666-8666-666666666666",
    request_id: sessionId,
    mode: "mock",
    model_version: "mock-1.0",
    quality_status: "demo",
    disclaimer: "Mock questionnaire result.",
    observations: [{ concern_id: "dehydration", level: "high", score: 0.78 }],
  },
  recommendations: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  harness.getAllCookies.mockReturnValue([]);
  harness.setCookie.mockReset();
  harness.getUser.mockResolvedValue({
    data: {
      user: {
        id: "user",
        is_anonymous: false,
        email_confirmed_at: "2026-10-10T12:00:00Z",
      },
    },
    error: null,
  });
  harness.signOut.mockResolvedValue({ error: null });
  harness.signInWithPassword.mockResolvedValue({
    data: { user: { is_anonymous: false } },
    error: null,
  });
  harness.signInAnonymously.mockResolvedValue({
    data: { user: { id: "fresh-anonymous-device", is_anonymous: true } },
    error: null,
  });
  harness.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === "owner_setup_eligible"
        ? true
        : name === "staff_context"
          ? staffRow
          : name === "device_context" || name === "pair_device"
            ? deviceRow
            : name === "read_store_catalog"
              ? [catalogRow]
              : name === "read_kiosk_session"
                ? sessionRow
                : name === "start_kiosk_session"
                  ? sessionId
                  : name === "import_catalog_drafts"
                    ? [variantId]
                    : null,
  }));
  harness.createServerClient.mockReturnValue({
    auth: {
      getUser: harness.getUser,
      signInWithPassword: harness.signInWithPassword,
      signInAnonymously: harness.signInAnonymously,
      signUp: harness.signUp,
      verifyOtp: harness.verifyOtp,
      resend: harness.resend,
      signOut: harness.signOut,
    },
    rpc: harness.rpc,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("business owner account onboarding", () => {
  it("registers only email/password and waits for email confirmation before any tenant query", async () => {
    harness.signUp.mockResolvedValue({
      data: { user: { id: "new-owner" }, session: null },
      error: null,
    });
    await expect(
      signupOwner("owner@example.test", "a-long-private-password"),
    ).resolves.toEqual({ next: "verify_email" });
    expect(harness.signUp).toHaveBeenCalledWith({
      email: "owner@example.test",
      password: "a-long-private-password",
    });
    expect(harness.rpc).not.toHaveBeenCalled();
    expect(harness.getUser).not.toHaveBeenCalled();
  });
  it("uses the same confirmation screen for already registered accounts", async () => {
    harness.signUp.mockResolvedValue({
      data: {},
      error: {
        status: 400,
        code: "user_already_exists",
        message: "RAW ACCOUNT",
      },
    });
    await expect(
      signupOwner("owner@example.test", "a-long-private-password"),
    ).resolves.toEqual({ next: "verify_email" });
    expect(harness.rpc).not.toHaveBeenCalled();
  });
  it("does not let anonymous identity or missing session become a business account", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    await expect(getOwnerAccount()).resolves.toEqual({
      authenticated: false,
      needsWorkspace: false,
      staff: null,
    });
    expect(harness.rpc).not.toHaveBeenCalled();
    harness.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError" },
    });
    await expect(getOwnerAccount()).resolves.toEqual({
      authenticated: false,
      needsWorkspace: false,
      staff: null,
    });
  });
  it("rejects unconfirmed accounts before membership or workspace RPCs", async () => {
    harness.getUser.mockResolvedValue({
      data: {
        user: {
          id: "new-owner",
          is_anonymous: false,
          email_confirmed_at: null,
        },
      },
      error: null,
    });
    await expect(
      createOwnerWorkspace("My Company", "First Store"),
    ).rejects.toMatchObject({
      status: 403,
      code: "email_confirmation_required",
    });
    expect(harness.rpc).not.toHaveBeenCalled();
  });
  it("verifies the signup code in the isolated staff namespace and resumes setup", async () => {
    harness.verifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
    harness.rpc.mockImplementation(async (name: string) =>
      name === "owner_setup_eligible"
        ? { data: true, error: null }
        : { data: null, error: { code: "42501" } },
    );
    await expect(
      verifyOwnerEmail("owner@example.test", "123456"),
    ).resolves.toEqual({ next: "setup" });
    expect(harness.verifyOtp).toHaveBeenCalledWith({
      email: "owner@example.test",
      token: "123456",
      type: "signup",
    });
    expect(harness.createServerClient.mock.calls[0][2].cookieOptions.name).toBe(
      "senmiva-staff",
    );
    expect(harness.rpc).toHaveBeenCalledWith("staff_context");
    expect(harness.rpc).not.toHaveBeenCalledWith(
      "create_owner_workspace",
      expect.anything(),
    );
  });
  it("rejects expired codes without logging in or revealing upstream tokens", async () => {
    harness.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { status: 403, code: "otp_expired", message: "RAW OTP TOKEN" },
    });
    await expect(
      verifyOwnerEmail("owner@example.test", "123456"),
    ).rejects.toMatchObject({ status: 400, code: "invalid_confirmation_code" });
    expect(harness.rpc).not.toHaveBeenCalled();
  });
  it("creates a workspace only through the narrow identity-scoped RPC", async () => {
    harness.rpc.mockImplementation(async (name: string) =>
      name === "staff_context"
        ? { data: null, error: { code: "42501" } }
        : {
            data: name === "owner_setup_eligible" ? true : staffRow,
            error: null,
          },
    );
    await expect(
      createOwnerWorkspace("Test Retail", "Test Store"),
    ).resolves.toMatchObject({ organizationId: org, role: "owner" });
    expect(harness.rpc).toHaveBeenCalledWith("create_owner_workspace", {
      p_organization_name: "Test Retail",
      p_store_name: "Test Store",
    });
  });
  it("keeps existing incompatible membership denial instead of granting a new tenant", async () => {
    harness.rpc.mockImplementation(async (name: string) =>
      name === "staff_context"
        ? { data: staffRow, error: null }
        : { data: null, error: { code: "42501", message: "RAW MEMBERSHIP" } },
    );
    await expect(
      createOwnerWorkspace("Other Company", "Other Store"),
    ).rejects.toMatchObject({
      status: 403,
      code: "workspace_creation_forbidden",
    });
  });
  it("resends signup confirmation without creating another account", async () => {
    harness.resend.mockResolvedValue({ error: null });
    await expect(
      resendOwnerConfirmation("owner@example.test"),
    ).resolves.toBeUndefined();
    expect(harness.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "owner@example.test",
    });
    expect(harness.signUp).not.toHaveBeenCalled();
  });
  it("maps email delivery throttling to a safe retry message", async () => {
    harness.resend.mockResolvedValue({
      error: {
        status: 429,
        code: "over_email_send_rate_limit",
        message: "RAW SMTP SECRET",
      },
    });
    await expect(
      resendOwnerConfirmation("owner@example.test"),
    ).rejects.toMatchObject({
      status: 429,
      code: "authentication_rate_limited",
    });
  });
  it("sends revoked or incompatible members to access restoration instead of creating another workspace", async () => {
    harness.rpc.mockImplementation(async (name: string) =>
      name === "staff_context"
        ? { data: null, error: { code: "42501" } }
        : { data: false, error: null },
    );
    await expect(getOwnerAccount()).rejects.toMatchObject({
      status: 403,
      code: "membership_required",
    });
    expect(harness.rpc).not.toHaveBeenCalledWith(
      "create_owner_workspace",
      expect.anything(),
    );
  });
  it.each(["signup", "verify", "login"])(
    "reports a retryable %s transport failure as service unavailable, not a credential mistake",
    async (action) => {
      const error = {
        status: 0,
        name: "AuthRetryableFetchError",
        message: "RAW NETWORK SECRET",
      };
      harness.signUp.mockResolvedValue({ data: {}, error });
      harness.verifyOtp.mockResolvedValue({ data: { session: null }, error });
      harness.signInWithPassword.mockResolvedValue({
        data: { user: null },
        error,
      });
      const work =
        action === "signup"
          ? signupOwner("owner@example.test", "a-long-private-password")
          : action === "verify"
            ? verifyOwnerEmail("owner@example.test", "123456")
            : loginStaff("owner@example.test", "a-long-private-password");
      await expect(work).rejects.toMatchObject({
        status: 503,
        code: "authentication_unavailable",
      });
    },
  );
});

describe("server-only Supabase auth boundaries", () => {
  it("isolates staff and device cookie namespaces and hardens session cookies", async () => {
    harness.getAllCookies.mockReturnValue([
      { name: "senmiva-staff.0", value: "staff-token" },
      { name: "senmiva-device.0", value: "device-token" },
    ]);
    await createCookieSupabaseClient("staff");
    const options = harness.createServerClient.mock.calls[0][2];
    expect(options.cookieOptions).toMatchObject({
      name: "senmiva-staff",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(options.cookies.getAll()).toEqual([
      { name: "senmiva-staff.0", value: "staff-token" },
    ]);
    options.cookies.setAll([
      { name: "senmiva-staff.0", value: "new-token", options: {} },
    ]);
    expect(harness.setCookie).toHaveBeenCalledWith(
      "senmiva-staff.0",
      "new-token",
      expect.objectContaining({ httpOnly: true }),
    );
    expect(() =>
      options.cookies.setAll([
        { name: "senmiva-device.0", value: "bad", options: {} },
      ]),
    ).toThrow();
  });

  it("derives the organization from verified user membership RPC", async () => {
    expect(await getStaffContext()).toMatchObject({
      organizationId: org,
      organizationName: "Test Retail",
      role: "owner",
      stores: [{ id: store, location: "Seoul" }],
    });
    expect(harness.getUser).toHaveBeenCalled();
    expect(harness.rpc).toHaveBeenCalledWith("staff_context");
  });

  it("does not let an anonymous device identity become staff", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    expect(await getStaffContext()).toBeNull();
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("does not let a staff identity become a paired device", async () => {
    expect(await getDeviceContext()).toBeNull();
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    await expect(getStaffContext()).rejects.toMatchObject({
      status: 503,
      code: "configuration_required",
    });
    expect(harness.createServerClient).not.toHaveBeenCalled();
  });

  it("never returns raw authentication or database errors", async () => {
    harness.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "SECRET DATABASE DETAIL" },
    });
    await expect(getStaffContext()).rejects.toMatchObject({
      status: 503,
      message: "Authentication is temporarily unavailable.",
    });
  });

  it("signs out only the staff namespace", async () => {
    await logoutStaff();
    expect(harness.createServerClient.mock.calls[0][2].cookieOptions.name).toBe(
      "senmiva-staff",
    );
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps a confirmed account without membership available for first workspace setup", async () => {
    harness.rpc.mockImplementation(async (name: string) =>
      name === "owner_setup_eligible"
        ? { data: true, error: null }
        : { data: null, error: { code: "42501" } },
    );
    await expect(
      loginStaff("owner@example.test", "test-password"),
    ).resolves.toEqual({ next: "setup" });
    expect(harness.signOut).not.toHaveBeenCalled();
  });

  it("reuses a pending anonymous identity when pairing", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { id: "pending-device", is_anonymous: true } },
      error: null,
    });
    harness.getAllCookies.mockReturnValue([
      { name: "senmiva-device-unpaired", value: "pending-device" },
    ]);
    harness.rpc.mockImplementation(async (name: string) =>
      name === "device_context"
        ? { data: null, error: { code: "42501" } }
        : { data: deviceRow, error: null },
    );
    expect(await pairDevice("abcd1234abcd1234")).toEqual(device);
    expect(harness.signInAnonymously).not.toHaveBeenCalled();
    expect(harness.rpc).toHaveBeenCalledWith("pair_device", {
      p_code: "ABCD1234ABCD1234",
    });
  });

  it("creates an anonymous identity only when no device user exists", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError" },
    });
    expect(await pairDevice("ABCD1234ABCD1234")).toEqual(device);
    expect(harness.signInAnonymously).toHaveBeenCalledOnce();
  });

  it("preserves an active device identity without attempting to consume another code", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { id: "active-anonymous-device", is_anonymous: true } },
      error: null,
    });
    harness.rpc.mockImplementation(async (name: string) =>
      name === "device_context"
        ? { data: deviceRow, error: null }
        : { data: null, error: { code: "42501" } },
    );
    await expect(pairDevice("ABCD1234ABCD1234")).rejects.toMatchObject({
      status: 409,
      code: "device_already_paired",
    });
    expect(harness.signOut).not.toHaveBeenCalled();
    expect(harness.signInAnonymously).not.toHaveBeenCalled();
    expect(harness.setCookie).not.toHaveBeenCalled();
    expect(harness.rpc).not.toHaveBeenCalledWith(
      "pair_device",
      expect.anything(),
    );
  });

  it("distinguishes authentication throttling from invalid staff credentials", async () => {
    harness.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: {
        status: 429,
        code: "over_request_rate_limit",
        message: "RAW AUTH",
      },
    });
    await expect(
      loginStaff("owner@example.test", "test-password"),
    ).rejects.toMatchObject({
      status: 429,
      code: "authentication_rate_limited",
      message: "Too many attempts. Wait a few minutes before trying again.",
    });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("gives an invited but unconfirmed staff account a useful next step", async () => {
    harness.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 400, code: "email_not_confirmed" },
    });
    await expect(
      loginStaff("owner@example.test", "test-password"),
    ).rejects.toMatchObject({
      status: 403,
      code: "email_confirmation_required",
    });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("explains a disabled email provider without reporting a bad password", async () => {
    harness.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: {
        status: 422,
        code: "email_provider_disabled",
        message: "RAW PROVIDER CONFIG",
      },
    });
    await expect(
      loginStaff("owner@example.test", "test-password"),
    ).rejects.toMatchObject({
      status: 503,
      code: "staff_setup_required",
      message:
        "Staff sign-in is not available yet. Ask your workspace owner to complete connection setup.",
    });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it.each(["anonymous_provider_disabled", "signup_disabled", "captcha_failed"])(
    "explains incomplete device setup for %s without exposing provider errors",
    async (code) => {
      harness.getUser.mockResolvedValue({
        data: { user: null },
        error: { name: "AuthSessionMissingError" },
      });
      harness.signInAnonymously.mockResolvedValue({
        data: { user: null },
        error: { code, message: "RAW PROVIDER CONFIG" },
      });
      await expect(pairDevice("ABCD1234ABCD1234")).rejects.toMatchObject({
        status: 503,
        code: "device_setup_required",
        message:
          "Device setup is not available yet. Ask your workspace owner to complete connection setup.",
      });
      expect(harness.rpc).not.toHaveBeenCalled();
    },
  );

  it("does not consume a pairing code when anonymous sign-in is throttled", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError" },
    });
    harness.signInAnonymously.mockResolvedValue({
      data: { user: null },
      error: { status: 429 },
    });
    await expect(pairDevice("ABCD1234ABCD1234")).rejects.toMatchObject({
      status: 429,
      code: "authentication_rate_limited",
    });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("does not turn a membership lookup outage into workspace creation access", async () => {
    harness.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "RAW DATABASE ERROR" },
    });
    await expect(
      loginStaff("owner@example.test", "test-password"),
    ).rejects.toMatchObject({
      status: 503,
      code: "authentication_unavailable",
    });
  });

  it("replaces revoked device authentication without touching staff cookies", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { id: "revoked-anonymous-device", is_anonymous: true } },
      error: null,
    });
    harness.rpc.mockImplementation(async (name: string) =>
      name === "device_context"
        ? { data: null, error: { code: "42501" } }
        : { data: deviceRow, error: null },
    );
    expect(await pairDevice("ABCD1234ABCD1234")).toEqual(device);
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(harness.signInAnonymously).toHaveBeenCalledOnce();
    expect(harness.createServerClient.mock.calls[0][2].cookieOptions.name).toBe(
      "senmiva-device",
    );
    expect(
      harness.setCookie.mock.calls.every(([name]) =>
        name.startsWith("senmiva-device"),
      ),
    ).toBe(true);
  });

  it("keeps the pending anonymous identity across invalid pairing-code retries", async () => {
    const cookieRows: { name: string; value: string }[] = [];
    harness.getAllCookies.mockImplementation(() => cookieRows);
    harness.setCookie.mockImplementation((name: string, value: string) => {
      const index = cookieRows.findIndex((cookie) => cookie.name === name);
      if (index >= 0) cookieRows[index] = { name, value };
      else cookieRows.push({ name, value });
    });
    harness.getUser
      .mockResolvedValueOnce({
        data: { user: { id: "revoked-anonymous-device", is_anonymous: true } },
        error: null,
      })
      .mockResolvedValue({
        data: { user: { id: "fresh-anonymous-device", is_anonymous: true } },
        error: null,
      });
    let attempts = 0;
    harness.rpc.mockImplementation(async (name: string) =>
      name === "device_context"
        ? { data: null, error: { code: "42501" } }
        : ++attempts === 1
          ? { data: null, error: { code: "22023" } }
          : { data: deviceRow, error: null },
    );
    await expect(pairDevice("ABCD1234ABCD1234")).rejects.toMatchObject({
      code: "invalid_code",
    });
    expect(await pairDevice("ABCD1234ABCD1234")).toEqual(device);
    expect(harness.signInAnonymously).toHaveBeenCalledOnce();
    expect(harness.signOut).toHaveBeenCalledOnce();
  });
});

describe("normalized Supabase repository mapping", () => {
  it.each([true, false])(
    "round-trips consented OpenAI observations (photo=%s) without scores or source codes",
    async (withPhoto) => {
      harness.getUser.mockResolvedValue({
        data: { user: { id: "device-user", is_anonymous: true } },
        error: null,
      });
      const analysis = {
        id: sessionRow.analysis.id,
        request_id: sessionId,
        mode: "openai",
        model_version: "gpt-4.1-mini-2025-04-14",
        quality_status: withPhoto ? "usable" : "not_provided",
        observations: [],
        disclaimer: OPENAI_SKIN_DISCLAIMER,
        vision: withPhoto
          ? {
              prompt_version: "visible-appearance-eval-v1",
              image_quality: "usable",
              quality_flags: [],
              observed_features: {
                visible_redness: "visible",
                visible_spots: "uncertain",
                visible_pores: "not_visible",
                visible_fine_lines: "not_visible",
                visible_flaking: "not_visible",
              },
            }
          : null,
      };
      harness.rpc.mockImplementation(async (name: string) => ({
        error: null,
        data:
          name === "device_context"
            ? deviceRow
            : name === "read_kiosk_session"
              ? {
                  ...sessionRow,
                  analysis,
                  vision_consent: {
                    accepted: withPhoto,
                    notice_version: VISION_NOTICE_VERSION,
                  },
                }
              : null,
      }));
      const repository = await makeSupabaseRepository("device");
      const result = await repository.session(sessionId, device);
      const { id: _id, ...expected } = analysis;
      void _id;
      expect(result.analysis).toEqual(expected);
      expect(result.visionConsent).toEqual({
        accepted: withPhoto,
        noticeVersion: VISION_NOTICE_VERSION,
      });
    },
  );
  it("routes photo choice and durable claim through guest-owned RPCs with no tenant parameter", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { id: "device-user", is_anonymous: true } },
      error: null,
    });
    const original = harness.rpc.getMockImplementation()!;
    harness.rpc.mockImplementation(async (name: string, args?: unknown) =>
      name === "claim_kiosk_vision_analysis"
        ? { error: null, data: true }
        : original(name, args),
    );
    const repository = await makeSupabaseRepository("device");
    await repository.visionConsent(
      sessionId,
      device,
      true,
      VISION_NOTICE_VERSION,
    );
    await expect(
      repository.claimVisionAnalysis(sessionId, device),
    ).resolves.toBe(true);
    expect(harness.rpc).toHaveBeenCalledWith("record_vision_consent", {
      p_session_id: sessionId,
      p_notice_version: VISION_NOTICE_VERSION,
      p_accepted: true,
    });
    expect(harness.rpc).toHaveBeenCalledWith("claim_kiosk_vision_analysis", {
      p_session_id: sessionId,
    });
  });
  it.each(["used", "unseen", "no-photo"])(
    "round-trips %s photo-feature provenance without converting codes into observations",
    async (coverage) => {
      harness.getUser.mockResolvedValue({
        data: { user: { id: "device-user", is_anonymous: true } },
        error: null,
      });
      const experimental = {
        id: sessionRow.analysis.id,
        request_id: sessionId,
        mode: "experimental",
        model_version: "local-1:source-codes-v1",
        quality_status: "experimental",
        observations: [],
        disclaimer: "Experimental outputs.",
        visual:
          coverage === "no-photo"
            ? null
            : {
                model_version: "photo-1",
                heads: Object.entries({
                  sensitivity: ["NS", "S"],
                  pigmentation: ["P0", "P1", "P2"],
                  wrinkles: ["W0", "W1", "W2"],
                  acne: ["NA", "A"],
                  pores: ["NVP", "VP"],
                  sagging: ["NSA", "SA"],
                  keratin: ["ND", "D"],
                  redness: ["NR", "R"],
                }).map(([key, codes]) => ({
                  key,
                  label: key,
                  predicted_code: codes[0],
                  probabilities: codes.map((code, index) => ({
                    code,
                    probability: index === 0 ? 0.8 : 0.2 / (codes.length - 1),
                  })),
                })),
              },
        ingredients: {
          model_version: "linear-1",
          candidates: [{ ingredient: "Glycerin", score: 0.9 }],
          input_coverage:
            coverage === "used"
              ? [
                  "visual_condition_used_source_contract_v1",
                  "visual_condition_exact_training_category",
                  "source_code_contract_aihub71886_v1",
                  "source_code_meanings_unverified",
                  "combined_pipeline_not_validated",
                ]
              : coverage === "unseen"
                ? [
                    "source_code_contract_aihub71886_v1",
                    "source_code_meanings_unverified",
                    "combined_pipeline_not_validated",
                    "visual_condition_unseen_in_training_omitted",
                    "visual_codes_not_used_for_ingredients",
                    "initial_skin_condition_omitted",
                  ]
                : [
                    "no_photo_questionnaire_only",
                    "visual_codes_not_used_for_ingredients",
                    "initial_skin_condition_omitted",
                  ],
        },
      };
      harness.rpc.mockImplementation(async (name: string) => ({
        error: null,
        data:
          name === "device_context"
            ? deviceRow
            : name === "read_kiosk_session"
              ? { ...sessionRow, analysis: experimental }
              : null,
      }));
      const repository = await makeSupabaseRepository("device");
      const result = await repository.session(sessionId, device);
      expect(result.analysis).toEqual({
        request_id: sessionId,
        mode: "experimental",
        model_version: "local-1:source-codes-v1",
        quality_status: "experimental",
        observations: [],
        disclaimer: "Experimental outputs.",
        visual: experimental.visual,
        ingredients: experimental.ingredients,
      });
    },
  );

  it("maps the normalized catalog view to the domain product", async () => {
    const repository = await makeSupabaseRepository("staff");
    expect(await repository.products(store)).toEqual([
      {
        id: variantId,
        organizationId: org,
        storeId: store,
        brand: "Test Brand",
        name: "Test Serum",
        category: "serum",
        sku: "TEST-01",
        priceMinor: 2400,
        currency: "USD",
        stock: 4,
        visible: true,
        status: "published",
        ingredients: ["Water", "Glycerin"],
        suitableSkinTypes: ["dry"],
        formulaComplete: true,
      },
    ]);
  });

  it("rejects an unexpected tenant in a catalog response", async () => {
    const repository = await makeSupabaseRepository("staff");
    harness.rpc.mockResolvedValue({
      data: [{ ...catalogRow, organization_id: otherOrg }],
      error: null,
    });
    await expect(repository.products(store)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("blocks writes outside verified store membership before calling the database", async () => {
    const repository = await makeSupabaseRepository("staff");
    harness.rpc.mockClear();
    await expect(
      repository.updateListing(
        "99999999-9999-4999-8999-999999999999",
        variantId,
        { priceMinor: 2000, stock: 2, visible: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("returns only today's UTC metrics rather than the 30-day reporting window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T23:50:00Z"));
    const repository = await makeSupabaseRepository("staff");
    harness.rpc.mockResolvedValue({
      error: null,
      data: [
        {
          day: "2026-10-09",
          sessions_started: 50,
          sessions_completed: 30,
          sessions_analyzed: 40,
        },
        {
          day: "2026-10-10",
          sessions_started: 3,
          sessions_completed: 1,
          sessions_analyzed: 2,
        },
      ],
    });
    expect(await repository.metrics(store)).toEqual({
      started: 3,
      completed: 1,
      analyzed: 2,
    });
  });

  it("imports drafts in one transaction RPC without publishing", async () => {
    const repository = await makeSupabaseRepository("staff");
    const [product] = await repository.products(store);
    harness.rpc.mockClear();
    await repository.importDrafts(store, [product]);
    expect(harness.rpc).toHaveBeenCalledExactlyOnceWith(
      "import_catalog_drafts",
      {
        p_store_id: store,
        p_products: [
          {
            sku: "TEST-01",
            brand: "Test Brand",
            name: "Test Serum",
            category: "serum",
            price_minor: 2400,
            currency: "USD",
            stock: 4,
            ingredients: ["Water", "Glycerin"],
            formulation_complete: true,
            skin_types: ["dry"],
          },
        ],
      },
    );
  });

  it("preserves exact stored mock observations and an uncomputed recommendation state", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    const repository = await makeSupabaseRepository("device");
    const result = await repository.session(sessionId, device);
    expect(result.answers?.sensitive).toBe(true);
    expect(result.analysis).toMatchObject({
      request_id: sessionId,
      mode: "mock",
      quality_status: "demo",
      observations: [{ concern_id: "dehydration", level: "high", score: 0.78 }],
    });
    expect(result.recommendations).toBeNull();
  });

  it("checks device identity before a session read or trusted writer operation", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    const repository = await makeSupabaseRepository("device");
    harness.rpc.mockClear();
    await expect(
      repository.session(sessionId, { ...device, organizationId: otherOrg }),
    ).rejects.toMatchObject({ status: 403 });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("reads the completed consultation's original policy through its guest-scoped RPC", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    harness.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === "device_context"
          ? deviceRow
          : {
              id: variantId,
              version: 2,
              source: "mock-onboarding-v1",
              rules: [
                {
                  concern: "dehydration",
                  ingredient: "Glycerin",
                  relevance: 3,
                },
              ],
            },
    }));
    const repository = await makeSupabaseRepository("device");
    expect(await repository.policy(device, sessionId)).toEqual({
      id: variantId,
      version: "2",
      source: "mock-onboarding-v1",
      rules: [{ concern: "dehydration", ingredient: "Glycerin", relevance: 3 }],
    });
    expect(harness.rpc).toHaveBeenCalledWith(
      "read_kiosk_recommendation_policy",
      { p_session_id: sessionId },
    );
    expect(harness.rpc).not.toHaveBeenCalledWith("read_recommendation_policy");
  });

  it("keeps initial policy selection on the current-policy endpoint and checks device identity", async () => {
    harness.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    harness.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === "device_context"
          ? deviceRow
          : {
              id: variantId,
              version: 1,
              rules: [],
              source: "operator-configured",
            },
    }));
    const repository = await makeSupabaseRepository("device");
    expect((await repository.policy(device)).source).toBe(
      "operator-configured",
    );
    expect(harness.rpc).toHaveBeenCalledWith(
      "read_recommendation_policy",
      undefined,
    );
    harness.rpc.mockClear();
    await expect(
      repository.policy({ ...device, organizationId: otherOrg }, sessionId),
    ).rejects.toMatchObject({ status: 403 });
    expect(harness.rpc).not.toHaveBeenCalled();
  });
});
