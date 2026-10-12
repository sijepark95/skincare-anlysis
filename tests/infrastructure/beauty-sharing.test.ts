import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: harness.createClient,
}));

import {
  beautyPublicOrigin,
  beautyTokenHash,
  newBeautyToken,
  readSavedBeauty,
  SupabaseSavedBeauty,
} from "@/infrastructure/beauty-sharing";
import type { SavedBeautySnapshot } from "@/application/beauty-consultations";

const preferences = {
  paletteId: "cool_soft",
  faceShape: "round",
  hairLength: "medium",
  mood: "fresh",
  finish: "satin",
} as const;
const snapshot: SavedBeautySnapshot = {
  guideVersion: "beauty-style-guide-v1",
  expiresAt: "2099-10-18T00:00:00Z",
  preferences,
  products: [],
};
const publicKey = "synthetic-public-publishable-key";
beforeEach(() => {
  vi.clearAllMocks();
  harness.createClient.mockReturnValue({ rpc: harness.rpc });
  harness.rpc.mockResolvedValue({ data: snapshot, error: null });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", publicKey);
  vi.stubEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "synthetic-service-secret-must-never-be-used",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("explicit public HTTPS origin", () => {
  it("normalizes an ordinary explicitly configured public origin", () => {
    expect(beautyPublicOrigin(" https://BEAUTY.Example.com/ ")).toBe(
      "https://beauty.example.com",
    );
    vi.stubEnv("BEAUTY_PUBLIC_ORIGIN", "https://beauty.example.com");
    expect(beautyPublicOrigin()).toBe("https://beauty.example.com");
  });
  it.each([
    "",
    "not-a-url",
    "http://beauty.example.com",
    "https://user:secret@beauty.example.com",
    "https://beauty.example.com/path",
    "https://beauty.example.com/?query=1",
    "https://beauty.example.com/#secret",
    "https://beauty.example.com:8443",
    "https://localhost",
    "https://kiosk.localhost",
    "https://kiosk.local",
    "https://kiosk.test",
    "https://127.0.0.1",
    "https://127.1",
    "https://2130706433",
    "https://[::1]",
    "https://localhost.",
    "https://kiosk.local.",
    "https://kiosk.localhost.",
    "https://kiosk.test.",
    "https://a..com",
    "https://-bad.example.com",
    "https://bad-.example.com",
    "https://*.example.com",
  ])(
    "does not enable phone sharing for an invalid or local origin: %s",
    (value) => {
      expect(beautyPublicOrigin(value)).toBeNull();
    },
  );
});

describe("unguessable canonical beauty capability tokens", () => {
  it("generates separate canonical 32-byte tokens and hashes only their exact value", () => {
    const tokens = Array.from({ length: 20 }, () => newBeautyToken());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(beautyTokenHash(token)).toBe(
        createHash("sha256").update(token).digest("hex"),
      );
    }
  });
  it.each([
    "",
    "a".repeat(42),
    "a".repeat(44),
    "a".repeat(43),
    "a".repeat(42) + "/",
    " a".repeat(22),
    "a".repeat(42) + "=",
  ])(
    "rejects malformed or noncanonical token without reflecting it",
    (token) => {
      try {
        beautyTokenHash(token);
        throw new Error("Token was accepted");
      } catch (error) {
        expect(error).toMatchObject({ status: 404, code: "guide_not_found" });
        if (token) expect((error as Error).message).not.toContain(token);
      }
    },
  );
});

describe("anonymous saved beauty capability RPC transport", () => {
  it("uses only a publishable key, disables ambient sessions and sends only a token hash", async () => {
    const tokenHash = beautyTokenHash(newBeautyToken());
    expect(
      await new SupabaseSavedBeauty().readSavedBeautyGuide(tokenHash),
    ).toEqual(snapshot);
    expect(harness.createClient).toHaveBeenCalledExactlyOnceWith(
      "https://project.supabase.co",
      publicKey,
      expect.objectContaining({
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: expect.objectContaining({ fetch: expect.any(Function) }),
      }),
    );
    expect(harness.rpc).toHaveBeenCalledExactlyOnceWith(
      "read_beauty_saved_guide",
      { p_token_hash: tokenHash },
    );
    expect(JSON.stringify(harness.createClient.mock.calls)).not.toContain(
      "synthetic-service-secret",
    );
    const options = harness.createClient.mock.calls[0][2];
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await options.global.fetch(
      "https://project.supabase.co/rest/v1/rpc/read_beauty_saved_guide",
      { method: "POST", body: JSON.stringify({ p_token_hash: tokenHash }) },
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(options.global.headers).toBeUndefined();
  });

  it("revokes via the anonymous capability RPC without a service key", async () => {
    const tokenHash = beautyTokenHash(newBeautyToken());
    await new SupabaseSavedBeauty().revokeSavedBeautyGuide(tokenHash);
    expect(harness.rpc).toHaveBeenCalledExactlyOnceWith(
      "revoke_beauty_saved_guide",
      { p_token_hash: tokenHash },
    );
    expect(harness.createClient.mock.calls[0][1]).toBe(publicKey);
  });

  it.each([
    { data: null, error: null },
    { data: { ...snapshot, guideVersion: "unknown-guide-v2" }, error: null },
    { data: { ...snapshot, guideVersion: undefined }, error: null },
    { data: snapshot, error: { message: "PRIVATE-DATABASE-DETAIL" } },
    { data: { ...snapshot, expiresAt: "2000-01-01T00:00:00Z" }, error: null },
    { data: { ...snapshot, photo: "PRIVATE-PHOTO" }, error: null },
    {
      data: { ...snapshot, preferences: { ...preferences, faceShape: "cat" } },
      error: null,
    },
    { data: { ...snapshot, products: [{ name: "incomplete" }] }, error: null },
  ])(
    "fails closed for missing, expired or unsupported snapshots",
    async (reply) => {
      harness.rpc.mockResolvedValueOnce(reply);
      await expect(
        new SupabaseSavedBeauty().readSavedBeautyGuide("a".repeat(64)),
      ).rejects.toMatchObject({ status: 404, code: "guide_not_found" });
      expect(harness.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it("does not echo database errors when capability revocation fails", async () => {
    harness.rpc.mockResolvedValueOnce({
      error: { message: "PRIVATE-DATABASE-DETAIL" },
    });
    const error = await new SupabaseSavedBeauty()
      .revokeSavedBeautyGuide("a".repeat(64))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "guide_unavailable" });
    expect((error as Error).message).not.toContain("PRIVATE-DATABASE-DETAIL");
  });

  it("rebuilds editorial copy from saved confirmed choices without a provider call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const repository = {
      readSavedBeautyGuide: vi.fn(async () => snapshot),
      revokeSavedBeautyGuide: vi.fn(),
    };
    const saved = await readSavedBeauty(repository, "a".repeat(64));
    expect(saved.preferences).toEqual(preferences);
    expect(saved.guide.palette.id).toBe(preferences.paletteId);
    expect(saved.guide.confirmedFaceShape).toBe(preferences.faceShape);
    expect(fetch).not.toHaveBeenCalled();
  });
});
