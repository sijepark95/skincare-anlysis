import type {
  ExplanationInput,
  ExplanationPlan,
  RenderedExplanation,
} from "@/domain/explanations";

export {
  EXPLANATION_NOTICE_VERSION,
  EXPLANATION_PROMPT_VERSION,
} from "@/domain/explanations";
export type { ExplanationInput, ExplanationPlan } from "@/domain/explanations";

/** Transient matching copy, never a new ranking, diagnosis or scientific claim. */
export type RecommendationExplanation = RenderedExplanation;

export interface ExplanationProvider {
  readonly modelVersion: string;
  explain(input: ExplanationInput): Promise<ExplanationPlan>;
}
