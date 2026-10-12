import { describe, expect, it } from "vitest";
import {
  BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION,
  BEAUTY_COMPLETE_PROMPT_VERSION,
  BEAUTY_PREVIEW_MODEL_VERSION,
  BEAUTY_PREVIEW_NOTICE_VERSION,
  BEAUTY_PREVIEW_PROMPT_VERSION,
  validateBeautyCompleteAnalysis,
  validateBeautyPreviewResult,
} from "@/domain/beauty-complete";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
} from "@/domain/beauty-analysis";
import {
  OPENAI_SKIN_PROMPT_VERSION,
  VISION_FEATURES,
} from "@/domain/skin-vision";

const requestId = "839acebb-91cb-4e96-892e-f363f4962a61";
const complete = {
  request_id: requestId,
  mode: "openai_beauty_complete",
  model_version: BEAUTY_MODEL_VERSION,
  prompt_version: BEAUTY_COMPLETE_PROMPT_VERSION,
  beauty: {
    request_id: requestId,
    mode: "openai_beauty",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_PROMPT_VERSION_V2,
    image_quality: "usable",
    quality_flags: [],
    undertone: "warm",
    chroma: "soft",
    face_shape: "oval",
    eye_shape: "almond",
    nose_shape: "medium",
    lip_fullness: "full",
  },
  skin: {
    prompt_version: OPENAI_SKIN_PROMPT_VERSION,
    image_quality: "usable",
    quality_flags: [],
    observed_features: Object.fromEntries(
      VISION_FEATURES.map((key) => [key, "visible"]),
    ),
  },
  animalVibe: "cat",
  baseDepth: "medium",
};
const preview = {
  request_id: requestId,
  kind: "hair_color",
  index: 2,
  mime_type: "image/jpeg",
  image_base64: Buffer.from([255, 216, 255, 224, 1, 255, 217]).toString(
    "base64",
  ),
  model_version: BEAUTY_PREVIEW_MODEL_VERSION,
  prompt_version: BEAUTY_PREVIEW_PROMPT_VERSION,
};

describe("new combined single-photo protocol", () => {
  it("keeps fresh versioned purposes and defensively copies independent strict blocks", () => {
    expect(BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION).toBe(
      "2026-10-beauty-complete-photo-v1",
    );
    expect(BEAUTY_PREVIEW_NOTICE_VERSION).toBe("2026-10-beauty-preview-v1");
    const result = validateBeautyCompleteAnalysis(complete, requestId);
    expect(result).toEqual(complete);
    expect(result?.beauty).not.toBe(complete.beauty);
    expect(result?.skin.observed_features).not.toBe(
      complete.skin.observed_features,
    );
    expect(
      validateBeautyCompleteAnalysis({
        ...complete,
        skin: {
          ...complete.skin,
          image_quality: "limited",
          quality_flags: ["resolution_limited"],
          observed_features: Object.fromEntries(
            VISION_FEATURES.map((key) => [key, "uncertain"]),
          ),
        },
      }),
    ).not.toBeNull();
  });
  it.each([
    null,
    [],
    {},
    { ...complete, diagnosis: "private" },
    { ...complete, confidence: 90 },
    { ...complete, animalVibe: "lion" },
    { ...complete, baseDepth: "white" },
    { ...complete, prompt_version: "beauty-style-suggestion-v2" },
    { ...complete, model_version: "latest" },
    { ...complete, beauty: { ...complete.beauty, gender: "female" } },
    {
      ...complete,
      beauty: {
        ...complete.beauty,
        request_id: "49df9792-de41-419d-bd6c-240dd8abce72",
      },
    },
    { ...complete, skin: null },
    { ...complete, skin: { ...complete.skin, confidence: 99 } },
    {
      ...complete,
      skin: {
        ...complete.skin,
        observed_features: {
          ...complete.skin.observed_features,
          hydration: "visible",
        },
      },
    },
    {
      ...complete,
      beauty: {
        ...complete.beauty,
        image_quality: "limited",
        quality_flags: ["blur"],
        undertone: "uncertain",
        chroma: "uncertain",
        face_shape: "uncertain",
        eye_shape: "uncertain",
        nose_shape: "uncertain",
        lip_fullness: "uncertain",
      },
    },
  ])("rejects unsupported/inconsistent output %o", (value) => {
    expect(validateBeautyCompleteAnalysis(value)).toBeNull();
  });
  it("rejects response correlation mismatch", () => {
    expect(
      validateBeautyCompleteAnalysis(
        complete,
        "49df9792-de41-419d-bd6c-240dd8abce72",
      ),
    ).toBeNull();
  });
});

describe("single image preview slot", () => {
  it("accepts a canonical bounded JPEG only at the expected slot", () => {
    expect(
      validateBeautyPreviewResult(preview, requestId, "hair_color", 2),
    ).toEqual(preview);
    expect(
      validateBeautyPreviewResult(preview, requestId, "makeup", 2),
    ).toBeNull();
    expect(
      validateBeautyPreviewResult(preview, requestId, "hair_color", 0),
    ).toBeNull();
  });
  it.each([
    { index: true },
    { index: "2" },
    { index: -1 },
    { index: 3 },
    { kind: "body" },
    { prompt: "custom" },
    { model_version: "latest" },
    { prompt_version: "beauty-makeup-preview-v1" },
    { mime_type: "image/png" },
    { request_id: "not-uuid" },
    { image_base64: "https://example.invalid/photo.jpg" },
    { image_base64: "data:image/jpeg;base64,/9j/Af/Z" },
    { image_base64: "/9j/AAAA" },
    { image_base64: "/9j/" + "A".repeat(1400000) },
  ])("rejects unknown or malformed image output %o", (change) => {
    expect(validateBeautyPreviewResult({ ...preview, ...change })).toBeNull();
  });
});
