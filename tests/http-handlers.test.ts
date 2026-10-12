import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getStaffContext: vi.fn(),
  getDeviceContext: vi.fn(),
  makeSupabaseRepository: vi.fn(),
  ensureDevice: vi.fn(),
  start: vi.fn(),
  session: vi.fn(),
  consent: vi.fn(),
  explanationConsent: vi.fn(),
  visionConsent: vi.fn(),
  claimVisionAnalysis: vi.fn(),
  claimExplanation: vi.fn(),
  saveExplanation: vi.fn(),
  saveAnalysis: vi.fn(),
  saveRecommendations: vi.fn(),
  policy: vi.fn(),
  finish: vi.fn(),
  publish: vi.fn(),
  saveDraft: vi.fn(),
  products: vi.fn(),
  devices: vi.fn(),
  metrics: vi.fn(),
  getOwnerAccount: vi.fn(),
  signupOwner: vi.fn(),
  verifyOwnerEmail: vi.fn(),
  resendOwnerConfirmation: vi.fn(),
  createOwnerWorkspace: vi.fn(),
  loginStaff: vi.fn(),
  colorSession: vi.fn(),
  colorConsent: vi.fn(),
  claimColorAnalysis: vi.fn(),
  saveColorAnalysis: vi.fn(),
  confirmColorPreferences: vi.fn(),
  lipShades: vi.fn(),
  publishLipShade: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => ({ value: "demo-device" }),
    set: vi.fn(),
  }),
}));
vi.mock("@/infrastructure/demo-repository", () => ({
  demoStaff: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationName: "Test Retail",
    role: "owner",
    stores: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Test Store",
        currency: "USD",
        location: "",
      },
    ],
  },
  demoRepository: harness,
}));
vi.mock("@/infrastructure/supabase-auth", () => ({
  getStaffContext: harness.getStaffContext,
  getDeviceContext: harness.getDeviceContext,
  makeSupabaseRepository: harness.makeSupabaseRepository,
  loginStaff: harness.loginStaff,
  logoutStaff: vi.fn(),
  pairDevice: vi.fn(),
  getOwnerAccount: harness.getOwnerAccount,
  signupOwner: harness.signupOwner,
  verifyOwnerEmail: harness.verifyOwnerEmail,
  resendOwnerConfirmation: harness.resendOwnerConfirmation,
  createOwnerWorkspace: harness.createOwnerWorkspace,
}));

import { AppError } from "@/application/contracts";
import { handle } from "@/interfaces/http/handler";
import {
  OPENAI_CONSENT_VERSION,
  VISION_NOTICE_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
  OPENAI_SKIN_PROMPT_VERSION,
} from "@/domain/skin-vision";

