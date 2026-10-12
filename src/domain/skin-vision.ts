import type { Concern } from "./types";

export const OPENAI_SKIN_MODEL = "gpt-4.1-mini-2025-04-14" as const;
export const OPENAI_SKIN_PROMPT_VERSION = "visible-appearance-eval-v1" as const;
export const OPENAI_CONSENT_VERSION = "2026-10-openai-v1";
export const VISION_NOTICE_VERSION = "2026-10-openai-photo-v1";
export const OPENAI_SKIN_DISCLAIMER =
  "AI observations describe visible cosmetic features in this photo, not a diagnosis or calibrated measurement. Lighting, makeup and camera quality can affect results. Photos are processed in memory by this app and are not saved or used for training. With your consent, a metadata-stripped photo is sent to OpenAI; provider retention may apply.";

export const VISION_FEATURES = [
  "visible_redness",
  "visible_spots",
  "visible_pores",
  "visible_fine_lines",
  "visible_flaking",
] as const;
export const VISION_QUALITY_FLAGS = [
  "no_face",
  "multiple_faces",
  "blur",
  "low_light",
  "uneven_lighting",
  "occlusion",
  "makeup_or_filter",
  "face_not_fully_visible",
  "resolution_limited",
] as const;
export const VISION_FEATURE_LABELS = {
  visible_redness: "Redness",
  visible_spots: "Visible spots",
  visible_pores: "Pores",
  visible_fine_lines: "Fine lines",
  visible_flaking: "Flaking",
} as const;
export const VISION_VALUE_LABELS = {
  visible: "Visible in this photo",
  not_visible: "Not visible in this photo",
  uncertain: "Unclear",
  not_assessable: "Unable to assess",
} as const;
export const VISION_QUALITY_LABELS = {
  no_face: "No face detected",
  multiple_faces: "More than one face",
  blur: "Photo is blurred",
  low_light: "Low lighting",
  uneven_lighting: "Uneven lighting",
  occlusion: "Part of the face is covered",
  makeup_or_filter: "Makeup or a filter may affect appearance",
  face_not_fully_visible: "Face is not fully visible",
  resolution_limited: "Photo detail is limited",
} as const;
export type VisionFeature = (typeof VISION_FEATURES)[number];
export type VisionValue = keyof typeof VISION_VALUE_LABELS;
export interface SkinVision {
  prompt_version: typeof OPENAI_SKIN_PROMPT_VERSION;
  image_quality: "usable" | "limited" | "not_assessable";
  quality_flags: (typeof VISION_QUALITY_FLAGS)[number][];
  observed_features: Record<VisionFeature, VisionValue>;
}
export interface OpenAISkinAnalysis {
  request_id: string;
  mode: "openai";
  model_version: typeof OPENAI_SKIN_MODEL;
  quality_status: SkinVision["image_quality"] | "not_provided";
  observations: [];
  disclaimer: string;
  vision: SkinVision | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** Validate the full protocol at every persistence/transport boundary. */
export function isOpenAIAnalysis(value: unknown): value is OpenAISkinAnalysis {
  if (
    !record(value) ||
    !exactKeys(value, [
      "request_id",
      "mode",
      "model_version",
      "quality_status",
      "observations",
      "disclaimer",
      "vision",
    ]) ||
    typeof value.request_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.request_id,
    ) ||
    value.mode !== "openai" ||
    value.model_version !== OPENAI_SKIN_MODEL ||
    value.disclaimer !== OPENAI_SKIN_DISCLAIMER ||
    !Array.isArray(value.observations) ||
    value.observations.length !== 0
  )
    return false;
  if (value.vision === null) return value.quality_status === "not_provided";
  const vision = value.vision;
  if (
    !record(vision) ||
    !exactKeys(vision, [
      "prompt_version",
      "image_quality",
      "quality_flags",
      "observed_features",
    ]) ||
    vision.prompt_version !== OPENAI_SKIN_PROMPT_VERSION ||
    !["usable", "limited", "not_assessable"].includes(
      String(vision.image_quality),
    ) ||
    value.quality_status !== vision.image_quality ||
    !Array.isArray(vision.quality_flags) ||
    new Set(vision.quality_flags).size !== vision.quality_flags.length ||
    vision.quality_flags.some((flag) => !VISION_QUALITY_FLAGS.includes(flag)) ||
    !record(vision.observed_features) ||
    !exactKeys(vision.observed_features, VISION_FEATURES) ||
    Object.values(vision.observed_features).some(
      (item) =>
        typeof item !== "string" || !Object.hasOwn(VISION_VALUE_LABELS, item),
    )
  )
    return false;
  if (vision.image_quality === "usable" && vision.quality_flags.length !== 0)
    return false;
  if (vision.image_quality !== "usable" && vision.quality_flags.length === 0)
    return false;
  if (
    vision.quality_flags.some(
      (flag) => flag === "no_face" || flag === "multiple_faces",
    ) &&
    vision.image_quality !== "not_assessable"
  )
    return false;
  const features = Object.values(vision.observed_features);
  if (
    vision.image_quality === "not_assessable" &&
    features.some((item) => item !== "not_assessable")
  )
    return false;
  return true;
}

/** Cosmetic discovery routing only; visible redness/flaking do not establish sensitivity or hydration. */
export function visibleRecommendationConcerns(
  vision: SkinVision | null,
): Concern[] {
  if (vision?.image_quality !== "usable") return [];
  const goals: Concern[] = [];
  if (vision.observed_features.visible_pores === "visible")
    goals.push("texture");
  if (vision.observed_features.visible_spots === "visible")
    goals.push("uneven_tone");
  if (vision.observed_features.visible_fine_lines === "visible")
    goals.push("fine_lines");
  return goals;
}
