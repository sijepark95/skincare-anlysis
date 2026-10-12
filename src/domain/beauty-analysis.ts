/** Exploratory beauty observations never establish a guest's preferences or identity. */
export const BEAUTY_PHOTO_NOTICE_VERSION = "2026-10-beauty-photo-v1" as const;
export const BEAUTY_PROMPT_VERSION = "beauty-style-suggestion-v1" as const;
/** Keep v1 readable without assigning new observations to an old persisted record. */
export const BEAUTY_PROMPT_VERSION_V2 = "beauty-style-suggestion-v2" as const;
export const BEAUTY_CURRENT_PROMPT_VERSION = BEAUTY_PROMPT_VERSION_V2;
export const BEAUTY_MODEL_VERSION = "gpt-4.1-mini-2025-04-14" as const;
export const beautyUndertones = [
  "warm",
  "cool",
  "neutral",
  "uncertain",
] as const;
export const beautyChromas = ["soft", "clear", "uncertain"] as const;
export const beautyImageQualities = [
  "usable",
  "limited",
  "not_assessable",
] as const;
export const beautyFaceShapes = [
  "oval",
  "round",
  "square",
  "oblong",
  "heart",
  "diamond",
  "uncertain",
] as const;
export const beautyEyeShapes = [
  "almond",
  "round",
  "hooded",
  "monolid",
  "uncertain",
] as const;
/** Apparent front-view width only; no height, anatomical ratio or ethnic inference. */
export const beautyNoseShapes = [
  "slender",
  "medium",
  "broad",
  "uncertain",
] as const;
export const beautyLipFullnesses = [
  "fine",
  "medium",
  "full",
  "uncertain",
] as const;
export const beautyQualityFlags = [
  "no_face",
  "multiple_faces",
  "blur",
  "low_light",
  "uneven_lighting",
  "makeup_or_filter",
  "face_not_fully_visible",
  "resolution_limited",
] as const;

export interface BeautyObservation {
  image_quality: (typeof beautyImageQualities)[number];
  undertone: (typeof beautyUndertones)[number];
  chroma: (typeof beautyChromas)[number];
  face_shape: (typeof beautyFaceShapes)[number];
  quality_flags: (typeof beautyQualityFlags)[number][];
}
export interface BeautyAnalysisV1 extends BeautyObservation {
  request_id: string;
  mode: "openai_beauty";
  model_version: typeof BEAUTY_MODEL_VERSION;
  prompt_version: typeof BEAUTY_PROMPT_VERSION;
}
export interface BeautyAnalysisV2 extends BeautyObservation {
  request_id: string;
  mode: "openai_beauty";
  model_version: typeof BEAUTY_MODEL_VERSION;
  prompt_version: typeof BEAUTY_PROMPT_VERSION_V2;
  eye_shape: (typeof beautyEyeShapes)[number];
  nose_shape: (typeof beautyNoseShapes)[number];
  lip_fullness: (typeof beautyLipFullnesses)[number];
}
export type BeautyAnalysis = BeautyAnalysisV1 | BeautyAnalysisV2;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Exact allowlisted data only: discard provider prose, scores and unsupported inferences. */
export function validateBeautyAnalysis(
  value: unknown,
  expectedRequestId?: string,
): BeautyAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const v2 = row.prompt_version === BEAUTY_PROMPT_VERSION_V2;
  const keys = [
    "request_id",
    "mode",
    "model_version",
    "prompt_version",
    "image_quality",
    "undertone",
    "chroma",
    "face_shape",
    "quality_flags",
    ...(v2 ? ["eye_shape", "nose_shape", "lip_fullness"] : []),
  ];
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  )
    return null;
  if (
    typeof row.request_id !== "string" ||
    !uuid.test(row.request_id) ||
    (expectedRequestId !== undefined && row.request_id !== expectedRequestId) ||
    row.mode !== "openai_beauty" ||
    row.model_version !== BEAUTY_MODEL_VERSION ||
    (!v2 && row.prompt_version !== BEAUTY_PROMPT_VERSION) ||
    !beautyImageQualities.some((item) => item === row.image_quality) ||
    !beautyUndertones.some((item) => item === row.undertone) ||
    !beautyChromas.some((item) => item === row.chroma) ||
    !beautyFaceShapes.some((item) => item === row.face_shape) ||
    (v2 &&
      (!beautyEyeShapes.some((item) => item === row.eye_shape) ||
        !beautyNoseShapes.some((item) => item === row.nose_shape) ||
        !beautyLipFullnesses.some((item) => item === row.lip_fullness))) ||
    !Array.isArray(row.quality_flags) ||
    row.quality_flags.length > beautyQualityFlags.length ||
    row.quality_flags.some(
      (flag) => !beautyQualityFlags.some((allowed) => flag === allowed),
    ) ||
    new Set(row.quality_flags).size !== row.quality_flags.length ||
    (row.image_quality === "usable" && row.quality_flags.length > 0) ||
    (row.image_quality !== "usable" &&
      (row.quality_flags.length === 0 ||
        row.undertone !== "uncertain" ||
        row.chroma !== "uncertain" ||
        row.face_shape !== "uncertain" ||
        (v2 &&
          (row.eye_shape !== "uncertain" ||
            row.nose_shape !== "uncertain" ||
            row.lip_fullness !== "uncertain")))) ||
    (row.quality_flags.some(
      (flag) => flag === "no_face" || flag === "multiple_faces",
    ) &&
      row.image_quality !== "not_assessable")
  )
    return null;
  const result: BeautyAnalysisV1 = {
    request_id: row.request_id,
    mode: "openai_beauty",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_PROMPT_VERSION,
    image_quality: row.image_quality as BeautyAnalysis["image_quality"],
    undertone: row.undertone as BeautyAnalysis["undertone"],
    chroma: row.chroma as BeautyAnalysis["chroma"],
    face_shape: row.face_shape as BeautyAnalysis["face_shape"],
    quality_flags: [...row.quality_flags] as BeautyAnalysis["quality_flags"],
  };
  if (!v2) return result;
  return {
    ...result,
    prompt_version: BEAUTY_PROMPT_VERSION_V2,
    eye_shape: row.eye_shape as BeautyAnalysisV2["eye_shape"],
    nose_shape: row.nose_shape as BeautyAnalysisV2["nose_shape"],
    lip_fullness: row.lip_fullness as BeautyAnalysisV2["lip_fullness"],
  };
}
export function isBeautyAnalysis(value: unknown): value is BeautyAnalysis {
  return validateBeautyAnalysis(value) !== null;
}
