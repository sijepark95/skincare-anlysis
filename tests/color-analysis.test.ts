import { describe, expect, it } from "vitest";
import {
  COLOR_MODEL_VERSION,
  COLOR_PHOTO_NOTICE_VERSION,
  COLOR_PROMPT_VERSION,
  isColorAnalysis,
  validateColorAnalysis,
} from "@/domain/color-analysis";

const requestId = "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b";
const result = {
  request_id: requestId,
  mode: "openai_color",
  model_version: COLOR_MODEL_VERSION,
  prompt_version: COLOR_PROMPT_VERSION,
  image_quality: "usable",
  undertone: "warm",
  chroma: "soft",
  quality_flags: [],
};

describe("independent strict exploratory colour protocol", () => {
  it("pins a separate consent purpose and returns a defensive typed copy", () => {
    expect(COLOR_PHOTO_NOTICE_VERSION).toBe("2026-10-personal-color-photo-v1");
    const parsed = validateColorAnalysis(result, requestId);
    expect(parsed).toEqual(result);
    expect(parsed).not.toBe(result);
    expect(parsed?.quality_flags).not.toBe(result.quality_flags);
    expect(isColorAnalysis(result)).toBe(true);
  });

  it("accepts uncertainty on a usable image without inventing a confirmed palette", () => {
    expect(
      validateColorAnalysis({
        ...result,
        undertone: "uncertain",
        chroma: "uncertain",
      }),
    ).not.toBeNull();
    expect(
      validateColorAnalysis({ ...result, confirmed_palette: "warm_soft" }),
    ).toBeNull();
  });

  it.each([
    {
      image_quality: "limited",
      undertone: "uncertain",
      chroma: "uncertain",
      quality_flags: ["uneven_lighting"],
    },
    {
      image_quality: "not_assessable",
      undertone: "uncertain",
      chroma: "uncertain",
      quality_flags: ["no_face"],
    },
    {
      image_quality: "not_assessable",
      undertone: "uncertain",
      chroma: "uncertain",
      quality_flags: ["multiple_faces"],
    },
  ])("accepts safe quality-correlated uncertainty: %o", (observation) => {
    expect(validateColorAnalysis({ ...result, ...observation })).not.toBeNull();
  });

  it.each([
    { model_version: "gpt-4.1-mini" },
    { mode: "openai" },
    { prompt_version: "visible-appearance-eval-v1" },
    { request_id: "private-session" },
    { image_quality: "excellent" },
    { undertone: "spring" },
    { chroma: "high-confidence" },
    { quality_flags: ["ethnicity"] },
    { quality_flags: ["blur", "blur"] },
    { quality_flags: ["low_light"] },
    { image_quality: "limited", quality_flags: ["blur"] },
    { image_quality: "limited", undertone: "uncertain", chroma: "uncertain" },
    { image_quality: "usable", undertone: true },
    { quality_flags: "none" },
    { diagnosis: "provider-free-text" },
    { confidence: 0.99 },
  ])("rejects invalid, unsupported or ungrounded output: %o", (change) => {
    expect(validateColorAnalysis({ ...result, ...change })).toBeNull();
  });

  it("rejects mismatched request ownership and missing keys", () => {
    expect(
      validateColorAnalysis(result, "885bfb29-66b3-46c5-97cc-0ef74acfd062"),
    ).toBeNull();
    const missing = { ...result } as Record<string, unknown>;
    delete missing.chroma;
    expect(validateColorAnalysis(missing)).toBeNull();
    expect(validateColorAnalysis(null)).toBeNull();
    expect(validateColorAnalysis([])).toBeNull();
  });
});
