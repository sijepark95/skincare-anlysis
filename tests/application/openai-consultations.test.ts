import { describe, expect, it, vi } from "vitest";
import { Consultations } from "@/application/consultations";
import type {
  Analysis,
  Answers,
  OpenAIAnalysis,
} from "@/application/contracts";
import { DemoRepository } from "@/infrastructure/demo-repository";
import { LocalMockAnalysis } from "@/infrastructure/analysis";
import { demoProducts } from "@/domain/demo-catalog";
import {
  OPENAI_CONSENT_VERSION,
  VISION_NOTICE_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
  OPENAI_SKIN_PROMPT_VERSION,
} from "@/domain/skin-vision";

const preferences: Answers = {
  skinType: "dry",
  concerns: ["dehydration"],
  sensitive: true,
  excludedIngredients: ["Vitamin B3"],
};
function appearance(
  request_id: string,
  image?: Uint8Array,
  quality: "usable" | "limited" = "usable",
): OpenAIAnalysis {
  return {
    request_id,
    mode: "openai",
    model_version: OPENAI_SKIN_MODEL,
    quality_status: image ? quality : "not_provided",
    observations: [],
    disclaimer: OPENAI_SKIN_DISCLAIMER,
    vision: image
      ? {
          prompt_version: OPENAI_SKIN_PROMPT_VERSION,
          image_quality: quality,
          quality_flags: quality === "usable" ? [] : ["low_light"],
          observed_features: {
            visible_redness: "visible",
            visible_spots: "visible",
            visible_pores: "visible",
            visible_fine_lines: "visible",
            visible_flaking: "visible",
          },
        }
      : null,
  };
}
async function setup(accepted: boolean | null = true) {
  const repository = new DemoRepository(false);
  const device = repository.ensureDevice("openai-application");
  const analyze = vi.fn(
    async (
      id: string,
      _answers: Answers,
      image?: Uint8Array,
    ): Promise<Analysis> => appearance(id, image),
  );
  const explain = vi.fn();
  const app = new Consultations(
    repository,
    { analyze },
    { explain, modelVersion: OPENAI_SKIN_MODEL },
    "openai",
  );
  const session = await app.start(device);
  await app.consent(session.id, device, true, OPENAI_CONSENT_VERSION);
  if (accepted !== null)
    await repository.visionConsent(
      session.id,
      device,
      accepted,
      VISION_NOTICE_VERSION,
    );
  await app.answers(session.id, device, preferences);
  return { repository, device, analyze, explain, app, id: session.id };
}

