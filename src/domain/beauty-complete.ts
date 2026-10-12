import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
  validateBeautyAnalysis,
  type BeautyAnalysisV2,
} from "./beauty-analysis";
import {
  BEAUTY_MAKEUP_MAX_IMAGE_BYTES,
  BEAUTY_MAKEUP_MODEL_VERSION,
} from "./beauty-makeup";
import {
  OPENAI_SKIN_DISCLAIMER,
  isOpenAIAnalysis,
  type SkinVision,
} from "./skin-vision";

export const BEAUTY_COMPLETE_PROMPT_VERSION = "beauty-complete-v1" as const;
export const BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION =
  "2026-10-beauty-complete-photo-v1" as const;
export const BEAUTY_PREVIEW_NOTICE_VERSION =
  "2026-10-beauty-preview-v1" as const;
export const BEAUTY_PREVIEW_PROMPT_VERSION = "beauty-preview-v1" as const;
export const BEAUTY_PREVIEW_MODEL_VERSION = BEAUTY_MAKEUP_MODEL_VERSION;
export const BEAUTY_PREVIEW_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const beautyAnimalVibes = [
  "cat",
  "dog",
  "rabbit",
  "fox",
  "deer",
  "bear",
  "uncertain",
] as const;
export const beautyBaseDepths = [
  "fair",
  "light",
  "medium",
  "tan",
  "deep",
  "uncertain",
] as const;
export const beautyPreviewKinds = [
  "makeup",
  "hair_style",
  "hair_color",
] as const;
export type BeautyAnimalVibe = (typeof beautyAnimalVibes)[number];
export type BeautyBaseDepth = (typeof beautyBaseDepths)[number];
export type BeautyPreviewKind = (typeof beautyPreviewKinds)[number];
export type BeautyPreviewIndex = 0 | 1 | 2;

/** Transient envelope. Animal association must never be persisted with the observation rows. */
export interface BeautyCompleteAnalysis {
  request_id: string;
  mode: "openai_beauty_complete";
  model_version: typeof BEAUTY_MODEL_VERSION;
  prompt_version: typeof BEAUTY_COMPLETE_PROMPT_VERSION;
  beauty: BeautyAnalysisV2;
  skin: SkinVision;
  animalVibe: BeautyAnimalVibe;
  baseDepth: BeautyBaseDepth;
}
export interface BeautyPreviewResult {
  request_id: string;
  kind: BeautyPreviewKind;
  index: BeautyPreviewIndex;
  mime_type: "image/jpeg";
  image_base64: string;
  model_version: typeof BEAUTY_PREVIEW_MODEL_VERSION;
  prompt_version: typeof BEAUTY_PREVIEW_PROMPT_VERSION;
}

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Reuse strict existing skin and v2 beauty checks without weakening either legacy protocol. */
export function validateBeautyCompleteAnalysis(
  value: unknown,
  expectedRequestId?: string,
): BeautyCompleteAnalysis | null {
  if (
    !exact(value, [
      "request_id",
      "mode",
      "model_version",
      "prompt_version",
      "beauty",
      "skin",
      "animalVibe",
      "baseDepth",
    ]) ||
    typeof value.request_id !== "string" ||
    (expectedRequestId !== undefined &&
      value.request_id !== expectedRequestId) ||
    value.mode !== "openai_beauty_complete" ||
    value.model_version !== BEAUTY_MODEL_VERSION ||
    value.prompt_version !== BEAUTY_COMPLETE_PROMPT_VERSION ||
    !beautyAnimalVibes.some((item) => item === value.animalVibe) ||
    !beautyBaseDepths.some((item) => item === value.baseDepth)
  )
    return null;
  const beauty = validateBeautyAnalysis(value.beauty, value.request_id);
  if (!beauty || beauty.prompt_version !== BEAUTY_PROMPT_VERSION_V2)
    return null;
  if (
    !isOpenAIAnalysis({
      request_id: value.request_id,
      mode: "openai",
      model_version: BEAUTY_MODEL_VERSION,
      quality_status: (value.skin as SkinVision | null)?.image_quality,
      observations: [],
      disclaimer: OPENAI_SKIN_DISCLAIMER,
      vision: value.skin,
    }) ||
    value.skin === null
  )
    return null;
  if (
    beauty.image_quality !== "usable" &&
    (value.animalVibe !== "uncertain" || value.baseDepth !== "uncertain")
  )
    return null;
  return {
    request_id: value.request_id,
    mode: "openai_beauty_complete",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_COMPLETE_PROMPT_VERSION,
    beauty,
    skin: structuredClone(value.skin) as SkinVision,
    animalVibe: value.animalVibe as BeautyAnimalVibe,
    baseDepth: value.baseDepth as BeautyBaseDepth,
  };
}
export function isBeautyCompleteAnalysis(
  value: unknown,
): value is BeautyCompleteAnalysis {
  return validateBeautyCompleteAnalysis(value) !== null;
}

/** Single canonical JPEG, bound to its durable slot; URLs and provider prose are rejected. */
export function validateBeautyPreviewResult(
  value: unknown,
  expectedRequestId?: string,
  expectedKind?: BeautyPreviewKind,
  expectedIndex?: BeautyPreviewIndex,
): BeautyPreviewResult | null {
  if (
    !exact(value, [
      "request_id",
      "kind",
      "index",
      "mime_type",
      "image_base64",
      "model_version",
      "prompt_version",
    ]) ||
    !beautyPreviewKinds.some((item) => item === value.kind) ||
    ![0, 1, 2].includes(value.index as number) ||
    (expectedKind !== undefined && value.kind !== expectedKind) ||
    (expectedIndex !== undefined && value.index !== expectedIndex) ||
    value.model_version !== BEAUTY_PREVIEW_MODEL_VERSION ||
    value.prompt_version !== BEAUTY_PREVIEW_PROMPT_VERSION
  )
    return null;
  if (
    typeof value.request_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.request_id,
    ) ||
    (expectedRequestId !== undefined &&
      value.request_id !== expectedRequestId) ||
    value.mime_type !== "image/jpeg" ||
    typeof value.image_base64 !== "string" ||
    value.image_base64.length < 8 ||
    value.image_base64.length >
      Math.ceil(BEAUTY_MAKEUP_MAX_IMAGE_BYTES / 3) * 4 ||
    !value.image_base64.startsWith("/9j/") ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.image_base64,
    )
  )
    return null;
  const encoded = value.image_base64;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (encoded.length / 4) * 3 - padding > BEAUTY_MAKEUP_MAX_IMAGE_BYTES ||
    (padding === 2 && (alphabet.indexOf(encoded.at(-3)!) & 15) !== 0) ||
    (padding === 1 && (alphabet.indexOf(encoded.at(-2)!) & 3) !== 0) ||
    !atob(encoded.slice(-8)).endsWith("\xff\xd9")
  )
    return null;
  return {
    request_id: value.request_id,
    kind: value.kind as BeautyPreviewKind,
    index: value.index as BeautyPreviewIndex,
    mime_type: "image/jpeg",
    image_base64: encoded,
    model_version: BEAUTY_PREVIEW_MODEL_VERSION,
    prompt_version: BEAUTY_PREVIEW_PROMPT_VERSION,
  };
}
