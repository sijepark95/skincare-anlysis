import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  cookies: vi.fn(),
  getDeviceContext: vi.fn(),
  getStaffContext: vi.fn(),
  makeSupabaseRepository: vi.fn(),
  ensureDevice: vi.fn(),
  session: vi.fn(),
  beautySession: vi.fn(),
  beautyConsent: vi.fn(),
  beautyMakeupState: vi.fn(),
  beautyMakeupConsent: vi.fn(),
  claimBeautyMakeup: vi.fn(),
  assertBeautyMakeup: vi.fn(),
  claimBeautyAnalysis: vi.fn(),
  saveBeautyAnalysis: vi.fn(),
  confirmBeautyPreferences: vi.fn(),
  beautyExclusions: vi.fn(),
  createBeautyGuide: vi.fn(),
  products: vi.fn(),
  lipShades: vi.fn(),
  createClient: vi.fn(),
  rpc: vi.fn(),
  qr: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: harness.cookies }));
vi.mock("qrcode", () => ({ default: { toDataURL: harness.qr } }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: harness.createClient,
}));
vi.mock("@/infrastructure/demo-repository", () => ({
  demoRepository: harness,
  demoStaff: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationName: "Test",
    role: "owner",
    stores: [],
  },
}));
vi.mock("@/infrastructure/supabase-auth", () => ({
  getDeviceContext: harness.getDeviceContext,
  getStaffContext: harness.getStaffContext,
  makeSupabaseRepository: harness.makeSupabaseRepository,
  loginStaff: vi.fn(),
  logoutStaff: vi.fn(),
  pairDevice: vi.fn(),
  getOwnerAccount: vi.fn(),
  signupOwner: vi.fn(),
  verifyOwnerEmail: vi.fn(),
  resendOwnerConfirmation: vi.fn(),
  createOwnerWorkspace: vi.fn(),
}));

import { handle } from "@/interfaces/http/handler";
import {
  BEAUTY_SAVE_NOTICE_VERSION,
  type BeautySession,
} from "@/application/beauty-consultations";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PHOTO_NOTICE_VERSION,
  BEAUTY_PROMPT_VERSION,
} from "@/domain/beauty-analysis";
import { OPENAI_CONSENT_VERSION } from "@/domain/skin-vision";
import {
  BEAUTY_MAKEUP_MODEL_VERSION,
  BEAUTY_MAKEUP_NOTICE_VERSION,
  BEAUTY_MAKEUP_PROMPT_VERSION,
} from "@/domain/beauty-makeup";
import {
  beautyTokenHash,
  newBeautyToken,
} from "@/infrastructure/beauty-sharing";

