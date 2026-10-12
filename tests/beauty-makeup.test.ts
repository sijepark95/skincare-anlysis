import { describe, expect, it } from "vitest";
import {
  BEAUTY_MAKEUP_MODEL_VERSION,
  BEAUTY_MAKEUP_PROMPT_VERSION,
  BEAUTY_MAKEUP_NOTICE_VERSION,
  beautyMakeupMoodIds,
  validateBeautyMakeupResult,
} from "@/domain/beauty-makeup";

const requestId = "839acebb-91cb-4e96-892e-f363f4962a61";
const result = {
  request_id: requestId,
  mode: "openai_beauty_makeup",
  model_version: BEAUTY_MAKEUP_MODEL_VERSION,
  prompt_version: BEAUTY_MAKEUP_PROMPT_VERSION,
  images: beautyMakeupMoodIds.map((id, index) => ({
    id,
    image_base64: Buffer.from([255, 216, 255, 224, index, 255, 217]).toString(
      "base64",
    ),
    mime_type: "image/jpeg",
  })),
};

describe("separate transient three-mood preview protocol", () => {
  it("pins an independent purpose and exact model with three defensive ordered images", () => {
    expect(BEAUTY_MAKEUP_NOTICE_VERSION).toBe("2026-10-beauty-makeup-v1");
    const value = validateBeautyMakeupResult(result, requestId);
    expect(value).toEqual(result);
    expect(value).not.toBe(result);
    expect(value?.images).not.toBe(result.images);
    expect(value?.images[0]).not.toBe(result.images[0]);
  });
  it.each([
    null,
    [],
    {},
    { ...result, request_id: "session-id" },
    { ...result, model_version: "gpt-image-2.5-flare" },
    { ...result, prompt_version: "unapproved" },
    { ...result, mode: "openai_beauty" },
    { ...result, photo: "private" },
    { ...result, images: result.images.slice(0, 2) },
    { ...result, images: [...result.images, result.images[0]] },
    {
      ...result,
      images: [result.images[1], result.images[0], result.images[2]],
    },
    {
      ...result,
      images: result.images.map((item) => ({
        ...item,
        image_base64: result.images[0].image_base64,
      })),
    },
  ])("rejects mismatched, incomplete or open-ended outputs: %o", (value) => {
    expect(validateBeautyMakeupResult(value)).toBeNull();
  });
  it.each([
    { mime_type: "image/svg+xml" },
    { image_base64: "https://untrusted.invalid/photo.jpg" },
    { image_base64: "data:image/jpeg;base64,/9j/AAAA" },
    { image_base64: "/9j/$$==" },
    { image_base64: "/9j/AAAA" },
    { image_base64: "/9j/" + "A".repeat(1400000) },
    { prompt: "private" },
    { id: "celebrity" },
    { image_base64: result.images[0].image_base64.replace(/=$/, "\n=") },
  ])(
    "rejects output URLs, oversized images, unsupported data or extra fields: %o",
    (change) => {
      expect(
        validateBeautyMakeupResult({
          ...result,
          images: [
            { ...result.images[0], ...change },
            ...result.images.slice(1),
          ],
        }),
      ).toBeNull();
    },
  );
  it("ties response ownership to the fresh admitted request", () => {
    expect(
      validateBeautyMakeupResult(
        result,
        "36755763-aaad-47cf-90b6-3ca605af06ce",
      ),
    ).toBeNull();
    expect(validateBeautyMakeupResult(Object.create(result))).toBeNull();
  });
});
