import { describe, expect, it, vi } from "vitest";
import { PersonalColors } from "@/application/personal-color";
import type { Answers } from "@/application/contracts";
import {
  COLOR_MODEL_VERSION,
  COLOR_PHOTO_NOTICE_VERSION,
  COLOR_PROMPT_VERSION,
  type ColorAnalysis,
} from "@/domain/color-analysis";
import type { ColorPreferences, LipShade } from "@/domain/personal-color";
import type { Product } from "@/domain/types";
import { OPENAI_CONSENT_VERSION } from "@/domain/skin-vision";
import { DemoRepository } from "@/infrastructure/demo-repository";

const requestId = "8d86a622-76bd-4b9e-bd85-2bc26cab45c6";
const answers: Answers = {
  skinType: "normal",
  concerns: ["texture"],
  sensitive: false,
  excludedIngredients: [],
};
const choice: ColorPreferences = { paletteId: "cool_soft", finish: "satin" };
function observation(id = requestId): ColorAnalysis {
  return {
    request_id: id,
    mode: "openai_color",
    model_version: COLOR_MODEL_VERSION,
    prompt_version: COLOR_PROMPT_VERSION,
    image_quality: "usable",
    undertone: "warm",
    chroma: "clear",
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
    consent?: boolean;
    provider?: boolean;
    mainNotice?: string;
    completeAnswers?: boolean;
  } = {},
) {
  const repository = new DemoRepository(false);
  const device = repository.ensureDevice("color-application");
  const session = await repository.start(device);
  await repository.consent(
    session.id,
    device,
    true,
    options.mainNotice ?? OPENAI_CONSENT_VERSION,
  );
  if (options.completeAnswers !== false)
    await repository.answers(session.id, device, answers);
  const analyze = vi.fn<
    (id: string, image: Uint8Array) => Promise<ColorAnalysis>
  >(async (id) => observation(id));
  const app = new PersonalColors(
    repository,
    options.provider === false ? null : { analyze },
    () => requestId,
  );
  if (
    options.consent !== false &&
    options.provider !== false &&
    options.completeAnswers !== false
  ) {
    await app.consent(session.id, device, true, COLOR_PHOTO_NOTICE_VERSION);
  }
  return { repository, device, id: session.id, app, analyze };
}

