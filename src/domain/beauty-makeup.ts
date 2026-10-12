/** Guest-photo makeup edits are illustrations, never a product try-on or measured outcome. */
export const BEAUTY_MAKEUP_NOTICE_VERSION = "2026-10-beauty-makeup-v1" as const;
export const BEAUTY_MAKEUP_MODEL_VERSION =
  "gpt-image-2.5-flare-2026-09-08" as const;
export const BEAUTY_MAKEUP_PROMPT_VERSION = "beauty-makeup-preview-v1" as const;
export const beautyMakeupMoodIds = ["soft", "fresh", "defined"] as const;
export const BEAUTY_MAKEUP_MAX_IMAGE_BYTES = 1024 * 1024;
export const BEAUTY_MAKEUP_MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
export interface BeautyMakeupImage {
  id: (typeof beautyMakeupMoodIds)[number];
  image_base64: string;
  mime_type: "image/jpeg";
}
export interface BeautyMakeupResult {
  request_id: string;
  mode: "openai_beauty_makeup";
  model_version: typeof BEAUTY_MAKEUP_MODEL_VERSION;
  prompt_version: typeof BEAUTY_MAKEUP_PROMPT_VERSION;
  images: [BeautyMakeupImage, BeautyMakeupImage, BeautyMakeupImage];
}

function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Bounded canonical JPEG base64 only; this pure boundary does not decode pixels or trust URLs. */
export function validateBeautyMakeupResult(
  value: unknown,
  expectedRequestId?: string,
): BeautyMakeupResult | null {
  if (
    !exact(value, [
      "request_id",
      "mode",
      "model_version",
      "prompt_version",
      "images",
    ]) ||
    typeof value.request_id !== "string" ||
    !uuid.test(value.request_id) ||
    (expectedRequestId !== undefined &&
      value.request_id !== expectedRequestId) ||
    value.mode !== "openai_beauty_makeup" ||
    value.model_version !== BEAUTY_MAKEUP_MODEL_VERSION ||
    value.prompt_version !== BEAUTY_MAKEUP_PROMPT_VERSION ||
    !Array.isArray(value.images) ||
    value.images.length !== 3
  )
    return null;
  const images: BeautyMakeupImage[] = [];
  for (let index = 0; index < beautyMakeupMoodIds.length; index++) {
    const item: unknown = value.images[index];
    if (
      !exact(item, ["id", "image_base64", "mime_type"]) ||
      item.id !== beautyMakeupMoodIds[index] ||
      item.mime_type !== "image/jpeg" ||
      typeof item.image_base64 !== "string" ||
      item.image_base64.length < 8 ||
      item.image_base64.length >
        Math.ceil(BEAUTY_MAKEUP_MAX_IMAGE_BYTES / 3) * 4 ||
      !item.image_base64.startsWith("/9j/") ||
      !base64.test(item.image_base64)
    )
      return null;
    const padding = item.image_base64.endsWith("==")
      ? 2
      : item.image_base64.endsWith("=")
        ? 1
        : 0;
    if (
      (item.image_base64.length / 4) * 3 - padding >
      BEAUTY_MAKEUP_MAX_IMAGE_BYTES
    )
      return null;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (
      (padding === 2 &&
        (alphabet.indexOf(item.image_base64.at(-3)!) & 15) !== 0) ||
      (padding === 1 && (alphabet.indexOf(item.image_base64.at(-2)!) & 3) !== 0)
    )
      return null;
    // Inspect only the final encoded block; generated pixels are decoded/sanitized by the private service.
    if (!atob(item.image_base64.slice(-8)).endsWith("\xff\xd9")) return null;
    images.push({
      id: beautyMakeupMoodIds[index],
      image_base64: item.image_base64,
      mime_type: "image/jpeg",
    });
  }
  if (new Set(images.map((item) => item.image_base64)).size !== 3) return null;
  return {
    request_id: value.request_id,
    mode: "openai_beauty_makeup",
    model_version: BEAUTY_MAKEUP_MODEL_VERSION,
    prompt_version: BEAUTY_MAKEUP_PROMPT_VERSION,
    images: images as BeautyMakeupResult["images"],
  };
}
