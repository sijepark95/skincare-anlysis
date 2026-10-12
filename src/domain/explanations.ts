import { canonicalizeIngredient } from "./ingredients";
import { concernLabels } from "./recommendations";
import { concerns, type Recommendation } from "./types";

export const EXPLANATION_PROMPT_VERSION = "retail-match-v1";
export const EXPLANATION_NOTICE_VERSION = "2026-10-openai-explanation-v1";

/** Local-only provenance, derived by the use case; never part of provider input. */
export const explanationBases = [
  "selected_goals",
  "mock",
  "questionnaire_only",
  "photo_contributed",
  "photo_unseen",
  "photo_not_used",
] as const;
export type ExplanationBasis = (typeof explanationBases)[number];

const basisSummaries: Record<ExplanationBasis, string> = {
  selected_goals: "",
  mock: "This is a demonstration; your photo was not analyzed. ",
  questionnaire_only:
    "No photo was analyzed. Ingredient ranking uses supported questionnaire fields. ",
  photo_contributed:
    "Your photo's experimental outputs contributed to ingredient ranking. They do not establish a skin diagnosis or an ingredient's efficacy. ",
  photo_unseen:
    "Your photo was analyzed, but its code combination was not present in recommendation training. Photo outputs were omitted from ingredient ranking; matching uses supported questionnaire fields. ",
  photo_not_used:
    "Your photo was analyzed, but its outputs were not used for ingredient ranking. Matching uses supported questionnaire fields. ",
};

/** Only an allowlisted matching fact leaves the application. Refs are per request. */
export interface ExplanationInput {
  products: {
    productRef: string;
    facts: { reasonRef: string; ingredient: string; concern: string }[];
  }[];
}

export const explanationWordings = ["ingredient_first", "goal_first"] as const;
export type ExplanationWording = (typeof explanationWordings)[number];

/** The model has no field in which to invent advice, efficacy or product claims. */
export interface ExplanationPlan {
  products: {
    productRef: string;
    reasonRefs: string[];
    wording: ExplanationWording;
  }[];
}

export interface RenderedExplanation {
  status: "generated" | "fallback";
  summary: string;
  products: { productId: string; text: string }[];
  modelVersion: string | null;
  promptVersion: string;
}

function invalid(): never {
  throw new Error("The explanation could not be verified.");
}

function objectWithKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function buildExplanationInput(
  recommendations: readonly Recommendation[],
): ExplanationInput {
  if (recommendations.length > 3) invalid();
  const seenProducts = new Set<string>();
  let nextReason = 1;
  return {
    products: recommendations.map((recommendation, index) => {
      if (
        !recommendation.product.id ||
        seenProducts.has(recommendation.product.id) ||
        recommendation.reasons.length < 1 ||
        recommendation.reasons.length > concerns.length
      )
        invalid();
      seenProducts.add(recommendation.product.id);
      const formula = new Set(
        recommendation.product.ingredients.map(canonicalizeIngredient),
      );
      const matched = new Set(
        recommendation.matchedIngredients.map(canonicalizeIngredient),
      );
      const seenConcerns = new Set<string>();
      const facts = recommendation.reasons.map((reason) => {
        const ingredient = canonicalizeIngredient(reason.ingredient);
        if (
          !ingredient ||
          !concerns.includes(reason.concern) ||
          seenConcerns.has(reason.concern) ||
          !formula.has(ingredient) ||
          !matched.has(ingredient) ||
          ![1, 2, 3].includes(reason.relevance)
        )
          invalid();
        seenConcerns.add(reason.concern);
        return {
          reasonRef: `R${nextReason++}`,
          ingredient,
          concern: concernLabels[reason.concern],
        };
      });
      return { productRef: `P${index + 1}`, facts };
    }),
  };
}