describe("consented OpenAI photo analysis application", () => {
  it.each([false, null])(
    "requires explicit photo consent before a durable claim or provider call (%s)",
    async (accepted) => {
      const f = await setup(accepted);
      const claim = vi.spyOn(f.repository, "claimVisionAnalysis");
      await expect(
        f.app.analyze(f.id, f.device, new Uint8Array([1])),
      ).rejects.toMatchObject({ code: "vision_consent_required" });
      expect(claim).not.toHaveBeenCalled();
      expect(f.analyze).not.toHaveBeenCalled();
    },
  );
  it("enforces the new main notice even when callers omit its argument", async () => {
    const f = await setup();
    vi.spyOn(f.repository, "session").mockResolvedValue({
      ...(await f.repository.session(f.id, f.device)),
      consentVersion: "2026-10-experimental-v1",
    });
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "consent_required" });
    expect(f.analyze).not.toHaveBeenCalled();
  });
  it("claims once across concurrent use-case instances and cached reloads", async () => {
    const f = await setup();
    let release!: (value: Analysis) => void;
    f.analyze.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const claim = vi.spyOn(f.repository, "claimVisionAnalysis");
    const first = f.app.analyze(f.id, f.device, new Uint8Array([1]));
    await vi.waitFor(() => expect(f.analyze).toHaveBeenCalledTimes(1));
    const second = new Consultations(
      f.repository,
      { analyze: f.analyze },
      null,
      "openai",
    );
    await expect(
      second.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "vision_already_attempted" });
    release(appearance(f.id, new Uint8Array([1])));
    const result = await first;
    const cached = await second.analyze(f.id, f.device, new Uint8Array([3]));
    expect(cached.analysis).toEqual(result.analysis);
    expect(f.analyze).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(2);
  });
  it("does not retry a failed external attempt but allows photo-free continuation", async () => {
    const f = await setup();
    f.analyze.mockRejectedValueOnce(new Error("private-upstream"));
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toThrow("private-upstream");
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "vision_already_attempted" });
    const result = await f.app.analyze(f.id, f.device);
    expect(result.analysis).toMatchObject({
      mode: "openai",
      quality_status: "not_provided",
      vision: null,
    });
    expect(f.analyze).toHaveBeenCalledTimes(2);
    expect(f.analyze.mock.calls[1][2]).toBeUndefined();
  });
  it("photo-free use needs no external opt-in or claim", async () => {
    const f = await setup(false);
    const claim = vi.spyOn(f.repository, "claimVisionAnalysis");
    expect((await f.app.analyze(f.id, f.device)).analysis).toMatchObject({
      mode: "openai",
      vision: null,
    });
    expect(claim).not.toHaveBeenCalled();
  });
  it("usable visible features extend only reviewed cosmetic policy goals without changing answers or exclusions", async () => {
    const f = await setup();
    const product = (sku: string, ingredient: string, patch = {}) => ({
      ...demoProducts[0],
      id: sku,
      sku,
      ingredients: ["Aqua", ingredient],
      ...patch,
    });
    vi.spyOn(f.repository, "products").mockResolvedValue([
      product("HYDRATE", "Glycerin"),
      product("TEXTURE", "Gluconolactone"),
      product("TONE", "Ascorbyl Glucoside"),
      product("LINES", "Palmitoyl Tripeptide-1"),
      product("EXCLUDED", "Niacinamide"),
      product("NO-STOCK", "Gluconolactone", { stock: 0 }),
      product("OTHER-TENANT", "Gluconolactone", {
        organizationId: "99999999-9999-4999-8999-999999999999",
      }),
    ]);
    vi.spyOn(f.repository, "policy").mockResolvedValue({
      id: "reviewed",
      version: "v1",
      rules: [
        { concern: "dehydration", ingredient: "Glycerin", relevance: 1 },
        { concern: "texture", ingredient: "Gluconolactone", relevance: 3 },
        {
          concern: "uneven_tone",
          ingredient: "Ascorbyl Glucoside",
          relevance: 2,
        },
        {
          concern: "fine_lines",
          ingredient: "Palmitoyl Tripeptide-1",
          relevance: 2,
        },
        { concern: "texture", ingredient: "Niacinamide", relevance: 3 },
      ],
    });
    const result = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    expect(result.answers).toEqual(preferences);
    expect(result.recommendations?.map((item) => item.product.sku)).toEqual([
      "TEXTURE",
      "LINES",
      "TONE",
    ]);
    expect(
      result.recommendations
        ?.flatMap((item) => item.reasons.map((reason) => reason.concern))
        .sort(),
    ).toEqual(["fine_lines", "texture", "uneven_tone"]);
  });
  it("limited photo observations add no recommendation goals", async () => {
    const f = await setup();
    f.analyze.mockImplementation(async (id, _answers, image) =>
      appearance(id, image, "limited"),
    );
    const result = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
    expect(
      result.recommendations
        ?.flatMap((item) => item.reasons)
        .every((reason) => reason.concern === "dehydration"),
    ).toBe(true);
  });
  it.each([
    {
      quality: "usable" as const,
      poreValue: "visible" as const,
      covered: true,
    },
    {
      quality: "limited" as const,
      poreValue: "visible" as const,
      covered: false,
    },
    {
      quality: "usable" as const,
      poreValue: "uncertain" as const,
      covered: false,
    },
  ])(
    "reserves a real registered pore/texture match only for usable visible pores: $quality/$poreValue",
    async ({ quality, poreValue, covered }) => {
      const f = await setup();
      f.analyze.mockImplementation(async (id, _answers, image) => {
        const result = appearance(id, image, quality);
        result.vision!.observed_features = {
          visible_redness: "not_visible",
          visible_spots: "not_visible",
          visible_pores: poreValue,
          visible_fine_lines: "not_visible",
          visible_flaking: "not_visible",
        };
        return result;
      });
      const catalog = ["HYDRATE-1", "HYDRATE-2", "HYDRATE-3"].map((sku) => ({
        ...demoProducts[0],
        id: sku,
        sku,
        ingredients: ["Aqua", "Glycerin"],
      }));
      catalog.push({
        ...demoProducts[0],
        id: "Z-PORES",
        sku: "Z-PORES",
        ingredients: ["Aqua", "Salicylic Acid"],
      });
      vi.spyOn(f.repository, "products").mockResolvedValue(catalog);
      vi.spyOn(f.repository, "policy").mockResolvedValue({
        id: "reviewed",
        version: "v1",
        rules: [
          { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
          { concern: "texture", ingredient: "Salicylic Acid", relevance: 3 },
        ],
      });
      const result = await f.app.analyze(f.id, f.device, new Uint8Array([1]));
      expect(result.recommendations?.map((item) => item.product.sku)).toEqual(
        covered
          ? ["HYDRATE-1", "HYDRATE-2", "Z-PORES"]
          : ["HYDRATE-1", "HYDRATE-2", "HYDRATE-3"],
      );
      expect(result.answers).toEqual(preferences);
      const texture = result.skinConsultation?.goals.find(
        (goal) => goal.concern === "texture",
      );
      if (covered) {
        expect(texture).toMatchObject({
          source: "photo",
          label: "Visible pores & texture",
          recommendedProductCount: 1,
          coverage: "matched_products",
        });
        expect(
          result.skinConsultation?.products.find(
            (product) => product.productId === "Z-PORES",
          )?.reasons,
        ).toEqual([
          expect.objectContaining({
            concern: "texture",
            ingredient: "Salicylic Acid",
            source: "photo",
          }),
        ]);
      } else expect(texture).toBeUndefined();
    },
  );
  it.each(["finish", "revoke", "photo_consent"])(
    "blocks late results when %s occurs during the API call",
    async (event) => {
      const f = await setup();
      let release!: (value: Analysis) => void;
      f.analyze.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const save = vi.spyOn(f.repository, "saveAnalysis");
      const pending = f.app.analyze(f.id, f.device, new Uint8Array([1]));
      const rejected = expect(pending).rejects.toMatchObject({
        code:
          event === "finish"
            ? "session_not_found"
            : event === "revoke"
              ? "device_revoked"
              : "vision_consent_required",
      });
      await vi.waitFor(() => expect(f.analyze).toHaveBeenCalledTimes(1));
      if (event === "finish") await f.app.finish(f.id, f.device);
      else if (event === "revoke")
        await f.repository.revokeDevice(f.device.deviceId);
      else
        await f.repository.visionConsent(
          f.id,
          f.device,
          false,
          VISION_NOTICE_VERSION,
        );
      release(appearance(f.id, new Uint8Array([1])));
      await rejected;
      expect(save).not.toHaveBeenCalled();
    },
  );
  it("rejects mock substitution and image/vision mismatches", async () => {
    const f = await setup();
    f.analyze.mockImplementation(async (id, answers) =>
      new LocalMockAnalysis().analyze(id, answers),
    );
    await expect(
      f.app.analyze(f.id, f.device, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "analysis_unavailable" });
    expect((await f.repository.session(f.id, f.device)).analysis).toBeNull();
    f.analyze.mockImplementation(async (id) =>
      appearance(id, new Uint8Array([1])),
    );
    await expect(f.app.analyze(f.id, f.device)).rejects.toMatchObject({
      code: "analysis_unavailable",
    });
  });
  it("disables the separate explanatory LLM use case", async () => {
    const f = await setup();
    const claim = vi.spyOn(f.repository, "claimExplanation");
    await expect(f.app.explain(f.id, f.device)).rejects.toMatchObject({
      code: "explanation_disabled",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(f.explain).not.toHaveBeenCalled();
  });
});
