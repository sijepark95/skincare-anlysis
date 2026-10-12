import { describe, expect, it } from "vitest";
import {
  BEAUTY_GUIDE_VERSION,
  beautyMoods,
  buildBeautyGuide,
  faceShapes,
  hairLengths,
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PHOTO_NOTICE_VERSION,
  BEAUTY_PROMPT_VERSION,
  beautyFaceShapes,
  isBeautyAnalysis,
  validateBeautyAnalysis,
} from "@/domain/beauty-analysis";
import { paletteIds } from "@/domain/personal-color";

const requestId = "839acebb-91cb-4e96-892e-f363f4962a61";
const observation = {
  request_id: requestId,
  mode: "openai_beauty",
  model_version: BEAUTY_MODEL_VERSION,
  prompt_version: BEAUTY_PROMPT_VERSION,
  image_quality: "usable",
  undertone: "warm",
  chroma: "soft",
  face_shape: "oval",
  quality_flags: [] as string[],
};
const preferences: BeautyPreferences = {
  paletteId: "cool_soft",
  faceShape: "round",
  hairLength: "medium",
  mood: "soft",
  finish: "satin",
};

describe("independent strict beauty observation protocol", () => {
  it("pins an independent purpose and protocol and returns only defensive typed data", () => {
    expect(BEAUTY_PHOTO_NOTICE_VERSION).toBe("2026-10-beauty-photo-v1");
    expect(BEAUTY_PROMPT_VERSION).toBe("beauty-style-suggestion-v1");
    expect(BEAUTY_MODEL_VERSION).toBe("gpt-4.1-mini-2025-04-14");
    const value = validateBeautyAnalysis(observation, requestId);
    expect(value).toEqual(observation);
    expect(value).not.toBe(observation);
    expect(value?.quality_flags).not.toBe(observation.quality_flags);
    expect(isBeautyAnalysis(value)).toBe(true);
  });

  it.each(beautyFaceShapes)(
    "accepts the allowed approximate outline %s without a score",
    (shape) => {
      expect(
        validateBeautyAnalysis({ ...observation, face_shape: shape }),
      ).not.toBeNull();
    },
  );

  it.each([
    {
      image_quality: "usable",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "uncertain",
      quality_flags: [],
    },
    {
      image_quality: "limited",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "uncertain",
      quality_flags: ["uneven_lighting"],
    },
    {
      image_quality: "not_assessable",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "uncertain",
      quality_flags: ["no_face"],
    },
    {
      image_quality: "not_assessable",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "uncertain",
      quality_flags: ["multiple_faces"],
    },
  ])("preserves quality-correlated uncertainty: %o", (change) => {
    expect(
      validateBeautyAnalysis({ ...observation, ...change }),
    ).not.toBeNull();
  });

  it.each([
    { mode: "openai_color" },
    { model_version: "gpt-4.1-mini" },
    { prompt_version: "personal-color-suggestion-v1" },
    { request_id: "session-id" },
    { request_id: "00000000-0000-0000-0000-000000000000" },
    { face_shape: "dog" },
    { face_shape: "cat" },
    { face_shape: "unsure" },
    { face_shape: 0.9 },
    { undertone: "spring" },
    { chroma: "high-confidence" },
    { quality_flags: ["blur"] },
    { quality_flags: ["blur", "blur"] },
    { quality_flags: ["ethnicity"] },
    { quality_flags: "none" },
    {
      image_quality: "limited",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "oval",
      quality_flags: ["blur"],
    },
    {
      image_quality: "limited",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "uncertain",
      quality_flags: [],
    },
    {
      image_quality: "limited",
      undertone: "uncertain",
      chroma: "uncertain",
      face_shape: "uncertain",
      quality_flags: ["no_face"],
    },
    { age: 25 },
    { sex: "female" },
    { race: "inferred" },
    { personality: "friendly" },
    { score: 99 },
    { confidence: 0.99 },
    { recommendation: "provider free text" },
    { confirmed_palette: "warm_soft" },
  ])("rejects unsupported output, quality or extra inference: %o", (change) => {
    expect(validateBeautyAnalysis({ ...observation, ...change })).toBeNull();
  });

  it("rejects missing keys, inherited keys and mismatched request ownership", () => {
    const missing = { ...observation } as Record<string, unknown>;
    delete missing.face_shape;
    expect(validateBeautyAnalysis(missing)).toBeNull();
    expect(validateBeautyAnalysis(Object.create(observation))).toBeNull();
    expect(
      validateBeautyAnalysis(
        observation,
        "4cd14d98-3cd7-4304-a3d6-5c957ff3ba04",
      ),
    ).toBeNull();
    expect(validateBeautyAnalysis(null)).toBeNull();
    expect(validateBeautyAnalysis([])).toBeNull();
  });
});

