import { AppError } from "@/application/contracts";
import {
  BEAUTY_MAKEUP_MAX_RESPONSE_BYTES,
  validateBeautyMakeupResult,
  type BeautyMakeupResult,
} from "@/domain/beauty-makeup";
import { paletteIds, type PaletteId } from "@/domain/personal-color";

/** Bounded memory-only image-edit transport. Durable consent/admission belongs to the application. */
export class HttpBeautyMakeup {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  async generate(
    requestId: string,
    image: Uint8Array,
    paletteId: PaletteId,
  ): Promise<BeautyMakeupResult> {
    try {
      if (
        !image.length ||
        image.length > 10 * 1024 * 1024 ||
        this.key.length < 32 ||
        !paletteIds.includes(paletteId)
      )
        throw new Error();
      const response = await fetch(
        `${this.url.replace(/\/$/, "")}/v1/generate/beauty-makeup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Analysis-Key": this.key,
          },
          body: JSON.stringify({
            request_id: requestId,
            image_base64: Buffer.from(image).toString("base64"),
            palette_id: paletteId,
          }),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(210000),
        },
      );
      if (
        !response.ok ||
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new Error();
      const declared = response.headers.get("content-length");
      if (
        declared &&
        (!/^\d+$/.test(declared) ||
          Number(declared) > BEAUTY_MAKEUP_MAX_RESPONSE_BYTES)
      ) {
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
          if (size > BEAUTY_MAKEUP_MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
        const result = validateBeautyMakeupResult(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          requestId,
        );
        if (!result) throw new Error();
        return result;
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
        reader.releaseLock();
      }
    } catch {
      throw new AppError(
        503,
        "beauty_makeup_unavailable",
        "Your makeup previews could not be generated. Continue with your beauty guide.",
      );
    }
  }
}
