import { AppError } from "@/application/contracts";
import {
  BEAUTY_PREVIEW_MAX_RESPONSE_BYTES,
  validateBeautyCompleteAnalysis,
  validateBeautyPreviewResult,
  type BeautyCompleteAnalysis,
  type BeautyPreviewIndex,
  type BeautyPreviewKind,
  type BeautyPreviewResult,
} from "@/domain/beauty-complete";
import { faceShapes, type BeautyFaceShape } from "@/domain/beauty";
import { paletteIds, type PaletteId } from "@/domain/personal-color";
import {
  isStylingDirection,
  type StylingDirection,
} from "@/domain/beauty-styling";

/** Private authenticated, bounded, stateless transport. Admission and consent belong to use cases. */
async function callPrivate(
  url: string,
  key: string,
  path: string,
  body: unknown,
  maximum: number,
  timeout: number,
): Promise<unknown> {
  const response = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Analysis-Key": key },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  if (
    !response.ok ||
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    await response.body?.cancel();
    throw new Error();
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
    reader.releaseLock();
  }
}
function validInput(key: string, image: Uint8Array): boolean {
  return (
    key.length >= 32 && image.length > 0 && image.length <= 10 * 1024 * 1024
  );
}

export class HttpBeautyCompleteProvider {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}
  async analyze(
    requestId: string,
    image: Uint8Array,
  ): Promise<BeautyCompleteAnalysis> {
    try {
      if (!validInput(this.key, image)) throw new Error();
      const result = validateBeautyCompleteAnalysis(
        await callPrivate(
          this.url,
          this.key,
          "/v1/analyze/beauty-complete",
          {
            request_id: requestId,
            image_base64: Buffer.from(image).toString("base64"),
          },
          32768,
          45000,
        ),
        requestId,
      );
      if (!result) throw new Error();
      return result;
    } catch {
      throw new AppError(
        503,
        "beauty_complete_unavailable",
        "Photo observations are unavailable. Continue without a photo or finish this session.",
      );
    }
  }
}
export class HttpBeautyPreviewProvider {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}
  async generate(
    requestId: string,
    image: Uint8Array,
    paletteId: PaletteId,
    kind: BeautyPreviewKind,
    index: BeautyPreviewIndex,
    faceShape: BeautyFaceShape,
    stylingDirection: StylingDirection = "balanced",
  ): Promise<BeautyPreviewResult> {
    try {
      if (
        !validInput(this.key, image) ||
        !paletteIds.includes(paletteId) ||
        !["makeup", "hair_style", "hair_color"].includes(kind) ||
        ![0, 1, 2].includes(index) ||
        !faceShapes.includes(faceShape) ||
        !isStylingDirection(stylingDirection)
      )
        throw new Error();
      const result = validateBeautyPreviewResult(
        await callPrivate(
          this.url,
          this.key,
          "/v1/generate/beauty-preview",
          {
            request_id: requestId,
            image_base64: Buffer.from(image).toString("base64"),
            palette_id: paletteId,
            kind,
            index,
            face_shape: faceShape,
            styling_direction: stylingDirection,
          },
          BEAUTY_PREVIEW_MAX_RESPONSE_BYTES,
          75000,
        ),
        requestId,
        kind,
        index,
      );
      if (!result) throw new Error();
      return result;
    } catch {
      throw new AppError(
        503,
        "beauty_preview_unavailable",
        "This preview could not be generated. Continue with your beauty guide.",
      );
    }
  }
}