describe("guest-confirmed local beauty guide", () => {
  it("does not treat an analysis result as confirmed preferences", () => {
    expect(validBeautyPreferences(observation)).toBe(false);
    expect(
      buildBeautyGuide(observation as unknown as BeautyPreferences),
    ).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { ...preferences, paletteId: "summer" },
    { ...preferences, faceShape: "uncertain" },
    { ...preferences, faceShape: "cat" },
    { ...preferences, hairLength: "unknown" },
    { ...preferences, mood: "attractive" },
    { ...preferences, finish: "metallic" },
    { ...preferences, providerSuggestion: true },
  ])(
    "rejects unconfirmed, incomplete or unsupported preference data: %o",
    (value) => {
      expect(validBeautyPreferences(value)).toBe(false);
      expect(buildBeautyGuide(value as BeautyPreferences)).toBeNull();
    },
  );

  it.each(paletteIds)(
    "returns stable locally authored ideas for confirmed %s",
    (paletteId) => {
      const guide = buildBeautyGuide({ ...preferences, paletteId })!;
      expect(guide.version).toBe(BEAUTY_GUIDE_VERSION);
      expect(guide.palette.id).toBe(paletteId);
      expect(guide.confirmedFaceShape).toBe(preferences.faceShape);
      expect(guide.mood).toBe(preferences.mood);
      expect(guide.makeupMoods.map((idea) => idea.id)).toEqual([
        "makeup-soft",
        "makeup-fresh",
        "makeup-defined",
      ]);
      expect(guide.hairCuts).toHaveLength(1);
      expect(guide.hairColors).toHaveLength(2);
      expect(guide.jewelry).toHaveLength(2);
      for (const idea of [
        ...guide.makeupMoods,
        ...guide.hairCuts,
        ...guide.hairColors,
        ...guide.jewelry,
      ]) {
        expect(Object.keys(idea).sort()).toEqual([
          "description",
          "id",
          "title",
        ]);
        expect(idea.id).toBeTruthy();
        expect(idea.title).toBeTruthy();
        expect(idea.description).toBeTruthy();
      }
      expect(buildBeautyGuide({ ...preferences, paletteId })).toEqual(guide);
    },
  );

  it.each(faceShapes)(
    "supports the confirmed outline %s including manual uncertainty",
    (faceShape) => {
      const guide = buildBeautyGuide({
        ...preferences,
        faceShape,
        hairLength: "any",
      })!;
      expect(guide.hairCuts).toHaveLength(3);
      expect(new Set(guide.hairCuts.map((idea) => idea.id)).size).toBe(3);
      expect(
        guide.hairCuts.every((idea) => idea.id.startsWith(`${faceShape}-`)),
      ).toBe(true);
      expect(guide.confirmedFaceShape).toBe(faceShape);
    },
  );

  it.each(hairLengths)(
    "filters haircut ideas to the chosen %s length",
    (hairLength) => {
      const guide = buildBeautyGuide({ ...preferences, hairLength })!;
      expect(guide.hairCuts).toHaveLength(hairLength === "any" ? 3 : 1);
      if (hairLength !== "any")
        expect(guide.hairCuts[0].id).toBe(`round-${hairLength}`);
    },
  );

  it.each(beautyMoods)(
    "uses the guest's selected %s mood rather than an image inference",
    (mood) => {
      const guide = buildBeautyGuide({
        ...preferences,
        mood,
        finish: "matte",
      })!;
      expect(guide.mood).toBe(mood);
      expect(
        guide.makeupMoods.find((idea) => idea.id === `makeup-${mood}`)
          ?.description,
      ).toContain("matte");
    },
  );

  it("keeps palette undertone and intensity connected to fixed hair, jewelry and makeup ideas", () => {
    const warm = buildBeautyGuide({ ...preferences, paletteId: "warm_clear" })!;
    const cool = buildBeautyGuide({ ...preferences, paletteId: "cool_soft" })!;
    const neutral = buildBeautyGuide({
      ...preferences,
      paletteId: "neutral_soft",
    })!;
    expect(warm.hairColors[0].id).toBe("hair-warm-chestnut");
    expect(cool.hairColors[0].id).toBe("hair-cool-brown");
    expect(neutral.hairColors[0].id).toBe("hair-neutral-brown");
    expect(warm.jewelry[0].id).toBe("jewelry-warm-metal");
    expect(cool.jewelry[0].id).toBe("jewelry-cool-metal");
    expect(neutral.jewelry[0].id).toBe("jewelry-neutral-metal");
    expect(warm.makeupMoods[0].description).toContain("clearer focal accent");
    expect(cool.makeupMoods[0].description).toContain("softly blended");
  });

  it("returns defensive guide copies so an altered view cannot change future sessions", () => {
    const first = buildBeautyGuide(preferences)!;
    first.hairColors[0].title = "Changed in one view";
    first.hairCuts.splice(0);
    (first.palette.swatches as string[])[0] = "#000000";
    const next = buildBeautyGuide(preferences)!;
    expect(next.hairColors[0].title).not.toBe("Changed in one view");
    expect(next.hairCuts).toHaveLength(1);
    expect(next.palette.swatches[0]).not.toBe("#000000");
    expect(preferences).toEqual({
      paletteId: "cool_soft",
      faceShape: "round",
      hairLength: "medium",
      mood: "soft",
      finish: "satin",
    });
  });
});
