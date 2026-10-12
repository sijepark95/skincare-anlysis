import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAnalysis } from "@/infrastructure/analysis";
import {
  isOpenAIAnalysis,
  OPENAI_SKIN_MODEL,
  OPENAI_SKIN_PROMPT_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  VISION_FEATURES,
  visibleRecommendationConcerns,
  type OpenAISkinAnalysis,
} from "@/domain/skin-vision";

const id = "44444444-4444-4444-8444-444444444444";
function result(photo = true): OpenAISkinAnalysis {
  return {
    request_id: id,
    mode: "openai",
    model_version: OPENAI_SKIN_MODEL,
    quality_status: photo ? "usable" : "not_provided",
    observations: [],
    disclaimer: OPENAI_SKIN_DISCLAIMER,
    vision: photo
      ? {
          prompt_version: OPENAI_SKIN_PROMPT_VERSION,
          image_quality: "usable",
          quality_flags: [],
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
afterEach(() => vi.unstubAllGlobals());
describe("hosted appearance contract", () => {
  it("accepts pinned photo and explicitly photo-free outputs", () => {
    expect(isOpenAIAnalysis(result())).toBe(true);
    expect(isOpenAIAnalysis(result(false))).toBe(true);
  });
  it.each([
    { ...result(), model_version: "gpt-4.1-mini" },
    { ...result(), mode: "experimental" },
    { ...result(), disclaimer: "Guaranteed diagnosis" },
    { ...result(), vision: null },
    { ...result(false), quality_status: "usable" },
    { ...result(), identity: "person" },
    { ...result(), observations: [{ score: 0.9 }] },
    { ...result(), vision: { ...result().vision!, free_text: "diagnosis" } },
    {
      ...result(),
      vision: { ...result().vision!, quality_flags: ["unknown"] },
    },
    {
      ...result(),
      vision: { ...result().vision!, quality_flags: ["no_face"] },
    },
    {
      ...result(),
      vision: {
        ...result().vision!,
        observed_features: {
          ...result().vision!.observed_features,
          visible_redness: "severe",
        },
      },
    },
  ])("rejects untrusted protocol alterations", (body) =>
    expect(isOpenAIAnalysis(body)).toBe(false),
  );
  it("accepts no-face only with a completely unassessable result", () => {
    const body = result();
    body.quality_status = "not_assessable";
    body.vision!.image_quality = "not_assessable";
    body.vision!.quality_flags = ["no_face"];
    for (const feature of VISION_FEATURES)
      body.vision!.observed_features[feature] = "not_assessable";
    expect(isOpenAIAnalysis(body)).toBe(true);
    body.vision!.observed_features.visible_pores = "visible";
    expect(isOpenAIAnalysis(body)).toBe(false);
  });
  it("routes only usable visible pores, spots and lines to cosmetic goals", () => {
    const vision = result().vision!;
    expect(visibleRecommendationConcerns(vision)).toEqual([
      "texture",
      "uneven_tone",
      "fine_lines",
    ]);
    vision.observed_features.visible_pores = "uncertain";
    vision.observed_features.visible_spots = "not_visible";
    vision.observed_features.visible_fine_lines = "not_assessable";
    expect(visibleRecommendationConcerns(vision)).toEqual([]);
    expect(visibleRecommendationConcerns(null)).toEqual([]);
    vision.image_quality = "limited";
    vision.observed_features.visible_pores = "visible";
    expect(visibleRecommendationConcerns(vision)).toEqual([]);
  });
});
describe("private hosted photo transport", () => {
  const answers = {
    skinType: "dry" as const,
    concerns: ["dehydration" as const],
    sensitive: false,
    excludedIngredients: [],
  };
  const provider = () =>
    new HttpAnalysis("http://127.0.0.1:8000", "private-secret", "openai");
  it("selects the hosted endpoint and validates the photo result", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result()));
    vi.stubGlobal("fetch", fetch);
    expect(
      await provider().analyze(id, answers, new Uint8Array([1, 2, 3])),
    ).toEqual(result());
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8000/v1/analyze/openai");
    expect(JSON.parse(options.body).image_base64).toBe("AQID");
    expect(options).toMatchObject({ redirect: "error", cache: "no-store" });
  });
  it("requires null photo output when no pixels were sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(result(false))),
    );
    expect(await provider().analyze(id, answers)).toEqual(result(false));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result())));
    await expect(provider().analyze(id, answers)).rejects.toMatchObject({
      code: "analysis_unavailable",
    });
  });
  it("never accepts a mock fallback or stale request ID", async () => {
    for (const body of [
      { ...result(), mode: "mock" },
      { ...result(), request_id: "55555555-5555-4555-8555-555555555555" },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(
        provider().analyze(id, answers, new Uint8Array([1])),
      ).rejects.toMatchObject({ status: 503 });
    }
  });
  it("returns safe errors for unreadable photos without provider content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("secret upstream", { status: 422 })),
    );
    await expect(
      provider().analyze(id, answers, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "photo_not_supported", status: 422 });
  });
});
