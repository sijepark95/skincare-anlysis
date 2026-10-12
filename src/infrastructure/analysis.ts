import { z } from "zod";
import type {
  Analysis,
  AnalysisProvider,
  Answers,
} from "@/application/contracts";
import { AppError } from "@/application/contracts";
import { isOpenAIAnalysis } from "@/domain/skin-vision";

const mockResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    mode: z.literal("mock"),
    model_version: z.string().min(1).max(100),
    quality_status: z.literal("demo"),
    observations: z
      .array(
        z
          .object({
            concern_id: z.enum([
              "dehydration",
              "texture",
              "uneven_tone",
              "fine_lines",
            ]),
            level: z.enum(["low", "moderate", "high"]),
            score: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    disclaimer: z.string().min(1).max(1000),
  })
  .strict();

const visualCodes = {
  sensitivity: ["NS", "S"],
  pigmentation: ["P0", "P1", "P2"],
  wrinkles: ["W0", "W1", "W2"],
  acne: ["NA", "A"],
  pores: ["NVP", "VP"],
  sagging: ["NSA", "SA"],
  keratin: ["ND", "D"],
  redness: ["NR", "R"],
} as const;
const experimentalResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    mode: z.literal("experimental"),
    model_version: z.string().min(1).max(100),
    quality_status: z.literal("experimental"),
    observations: z.tuple([]),
    disclaimer: z.string().min(1).max(1000),
    visual: z
      .object({
        model_version: z.string().min(1).max(100),
        heads: z
          .array(
            z
              .object({
                key: z.enum([
                  "sensitivity",
                  "pigmentation",
                  "wrinkles",
                  "acne",
                  "pores",
                  "sagging",
                  "keratin",
                  "redness",
                ]),
                label: z.string().min(1).max(80),
                predicted_code: z.string().min(1).max(10),
                probabilities: z
                  .array(
                    z
                      .object({
                        code: z.string().min(1).max(10),
                        probability: z.number().min(0).max(1),
                      })
                      .strict(),
                  )
                  .min(2)
                  .max(3),
              })
              .strict(),
          )
          .length(8),
      })
      .strict()
      .nullable(),
    ingredients: z
      .object({
        model_version: z.string().min(1).max(100),
        candidates: z
          .array(
            z
              .object({
                ingredient: z.string().min(1).max(256),
                score: z.number().min(0).max(1),
              })
              .strict(),
          )
          .min(1)
          .max(128),
        input_coverage: z.array(z.string().min(1).max(200)).max(16),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, ctx) => {
    const heads = result.visual?.heads ?? [];
    const coverage = new Set(result.ingredients.input_coverage);
    const usedPhoto = coverage.has("visual_condition_used_source_contract_v1");
    if (
      coverage.size !== result.ingredients.input_coverage.length ||
      (usedPhoto &&
        (!result.visual ||
          !coverage.has("source_code_contract_aihub71886_v1") ||
          !coverage.has("visual_condition_exact_training_category") ||
          [
            "visual_codes_not_used_for_ingredients",
            "initial_skin_condition_omitted",
            "visual_condition_unseen_in_training_omitted",
            "visual_condition_support_unavailable_omitted",
            "no_photo_questionnaire_only",
          ].some((flag) => coverage.has(flag)))) ||
      (coverage.has("visual_condition_unseen_in_training_omitted") &&
        !result.visual) ||
      (coverage.has("no_photo_questionnaire_only") && result.visual)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid model input provenance",
      });
    if (
      new Set(heads.map((h) => h.key)).size !== heads.length ||
      new Set(
        result.ingredients.candidates.map((c) => c.ingredient.toLowerCase()),
      ).size !== result.ingredients.candidates.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate model outputs" });
    for (const head of heads) {
      const codes: readonly string[] = visualCodes[head.key];
      const values = head.probabilities;
      const max = Math.max(...values.map((p) => p.probability));
      if (
        values.length !== codes.length ||
        new Set(values.map((p) => p.code)).size !== codes.length ||
        values.some((p) => !codes.includes(p.code)) ||
        !codes.includes(head.predicted_code) ||
        Math.abs(values.reduce((sum, p) => sum + p.probability, 0) - 1) >
          0.001 ||
        values.find((p) => p.code === head.predicted_code)?.probability !== max
      )
        ctx.addIssue({ code: "custom", message: "Invalid visual output" });
    }
  });
export class LocalMockAnalysis implements AnalysisProvider {
  async analyze(sessionId: string, answers: Answers): Promise<Analysis> {
    return {
      request_id: sessionId,
      mode: "mock",
      model_version: "mock-1.0-local",
      quality_status: "demo",
      observations: answers.concerns.map((concern_id, i) => ({
        concern_id,
        level: i === 0 ? "moderate" : "low",
        score: i === 0 ? 0.6 : 0.3,
      })),
      disclaimer:
        "Illustrative mock results based on your selected preferences. Your photo is not analyzed. This is not a medical assessment.",
    };
  }
}
export class HttpAnalysis implements AnalysisProvider {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly mode: "mock" | "experimental" | "openai" = "mock",
  ) {}
  async analyze(
    sessionId: string,
    answers: Answers,
    image?: Uint8Array,
  ): Promise<Analysis> {
    try {
      if (
        image &&
        (this.mode === "mock" ||
          image.length === 0 ||
          image.length > 10 * 1024 * 1024)
      )
        throw new Error("Unsupported image request");
      const response = await fetch(
        `${this.url.replace(/\/$/, "")}/v1/analyze${this.mode === "mock" ? "" : `/${this.mode}`}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Analysis-Key": this.key,
          },
          body: JSON.stringify({
            request_id: sessionId,
            concern_ids: answers.concerns,
            skin_type: answers.skinType,
            sensitive: answers.sensitive,
            ...(image
              ? { image_base64: Buffer.from(image).toString("base64") }
              : {}),
          }),
          signal: AbortSignal.timeout(
            this.mode === "experimental"
              ? 60000
              : this.mode === "openai"
                ? 45000
                : 10000,
          ),
          cache: "no-store",
          redirect: "error",
        },
      );
      if (!response.ok) {
        if (this.mode !== "mock" && response.status === 422 && image)
          throw new AppError(
            422,
            "photo_not_supported",
            this.mode === "openai"
              ? "The photo could not be analyzed. Continue without a photo, or start a new consultation with a clear JPEG, PNG or WebP image."
              : "The model could not read this photo. Choose a clear, static JPEG, PNG or WebP image at least 224 × 224 pixels and try again.",
          );
        throw new Error("Analysis service rejected request");
      }
      const body = await readAnalysisResponse(response);
      if (this.mode === "openai") {
        if (
          !isOpenAIAnalysis(body) ||
          body.request_id !== sessionId ||
          Boolean(body.vision) !== Boolean(image)
        )
          throw new Error("Unexpected OpenAI photo response");
        return body;
      }
      if (this.mode === "experimental") {
        const result = experimentalResponseSchema.parse(body);
        if (
          result.request_id !== sessionId ||
          Boolean(result.visual) !== Boolean(image)
        )
          throw new Error("Unexpected experimental response");
        return result;
      }
      const result = mockResponseSchema.parse(body);
      const returned = new Set(
        result.observations.map((observation) => observation.concern_id),
      );
      if (
        result.request_id !== sessionId ||
        returned.size !== result.observations.length ||
        returned.size !== answers.concerns.length ||
        answers.concerns.some((concern) => !returned.has(concern))
      )
        throw new Error("Unexpected analysis response");
      return result;
    } catch (error) {
      if (error instanceof AppError && error.code === "photo_not_supported")
        throw error;
      throw new AppError(
        503,
        "analysis_unavailable",
        this.mode === "openai"
          ? "Photo analysis is unavailable. Continue without a photo, or start a new consultation to try another photo."
          : "The analysis service is unavailable. Your preferences are safe to retry during this session.",
      );
    }
  }
}

async function readAnalysisResponse(response: Response): Promise<unknown> {
  if (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    throw new Error("Expected a JSON analysis response");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing analysis response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16384) {
      await reader.cancel();
      throw new Error("Analysis response is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}