const sessionId = "44444444-4444-4444-8444-444444444444";
const choice = {
  paletteId: "cool_soft",
  faceShape: "round",
  hairLength: "medium",
  mood: "fresh",
  finish: "satin",
} as const;
const path = `kiosk/sessions/${sessionId}`;
let sequence = 0;
let device: { organizationId: string; storeId: string; deviceId: string };
let state: BeautySession;
function request(route: string, body: unknown = {}, method = "POST") {
  return new Request(`http://localhost/api/v1/${route}`, {
    method,
    headers: {
      Origin: "http://localhost",
      "Content-Type": "application/json",
      "X-Forwarded-For": `beauty-test-${sequence}`,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}
function photoRequest(endpoint = "beauty-analysis") {
  return new Request(`http://localhost/api/v1/${path}/${endpoint}`, {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "image/jpeg" },
    body: new Uint8Array([1, 2, 3]),
  });
}
function run(endpoint: string, body: unknown = {}, method = "POST") {
  return handle(request(`${path}/${endpoint}`, body, method), [
    ...path.split("/"),
    endpoint,
  ]);
}
function openai() {
  vi.stubEnv("ANALYSIS_PROVIDER", "openai");
  vi.stubEnv("ANALYSIS_SERVICE_URL", "http://127.0.0.1:8000");
  vi.stubEnv(
    "ANALYSIS_API_KEY",
    "synthetic-private-key-with-at-least-32-characters",
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  sequence++;
  device = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    deviceId: crypto.randomUUID(),
  };
  state = {
    consent: false,
    attempted: false,
    analysis: null,
    preferences: null,
    excludedIngredients: [],
  };
  vi.stubEnv("APP_MODE", "demo");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost");
  vi.stubEnv("ANALYSIS_PROVIDER", "mock");
  vi.stubEnv("ANALYSIS_SERVICE_URL", "");
  vi.stubEnv("ANALYSIS_API_KEY", "");
  vi.stubEnv("BEAUTY_PUBLIC_ORIGIN", "");
  vi.stubEnv("ANALYSIS_BEAUTY_MAKEUP_ENABLED", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "synthetic-public-key");
  vi.stubEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "synthetic-service-secret-must-not-be-used",
  );
  harness.cookies.mockResolvedValue({
    get: () => ({ value: "test-device" }),
    set: vi.fn(),
  });
  harness.ensureDevice.mockReturnValue(device);
  harness.getDeviceContext.mockResolvedValue(device);
  harness.makeSupabaseRepository.mockResolvedValue(harness);
  harness.session.mockResolvedValue({
    id: sessionId,
    ...device,
    consent: true,
    consentVersion: OPENAI_CONSENT_VERSION,
    answers: null,
    analysis: null,
    recommendations: null,
  });
  harness.beautySession.mockImplementation(async () => structuredClone(state));
  harness.beautyMakeupState.mockResolvedValue({
    consent: false,
    attempted: false,
  });
  harness.beautyConsent.mockImplementation(async (_id, _device, accepted) => {
    state.consent = accepted;
  });
  harness.confirmBeautyPreferences.mockImplementation(
    async (_id, _device, preferences) => {
      state.preferences = preferences;
    },
  );
  harness.beautyExclusions.mockImplementation(
    async (_id, _device, ingredients) => {
      state.excludedIngredients = ingredients;
    },
  );
  harness.claimBeautyAnalysis.mockImplementation(async () => {
    if (state.attempted) return false;
    state.attempted = true;
    return true;
  });
  harness.saveBeautyAnalysis.mockImplementation(
    async (_id, _device, analysis) => {
      state.analysis = analysis;
    },
  );
  harness.products.mockResolvedValue([]);
  harness.lipShades.mockResolvedValue([]);
  harness.createBeautyGuide.mockResolvedValue({
    expiresAt: "2099-10-18T00:00:00Z",
  });
  harness.createClient.mockReturnValue({ rpc: harness.rpc });
  harness.rpc.mockResolvedValue({
    data: {
      guideVersion: "beauty-style-guide-v1",
      expiresAt: "2099-10-18T00:00:00Z",
      preferences: choice,
      products: [],
    },
    error: null,
  });
  harness.qr.mockResolvedValue("data:image/png;base64,synthetic-qr");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("own-photo makeup HTTP boundary", () => {
  function enable() {
    openai();
    vi.stubEnv("ANALYSIS_BEAUTY_MAKEUP_ENABLED", "true");
    state.consent = true;
    state.attempted = true;
    state.preferences = choice;
    state.analysis = {
      request_id: sessionId,
      mode: "openai_beauty",
      model_version: BEAUTY_MODEL_VERSION,
      prompt_version: "beauty-style-suggestion-v2",
      image_quality: "usable",
      undertone: "cool",
      chroma: "soft",
      face_shape: "round",
      eye_shape: "round",
      nose_shape: "medium",
      lip_fullness: "full",
      quality_flags: [],
    };
    harness.beautyMakeupState.mockResolvedValue({
      consent: true,
      attempted: false,
    });
  }
  it("requires a separate exact current notice and rejects extra identity fields", async () => {
    enable();
    expect(
      (
        await run("beauty-makeup-consent", {
          accepted: true,
          noticeVersion: BEAUTY_MAKEUP_NOTICE_VERSION,
        })
      ).status,
    ).toBe(200);
    expect(harness.beautyMakeupConsent).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      device,
      true,
      BEAUTY_MAKEUP_NOTICE_VERSION,
    );
    expect(
      (
        await run("beauty-makeup-consent", {
          accepted: true,
          noticeVersion: BEAUTY_MAKEUP_NOTICE_VERSION,
          organizationId: device.organizationId,
        })
      ).status,
    ).toBe(422);
  });
  it.each([
    "disabled",
    "not-consented",
    "attempted",
    "not-confirmed",
    "legacy",
  ])(
    "checks %s before reading the image or starting a provider call",
    async (reason) => {
      enable();
      if (reason === "disabled")
        vi.stubEnv("ANALYSIS_BEAUTY_MAKEUP_ENABLED", "false");
      if (reason === "not-consented")
        harness.beautyMakeupState.mockResolvedValue({
          consent: false,
          attempted: false,
        });
      if (reason === "attempted")
        harness.beautyMakeupState.mockResolvedValue({
          consent: true,
          attempted: true,
        });
      if (reason === "not-confirmed") state.preferences = null;
      if (reason === "legacy") state.analysis = null;
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const image = photoRequest("beauty-makeup");
      const response = await handle(image, [
        ...path.split("/"),
        "beauty-makeup",
      ]);
      expect(response.status).toBe(409);
      expect(image.bodyUsed).toBe(false);
      expect(harness.claimBeautyMakeup).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("returns exactly3 bounded real-provider envelopes with no cache and a late-state check", async () => {
    enable();
    const fetch = vi.fn(async (_url, options) => {
      const sent = JSON.parse(options.body as string);
      expect(sent.palette_id).toBe("cool_soft");
      expect(Object.keys(sent).sort()).toEqual([
        "image_base64",
        "palette_id",
        "request_id",
      ]);
      return new Response(
        JSON.stringify({
          request_id: sent.request_id,
          mode: "openai_beauty_makeup",
          model_version: BEAUTY_MAKEUP_MODEL_VERSION,
          prompt_version: BEAUTY_MAKEUP_PROMPT_VERSION,
          images: ["soft", "fresh", "defined"].map((id, index) => ({
            id,
            image_base64: Buffer.from([
              255,
              216,
              255,
              224,
              index,
              0,
              255,
              217,
            ]).toString("base64"),
            mime_type: "image/jpeg",
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const response = await handle(photoRequest("beauty-makeup"), [
      ...path.split("/"),
      "beauty-makeup",
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(
      (await response.json()).images.map((value: { id: string }) => value.id),
    ).toEqual(["soft", "fresh", "defined"]);
    expect(harness.claimBeautyMakeup).toHaveBeenCalledTimes(1);
    expect(harness.assertBeautyMakeup).toHaveBeenCalledTimes(1);
    expect(harness.saveBeautyAnalysis).not.toHaveBeenCalled();
    expect(harness.createBeautyGuide).not.toHaveBeenCalled();
  });
  it("rejects a foreign-origin image before parsing, claims or provider calls", async () => {
    enable();
    const image = photoRequest("beauty-makeup");
    image.headers.set("Origin", "https://foreign.example");
    expect(
      (await handle(image, [...path.split("/"), "beauty-makeup"])).status,
    ).toBe(403);
    expect(image.bodyUsed).toBe(false);
    expect(harness.claimBeautyMakeup).not.toHaveBeenCalled();
  });
});

describe("primary beauty HTTP boundary", () => {
  it("reads primary beauty without skin answers, provider calls or public caching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await run("beauty", undefined, "GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      preferences: null,
      guide: null,
      photoAvailable: false,
      sharingAvailable: false,
    });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.claimBeautyAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    "beauty-consent",
    "beauty-preferences",
    "beauty-exclusions",
    "beauty-share",
    "beauty-analysis",
  ])(
    "rejects cross-origin %s before device lookup or reading a body",
    async (endpoint) => {
      const submission = request(`${path}/${endpoint}`, {
        private: "PRIVATE-BODY",
      });
      submission.headers.set("Origin", "https://attacker.example");
      const response = await handle(submission, [...path.split("/"), endpoint]);
      expect(response.status).toBe(403);
      expect(submission.bodyUsed).toBe(false);
      expect(harness.cookies).not.toHaveBeenCalled();
      expect(harness.getDeviceContext).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("PRIVATE-BODY");
    },
  );

  it("requires pairing before beauty access in Supabase mode", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    harness.getDeviceContext.mockResolvedValue(null);
    const response = await run("beauty", undefined, "GET");
    expect(response.status).toBe(401);
    expect(harness.makeSupabaseRepository).not.toHaveBeenCalled();
  });

  it.each([
    { ...choice, faceShape: "cat" },
    { ...choice, paletteId: "spring" },
    { ...choice, hairLength: "unknown" },
    { ...choice, mood: "personality" },
    { ...choice, organizationId: "client-tenant" },
    { paletteId: "cool_soft" },
  ])(
    "accepts only complete confirmed enumerated preferences: %o",
    async (body) => {
      expect((await run("beauty-preferences", body)).status).toBe(422);
      expect(harness.confirmBeautyPreferences).not.toHaveBeenCalled();
    },
  );

  it("manual confirmation and exclusions make no photo request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await run("beauty-preferences", choice)).status).toBe(200);
    expect(harness.confirmBeautyPreferences).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      device,
      choice,
    );
    expect(
      (
        await run("beauty-exclusions", {
          excludedIngredients: ["Vitamin B3", "Niacinamide"],
        })
      ).status,
    ).toBe(200);
    expect(harness.beautyExclusions).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      device,
      ["Niacinamide"],
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { excludedIngredients: ["Unknown ingredient"] },
    { excludedIngredients: [1] },
    { excludedIngredients: [""] },
    { excludedIngredients: Array.from({ length: 21 }, () => "Glycerin") },
    { excludedIngredients: [], organizationId: "client-tenant" },
  ])(
    "rejects unsupported, oversized or extra exclusion inputs",
    async (body) => {
      expect((await run("beauty-exclusions", body)).status).toBe(422);
      expect(harness.beautyExclusions).not.toHaveBeenCalled();
    },
  );

  it.each([
    { consent: false, attempted: false },
    { consent: true, attempted: true },
  ])(
    "checks photo purpose/attempt before image parsing: %o",
    async (photoState) => {
      openai();
      Object.assign(state, photoState);
      const photo = photoRequest();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const response = await handle(photo, [
        ...path.split("/"),
        "beauty-analysis",
      ]);
      expect(response.status).toBe(409);
      expect(photo.bodyUsed).toBe(false);
      expect(harness.claimBeautyAnalysis).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects stale or preselected consent data without recording acceptance", async () => {
    openai();
    expect(
      (await run("beauty-consent", { accepted: true, noticeVersion: "old" }))
        .status,
    ).toBe(422);
    expect(
      (
        await run("beauty-consent", {
          accepted: true,
          noticeVersion: BEAUTY_PHOTO_NOTICE_VERSION,
          organizationId: "client-tenant",
        })
      ).status,
    ).toBe(422);
    expect(harness.beautyConsent).not.toHaveBeenCalled();
  });

  it("shares one inflight analysis slot across beauty, colour and skin routes", async () => {
    openai();
    state.consent = true;
    harness.session.mockResolvedValue({
      id: sessionId,
      ...device,
      consent: true,
      consentVersion: OPENAI_CONSENT_VERSION,
      answers: {
        skinType: "normal",
        concerns: ["texture"],
        sensitive: false,
        excludedIngredients: [],
      },
      analysis: null,
      recommendations: null,
    });
    const started = deferred<{ request_id: string }>();
    const response = deferred<Response>();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      started.resolve(JSON.parse(init!.body as string));
      return response.promise;
    });
    vi.stubGlobal("fetch", fetch);
    const pending = handle(photoRequest(), [
      ...path.split("/"),
      "beauty-analysis",
    ]);
    const payload = await started.promise;
    for (const endpoint of ["beauty-analysis", "color-analysis", "analysis"]) {
      const photo = photoRequest(endpoint);
      expect((await handle(photo, [...path.split("/"), endpoint])).status).toBe(
        429,
      );
      expect(photo.bodyUsed).toBe(false);
    }
    response.resolve(
      Response.json({
        request_id: payload.request_id,
        mode: "openai_beauty",
        model_version: BEAUTY_MODEL_VERSION,
        prompt_version: BEAUTY_PROMPT_VERSION,
        image_quality: "usable",
        undertone: "warm",
        chroma: "soft",
        face_shape: "oval",
        quality_flags: [],
      }),
    );
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(harness.claimBeautyAnalysis).toHaveBeenCalledTimes(1);
    expect((await run("beauty", undefined, "GET")).status).toBe(200);
  });

  it("creates a fragment-only capability link from the configured public origin", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    vi.stubEnv("BEAUTY_PUBLIC_ORIGIN", "https://beauty.example.com");
    state.preferences = choice;
    const submission = request(`${path}/beauty-share`, {
      accepted: true,
      noticeVersion: BEAUTY_SAVE_NOTICE_VERSION,
    });
    submission.headers.set("Host", "forged.example");
    const response = await handle(submission, [
      ...path.split("/"),
      "beauty-share",
    ]);
    expect(response.status).toBe(201);
    const body = await response.json();
    const link = new URL(body.url);
    expect(link.origin).toBe("https://beauty.example.com");
    expect(link.pathname).toBe("/result");
    expect(link.search).toBe("");
    const token = link.hash.slice(1);
    expect(harness.createBeautyGuide).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      device,
      beautyTokenHash(token),
      BEAUTY_SAVE_NOTICE_VERSION,
    );
    expect(JSON.stringify(harness.createBeautyGuide.mock.calls)).not.toContain(
      token,
    );
    expect(harness.qr).toHaveBeenCalledWith(
      body.url,
      expect.objectContaining({ width: 320 }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});

describe("public saved beauty capability HTTP boundary", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "supabase");
    harness.getDeviceContext.mockResolvedValue(null);
  });

  it.each(["read", "revoke"])(
    "allows token-authorized %s without a device, staff login or service role",
    async (operation) => {
      const token = newBeautyToken();
      const route = `shared-results/${operation}`;
      const response = await handle(
        request(route, { token }),
        route.split("/"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(harness.rpc).toHaveBeenNthCalledWith(
        1,
        operation === "read"
          ? "read_beauty_saved_guide"
          : "revoke_beauty_saved_guide",
        { p_token_hash: beautyTokenHash(token) },
      );
      if (operation === "revoke") {
        // Both capability namespaces are idempotent; legacy success cannot mask
        // an integrated guide that uses the same public revocation endpoint.
        expect(harness.rpc).toHaveBeenNthCalledWith(
          2,
          "revoke_complete_beauty_guide",
          { p_token_hash: beautyTokenHash(token) },
        );
      }
      expect(harness.rpc).toHaveBeenCalledTimes(operation === "revoke" ? 2 : 1);
      expect(harness.cookies).not.toHaveBeenCalled();
      expect(harness.getDeviceContext).not.toHaveBeenCalled();
      expect(harness.getStaffContext).not.toHaveBeenCalled();
      expect(harness.makeSupabaseRepository).not.toHaveBeenCalled();
      expect(harness.createClient.mock.calls[0][1]).toBe(
        "synthetic-public-key",
      );
      const body = await response.text();
      expect(body).not.toContain(token);
      expect(body).not.toContain("synthetic-service-secret");
      expect(body).not.toContain("image_base64");
    },
  );

  it.each(["read", "revoke"])(
    "retains same-origin CSRF protection for public %s",
    async (operation) => {
      const route = `shared-results/${operation}`;
      const submission = request(route, { token: newBeautyToken() });
      submission.headers.delete("Origin");
      expect((await handle(submission, route.split("/"))).status).toBe(403);
      expect(submission.bodyUsed).toBe(false);
      expect(harness.createClient).not.toHaveBeenCalled();
    },
  );

  it("rejects tokens placed in a URL and extra body identity fields", async () => {
    const route = "shared-results/read";
    expect(
      (
        await handle(
          request(`${route}?token=${newBeautyToken()}`, {}, "GET"),
          route.split("/"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handle(
          request(route, {
            token: newBeautyToken(),
            organizationId: device.organizationId,
          }),
          route.split("/"),
        )
      ).status,
    ).toBe(422);
    expect(harness.createClient).not.toHaveBeenCalled();
  });

  it("does not echo or log capability bodies or private database errors", async () => {
    const token = newBeautyToken();
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    harness.rpc.mockResolvedValue({
      data: null,
      error: { message: "PRIVATE-DATABASE-DETAIL" },
    });
    const response = await handle(request("shared-results/read", { token }), [
      "shared-results",
      "read",
    ]);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain("PRIVATE-DATABASE-DETAIL");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});
