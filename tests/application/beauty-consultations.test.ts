import { describe, expect, it, vi } from "vitest";
import type { OpenAIAnalysis } from "@/application/contracts";
import {
  BEAUTY_SAVE_NOTICE_VERSION,
  BeautyConsultations,
} from "@/application/beauty-consultations";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PHOTO_NOTICE_VERSION,
  BEAUTY_PROMPT_VERSION,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import type { BeautyPreferences } from "@/domain/beauty";
import type { LipShade } from "@/domain/personal-color";
import type { Product } from "@/domain/types";
import {
  OPENAI_CONSENT_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
} from "@/domain/skin-vision";
import { DemoRepository } from "@/infrastructure/demo-repository";

const requestId = "fc7d2ac1-a4ab-4bda-8219-01bc88f58294";
const choice: BeautyPreferences = {
  paletteId: "cool_soft",
  faceShape: "round",
  hairLength: "medium",
  mood: "fresh",
  finish: "satin",
};
const tokenHash = "a".repeat(64);
function observation(id = requestId): BeautyAnalysis {
  return {
    request_id: id,
    mode: "openai_beauty",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_PROMPT_VERSION,
    image_quality: "usable",
    undertone: "warm",
    chroma: "clear",
    face_shape: "oval",
    quality_flags: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  options: {
    photoConsent?: boolean;
    provider?: boolean;
    mainNotice?: string;
    sharing?: boolean;
    now?: () => number;
  } = {},
) {
  const repository = new DemoRepository(false, options.now);
  const device = repository.ensureDevice("beauty-application");
  const session = await repository.start(device);
  await repository.consent(
    session.id,
    device,
    true,
    options.mainNotice ?? OPENAI_CONSENT_VERSION,
  );
  // Beauty is a primary experience: deliberately do not supply skin questionnaire answers.
  const analyze = vi.fn<
    (id: string, image: Uint8Array) => Promise<BeautyAnalysis>
  >(async (id) => observation(id));
  const app = new BeautyConsultations(
    repository,
    options.provider === false ? null : { analyze },
    () => requestId,
    options.sharing === true,
  );
  if (options.photoConsent !== false && options.provider !== false) {
    await app.consent(session.id, device, true, BEAUTY_PHOTO_NOTICE_VERSION);
  }
  return { repository, device, id: session.id, analyze, app };
}
async function registeredLip(f: Awaited<ReturnType<typeof setup>>) {
  const product: Product = {
    id: "registered-lip",
    organizationId: f.device.organizationId,
    storeId: f.device.storeId,
    sku: "REGISTERED-LIP",
    brand: "Test merchant",
    name: "Test lip",
    category: "lip_color",
    priceMinor: 1000,
    currency: "USD",
    stock: 1,
    visible: true,
    status: "published",
    formulaComplete: true,
    ingredients: ["Aqua", "Niacinamide"],
    suitableSkinTypes: [],
  };
  const shade: LipShade = {
    variantId: product.id,
    organizationId: product.organizationId,
    versionId: "reviewed-version",
    version: 1,
    shadeName: "Rose",
    hueFamily: "rose",
    undertone: "cool",
    intensity: "soft",
    finish: "satin",
    swatchHex: "#B87D93",
    reviewed: true,
  };
  vi.spyOn(f.repository, "products").mockResolvedValue([product]);
  vi.spyOn(f.repository, "lipShades").mockResolvedValue([shade]);
  return { product, shade };
}

describe("primary beauty consultation boundaries and lifecycle", () => {
  it("works without skin answers and never auto-confirms the photo's palette or outline", async () => {
    const f = await setup();
    await registeredLip(f);
    const before = await f.app.read(f.id, f.device);
    expect(before).toMatchObject({
      preferences: null,
      guide: null,
      recommendations: [],
    });
    const state = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    expect(state).toMatchObject({
      attempted: true,
      analysis: observation(),
      preferences: null,
      guide: null,
      recommendations: [],
    });
    expect((await f.repository.session(f.id, f.device)).answers).toBeNull();
    expect(f.analyze).toHaveBeenCalledExactlyOnceWith(
      requestId,
      new Uint8Array([1]),
    );
    expect(requestId).not.toBe(f.id);
    const confirmed = await f.app.confirm(f.id, f.device, choice);
    expect(confirmed.preferences).toEqual(choice);
    expect(confirmed.guide?.palette.id).toBe("cool_soft");
    expect(confirmed.guide?.confirmedFaceShape).toBe("round");
    expect(confirmed.recommendations).toHaveLength(1);
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("requires separate current photo consent before a claim or provider call", async () => {
    const f = await setup({ photoConsent: false });
    const claim = vi.spyOn(f.repository, "claimBeautyAnalysis");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "beauty_consent_required" });
    await expect(
      f.app.consent(f.id, f.device, true, "2026-10-personal-color-photo-v1"),
    ).rejects.toMatchObject({ code: "invalid_consent_version" });
    expect(claim).not.toHaveBeenCalled();
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("claims once for simultaneous requests across use-case instances", async () => {
    const f = await setup();
    const started = deferred<void>();
    const response = deferred<BeautyAnalysis>();
    f.analyze.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const second = new BeautyConsultations(
      f.repository,
      { analyze: f.analyze },
      () => requestId,
    );
    const all = Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? second : f.app).analyze(
          f.id,
          f.device,
          new Uint8Array([index + 1]),
        ),
      ),
    );
    await started.promise;
    response.resolve(observation());
    const results = await all;
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const failures = results.filter((item) => item.status === "rejected");
    expect(failures).toHaveLength(9);
    for (const failure of failures)
      expect(failure.reason).toMatchObject({
        code: "beauty_already_attempted",
      });
    await second.read(f.id, f.device);
    await expect(
      second.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "beauty_already_attempted" });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("preserves the durable attempt after provider failure and allows manual continuation", async () => {
    const f = await setup();
    f.analyze.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toThrow("synthetic provider failure");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "beauty_already_attempted" });
    expect(await f.app.confirm(f.id, f.device, choice)).toMatchObject({
      attempted: true,
      analysis: null,
      preferences: choice,
    });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("withdrawal and reaccept permanently reject an inflight response without another attempt", async () => {
    const f = await setup();
    const started = deferred<void>();
    const response = deferred<BeautyAnalysis>();
    f.analyze.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = f.app.analyze(f.id, f.device, new Uint8Array([1]));
    const rejected = expect(pending).rejects.toMatchObject({
      code: "beauty_write_failed",
    });
    await started.promise;
    await f.app.consent(f.id, f.device, false, BEAUTY_PHOTO_NOTICE_VERSION);
    await f.app.consent(f.id, f.device, true, BEAUTY_PHOTO_NOTICE_VERSION);
    response.resolve(observation());
    await rejected;
    expect(await f.app.read(f.id, f.device)).toMatchObject({
      consent: true,
      attempted: true,
      analysis: null,
      preferences: null,
    });
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "beauty_already_attempted" });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("withdrawal clears saved photo observations and confirmed preferences", async () => {
    const f = await setup();
    await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await f.app.confirm(f.id, f.device, choice);
    await f.app.consent(f.id, f.device, false, BEAUTY_PHOTO_NOTICE_VERSION);
    expect(await f.app.read(f.id, f.device)).toMatchObject({
      consent: false,
      attempted: true,
      analysis: null,
      preferences: null,
      guide: null,
    });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("finish prevents late save, subsequent read and guide sharing", async () => {
    const f = await setup({ sharing: true });
    const started = deferred<void>();
    const response = deferred<BeautyAnalysis>();
    const save = vi.spyOn(f.repository, "saveBeautyAnalysis");
    const share = vi.spyOn(f.repository, "createBeautyGuide");
    f.analyze.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = f.app.analyze(f.id, f.device, new Uint8Array([1]));
    const rejected = expect(pending).rejects.toMatchObject({
      code: "session_not_found",
    });
    await started.promise;
    await f.repository.finish(f.id, f.device);
    response.resolve(observation());
    await rejected;
    await expect(f.app.read(f.id, f.device)).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(
      f.app.save(f.id, f.device, tokenHash, true, BEAUTY_SAVE_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "session_not_found" });
    expect(save).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("rejects invalid response ownership after one durable attempt", async () => {
    const f = await setup();
    f.analyze.mockResolvedValueOnce(
      observation("277c5b4c-abf7-4faf-aef5-e1f3cd0f2fd2"),
    );
    const save = vi.spyOn(f.repository, "saveBeautyAnalysis");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "invalid_beauty_analysis" });
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "beauty_already_attempted" });
    expect(save).not.toHaveBeenCalled();
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it.each([new Uint8Array(), new Uint8Array(10 * 1024 * 1024 + 1)])(
    "rejects invalid image byte limits before a claim",
    async (image) => {
      const f = await setup();
      const claim = vi.spyOn(f.repository, "claimBeautyAnalysis");
      await expect(f.app.analyze(f.id, f.device, image)).rejects.toMatchObject({
        code: "invalid_image",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(f.analyze).not.toHaveBeenCalled();
    },
  );

  it("supports manual primary beauty and reads without photo opt-in or any provider", async () => {
    const f = await setup({ provider: false });
    const claim = vi.spyOn(f.repository, "claimBeautyAnalysis");
    const state = await f.app.confirm(f.id, f.device, choice);
    expect(state).toMatchObject({
      photoAvailable: false,
      attempted: false,
      analysis: null,
      preferences: choice,
    });
    expect(state.guide?.hairCuts).toHaveLength(1);
    await f.app.read(f.id, f.device);
    await expect(
      f.app.consent(f.id, f.device, true, BEAUTY_PHOTO_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "beauty_photo_disabled" });
    expect(claim).not.toHaveBeenCalled();
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("does not authorize external beauty from the old main privacy notice", async () => {
    const f = await setup({ photoConsent: false, mainNotice: "2026-10-mvp" });
    await expect(
      f.app.consent(f.id, f.device, true, BEAUTY_PHOTO_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "beauty_photo_disabled" });
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "beauty_photo_disabled" });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("matches only confirmed choices and canonical ingredient exclusions without new provider calls", async () => {
    const f = await setup({ photoConsent: false });
    await registeredLip(f);
    expect(
      (await f.app.confirm(f.id, f.device, choice)).recommendations,
    ).toHaveLength(1);
    const excluded = await f.app.exclusions(f.id, f.device, [
      "Vitamin B3",
      "Niacinamide",
    ]);
    expect(excluded.excludedIngredients).toEqual(["Niacinamide"]);
    expect(excluded.recommendations).toEqual([]);
    expect(
      (await f.app.exclusions(f.id, f.device, [])).recommendations,
    ).toHaveLength(1);
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it.each([
    { ingredients: ["Unregistered ingredient"] },
    { ingredients: Array.from({ length: 21 }, () => "Glycerin") },
  ])(
    "rejects unresolved or excessive exclusions before changing state",
    async ({ ingredients }) => {
      const f = await setup({ photoConsent: false });
      const write = vi.spyOn(f.repository, "beautyExclusions");
      await expect(
        f.app.exclusions(f.id, f.device, ingredients),
      ).rejects.toMatchObject({ code: "invalid_exclusions" });
      expect(write).not.toHaveBeenCalled();
      expect(f.analyze).not.toHaveBeenCalled();
    },
  );

  it("rejects stale results if exclusions change during catalog assembly", async () => {
    const f = await setup({ photoConsent: false });
    const { product } = await registeredLip(f);
    await f.repository.confirmBeautyPreferences(f.id, f.device, choice);
    const gate = deferred<Product[]>();
    const started = deferred<void>();
    vi.mocked(f.repository.products).mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const pending = f.app.read(f.id, f.device);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "beauty_changed",
    });
    await started.promise;
    await f.repository.beautyExclusions(f.id, f.device, ["Niacinamide"]);
    gate.resolve([product]);
    await rejected;
    expect((await f.app.read(f.id, f.device)).recommendations).toEqual([]);
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("blocks a foreign paired device from reading or analyzing this consultation", async () => {
    const f = await setup();
    const foreign = f.repository.ensureDevice("foreign-beauty-device");
    await expect(f.app.read(f.id, foreign)).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(
      f.app.analyze(f.id, foreign, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "session_not_found" });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("explains unavailable local phone sharing and performs no persistence or provider call", async () => {
    const f = await setup({ photoConsent: false });
    await f.app.confirm(f.id, f.device, choice);
    const share = vi.spyOn(f.repository, "createBeautyGuide");
    const state = await f.app.read(f.id, f.device);
    expect(state.sharingAvailable).toBe(false);
    expect(state.shareUnavailableReason).toContain("public HTTPS");
    await expect(
      f.app.save(f.id, f.device, tokenHash, true, BEAUTY_SAVE_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "sharing_unavailable" });
    expect(share).not.toHaveBeenCalled();
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it.each([
    { accepted: false, notice: BEAUTY_SAVE_NOTICE_VERSION, hash: tokenHash },
    { accepted: true, notice: BEAUTY_PHOTO_NOTICE_VERSION, hash: tokenHash },
    {
      accepted: true,
      notice: BEAUTY_SAVE_NOTICE_VERSION,
      hash: "not-a-token-hash",
    },
  ])(
    "requires current explicit save consent and a hashed token: %o",
    async ({ accepted, notice, hash }) => {
      const f = await setup({ photoConsent: false, sharing: true });
      await f.app.confirm(f.id, f.device, choice);
      const share = vi.spyOn(f.repository, "createBeautyGuide");
      await expect(
        f.app.save(f.id, f.device, hash, accepted, notice),
      ).rejects.toMatchObject({ code: "save_consent_required" });
      expect(share).not.toHaveBeenCalled();
      expect(f.analyze).not.toHaveBeenCalled();
    },
  );

  it("requires confirmed preferences for saving even when sharing consent was accepted", async () => {
    const f = await setup({ photoConsent: false, sharing: true });
    const share = vi.spyOn(f.repository, "createBeautyGuide");
    await expect(
      f.app.save(f.id, f.device, tokenHash, true, BEAUTY_SAVE_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(share).not.toHaveBeenCalled();
  });

  it("creates a separately consented guide without another photo or provider request", async () => {
    const f = await setup({ photoConsent: false, sharing: true });
    await f.app.confirm(f.id, f.device, choice);
    const expiry = { expiresAt: "2026-10-18T00:00:00Z" };
    const share = vi
      .spyOn(f.repository, "createBeautyGuide")
      .mockResolvedValueOnce(expiry);
    expect(
      await f.app.save(
        f.id,
        f.device,
        tokenHash,
        true,
        BEAUTY_SAVE_NOTICE_VERSION,
      ),
    ).toEqual(expiry);
    expect(share).toHaveBeenCalledExactlyOnceWith(
      f.id,
      f.device,
      tokenHash,
      BEAUTY_SAVE_NOTICE_VERSION,
    );
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("counts a manually confirmed beauty completion exactly once without an analysis", async () => {
    const f = await setup({ provider: false });
    await f.app.confirm(f.id, f.device, choice);
    expect(await f.repository.metrics(f.device.storeId)).toEqual({
      started: 1,
      analyzed: 0,
      completed: 0,
    });
    await f.repository.finish(f.id, f.device);
    await f.repository.finish(f.id, f.device);
    expect(await f.repository.metrics(f.device.storeId)).toEqual({
      started: 1,
      analyzed: 0,
      completed: 1,
    });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("counts a saved photo attempt once but does not complete an unconfirmed beauty guide", async () => {
    const f = await setup();
    await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await f.app.read(f.id, f.device);
    await f.app.read(f.id, f.device);
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "beauty_already_attempted" });
    await f.repository.finish(f.id, f.device);
    expect(await f.repository.metrics(f.device.storeId)).toEqual({
      started: 1,
      analyzed: 1,
      completed: 0,
    });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("does not double-count analysis or completion when beauty and photo-free skin share a session", async () => {
    const f = await setup();
    await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await f.app.confirm(f.id, f.device, choice);
    await f.repository.answers(f.id, f.device, {
      skinType: "normal",
      concerns: ["texture"],
      sensitive: false,
      excludedIngredients: [],
    });
    const skinResult: OpenAIAnalysis = {
      request_id: f.id,
      mode: "openai" as const,
      model_version: OPENAI_SKIN_MODEL,
      quality_status: "not_provided" as const,
      observations: [],
      disclaimer: OPENAI_SKIN_DISCLAIMER,
      vision: null,
    };
    await f.repository.saveAnalysis(f.id, f.device, skinResult);
    await f.repository.saveAnalysis(f.id, f.device, skinResult);
    expect(await f.repository.metrics(f.device.storeId)).toEqual({
      started: 1,
      analyzed: 1,
      completed: 0,
    });
    await f.repository.finish(f.id, f.device);
    await f.repository.finish(f.id, f.device);
    expect(await f.repository.metrics(f.device.storeId)).toEqual({
      started: 1,
      analyzed: 1,
      completed: 1,
    });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("withdrawn beauty confirmation does not count as a completion", async () => {
    const f = await setup();
    await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await f.app.confirm(f.id, f.device, choice);
    await f.app.consent(f.id, f.device, false, BEAUTY_PHOTO_NOTICE_VERSION);
    await f.repository.finish(f.id, f.device);
    expect(await f.repository.metrics(f.device.storeId)).toEqual({
      started: 1,
      analyzed: 1,
      completed: 0,
    });
  });

  it.each(["expiry", "revocation"])(
    "purges confirmed beauty without completion during %s",
    async (operation) => {
      let now = Date.parse("2026-10-11T00:00:00Z");
      const f = await setup({ provider: false, now: () => now });
      await f.app.confirm(f.id, f.device, choice);
      if (operation === "expiry") {
        now += 15 * 60_000;
        await expect(f.app.read(f.id, f.device)).rejects.toMatchObject({
          code: "session_not_found",
        });
      } else {
        await f.repository.revokeDevice(f.device.deviceId);
        await expect(f.app.read(f.id, f.device)).rejects.toMatchObject({
          code: "device_revoked",
        });
      }
      expect(await f.repository.metrics(f.device.storeId)).toEqual({
        started: 1,
        analyzed: 0,
        completed: 0,
      });
      expect(f.analyze).not.toHaveBeenCalled();
    },
  );
});
