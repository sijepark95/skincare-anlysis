import { describe, expect, it, vi } from "vitest";
import { BeautyCompleteConsultations } from "@/application/beauty-complete";
import {
  COMPLETE_PHOTO_NOTICE_VERSION,
  COMPLETE_PREVIEW_NOTICE_VERSION,
} from "@/application/beauty-complete-contracts";
import {
  OPENAI_CONSENT_VERSION,
  OPENAI_SKIN_PROMPT_VERSION,
  VISION_FEATURES,
} from "@/domain/skin-vision";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PHOTO_NOTICE_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
} from "@/domain/beauty-analysis";
import { COLOR_PHOTO_NOTICE_VERSION } from "@/domain/color-analysis";
import {
  BEAUTY_COMPLETE_PROMPT_VERSION,
  BEAUTY_PREVIEW_MODEL_VERSION,
  BEAUTY_PREVIEW_PROMPT_VERSION,
  type BeautyCompleteAnalysis,
  type BeautyPreviewResult,
} from "@/domain/beauty-complete";
import { faceShapes, type BeautyPreferences } from "@/domain/beauty";
import {
  stylingDirections,
  type StylingDirection,
} from "@/domain/beauty-styling";
import type { BaseChoice } from "@/domain/cosmetic-shades";
import type { Product } from "@/domain/types";
import { DemoRepository } from "@/infrastructure/demo-repository";
import {
  DemoBeautyCompleteRepository,
  demoBeautyCompleteRepository,
} from "@/infrastructure/demo-beauty-complete";

