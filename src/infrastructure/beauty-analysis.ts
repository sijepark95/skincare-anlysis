import { AppError } from "@/application/contracts";
import type { BeautyAnalysisProvider } from "@/application/beauty-consultations";
import {
  validateBeautyAnalysis,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";

/** Private authenticated service transport. No automatic retries or photo-free provider calls. */
export class HttpBeautyAnalysis implements BeautyAnalysisProvider {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}
  async analyze(requestId: string, image: Uint8Array): Promise<BeautyAnalysis> {
    try {
      if (
        !image.length ||
        image.length > 10 * 1024 * 1024 ||
        this.key.length < 32
      )
        throw new Error();
      const response = await fetch(
        `${this.url.replace(/\/$/, "")}/v1/analyze/beauty`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Analysis-Key": this.key,
          },
          body: JSON.stringify({
            request_id: requestId,
            image_base64: Buffer.from(image).toString("base64"),
          }),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(45000),
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
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16384) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const result = validateBeautyAnalysis(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        requestId,
      );
      if (!result) throw new Error();
      return result;
    } catch {
      throw new AppError(
        503,
        "beauty_analysis_unavailable",
        "The photo styling suggestion is unavailable. Choose your style yourself, or finish and start a new consultation.",
      );
    }
  }
}