const storeId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
const device = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  storeId,
  deviceId: "33333333-3333-4333-8333-333333333333",
};
function request(path: string, body: unknown = {}, method = "POST") {
  return new Request(`http://localhost/api/v1/${path}`, {
    method,
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_MODE", "demo");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost");
  vi.stubEnv("EXPLANATION_PROVIDER", "disabled");
  vi.stubEnv("OPENAI_API_KEY", "");
  harness.ensureDevice.mockReturnValue(device);
  harness.start.mockResolvedValue({ id: sessionId });
  harness.session.mockResolvedValue({
    id: sessionId,
    consent: true,
    consentVersion: "2026-10-experimental-v1",
    answers: {
      skinType: "dry",
      concerns: ["dehydration"],
      sensitive: false,
      excludedIngredients: [],
    },
    analysis: null,
    recommendations: null,
  });
  harness.finish.mockResolvedValue(undefined);
  harness.visionConsent.mockResolvedValue(undefined);
  harness.claimVisionAnalysis.mockResolvedValue(true);
  harness.saveAnalysis.mockResolvedValue(undefined);
  harness.saveRecommendations.mockResolvedValue(undefined);
  harness.publish.mockResolvedValue(undefined);
  harness.saveDraft.mockResolvedValue(undefined);
  harness.makeSupabaseRepository.mockResolvedValue(harness);
  harness.getStaffContext.mockResolvedValue(null);
  harness.getDeviceContext.mockResolvedValue(null);
  harness.metrics.mockResolvedValue({ started: 2, analyzed: 1, completed: 1 });
  harness.getOwnerAccount.mockResolvedValue({
    authenticated: false,
    needsWorkspace: false,
    staff: null,
  });
  harness.signupOwner.mockResolvedValue({ next: "verify_email" });
  harness.verifyOwnerEmail.mockResolvedValue({ next: "setup" });
  harness.resendOwnerConfirmation.mockResolvedValue(undefined);
  harness.createOwnerWorkspace.mockResolvedValue({
    organizationId: device.organizationId,
    role: "owner",
  });
  harness.loginStaff.mockResolvedValue({ next: "setup" });
  harness.products.mockResolvedValue([]);
  harness.lipShades.mockResolvedValue([]);
  harness.colorSession.mockResolvedValue({
    consent: false,
    attempted: false,
    analysis: null,
    preferences: null,
  });
  harness.colorConsent.mockResolvedValue(undefined);
  harness.confirmColorPreferences.mockResolvedValue(undefined);
  harness.publishLipShade.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("personal color HTTP boundary", () => {
  const path = `kiosk/sessions/${sessionId}`;
  beforeEach(() => {
    vi.stubEnv("ANALYSIS_PROVIDER", "mock");
    vi.stubEnv("ANALYSIS_SERVICE_URL", "");
    harness.ensureDevice.mockReturnValue({
      ...device,
      deviceId: crypto.randomUUID(),
    });
  });
  it("allows manual discovery without an external service or photo consent", async () => {
    const response = await handle(request(`${path}/color`, undefined, "GET"), [
      ...path.split("/"),
      "color",
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      consent: false,
      attempted: false,
      analysis: null,
      preferences: null,
      photoAvailable: false,
      recommendations: [],
    });
    expect(harness.claimColorAnalysis).not.toHaveBeenCalled();
  });
  it("rejects image upload before reading its body without separate color consent", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "openai");
    vi.stubEnv("ANALYSIS_SERVICE_URL", "http://127.0.0.1:8000");
    vi.stubEnv("ANALYSIS_API_KEY", "x".repeat(40));
    const photo = new Request(
      `http://localhost/api/v1/${path}/color-analysis`,
      {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "image/jpeg" },
        body: new Uint8Array([1, 2]),
      },
    );
    const response = await handle(photo, [
      ...path.split("/"),
      "color-analysis",
    ]);
    expect(response.status).toBe(409);
    expect(photo.bodyUsed).toBe(false);
    expect(harness.claimColorAnalysis).not.toHaveBeenCalled();
  });
  it("keeps manual palettes available when the private photo key is missing", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "openai");
    vi.stubEnv("ANALYSIS_SERVICE_URL", "http://127.0.0.1:8000");
    vi.stubEnv("ANALYSIS_API_KEY", "");
    const response = await handle(request(`${path}/color`, undefined, "GET"), [
      ...path.split("/"),
      "color",
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      photoAvailable: false,
      recommendations: [],
    });
    expect(harness.claimColorAnalysis).not.toHaveBeenCalled();
  });
  it("accepts only confirmed enumerated palette and finish fields", async () => {
    const response = await handle(
      request(`${path}/color-preferences`, {
        paletteId: "warm_soft",
        finish: "any",
        organizationId: device.organizationId,
      }),
      [...path.split("/"), "color-preferences"],
    );
    expect(response.status).toBe(422);
    expect(harness.confirmColorPreferences).not.toHaveBeenCalled();
  });
  it("rejects cross-origin color confirmation", async () => {
    const submission = request(`${path}/color-preferences`, {
      paletteId: "warm_soft",
      finish: "satin",
    });
    submission.headers.set("Origin", "https://foreign.example");
    expect(
      (await handle(submission, [...path.split("/"), "color-preferences"]))
        .status,
    ).toBe(403);
    expect(harness.confirmColorPreferences).not.toHaveBeenCalled();
  });
  it("rejects stale color photo notice", async () => {
    expect(
      (
        await handle(
          request(`${path}/color-consent`, {
            accepted: true,
            noticeVersion: "old",
          }),
          [...path.split("/"), "color-consent"],
        )
      ).status,
    ).toBe(422);
    expect(harness.colorConsent).not.toHaveBeenCalled();
  });
  it("requires owner for reviewed shade publication", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    harness.getStaffContext.mockResolvedValue({
      organizationId: device.organizationId,
      organizationName: "Store",
      role: "manager",
      stores: [{ id: storeId, name: "Store", currency: "USD", location: "" }],
    });
    const route = `management/lip-shades/${sessionId}`;
    expect(
      (
        await handle(
          request(`${route}?storeId=${storeId}`, {}, "PUT"),
          route.split("/"),
        )
      ).status,
    ).toBe(403);
    expect(harness.publishLipShade).not.toHaveBeenCalled();
  });
});