describe("independent personal-colour application lifecycle", () => {
  it("requires the separate current unticked consent before claiming or calling", async () => {
    const f = await setup({ consent: false });
    const claim = vi.spyOn(f.repository, "claimColorAnalysis");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "color_consent_required" });
    await expect(
      f.app.consent(f.id, f.device, true, "2026-10-openai-color-v1"),
    ).rejects.toMatchObject({ code: "invalid_consent_version" });
    expect(claim).not.toHaveBeenCalled();
    expect(f.analyze).not.toHaveBeenCalled();
    expect(await f.app.read(f.id, f.device)).toMatchObject({
      consent: false,
      attempted: false,
      analysis: null,
      preferences: null,
    });
  });

  it("claims once across simultaneous requests and separate use-case instances", async () => {
    const f = await setup();
    const response = deferred<ColorAnalysis>();
    const started = deferred<void>();
    f.analyze.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const secondApp = new PersonalColors(
      f.repository,
      { analyze: f.analyze },
      () => requestId,
    );
    const pending = Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? secondApp : f.app).analyze(
        f.id,
        f.device,
        new Uint8Array([index + 1]),
      ),
    );
    const settled = Promise.allSettled(pending);
    await started.promise;
    response.resolve(observation());
    const results = await settled;
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(11);
    for (const failure of failures)
      expect(failure.reason).toMatchObject({ code: "color_already_attempted" });
    expect(f.analyze).toHaveBeenCalledTimes(1);
    expect(f.analyze).toHaveBeenCalledWith(requestId, expect.any(Uint8Array));
    expect(await secondApp.read(f.id, f.device)).toMatchObject({
      attempted: true,
      analysis: observation(),
      preferences: null,
      recommendations: [],
    });
    await expect(
      secondApp.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "color_already_attempted" });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("keeps the attempt after provider failure and supports manual continuation without another call", async () => {
    const f = await setup();
    f.analyze.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toThrow("synthetic provider failure");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "color_already_attempted" });
    const state = await f.app.confirm(f.id, f.device, choice);
    expect(state).toMatchObject({
      attempted: true,
      analysis: null,
      preferences: choice,
    });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("does not automatically confirm the photo suggestion and preserves the guest's arbitrary choice", async () => {
    const f = await setup();
    await f.app.confirm(f.id, f.device, choice);
    const state = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    expect(state.analysis?.undertone).toBe("warm");
    expect(state.preferences).toEqual(choice);
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("withdrawal and reaccept permanently invalidate an inflight response and do not reset its claim", async () => {
    const f = await setup();
    const response = deferred<ColorAnalysis>();
    const started = deferred<void>();
    f.analyze.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = f.app.analyze(f.id, f.device, new Uint8Array([1]));
    const rejected = expect(pending).rejects.toMatchObject({
      code: "color_write_failed",
    });
    await started.promise;
    await f.app.consent(f.id, f.device, false, COLOR_PHOTO_NOTICE_VERSION);
    await f.app.consent(f.id, f.device, true, COLOR_PHOTO_NOTICE_VERSION);
    response.resolve(observation());
    await rejected;
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "color_already_attempted" });
    expect(await f.app.read(f.id, f.device)).toMatchObject({
      consent: true,
      attempted: true,
      analysis: null,
      preferences: null,
    });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("withdrawal removes saved observations and preferences without authorizing another attempt", async () => {
    const f = await setup();
    await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await f.app.confirm(f.id, f.device, choice);
    await f.app.consent(f.id, f.device, false, COLOR_PHOTO_NOTICE_VERSION);
    expect(await f.app.read(f.id, f.device)).toMatchObject({
      consent: false,
      attempted: true,
      analysis: null,
      preferences: null,
    });
    await f.app.consent(f.id, f.device, true, COLOR_PHOTO_NOTICE_VERSION);
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "color_already_attempted" });
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it("finish purges the session and prevents late response save or subsequent read", async () => {
    const f = await setup();
    const response = deferred<ColorAnalysis>();
    const started = deferred<void>();
    f.analyze.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const save = vi.spyOn(f.repository, "saveColorAnalysis");
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
      f.repository.colorSession(f.id, f.device),
    ).rejects.toMatchObject({ code: "session_not_found" });
    expect(save).not.toHaveBeenCalled();
    expect(f.analyze).toHaveBeenCalledTimes(1);
  });

  it.each(["mismatched-id", "unsupported-protocol"])(
    "rejects %s output after one durable attempt",
    async (kind) => {
      const f = await setup();
      f.analyze.mockResolvedValueOnce(
        kind === "mismatched-id"
          ? observation("334eeaec-5a19-461c-a2cc-f66acef5098e")
          : ({
              ...observation(),
              prompt_version: "invalid",
            } as unknown as ColorAnalysis),
      );
      const save = vi.spyOn(f.repository, "saveColorAnalysis");
      await expect(
        f.app.analyze(f.id, f.device, new Uint8Array([1])),
      ).rejects.toMatchObject({ code: "invalid_color_analysis" });
      await expect(
        f.app.analyze(f.id, f.device, new Uint8Array([1])),
      ).rejects.toMatchObject({ code: "color_already_attempted" });
      expect(save).not.toHaveBeenCalled();
      expect(f.analyze).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new Uint8Array(), new Uint8Array(10 * 1024 * 1024 + 1)])(
    "rejects invalid image length before claim or provider",
    async (image) => {
      const f = await setup();
      const claim = vi.spyOn(f.repository, "claimColorAnalysis");
      await expect(f.app.analyze(f.id, f.device, image)).rejects.toMatchObject({
        code: "invalid_image",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(f.analyze).not.toHaveBeenCalled();
    },
  );

  it("read and manual confirmation need no photo consent, claim or provider", async () => {
    const f = await setup({ consent: false });
    const claim = vi.spyOn(f.repository, "claimColorAnalysis");
    await f.app.read(f.id, f.device);
    const state = await f.app.confirm(f.id, f.device, choice);
    await f.app.read(f.id, f.device);
    expect(state).toMatchObject({
      consent: false,
      attempted: false,
      analysis: null,
      preferences: choice,
    });
    expect(claim).not.toHaveBeenCalled();
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("keeps manual choice available with no configured provider", async () => {
    const f = await setup({ provider: false });
    expect(await f.app.confirm(f.id, f.device, choice)).toMatchObject({
      photoAvailable: false,
      preferences: choice,
    });
    await expect(
      f.app.consent(f.id, f.device, true, COLOR_PHOTO_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "color_photo_disabled" });
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "color_photo_disabled" });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("does not authorize external colour calls from an old main consent", async () => {
    const f = await setup({ consent: false, mainNotice: "2026-10-mvp" });
    await expect(
      f.app.consent(f.id, f.device, true, COLOR_PHOTO_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "color_photo_disabled" });
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "color_photo_disabled" });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("requires completed questionnaire answers even for manual selection", async () => {
    const f = await setup({ completeAnswers: false });
    await expect(f.app.read(f.id, f.device)).rejects.toMatchObject({
      code: "answers_required",
    });
    await expect(f.app.confirm(f.id, f.device, choice)).rejects.toMatchObject({
      code: "answers_required",
    });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("rejects invalid confirmation and foreign-device reads without provider work", async () => {
    const f = await setup({ consent: false });
    await expect(
      f.app.confirm(f.id, f.device, {
        paletteId: "winter",
        finish: "any",
      } as unknown as ColorPreferences),
    ).rejects.toMatchObject({ code: "invalid_color_preferences" });
    const foreign = f.repository.ensureDevice("another-device");
    await expect(f.app.read(f.id, foreign)).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(
      f.app.analyze(f.id, foreign, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "session_not_found" });
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("does not return a stale assembly after a concurrent guest preference change", async () => {
    const f = await setup({ consent: false });
    const products = await f.repository.products(f.device.storeId);
    const delayed = deferred<typeof products>();
    const started = deferred<void>();
    vi.spyOn(f.repository, "products").mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const pending = f.app.read(f.id, f.device);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "color_changed",
    });
    await started.promise;
    await f.repository.confirmColorPreferences(f.id, f.device, choice);
    delayed.resolve(products);
    await rejected;
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("does not return a session finished during catalog assembly", async () => {
    const f = await setup({ consent: false });
    const products = await f.repository.products(f.device.storeId);
    const delayed = deferred<typeof products>();
    const started = deferred<void>();
    vi.spyOn(f.repository, "products").mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const pending = f.app.read(f.id, f.device);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "session_not_found",
    });
    await started.promise;
    await f.repository.finish(f.id, f.device);
    delayed.resolve(products);
    await rejected;
    expect(f.analyze).not.toHaveBeenCalled();
  });

  it("rechecks the latest questionnaire exclusions after catalog assembly without a provider call", async () => {
    const f = await setup({ consent: false });
    await f.repository.confirmColorPreferences(f.id, f.device, choice);
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
      ingredients: ["Aqua", "Glycerin"],
      suitableSkinTypes: [],
    };
    const shade: LipShade = {
      variantId: product.id,
      organizationId: f.device.organizationId,
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
    const gate = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(f.repository, "products").mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      return [product];
    });
    vi.spyOn(f.repository, "lipShades").mockImplementation(async () => {
      await gate.promise;
      return [shade];
    });
    const pending = f.app.read(f.id, f.device);
    await started.promise;
    await f.repository.answers(f.id, f.device, {
      ...answers,
      excludedIngredients: ["Glycerin"],
    });
    gate.resolve();
    expect((await pending).recommendations).toEqual([]);
    expect(f.analyze).not.toHaveBeenCalled();
  });
});
