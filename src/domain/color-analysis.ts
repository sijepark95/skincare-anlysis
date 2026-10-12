/** A separate exploratory colour protocol. It cannot change or confirm a skin result. */
export const COLOR_PHOTO_NOTICE_VERSION =
  "2026-10-personal-color-photo-v1" as const;
export const COLOR_PROMPT_VERSION = "personal-color-suggestion-v1" as const;
export const COLOR_MODEL_VERSION = "gpt-4.1-mini-2025-04-14" as const;
export const colorUndertones = [
  "warm",
  "cool",
  "neutral",
  "uncertain",
] as const;
export const colorChromas = ["soft", "clear", "uncertain"] as const;
export const colorImageQualities = [
  "usable",
  "limited",
  "not_assessable",
] as const;
export const colorQualityFlags = [
  "no_face",
  "multiple_faces",
  "blur",
  "low_light",
  "uneven_lighting",
  "makeup_or_filter",
  "face_not_fully_visible",
  "resolution_limited",
] as const;

export interface ColorObservation {
  image_quality: (typeof colorImageQualities)[number];
  undertone: (typeof colorUndertones)[number];
  chroma: (typeof colorChromas)[number];
  quality_flags: (typeof colorQualityFlags)[number][];
}

export interface ColorAnalysis extends ColorObservation {
  request_id: string;
  mode: "openai_color";
  model_version: typeof COLOR_MODEL_VERSION;
  prompt_version: typeof COLOR_PROMPT_VERSION;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Exact keys, typed categories and correlated quality; no provider prose survives. */
export function validateColorAnalysis(
  value: unknown,
  expectedRequestId?: string,
): ColorAnalysis | null {
  const keys = [
    "request_id",
    "mode",
    "model_version",
    "prompt_version",
    "image_quality",
    "undertone",
    "chroma",
    "quality_flags",
  ];
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return null;
  if (
    typeof value.request_id !== "string" ||
    !uuid.test(value.request_id) ||
    (expectedRequestId !== undefined &&
      value.request_id !== expectedRequestId) ||
    value.mode !== "openai_color" ||
    value.model_version !== COLOR_MODEL_VERSION ||
    value.prompt_version !== COLOR_PROMPT_VERSION ||
    !colorImageQualities.some((item) => item === value.image_quality) ||
    !colorUndertones.some((item) => item === value.undertone) ||
    !colorChromas.some((item) => item === value.chroma) ||
    !Array.isArray(value.quality_flags) ||
    value.quality_flags.length > colorQualityFlags.length ||
    value.quality_flags.some(
      (flag) => !colorQualityFlags.some((allowed) => allowed === flag),
    ) ||
    new Set(value.quality_flags).size !== value.quality_flags.length ||
    (value.image_quality === "usable" && value.quality_flags.length !== 0) ||
    (value.image_quality !== "usable" &&
      (value.quality_flags.length === 0 ||
        value.undertone !== "uncertain" ||
        value.chroma !== "uncertain")) ||
    (value.quality_flags.some(
      (flag) => flag === "no_face" || flag === "multiple_faces",
    ) &&
      value.image_quality !== "not_assessable")
  )
    return null;
  return {
    request_id: value.request_id,
    mode: "openai_color",
    model_version: COLOR_MODEL_VERSION,
    prompt_version: COLOR_PROMPT_VERSION,
    image_quality: value.image_quality as ColorAnalysis["image_quality"],
    undertone: value.undertone as ColorAnalysis["undertone"],
    chroma: value.chroma as ColorAnalysis["chroma"],
    quality_flags: [...value.quality_flags] as ColorAnalysis["quality_flags"],
  };
}

export function isColorAnalysis(value: unknown): value is ColorAnalysis {
  return validateColorAnalysis(value) !== null;
}