describe("hosted explanation HTTP boundary", () => {
  let sequence = 0;
  function prepare() {
    harness.ensureDevice.mockReturnValue({
      ...device,
      deviceId: `explanation-http-${++sequence}`,
    });
    vi.stubEnv("ANALYSIS_SERVICE_URL", "");
    vi.stubEnv("ANALYSIS_PROVIDER", "mock");
  }
  it("keeps kiosk context usable when optional provider settings are invalid", async () => {
    prepare();
    vi.stubEnv("EXPLANATION_PROVIDER", "unsupported");
    const response = await handle(request("context", {}, "GET"), ["context"]);
    expect(response.status).toBe(200);
    expect((await response.json()).explanationAvailable).toBe(false);
  });
  it("does not expose keys or a configured model to kiosk context", async () => {
    prepare();
    vi.stubEnv("EXPLANATION_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-private-test-with-enough-characters");
    const response = await handle(request("context", {}, "GET"), ["context"]);
    const body = await response.json();
    expect(body.explanationAvailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-private");
    expect(JSON.stringify(body)).not.toContain("gpt-");
  });
  it("requires configured availability before accepting optional external consent", async () => {
    prepare();
    const route = `kiosk/sessions/${sessionId}/consent`;
    const response = await handle(
      request(route, { accepted: true, explanationAccepted: true }),
      route.split("/"),
    );
    expect(response.status).toBe(409);
    expect(harness.consent).not.toHaveBeenCalled();
    expect(harness.explanationConsent).not.toHaveBeenCalled();
  });
  it("records the optional notice separately without changing the main privacy version", async () => {
    prepare();
    vi.stubEnv("EXPLANATION_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-private-test-with-enough-characters");
    const route = `kiosk/sessions/${sessionId}/consent`;
    const response = await handle(
      request(route, { accepted: true, explanationAccepted: true }),
      route.split("/"),
    );
    expect(response.status).toBe(200);
    expect(harness.consent).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      true,
      "2026-10-mvp",
    );
    expect(harness.explanationConsent).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      true,
      "2026-10-openai-explanation-v1",
    );
  });
  it("rejects client-provided products and fails closed without optional consent", async () => {
    prepare();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const route = `kiosk/sessions/${sessionId}/explanation`;
    const extra = await handle(
      request(route, { products: ["attacker"] }),
      route.split("/"),
    );
    expect(extra.status).toBe(422);
    const noConsent = await handle(request(route), route.split("/"));
    expect(noConsent.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.claimExplanation).not.toHaveBeenCalled();
  });
  it("rejects cross-origin explanation requests before session reads", async () => {
    prepare();
    const route = `kiosk/sessions/${sessionId}/explanation`;
    const req = new Request(`http://localhost/api/v1/${route}`, {
      method: "POST",
      headers: {
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect((await handle(req, route.split("/"))).status).toBe(403);
    expect(harness.session).not.toHaveBeenCalled();
  });
});

describe("OpenAI photo consent HTTP boundary", () => {
  let sequence = 0;
  const segments = ["kiosk", "sessions", sessionId, "analysis"];
  function prepare(
    visionAccepted: boolean | null = true,
    noticeVersion = VISION_NOTICE_VERSION,
  ) {
    vi.stubEnv("ANALYSIS_PROVIDER", "openai");
    vi.stubEnv("ANALYSIS_SERVICE_URL", "http://127.0.0.1:8000");
    vi.stubEnv(
      "ANALYSIS_API_KEY",
      "private-test-key-with-at-least-32-characters",
    );
    harness.ensureDevice.mockReturnValue({
      ...device,
      deviceId: `openai-http-${++sequence}`,
    });
    harness.session.mockResolvedValue({
      id: sessionId,
      consent: true,
      consentVersion: OPENAI_CONSENT_VERSION,
      answers: {
        skinType: "dry",
        concerns: ["dehydration"],
        sensitive: false,
        excludedIngredients: [],
      },
      analysis: null,
      recommendations: null,
      visionConsent:
        visionAccepted === null
          ? null
          : { accepted: visionAccepted, noticeVersion },
    });
  }
  function photo(origin = "http://localhost") {
    return new Request(`http://localhost/api/v1/${segments.join("/")}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
  }
  it("uses the direct photo endpoint after a claim and reuses its saved result without another API call", async () => {
    prepare();
    vi.stubEnv("EXPLANATION_PROVIDER", "unsupported-private-setting");
    const session = await harness.session();
    const analysis = {
      request_id: sessionId,
      mode: "openai",
      model_version: OPENAI_SKIN_MODEL,
      quality_status: "usable",
      observations: [],
      disclaimer: OPENAI_SKIN_DISCLAIMER,
      vision: {
        prompt_version: OPENAI_SKIN_PROMPT_VERSION,
        image_quality: "usable",
        quality_flags: [],
        observed_features: {
          visible_redness: "not_visible",
          visible_spots: "not_visible",
          visible_pores: "visible",
          visible_fine_lines: "uncertain",
          visible_flaking: "not_visible",
        },
      },
    };
    harness.session.mockImplementation(async () => structuredClone(session));
    harness.saveAnalysis.mockImplementation(async (_id, _device, value) => {
      session.analysis = value;
    });
    harness.saveRecommendations.mockImplementation(
      async (_id, _device, _policy, values) => {
        session.recommendations = values;
      },
    );
    harness.policy.mockResolvedValue({
      id: "reviewed-policy",
      version: "1",
      rules: [],
    });
    harness.products.mockResolvedValue([]);
    const fetch = vi.fn().mockResolvedValue(Response.json(analysis));
    vi.stubGlobal("fetch", fetch);
    const response = await handle(photo(), segments);
    expect(response.status).toBe(200);
    expect((await response.json()).analysis).toEqual(analysis);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8000/v1/analyze/openai",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      request_id: sessionId,
      image_base64: "AQID",
    });
    expect(
      harness.claimVisionAnalysis.mock.invocationCallOrder[0],
    ).toBeLessThan(fetch.mock.invocationCallOrder[0]);
    const route = segments.join("/");
    expect((await handle(request(route), segments)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(harness.claimVisionAnalysis).toHaveBeenCalledTimes(1);
    expect(harness.claimExplanation).not.toHaveBeenCalled();
  });
  it("disables separate explanation availability and requests in direct-photo mode", async () => {
    prepare();
    vi.stubEnv("EXPLANATION_PROVIDER", "unsupported-private-setting");
    const context = await handle(request("context", {}, "GET"), ["context"]);
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({
      analysisMode: "openai",
      explanationAvailable: false,
    });
    const route = `kiosk/sessions/${sessionId}/explanation`;
    const req = request(route);
    expect((await handle(req, route.split("/"))).status).toBe(409);
    expect(req.bodyUsed).toBe(false);
    expect(harness.claimExplanation).not.toHaveBeenCalled();
  });
  it.each([false, null])(
    "requires separate explicit photo consent before consuming image bytes (%s)",
    async (accepted) => {
      prepare(accepted);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const req = photo();
      const response = await handle(req, segments);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe(
        "vision_consent_required",
      );
      expect(req.bodyUsed).toBe(false);
      expect(harness.claimVisionAnalysis).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects stale optional and main consent before image reads", async () => {
    prepare(true, "2026-10-openai-explanation-v1");
    let req = photo();
    expect((await handle(req, segments)).status).toBe(409);
    expect(req.bodyUsed).toBe(false);
    prepare();
    harness.session.mockResolvedValue({
      consent: true,
      consentVersion: "2026-10-experimental-v1",
      answers: {
        skinType: "dry",
        concerns: ["texture"],
        sensitive: false,
        excludedIngredients: [],
      },
    });
    req = photo();
    expect((await handle(req, segments)).status).toBe(409);
    expect(req.bodyUsed).toBe(false);
  });
  it("records the photo notice separately and defaults omitted photo consent to false", async () => {
    prepare();
    const route = `kiosk/sessions/${sessionId}/consent`;
    const response = await handle(
      request(route, { accepted: true }),
      route.split("/"),
    );
    expect(response.status).toBe(200);
    expect(harness.consent).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      true,
      OPENAI_CONSENT_VERSION,
    );
    expect(harness.visionConsent).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      false,
      VISION_NOTICE_VERSION,
    );
    expect(harness.explanationConsent).not.toHaveBeenCalled();
    await handle(
      request(route, { accepted: true, visionAccepted: true }),
      route.split("/"),
    );
    expect(harness.visionConsent).toHaveBeenLastCalledWith(
      sessionId,
      expect.anything(),
      true,
      VISION_NOTICE_VERSION,
    );
  });
  it("rejects explanation opt-in or photo opt-in without main acceptance", async () => {
    prepare();
    const route = `kiosk/sessions/${sessionId}/consent`;
    expect(
      (
        await handle(
          request(route, { accepted: true, explanationAccepted: true }),
          route.split("/"),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handle(
          request(route, { accepted: false, visionAccepted: true }),
          route.split("/"),
        )
      ).status,
    ).toBe(409);
    expect(harness.consent).not.toHaveBeenCalled();
    expect(harness.visionConsent).not.toHaveBeenCalled();
  });
  it("keeps same-origin and pairing checks ahead of external photo consent or bytes", async () => {
    prepare();
    let req = photo("https://attacker.example");
    expect((await handle(req, segments)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    vi.stubEnv("APP_MODE", "supabase");
    req = photo();
    expect((await handle(req, segments)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(harness.claimVisionAnalysis).not.toHaveBeenCalled();
  });
});

describe("experimental kiosk image authorization", () => {
  let sequence = 0;
  function imageRequest(origin = "http://localhost") {
    harness.ensureDevice.mockReturnValue({
      ...device,
      deviceId: `image-test-${++sequence}`,
    });
    return new Request(
      `http://localhost/api/v1/kiosk/sessions/${sessionId}/analysis`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "image/png" },
        body: new Blob([new Uint8Array([1, 2, 3])]),
      },
    );
  }
  function experimental() {
    vi.stubEnv("ANALYSIS_PROVIDER", "experimental");
    vi.stubEnv("ANALYSIS_SERVICE_URL", "http://127.0.0.1:8000");
    vi.stubEnv(
      "ANALYSIS_API_KEY",
      "private-test-key-with-at-least-32-characters",
    );
  }
  const segments = ["kiosk", "sessions", sessionId, "analysis"];
  it("rejects cross-origin uploads before obtaining a device or reading a body", async () => {
    const req = imageRequest("https://attacker.example");
    expect((await handle(req, segments)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(harness.ensureDevice).not.toHaveBeenCalled();
  });
  it("requires paired device authority before reading the image", async () => {
    experimental();
    vi.stubEnv("APP_MODE", "supabase");
    const req = imageRequest();
    expect((await handle(req, segments)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });
  it("requires consent and answers before reading any image bytes", async () => {
    experimental();
    harness.session.mockResolvedValue({ consent: false, answers: null });
    const req = imageRequest();
    expect((await handle(req, segments)).status).toBe(409);
    expect(req.bodyUsed).toBe(false);
  });
  it("does not reuse an earlier mock privacy notice for experimental photo processing", async () => {
    experimental();
    harness.session.mockResolvedValue({
      consent: true,
      consentVersion: "2026-10-mvp",
      answers: {
        skinType: "dry",
        concerns: ["dehydration"],
        sensitive: false,
        excludedIngredients: [],
      },
    });
    const req = imageRequest();
    expect((await handle(req, segments)).status).toBe(409);
    expect(req.bodyUsed).toBe(false);
    expect(harness.saveAnalysis).not.toHaveBeenCalled();
  });
  it("rejects photo upload in mock mode without consuming the body", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "mock");
    const req = imageRequest();
    expect((await handle(req, segments)).status).toBe(415);
    expect(req.bodyUsed).toBe(false);
  });
  it("clears the device concurrency slot after a model failure and exposes no private details", async () => {
    experimental();
    const req = imageRequest();
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error("private-key-and-photo-detail"));
    vi.stubGlobal("fetch", fetch);
    const first = await handle(req, segments);
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain("private-key-and-photo-detail");
    const second = new Request(req.url, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "image/png" },
      body: "x",
    });
    expect((await handle(second, segments)).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(harness.saveAnalysis).not.toHaveBeenCalled();
  });
});

describe("owner signup HTTP boundaries", () => {
  let sequence = 0;
  function ownerRequest(path: string, body: unknown) {
    const value = request(path, body);
    value.headers.set("x-forwarded-for", `owner-test-${++sequence}`);
    return value;
  }
  it("shows safe email delivery guidance before sign in without returning credentials or reading account data", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    vi.stubEnv("AUTH_EMAIL_DELIVERY", "smtp");
    vi.stubEnv("SMTP_PASS", "private-mail-key-for-test");
    const response = await handle(request("auth/email-delivery", {}, "GET"), [
      "auth",
      "email-delivery",
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ mode: "smtp" });
    expect(harness.getStaffContext).not.toHaveBeenCalled();
    expect(harness.getOwnerAccount).not.toHaveBeenCalled();
    expect(harness.getDeviceContext).not.toHaveBeenCalled();
  });
  it("registers only valid email/password and returns a verification next step", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const response = await handle(
      ownerRequest("auth/signup", {
        email: " owner@example.test ",
        password: "a-long-private-password",
      }),
      ["auth", "signup"],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "verify_email" });
    expect(harness.signupOwner).toHaveBeenCalledWith(
      "owner@example.test",
      "a-long-private-password",
    );
    expect(harness.createOwnerWorkspace).not.toHaveBeenCalled();
  });
  it.each([
    ["signup", { email: "owner@example.test", password: "short" }],
    [
      "signup",
      {
        email: "owner@example.test",
        password: "a-long-private-password",
        role: "owner",
      },
    ],
    ["verify-email", { email: "owner@example.test", token: "not-a-code" }],
    [
      "workspace",
      {
        organizationName: "Company",
        storeName: "Store",
        organizationId: "forged-tenant",
      },
    ],
    [
      "workspace",
      {
        organizationName: "Company",
        storeName: "Store",
        userId: "someone-else",
      },
    ],
  ])(
    "rejects invalid or privilege-bearing %s payloads",
    async (action, body) => {
      vi.stubEnv("APP_MODE", "supabase");
      const response = await handle(ownerRequest(`auth/${action}`, body), [
        "auth",
        action as string,
      ]);
      expect(response.status).toBe(422);
      expect(harness.signupOwner).not.toHaveBeenCalled();
      expect(harness.verifyOwnerEmail).not.toHaveBeenCalled();
      expect(harness.createOwnerWorkspace).not.toHaveBeenCalled();
    },
  );
  it("keeps demo mode from pretending to create a real account", async () => {
    const response = await handle(
      ownerRequest("auth/signup", {
        email: "owner@example.test",
        password: "a-long-private-password",
      }),
      ["auth", "signup"],
    );
    expect(response.status).toBe(503);
    expect(harness.signupOwner).not.toHaveBeenCalled();
  });
  it("returns account state without granting staff or device permissions", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    harness.getOwnerAccount.mockResolvedValue({
      authenticated: true,
      needsWorkspace: true,
      staff: null,
    });
    const response = await handle(request("auth/account", undefined, "GET"), [
      "auth",
      "account",
    ]);
    expect(await response.json()).toEqual({
      authenticated: true,
      needsWorkspace: true,
      staff: null,
    });
    expect(harness.makeSupabaseRepository).not.toHaveBeenCalled();
  });
  it("uses only the two normalized names for explicit workspace setup", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const response = await handle(
      ownerRequest("auth/workspace", {
        organizationName: " My Company ",
        storeName: " First Store ",
      }),
      ["auth", "workspace"],
    );
    expect(response.status).toBe(200);
    expect(harness.createOwnerWorkspace).toHaveBeenCalledWith(
      "My Company",
      "First Store",
    );
  });
  it("uses same-origin protection before sending email or changing identity", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const value = ownerRequest("auth/resend-confirmation", {
      email: "owner@example.test",
    });
    value.headers.set("Origin", "https://untrusted.example");
    const response = await handle(value, ["auth", "resend-confirmation"]);
    expect(response.status).toBe(403);
    expect(harness.resendOwnerConfirmation).not.toHaveBeenCalled();
  });
  it("allows a confirmed account login to resume workspace setup", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const response = await handle(
      ownerRequest("auth/login", {
        email: "owner@example.test",
        password: "a-long-private-password",
      }),
      ["auth", "login"],
    );
    expect(await response.json()).toEqual({ ok: true, next: "setup" });
  });
});