/** Validate the minimized input even when a provider is called outside the use case. */
export function validateExplanationInput(value: unknown): ExplanationInput {
  if (
    !objectWithKeys(value, ["products"]) ||
    !Array.isArray(value.products) ||
    value.products.length > 3
  )
    invalid();
  let nextReason = 1;
  const products = value.products.map((product, index) => {
    if (
      !objectWithKeys(product, ["productRef", "facts"]) ||
      product.productRef !== `P${index + 1}` ||
      !Array.isArray(product.facts) ||
      product.facts.length < 1 ||
      product.facts.length > concerns.length
    )
      invalid();
    const seenConcerns = new Set<string>();
    const facts = product.facts.map((fact) => {
      if (
        !objectWithKeys(fact, ["reasonRef", "ingredient", "concern"]) ||
        fact.reasonRef !== `R${nextReason++}` ||
        typeof fact.ingredient !== "string" ||
        canonicalizeIngredient(fact.ingredient) !== fact.ingredient ||
        typeof fact.concern !== "string" ||
        !Object.values(concernLabels).includes(fact.concern) ||
        seenConcerns.has(fact.concern)
      )
        invalid();
      seenConcerns.add(fact.concern);
      return {
        reasonRef: fact.reasonRef as string,
        ingredient: fact.ingredient,
        concern: fact.concern,
      };
    });
    return { productRef: product.productRef as string, facts };
  });
  return { products };
}

export function validateExplanationPlan(
  input: ExplanationInput,
  value: unknown,
): ExplanationPlan {
  const safeInput = validateExplanationInput(input);
  if (
    !objectWithKeys(value, ["products"]) ||
    !Array.isArray(value.products) ||
    value.products.length !== safeInput.products.length
  )
    invalid();
  const products = value.products.map((product, index) => {
    const source = safeInput.products[index];
    if (
      !objectWithKeys(product, ["productRef", "reasonRefs", "wording"]) ||
      product.productRef !== source.productRef ||
      !Array.isArray(product.reasonRefs) ||
      product.reasonRefs.length < 1 ||
      product.reasonRefs.length > Math.min(2, source.facts.length) ||
      new Set(product.reasonRefs).size !== product.reasonRefs.length ||
      !product.reasonRefs.every(
        (ref) =>
          typeof ref === "string" &&
          source.facts.some((fact) => fact.reasonRef === ref),
      ) ||
      !explanationWordings.includes(product.wording as ExplanationWording)
    )
      invalid();
    return {
      productRef: source.productRef,
      reasonRefs: [...product.reasonRefs] as string[],
      wording: product.wording as ExplanationWording,
    };
  });
  return { products };
}

/** Rendering only audited sentences makes schema-valid model mistakes harmless. */
export function renderExplanation(
  recommendations: readonly Recommendation[],
  plan: ExplanationPlan,
  options: {
    status: "generated" | "fallback";
    modelVersion: string | null;
    analysisBasis?: ExplanationBasis;
  },
): RenderedExplanation {
  const input = buildExplanationInput(recommendations);
  const verified = validateExplanationPlan(input, plan);
  const basis = options.analysisBasis ?? "selected_goals";
  if (
    !["generated", "fallback"].includes(options.status) ||
    !explanationBases.includes(basis) ||
    (options.status === "generated" &&
      (typeof options.modelVersion !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(options.modelVersion))) ||
    (options.status === "fallback" && options.modelVersion !== null)
  )
    invalid();
  return {
    status: options.status,
    summary:
      basisSummaries[basis] +
      (recommendations.length
        ? "Matched from this store's catalog using your selected goals and registered ingredients."
        : "No eligible products match this store's current catalog rules."),
    products: verified.products.map((product, index) => ({
      productId: recommendations[index].product.id,
      text: product.reasonRefs
        .map((ref) => {
          const fact = input.products[index].facts.find(
            (item) => item.reasonRef === ref,
          )!;
          const goal = fact.concern.toLocaleLowerCase("en-US");
          return product.wording === "goal_first"
            ? `For your ${goal} goal, this store's rule matches ${fact.ingredient} in the registered formula.`
            : `${fact.ingredient} is listed in the formula and matches this store's rule for your ${goal} goal.`;
        })
        .join(" "),
    })),
    modelVersion: options.modelVersion,
    promptVersion: EXPLANATION_PROMPT_VERSION,
  };
}

export function fallbackExplanation(
  recommendations: readonly Recommendation[],
  analysisBasis: ExplanationBasis = "selected_goals",
): RenderedExplanation {
  const input = buildExplanationInput(recommendations);
  return renderExplanation(
    recommendations,
    {
      products: input.products.map((product) => ({
        productRef: product.productRef,
        reasonRefs: product.facts.slice(0, 2).map((fact) => fact.reasonRef),
        wording: "ingredient_first",
      })),
    },
    { status: "fallback", modelVersion: null, analysisBasis },
  );
}
