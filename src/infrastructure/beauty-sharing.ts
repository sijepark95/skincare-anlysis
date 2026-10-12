import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AppError } from "@/application/contracts";
import type {
  SavedBeautyRepository,
  SavedBeautyResult,
} from "@/application/beauty-consultations";
import {
  BEAUTY_GUIDE_VERSION,
  buildBeautyGuide,
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import { lipFinishes, lipHueFamilies } from "@/domain/personal-color";
import { requiredEnv } from "./config";
import { completeSavedGuideSchema } from "./beauty-complete-repository";
import type { CompleteSavedGuide } from "@/application/beauty-complete-contracts";

/** Public capability RPC only: deliberately no cookies, paired identity or service role. */
export async function readCompleteSavedGuide(
  tokenHash: string,
): Promise<CompleteSavedGuide> {
  const client = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
          }),
      },
    },
  );
  const { data, error } = await client.rpc("read_complete_beauty_guide", {
    p_token_hash: tokenHash,
  });
  const result = completeSavedGuideSchema.safeParse(data);
  if (error || !result.success)
    throw new AppError(
      404,
      "guide_not_found",
      "This guide is unavailable or has expired.",
    );
  return result.data;
}
export async function revokeCompleteSavedGuide(
  tokenHash: string,
): Promise<void> {
  const client = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
          }),
      },
    },
  );
  const { error } = await client.rpc("revoke_complete_beauty_guide", {
    p_token_hash: tokenHash,
  });
  if (error)
    throw new AppError(
      503,
      "guide_unavailable",
      "The guide could not be removed. Try again.",
    );
}

/** Explicit operator setting only; never construct a capability link from a request Host header. */
export function beautyPublicOrigin(
  value = process.env.BEAUTY_PUBLIC_ORIGIN,
): string | null {
  try {
    if (!value?.trim()) return null;
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const labels = host.split(".");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.port ||
      !host.includes(".") ||
      host.length > 253 ||
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      ) ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".test") ||
      host.includes(":") ||
      /^\d+(\.\d+){3}$/.test(host)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function newBeautyToken(): string {
  return randomBytes(32).toString("base64url");
}
export function beautyTokenHash(token: string): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, "base64url").toString("base64url") !== token
  )
    throw new AppError(
      404,
      "guide_not_found",
      "This guide is unavailable or has expired.",
    );
  return createHash("sha256").update(token).digest("hex");
}
const snapshotSchema = z
  .object({
    guideVersion: z.literal(BEAUTY_GUIDE_VERSION),
    expiresAt: z.string().datetime({ offset: true }),
    preferences: z.custom<BeautyPreferences>(validBeautyPreferences),
    products: z
      .array(
        z
          .object({
            variantId: z.string().uuid(),
            shadeVersionId: z.string().uuid(),
            name: z.string().min(1).max(500),
            brand: z.string().min(1).max(500),
            priceMinor: z.number().int().nonnegative().nullable(),
            currency: z.string().length(3).nullable(),
            shadeName: z.string().min(1).max(80),
            hueFamily: z.enum(lipHueFamilies),
            undertone: z.enum(["warm", "cool", "neutral"]),
            intensity: z.enum(["soft", "clear"]),
            finish: z.enum(lipFinishes),
            swatchHex: z.string().regex(/^#[0-9a-f]{6}$/i),
            available: z.boolean(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

/** Anonymous capability RPCs only, without a service key, guest login or ambient staff/device cookies. */
export class SupabaseSavedBeauty implements SavedBeautyRepository {
  private client() {
    return createClient(
      requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              cache: "no-store",
              signal: AbortSignal.timeout(10000),
            }),
        },
      },
    );
  }
  async readSavedBeautyGuide(tokenHash: string) {
    const { data, error } = await this.client().rpc("read_beauty_saved_guide", {
      p_token_hash: tokenHash,
    });
    if (error || data === null)
      throw new AppError(
        404,
        "guide_not_found",
        "This guide is unavailable or has expired.",
      );
    const result = snapshotSchema.safeParse(data);
    if (!result.success || Date.parse(result.data.expiresAt) <= Date.now())
      throw new AppError(
        404,
        "guide_not_found",
        "This guide is unavailable or has expired.",
      );
    return result.data;
  }
  async revokeSavedBeautyGuide(tokenHash: string) {
    const { error } = await this.client().rpc("revoke_beauty_saved_guide", {
      p_token_hash: tokenHash,
    });
    if (error)
      throw new AppError(
        503,
        "guide_unavailable",
        "Your guide could not be deleted. Please try again.",
      );
  }
}
export async function readSavedBeauty(
  repository: SavedBeautyRepository,
  tokenHash: string,
): Promise<SavedBeautyResult> {
  const snapshot = await repository.readSavedBeautyGuide(tokenHash);
  const guide = buildBeautyGuide(snapshot.preferences);
  if (!guide)
    throw new AppError(
      404,
      "guide_not_found",
      "This guide is unavailable or has expired.",
    );
  return { ...snapshot, guide };
}
