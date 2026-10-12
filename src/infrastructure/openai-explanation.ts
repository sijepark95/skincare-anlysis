import "server-only";
import type { ExplanationProvider } from "@/application/explanation-contracts";
import {
  EXPLANATION_PROMPT_VERSION,
  explanationWordings,
  validateExplanationInput,
  validateExplanationPlan,
  type ExplanationInput,
  type ExplanationPlan,
} from "@/domain/explanations";

export const OPENAI_EXPLANATION_MODEL = "gpt-4.1-mini-2025-04-14";
const endpoint = "https://api.openai.com/v1/responses";
const maxResponseBytes = 32 * 1024;
const instructions = `You select presentation choices for ${EXPLANATION_PROMPT_VERSION}.
The application has already selected and ranked all products. Preserve every productRef in its original order.
For each product, choose the clearest one or two of its own supplied reasonRefs and one allowed wording.
The supplied facts describe registered ingredients matched to store catalog rules for selected goals.
They are not scientific evidence of efficacy, concentration, diagnosis, allergy safety, suitability or treatment.
Never invent facts, change ranking, add products, interpret skin codes or supply advice. Return only the requested JSON.`;

const planSchema = {
  type: "object",
  properties: {
    products: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          productRef: { type: "string", enum: ["P1", "P2", "P3"] },
          reasonRefs: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              type: "string",
              enum: Array.from({ length: 12 }, (_, index) => `R${index + 1}`),
            },
          },
          wording: { type: "string", enum: [...explanationWordings] },
        },
        required: ["productRef", "reasonRefs", "wording"],
        additionalProperties: false,
      },
    },
  },
  required: ["products"],
  additionalProperties: false,
};

function failed(): Error {
  // No upstream body, credential, input fact or remote error enters application errors.
  return new Error("The explanation service is unavailable.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    throw failed();
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)
  )
    throw failed();
  if (!response.body) throw failed();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) throw failed();
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function outputText(value: unknown): string {
  if (
    !record(value) ||
    value.status !== "completed" ||
    (value.error !== undefined && value.error !== null) ||
    (value.incomplete_details !== undefined &&
      value.incomplete_details !== null) ||
    !Array.isArray(value.output) ||
    value.output.length !== 1
  )
    throw failed();
  const message = value.output[0];
  if (
    !record(message) ||
    message.type !== "message" ||
    message.status !== "completed" ||
    message.role !== "assistant" ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  )
    throw failed();
  const content = message.content[0];
  if (
    !record(content) ||
    content.type !== "output_text" ||
    typeof content.text !== "string" ||
    !content.text ||
    (content.annotations !== undefined &&
      (!Array.isArray(content.annotations) || content.annotations.length !== 0))
  )
    throw failed();
  return content.text;
}

export class OpenAiExplanationProvider implements ExplanationProvider {
  readonly modelVersion: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    apiKey: string;
    model?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    const model = options.model ?? OPENAI_EXPLANATION_MODEL;
    if (
      !options.apiKey ||
      options.apiKey.length > 512 ||
      /[\s\x00-\x1f\x7f]/.test(options.apiKey) ||
      ![OPENAI_EXPLANATION_MODEL, "gpt-4.1-mini"].includes(model) ||
      (options.timeoutMs !== undefined &&
        (!Number.isInteger(options.timeoutMs) ||
          options.timeoutMs < 1 ||
          options.timeoutMs > 8_000))
    )
      throw failed();
    this.apiKey = options.apiKey;
    this.modelVersion = model;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async explain(input: ExplanationInput): Promise<ExplanationPlan> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const minimized = validateExplanationInput(input);
      if (minimized.products.length === 0) return { products: [] };
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(failed());
        }, this.timeoutMs);
      });
      return await Promise.race([
        (async () => {
          const response = await this.fetcher(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            redirect: "error",
            cache: "no-store",
            body: JSON.stringify({
              model: this.modelVersion,
              instructions,
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: JSON.stringify(minimized) },
                  ],
                },
              ],
              store: false,
              max_output_tokens: 512,
              text: {
                format: {
                  type: "json_schema",
                  name: "retail_match_plan",
                  strict: true,
                  schema: planSchema,
                },
              },
            }),
          });
          const envelope = await boundedJson(response, controller.signal);
          return validateExplanationPlan(
            minimized,
            JSON.parse(outputText(envelope)),
          );
        })(),
        deadline,
      ]);
    } catch {
      throw failed();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}
