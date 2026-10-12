import { describe, expect, it } from "vitest";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PROMPT_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
  BEAUTY_CURRENT_PROMPT_VERSION,
  beautyEyeShapes,
  beautyNoseShapes,
  beautyLipFullnesses,
  validateBeautyAnalysis,
} from "@/domain/beauty-analysis";

const requestId = "839acebb-91cb-4e96-892e-f363f4962a61";
const legacy = {
  request_id: requestId,
  mode: "openai_beauty",
  model_version: BEAUTY_MODEL_VERSION,
  prompt_version: BEAUTY_PROMPT_VERSION,
  image_quality: "usable",
  undertone: "cool",
  chroma: "soft",
  face_shape: "oval",
  quality_flags: [],
};
const current = {
  ...legacy,
  prompt_version: BEAUTY_PROMPT_VERSION_V2,
  eye_shape: "almond",
  nose_shape: "medium",
  lip_fullness: "full",
};

describe("strict visible facial-feature observations", () => {
  it("reads exact v1 records without adding inferred features and uses an independent v2", () => {
    expect(BEAUTY_CURRENT_PROMPT_VERSION).toBe("beauty-style-suggestion-v2");
    expect(validateBeautyAnalysis(legacy, requestId)).toEqual(legacy);
    expect(validateBeautyAnalysis(legacy)).not.toHaveProperty("eye_shape");
    expect(validateBeautyAnalysis(current, requestId)).toEqual(current);
    expect(
      validateBeautyAnalysis({
        ...current,
        prompt_version: BEAUTY_PROMPT_VERSION,
      }),
    ).toBeNull();
    expect(
      validateBeautyAnalysis({
        ...legacy,
        prompt_version: BEAUTY_PROMPT_VERSION_V2,
      }),
    ).toBeNull();
  });
  it.each(beautyEyeShapes)(
    "accepts visible eye category %s with no numerical claim",
    (eye_shape) => {
      expect(validateBeautyAnalysis({ ...current, eye_shape })).not.toBeNull();
    },
  );
  it.each(beautyNoseShapes)(
    "accepts apparent front-view nose width %s",
    (nose_shape) => {
      expect(validateBeautyAnalysis({ ...current, nose_shape })).not.toBeNull();
    },
  );
  it.each(beautyLipFullnesses)(
    "accepts approximate visible lip category %s",
    (lip_fullness) => {
      expect(
        validateBeautyAnalysis({ ...current, lip_fullness }),
      ).not.toBeNull();
    },
  );
  it.each([
    { eye_shape: "cat" },
    { eye_shape: 39 },
    { nose_shape: "high_bridge" },
    { lip_fullness: "attractive" },
    { confidence: 0.99 },
    { ratio: 0.5 },
    { race: "inferred" },
    { personality: "gentle" },
    { eye_shape: undefined },
    { lip_fullness: null },
  ])(
    "rejects unsupported features, inferred traits or extra precision: %o",
    (change) => {
      expect(validateBeautyAnalysis({ ...current, ...change })).toBeNull();
    },
  );
  it.each(["eye_shape", "nose_shape", "lip_fullness"])(
    "requires %s and makes it uncertain when limited",
    (key) => {
      const missing = { ...current } as Record<string, unknown>;
      delete missing[key];
      expect(validateBeautyAnalysis(missing)).toBeNull();
      const limited = {
        ...current,
        image_quality: "limited",
        quality_flags: ["blur"],
        undertone: "uncertain",
        chroma: "uncertain",
        face_shape: "uncertain",
        eye_shape: "uncertain",
        nose_shape: "uncertain",
        lip_fullness: "uncertain",
      };
      expect(validateBeautyAnalysis(limited)).not.toBeNull();
      expect(
        validateBeautyAnalysis({
          ...limited,
          [key]: current[key as keyof typeof current],
        }),
      ).toBeNull();
    },
  );
});