describe("catalog submission feedback", () => {
  function product(patch: Record<string, unknown> = {}) {
    return {
      sku: "A",
      brand: "Retail Lab",
      name: "Heartleaf essence pad Clear touch",
      category: "serum",
      priceMinor: 2400,
      currency: "USD",
      stock: 10,
      visible: false,
      ingredients: ["Aqua", "1,2-Hexanediol", "Houttuynia Cordata Extract"],
      formulaComplete: false,
      suitableSkinTypes: [],
      ...patch,
    };
  }
  async function submit(body: unknown) {
    return handle(request("management/products", body), [
      "management",
      "products",
    ]);
  }
  it("saves a one-character SKU and preserves chemical ingredient commas", async () => {
    const body = product();
    const response = await submit(body);
    expect(response.status).toBe(201);
    expect(harness.saveDraft).toHaveBeenCalledExactlyOnceWith(storeId, body);
  });
  it("accepts all bounded ingredient names even when UTF-8 exceeds the general request limit", async () => {
    const ingredients = Array.from(
      { length: 100 },
      (_, index) => `${"花".repeat(118)}${index}`,
    );
    const response = await submit(product({ ingredients }));
    expect(response.status).toBe(201);
    expect(harness.saveDraft).toHaveBeenCalledExactlyOnceWith(
      storeId,
      expect.objectContaining({ ingredients }),
    );
  });
  it("still rejects oversized product requests before saving", async () => {
    const response = await submit(
      product({ ingredients: ["x".repeat(65_536)] }),
    );
    expect(response.status).toBe(413);
    expect(harness.saveDraft).not.toHaveBeenCalled();
  });
  it.each(["", "   ", undefined])(
    "assigns a server SKU to a new blank or omitted SKU (%s)",
    async (sku) => {
      const response = await submit(product({ sku }));
      expect(response.status).toBe(201);
      const saved = harness.saveDraft.mock.calls[0][1];
      expect(saved.sku).toMatch(/^SMV-[0-9a-f]{32}$/);
      expect(saved.formulaComplete).toBe(false);
      expect(saved.visible).toBe(false);
      expect(harness.publish).not.toHaveBeenCalled();
    },
  );
  it("rejects a blank SKU on an existing product without replacing its identity", async () => {
    const response = await submit(product({ id: sessionId, sku: "" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_product", fields: { sku: expect.any(String) } },
    });
    expect(harness.saveDraft).not.toHaveBeenCalled();
  });
  it.each([
    ["sku", "private invalid sku"],
    ["name", "N".repeat(161)],
    ["brand", "B".repeat(121)],
    ["ingredients", ["private ingredient ".repeat(10)]],
    ["priceMinor", 100_000_001],
    ["stock", 0.5],
  ])(
    "returns safe specific feedback for %s before saving",
    async (field, value) => {
      const response = await submit(product({ [field]: value }));
      expect(response.status).toBe(422);
      const result = await response.json();
      expect(result.error.fields[field]).toEqual(expect.any(String));
      expect(result.error.message).toBe(
        "Correct the highlighted product fields and try again.",
      );
      expect(JSON.stringify(result)).not.toContain("private");
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
      expect(harness.saveDraft).not.toHaveBeenCalled();
    },
  );
  it("does not echo injected fields or accept a client tenant", async () => {
    const response = await submit(
      product({ organizationId: "private-tenant-id" }),
    );
    expect(response.status).toBe(422);
    const result = await response.json();
    expect(result.error.fields).toEqual({});
    expect(JSON.stringify(result)).not.toContain("private-tenant-id");
    expect(JSON.stringify(result)).not.toContain("organizationId");
    expect(harness.saveDraft).not.toHaveBeenCalled();
  });
  it("keeps ordinary application failures separate from field validation", async () => {
    harness.saveDraft.mockRejectedValueOnce(
      new AppError(409, "sku_exists", "This SKU already exists."),
    );
    const response = await submit(product());
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).toMatchObject({
      error: { code: "sku_exists", message: "This SKU already exists." },
    });
    expect(result.error).not.toHaveProperty("fields");
  });
  it("requires an authenticated owner before handling product fields", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const response = await submit(product({ sku: "" }));
    expect(response.status).toBe(401);
    expect(harness.saveDraft).not.toHaveBeenCalled();
  });
});