const preferences: BeautyPreferences = {
  paletteId: "cool_soft",
  faceShape: "round",
  hairLength: "any",
  mood: "fresh",
  finish: "any",
};
const base: BaseChoice = {
  depth: "medium",
  undertone: "cool",
  concealerPurpose: "match",
};
function result(id: string): BeautyCompleteAnalysis {
  return {
    request_id: id,
    mode: "openai_beauty_complete",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_COMPLETE_PROMPT_VERSION,
    beauty: {
      request_id: id,
      mode: "openai_beauty",
      model_version: BEAUTY_MODEL_VERSION,
      prompt_version: BEAUTY_PROMPT_VERSION_V2,
      image_quality: "usable",
      quality_flags: [],
      undertone: "cool",
      chroma: "soft",
      face_shape: "round",
      eye_shape: "round",
      nose_shape: "medium",
      lip_fullness: "full",
    },
    skin: {
      prompt_version: OPENAI_SKIN_PROMPT_VERSION,
      image_quality: "usable",
      quality_flags: [],
      observed_features: {
        ...Object.fromEntries(
          VISION_FEATURES.map((key) => [key, "not_visible"]),
        ),
        visible_pores: "visible",
      } as BeautyCompleteAnalysis["skin"]["observed_features"],
    },
    animalVibe: "dog",
    baseDepth: "medium",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function setup(now = () => Date.now(), teenPhotoEnabled = false) {
  const repository = new DemoRepository(false, now);
  const complete = new DemoBeautyCompleteRepository(repository, now);
  const device = repository.ensureDevice("complete-test");
  const session = await repository.start(device);
  await repository.consent(session.id, device, true, OPENAI_CONSENT_VERSION);
  const analyze = vi.fn(async (id: string) => result(id));
  const generate = vi.fn(
    async (
      id: string,
      image: Uint8Array,
      paletteId: BeautyPreferences["paletteId"],
      kind: BeautyPreviewResult["kind"],
      index: BeautyPreviewResult["index"],
      faceShape: BeautyPreferences["faceShape"],
      stylingDirection: StylingDirection,
    ) => {
      expect(faceShapes).toContain(faceShape);
      expect(stylingDirections).toContain(stylingDirection);
      return {
        request_id: id,
        kind,
        index,
        mime_type: "image/jpeg" as const,
        image_base64: Buffer.from([
          255,
          216,
          255,
          224,
          index,
          255,
          217,
        ]).toString("base64"),
        model_version: BEAUTY_PREVIEW_MODEL_VERSION,
        prompt_version: BEAUTY_PREVIEW_PROMPT_VERSION,
      };
    },
  );
  const app = new BeautyCompleteConsultations(
    repository,
    complete,
    { analyze },
    { generate },
    { sharingAvailable: false, teenPhotoEnabled },
  );
  await app.context(session.id, device, {
    ageBand: "25-34",
    locale: "ko",
    analyticsConsent: false,
  });
  return {
    app,
    repository,
    complete,
    device,
    id: session.id,
    analyze,
    generate,
  };
}
async function ready(f: Awaited<ReturnType<typeof setup>>) {
  await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
  const view = await f.app.analyze(f.id, f.device, new Uint8Array([1, 2]));
  await f.app.confirm(f.id, f.device, preferences, base);
  await f.app.previewConsent(
    f.id,
    f.device,
    true,
    COMPLETE_PREVIEW_NOTICE_VERSION,
  );
  return view;
}

describe("integrated demo consultation lifecycle and deterministic recommendations", () => {
  it("connects usable pores to skincare with no invented questionnaire, excludes cosmetic and foreign products", async () => {
    const f = await setup();
    const product: Product = {
      id: "serum",
      organizationId: f.device.organizationId,
      storeId: f.device.storeId,
      sku: "PORES",
      brand: "Store",
      name: "Texture serum",
      category: "serum",
      priceMinor: 1500,
      currency: "USD",
      stock: 2,
      visible: true,
      status: "published",
      formulaComplete: true,
      ingredients: ["Aqua", "Niacinamide"],
      suitableSkinTypes: [],
    };
    vi.spyOn(f.repository, "products").mockResolvedValue([
      product,
      { ...product, id: "makeup", category: "lip_color", sku: "LIP" },
      { ...product, id: "foreign", organizationId: "foreign" },
      { ...product, id: "other-store", storeId: "other-store" },
    ]);
    await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
    const view = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    expect(view.skinProfile).toEqual({
      skinType: "unsure",
      concerns: [],
      excludedIngredients: [],
    });
    expect((await f.repository.session(f.id, f.device)).answers).toBeNull();
    expect(view.skinRecommendations.map((item) => item.product.id)).toEqual([
      "serum",
    ]);
    expect(view.skinRecommendations[0].reasons).toContainEqual({
      concern: "texture",
      ingredient: "Niacinamide",
      relevance: 2,
    });
    expect(view.beauty.preferences).toBeNull();
    expect(view.analysis?.animalVibe).toBe("dog");
    expect(
      JSON.stringify(await f.complete.readComplete(f.id, f.device)),
    ).not.toContain("animalVibe");
    await f.app.skin(f.id, f.device, {
      skinType: "unsure",
      concerns: [],
      excludedIngredients: ["Niacinamide"],
    });
    expect((await f.app.read(f.id, f.device)).skinRecommendations).toEqual([]);
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });
  it("manual choices and locale changes make no provider calls", async () => {
    const f = await setup();
    const view = await f.app.confirm(f.id, f.device, preferences, {
      depth: "unknown",
      undertone: "unknown",
      concealerPurpose: "match",
    });
    expect(view.beauty.guide).not.toBeNull();
    await f.app.context(f.id, f.device, {
      ageBand: "25-34",
      locale: "es",
      analyticsConsent: true,
    });
    expect((await f.app.read(f.id, f.device)).beauty.preferences).toEqual(
      preferences,
    );
    expect(f.analyze).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    await expect(
      f.app.save(f.id, f.device, "a".repeat(64), "2026-10-complete-save-v1"),
    ).rejects.toMatchObject({ code: "sharing_unavailable" });
  });
  it("age gates under13 and teen photos while keeping teen analytics disabled", async () => {
    const f = await setup();
    await f.app.context(f.id, f.device, {
      ageBand: "under13",
      locale: "en",
      analyticsConsent: true,
    });
    await expect(
      f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "photo_unavailable" });
    await f.app.context(f.id, f.device, {
      ageBand: "16-17",
      locale: "en",
      analyticsConsent: true,
    });
    expect((await f.app.read(f.id, f.device)).context?.analyticsConsent).toBe(
      false,
    );
    await expect(
      f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "photo_unavailable" });
    expect(f.analyze).not.toHaveBeenCalled();
  });
  it("rejects a different paired device and tenant", async () => {
    const f = await setup();
    const other = f.repository.ensureDevice("other-device");
    await expect(f.app.read(f.id, other)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      f.app.read(f.id, { ...f.device, organizationId: "other-org" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.analyze).not.toHaveBeenCalled();
  });
  it("one analysis attempt remains spent and revoked in-flight results are rejected", async () => {
    const f = await setup();
    const delayed = deferred<BeautyCompleteAnalysis>();
    f.analyze.mockImplementationOnce(() => delayed.promise);
    await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
    const work = f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await vi.waitFor(() => expect(f.analyze).toHaveBeenCalledTimes(1));
    const requestId = f.analyze.mock.calls[0][0];
    await f.app.consent(f.id, f.device, false, COMPLETE_PHOTO_NOTICE_VERSION);
    delayed.resolve(result(requestId));
    await expect(work).rejects.toMatchObject({ code: "complete_write_failed" });
    await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "complete_photo_unavailable" });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });
  it("rechecks photo permission after the durable claim before calling the provider", async () => {
    const f = await setup();
    await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
    const claim = f.complete.claimCompleteAnalysis.bind(f.complete);
    vi.spyOn(f.complete, "claimCompleteAnalysis").mockImplementationOnce(
      async (...args) => {
        const requestId = await claim(...args);
        await f.complete.completePhotoConsent(
          f.id,
          f.device,
          false,
          COMPLETE_PHOTO_NOTICE_VERSION,
        );
        return requestId;
      },
    );
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "complete_photo_unavailable" });
    expect(f.analyze).not.toHaveBeenCalled();
    expect((await f.complete.readComplete(f.id, f.device)).attempted).toBe(
      true,
    );
  });
  it("does not return transient observations after permission ends during recommendation persistence", async () => {
    const f = await setup();
    await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
    const save = f.complete.saveCompleteRecommendations.bind(f.complete);
    vi.spyOn(f.complete, "saveCompleteRecommendations").mockImplementationOnce(
      async (...args) => {
        await save(...args);
        await f.complete.completePhotoConsent(
          f.id,
          f.device,
          false,
          COMPLETE_PHOTO_NOTICE_VERSION,
        );
      },
    );
    const policy = vi.spyOn(f.repository, "policy");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "beauty_changed" });
    expect((await f.app.read(f.id, f.device)).analysis).toBeNull();
    expect(policy.mock.calls.every((call) => call[1] === f.id)).toBe(true);
  });
  it("accepts semantically identical database observations with reordered JSON keys", async () => {
    const f = await setup();
    await f.app.consent(f.id, f.device, true, COMPLETE_PHOTO_NOTICE_VERSION);
    const save = f.complete.saveCompleteAnalysis.bind(f.complete);
    vi.spyOn(f.complete, "saveCompleteAnalysis").mockImplementationOnce(
      async (id, device, requestId, beauty, skin) => {
        const reordered = Object.fromEntries(
          Object.entries(skin).reverse(),
        ) as typeof skin;
        reordered.observed_features = Object.fromEntries(
          Object.entries(skin.observed_features).reverse(),
        ) as typeof skin.observed_features;
        await save(id, device, requestId, beauty, reordered);
      },
    );
    const view = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    expect(view.analysis?.animalVibe).toBe("dog");
    expect(view.analysis?.skin.observed_features.visible_pores).toBe("visible");
  });
  it("guards every legacy photo claim after complete context and rejects reusing an old beauty source", async () => {
    const f = await setup();
    for (const claim of [
      f.repository.claimVisionAnalysis.bind(f.repository),
      f.repository.claimColorAnalysis.bind(f.repository),
      f.repository.claimBeautyAnalysis.bind(f.repository),
      f.repository.claimBeautyMakeup.bind(f.repository),
    ])
      await expect(claim(f.id, f.device)).rejects.toMatchObject({
        code: "complete_source_guard",
      });
    expect(demoBeautyCompleteRepository).toBeInstanceOf(
      DemoBeautyCompleteRepository,
    );
    const device = f.repository.ensureDevice("old-beauty");
    const old = await f.repository.start(device);
    await f.repository.consent(old.id, device, true, OPENAI_CONSENT_VERSION);
    await f.repository.beautyConsent(
      old.id,
      device,
      true,
      BEAUTY_PHOTO_NOTICE_VERSION,
    );
    await f.repository.claimBeautyAnalysis(old.id, device);
    await expect(
      f.complete.setGuestContext(old.id, device, {
        ageBand: "25-34",
        locale: "en",
        analyticsConsent: false,
      }),
    ).rejects.toMatchObject({ code: "fresh_session_required" });
    const colorDevice = f.repository.ensureDevice("old-color");
    const oldColor = await f.repository.start(colorDevice);
    await f.repository.consent(
      oldColor.id,
      colorDevice,
      true,
      OPENAI_CONSENT_VERSION,
    );
    await f.repository.colorConsent(
      oldColor.id,
      colorDevice,
      true,
      COLOR_PHOTO_NOTICE_VERSION,
    );
    await f.repository.answers(oldColor.id, colorDevice, {
      skinType: "normal",
      concerns: ["texture"],
      excludedIngredients: [],
      sensitive: false,
    });
    await f.repository.claimColorAnalysis(oldColor.id, colorDevice);
    await expect(
      f.complete.setGuestContext(oldColor.id, colorDevice, {
        ageBand: "25-34",
        locale: "en",
        analyticsConsent: false,
      }),
    ).rejects.toMatchObject({ code: "fresh_session_required" });
  });
});