describe("HTTP mutation security", () => {
  it.each([
    ["kiosk", "sessions"],
    ["kiosk", "sessions", sessionId, "analysis"],
    ["kiosk", "sessions", sessionId, "finish"],
    ["management", "products", sessionId, "publish"],
  ])(
    "rejects payloads on command-only endpoints without running the command",
    async (...segments) => {
      const response = await handle(
        request(segments.join("/"), {
          photo: "PRIVATE-PHOTO-DATA",
          organizationId: "fabricated",
        }),
        segments,
      );
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain("PRIVATE-PHOTO-DATA");
      expect(harness.start).not.toHaveBeenCalled();
      expect(harness.finish).not.toHaveBeenCalled();
      expect(harness.publish).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized ignored command bodies", async () => {
    const response = await handle(
      request("kiosk/sessions", { photo: "x".repeat(1025) }),
      ["kiosk", "sessions"],
    );
    expect(response.status).toBe(413);
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("rejects trailing paths rather than performing a partial route match", async () => {
    const segments = ["kiosk", "sessions", sessionId, "finish", "extra"];
    const response = await handle(request(segments.join("/")), segments);
    expect(response.status).toBe(404);
    expect(harness.finish).not.toHaveBeenCalled();
  });

  it("rejects cross-origin commands before device initialization", async () => {
    const malicious = new Request("http://localhost/api/v1/kiosk/sessions", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await handle(malicious, ["kiosk", "sessions"]);
    expect(response.status).toBe(403);
    expect(harness.ensureDevice).not.toHaveBeenCalled();
  });

  it("accepts a valid empty command and marks its response private", async () => {
    const response = await handle(request("kiosk/sessions"), [
      "kiosk",
      "sessions",
    ]);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("persistent authentication remains fail-closed", () => {
  it("returns no device for an unpaired browser without bootstrapping a demo identity", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const response = await handle(request("context", undefined, "GET"), [
      "context",
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "supabase",
      staff: null,
      device: null,
    });
    expect(harness.ensureDevice).not.toHaveBeenCalled();
  });

  it("blocks consultation creation without a paired device", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    const response = await handle(request("kiosk/sessions"), [
      "kiosk",
      "sessions",
    ]);
    expect(response.status).toBe(401);
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("does not treat authentication service failure as demo access", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    harness.getDeviceContext.mockRejectedValue(
      new AppError(
        503,
        "authentication_unavailable",
        "Authentication is temporarily unavailable.",
      ),
    );
    const response = await handle(request("context", undefined, "GET"), [
      "context",
    ]);
    expect(response.status).toBe(503);
    expect(harness.ensureDevice).not.toHaveBeenCalled();
  });

  it("lets viewers see aggregates without querying products or devices", async () => {
    vi.stubEnv("APP_MODE", "supabase");
    harness.getStaffContext.mockResolvedValue({
      organizationId: device.organizationId,
      organizationName: "Test Retail",
      role: "viewer",
      stores: [
        { id: storeId, name: "Test Store", currency: "USD", location: "" },
      ],
    });
    const response = await handle(
      request("management/overview", undefined, "GET"),
      ["management", "overview"],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      products: [],
      devices: [],
      metrics: { started: 2 },
    });
    expect(harness.products).not.toHaveBeenCalled();
    expect(harness.devices).not.toHaveBeenCalled();
  });
});