describe("nine individual original-photo edits", () => {
  it.each(["balanced", "masculine", "feminine"] as const)(
    "passes %s only to the edit provider and never to session state or output",
    async (direction) => {
      const f = await setup();
      await ready(f);
      const image = new Uint8Array([1]);
      const output = await f.app.preview(f.id, f.device, 0, image, direction);
      expect(f.generate.mock.calls[0][1]).toBe(image);
      expect(f.generate.mock.calls[0][6]).toBe(direction);
      const state = JSON.stringify(
        await f.complete.readComplete(f.id, f.device),
      );
      expect(state).not.toContain("stylingDirection");
      expect(state).not.toContain(direction);
      expect(output).not.toHaveProperty("stylingDirection");
    },
  );
  it("defaults legacy preview callers to balanced and rejects arbitrary direction before claiming", async () => {
    const f = await setup();
    await ready(f);
    await expect(
      f.app.preview(
        f.id,
        f.device,
        0,
        new Uint8Array([1]),
        "male custom prompt" as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_styling_direction" });
    expect(
      (await f.complete.readComplete(f.id, f.device)).previewPlan,
    ).toBeNull();
    await f.app.preview(f.id, f.device, 0, new Uint8Array([1]));
    expect(f.generate.mock.calls[0][6]).toBe("balanced");
  });
  it("keeps an existing preview plan when identical confirmed choices are submitted again", async () => {
    const f = await setup();
    await ready(f);
    await f.app.preview(f.id, f.device, 0, new Uint8Array([1]));
    await f.app.confirm(f.id, f.device, preferences, base);
    await f.app.preview(f.id, f.device, 1, new Uint8Array([1]));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it("rejects preferences changed between the initial snapshot and plan creation before a paid edit", async () => {
    const f = await setup();
    await ready(f);
    const create = f.complete.createPreviewPlan.bind(f.complete);
    vi.spyOn(f.complete, "createPreviewPlan").mockImplementationOnce(
      async (...args) => {
        await f.complete.confirmCompletePreferences(f.id, f.device, {
          ...preferences,
          paletteId: "warm_soft",
        });
        return create(...args);
      },
    );
    await expect(
      f.app.preview(f.id, f.device, 0, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "preview_changed" });
    expect(f.generate).not.toHaveBeenCalled();
    expect((await f.app.read(f.id, f.device)).preview.slots[0].status).toBe(
      "failed",
    );
  });
  it("discards an edit if the plan is cancelled immediately after terminal completion", async () => {
    const f = await setup();
    await ready(f);
    const finish = f.complete.finishPreviewSlot.bind(f.complete);
    vi.spyOn(f.complete, "finishPreviewSlot").mockImplementationOnce(
      async (...args) => {
        await finish(...args);
        await f.complete.cancelPreviewPlan(f.id, f.device, args[2]);
      },
    );
    await expect(
      f.app.preview(f.id, f.device, 0, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "preview_changed" });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("runs makeup3/hair3/color3 once in sequence and continues after one honest failure", async () => {
    const f = await setup();
    await ready(f);
    const original = new Uint8Array([5, 6, 7]);
    for (let slot = 0; slot < 9; slot++) {
      if (slot === 4)
        f.generate.mockRejectedValueOnce(new Error("synthetic failure"));
      const work = f.app.preview(f.id, f.device, slot, original);
      if (slot === 4) await expect(work).rejects.toThrow("synthetic failure");
      else expect((await work).index).toBe(slot % 3);
    }
    expect(f.generate).toHaveBeenCalledTimes(9);
    expect(f.generate.mock.calls.map((call) => call[3])).toEqual([
      "makeup",
      "makeup",
      "makeup",
      "hair_style",
      "hair_style",
      "hair_style",
      "hair_color",
      "hair_color",
      "hair_color",
    ]);
    expect(f.generate.mock.calls.every((call) => call[1] === original)).toBe(
      true,
    );
    const slots = (await f.app.read(f.id, f.device)).preview.slots;
    expect(slots.filter((slot) => slot.status === "complete")).toHaveLength(8);
    expect(slots[4].status).toBe("failed");
    await expect(
      f.app.preview(f.id, f.device, 0, original),
    ).rejects.toMatchObject({ code: "preview_slot_unavailable" });
    expect(f.generate).toHaveBeenCalledTimes(9);
  });
  it("blocks out-of-order slots, duplicate concurrent claims and stale completion after cancel", async () => {
    const f = await setup();
    await ready(f);
    await expect(
      f.app.preview(f.id, f.device, 1, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "preview_slot_unavailable" });
    const delayed = deferred<BeautyPreviewResult>();
    f.generate.mockImplementationOnce(() => delayed.promise);
    const work = f.app.preview(f.id, f.device, 0, new Uint8Array([1]));
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    await expect(
      f.app.preview(f.id, f.device, 0, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "preview_slot_unavailable" });
    const id = f.generate.mock.calls[0][0];
    await f.app.cancelPreview(f.id, f.device);
    delayed.resolve({
      request_id: id,
      kind: "makeup",
      index: 0,
      mime_type: "image/jpeg",
      image_base64: "/9j/Af/Z",
      model_version: BEAUTY_PREVIEW_MODEL_VERSION,
      prompt_version: BEAUTY_PREVIEW_PROMPT_VERSION,
    });
    await expect(work).rejects.toMatchObject({ code: "preview_changed" });
    expect(
      (await f.app.read(f.id, f.device)).preview.slots.every(
        (slot) => slot.status === "cancelled",
      ),
    ).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("cancels remaining slots on changed direction and cannot start another paid plan", async () => {
    const f = await setup();
    await ready(f);
    await f.app.preview(f.id, f.device, 0, new Uint8Array([1]));
    await f.app.confirm(
      f.id,
      f.device,
      { ...preferences, paletteId: "warm_soft" },
      base,
    );
    await expect(
      f.app.preview(f.id, f.device, 1, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "preview_changed" });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("enforces twelve-minute overall deadline and session purge", async () => {
    let time = Date.UTC(2026, 9, 11, 10);
    const f = await setup(() => time);
    await ready(f);
    await f.app.preview(f.id, f.device, 0, new Uint8Array([1]));
    time += 12 * 60000 + 1;
    await expect(
      f.app.preview(f.id, f.device, 1, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "preview_changed" });
    time += 4 * 60000;
    await expect(f.app.read(f.id, f.device)).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("finishes immediately while generation runs, rejects the late image and counts completion once", async () => {
    const f = await setup();
    await ready(f);
    const delayed = deferred<BeautyPreviewResult>();
    f.generate.mockImplementationOnce(() => delayed.promise);
    const work = f.app.preview(f.id, f.device, 0, new Uint8Array([1]));
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    const requestId = f.generate.mock.calls[0][0];
    await f.app.finish(f.id, f.device, "woman");
    await f.app.finish(f.id, f.device, "woman");
    delayed.resolve({
      request_id: requestId,
      kind: "makeup",
      index: 0,
      mime_type: "image/jpeg",
      image_base64: "/9j/Af/Z",
      model_version: BEAUTY_PREVIEW_MODEL_VERSION,
      prompt_version: BEAUTY_PREVIEW_PROMPT_VERSION,
    });
    await expect(work).rejects.toMatchObject({ code: "session_not_found" });
    expect((await f.repository.metrics(f.device.storeId)).completed).toBe(1);
  });
});

describe("adult aggregate demographics", () => {
  it("keeps Gender outside individual state, excludes open weeks and suppresses small closed distributions", async () => {
    let time = Date.UTC(2026, 9, 11, 10);
    const f = await setup(() => time);
    await f.app.context(f.id, f.device, {
      ageBand: "25-34",
      locale: "en",
      analyticsConsent: true,
    });
    await f.app.confirm(f.id, f.device, preferences, base);
    expect(
      JSON.stringify(await f.complete.readComplete(f.id, f.device)),
    ).not.toContain("gender");
    await f.app.finish(f.id, f.device, "woman");
    expect((await f.complete.demographics(f.device.storeId)).age).toEqual({
      suppressed: false,
      counts: {},
    });
    time += 7 * 86400000;
    const closed = await f.complete.demographics(f.device.storeId);
    expect(closed.unit).toBe("completed_sessions");
    expect(closed.age).toEqual({ suppressed: true, counts: {} });
    expect(closed.gender).toEqual({ suppressed: true, counts: {} });
  });
});
