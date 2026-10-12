import { validateCatalogDraft } from "./catalog";
import { canonicalizeIngredient, canonicalizeIngredients } from "./ingredients";
import {
  isSkincareCategory,
  type SkinRecommendationContext,
} from "./skin-recommendation-context";
import {
  concerns,
  type Concern,
  type IngredientRule,
  type Product,
  type Questionnaire,
  type Recommendation,
  type RecommendationScope,
} from "./types";

/** Curated demo relevance, not a learned model or medical efficacy rating. */
export const ingredientRules: Readonly<
  Record<Concern, ReadonlyArray<{ ingredient: string; relevance: 1 | 2 | 3 }>>
> = {
  dehydration: [
    { ingredient: "Glycerin", relevance: 3 },
    { ingredient: "Sodium Hyaluronate", relevance: 3 },
    { ingredient: "Hyaluronic Acid", relevance: 3 },
    { ingredient: "Panthenol", relevance: 2 },
    { ingredient: "Ceramide NP", relevance: 2 },
    { ingredient: "Squalane", relevance: 2 },
    { ingredient: "Betaine", relevance: 2 },
  ],
  texture: [
    { ingredient: "Gluconolactone", relevance: 3 },
    { ingredient: "Lactic Acid", relevance: 3 },
    { ingredient: "Salicylic Acid", relevance: 3 },
    { ingredient: "Niacinamide", relevance: 2 },
  ],
  uneven_tone: [
    { ingredient: "Niacinamide", relevance: 3 },
    { ingredient: "Ascorbyl Glucoside", relevance: 3 },
    { ingredient: "Ascorbic Acid", relevance: 3 },
    { ingredient: "Lactic Acid", relevance: 1 },
  ],
  fine_lines: [
    { ingredient: "Palmitoyl Tripeptide-1", relevance: 3 },
    { ingredient: "Niacinamide", relevance: 2 },
    { ingredient: "Sodium Hyaluronate", relevance: 2 },
    { ingredient: "Hyaluronic Acid", relevance: 2 },
  ],
};

export const DEMO_RULES: readonly IngredientRule[] = concerns.flatMap(
  (concern) => ingredientRules[concern].map((rule) => ({ concern, ...rule })),
);

export const concernLabels: Record<Concern, string> = {
  dehydration: "Hydration",
  texture: "Smooth texture",
  uneven_tone: "Even-looking tone",
  fine_lines: "Fine lines",
};

export function recommendProducts(
  products: readonly Product[],
  questionnaire: Questionnaire,
  scope: RecommendationScope,
): Recommendation[] {
  return rankSkinProducts(
    products,
    {
      skinType: questionnaire.skinType,
      selectedConcerns: questionnaire.concerns,
      photoConcerns: [],
      excludedIngredients: questionnaire.excludedIngredients,
      concernWeights: questionnaire.concernWeights,
    },
    scope,
  );
}

export function rankSkinProducts(
  products: readonly Product[],
  context: SkinRecommendationContext,
  scope: RecommendationScope,
): Recommendation[] {
  if (!scope.organizationId || !scope.storeId) return [];
  const selectedConcerns = concerns.filter(
    (concern) =>
      context.selectedConcerns.includes(concern) ||
      context.photoConcerns.includes(concern),
  );
  const rules = (scope.rules ?? DEMO_RULES).flatMap((rule) => {
    const ingredient = canonicalizeIngredient(rule.ingredient);
    return ingredient &&
      [1, 2, 3].includes(rule.relevance) &&
      concerns.includes(rule.concern)
      ? [{ ...rule, ingredient }]
      : [];
  });
  const exclusions = canonicalizeIngredients(context.excludedIngredients);
  // An unresolved exclusion cannot be checked reliably against a bounded vocabulary.
  if (exclusions.unknown.length) return [];
  const excluded = new Set(exclusions.canonical);
  const candidateScores =
    scope.ingredientCandidates === undefined ? null : new Map<string, number>();
  for (const candidate of scope.ingredientCandidates ?? []) {
    const ingredient = canonicalizeIngredient(candidate.ingredient);
    if (
      ingredient &&
      Number.isFinite(candidate.score) &&
      candidate.score > 0 &&
      candidate.score <= 1
    ) {
      candidateScores!.set(
        ingredient,
        Math.max(candidateScores!.get(ingredient) ?? 0, candidate.score),
      );
    }
  }
  const ranked: Recommendation[] = [];
  const seen = new Set<string>();

  for (const product of products) {
    if (
      product.organizationId !== scope.organizationId ||
      product.storeId !== scope.storeId
    )
      continue;
    if (
      !isSkincareCategory(product.category) ||
      product.status !== "published" ||
      !product.visible ||
      product.stock <= 0 ||
      !validateCatalogDraft(product).valid
    )
      continue;
    const ingredients = new Set(
      canonicalizeIngredients(product.ingredients).canonical,
    );
    if ([...excluded].some((ingredient) => ingredients.has(ingredient)))
      continue;
    const key = `${product.organizationId}:${product.storeId}:${product.sku}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const reasons: Recommendation["reasons"] = [];
    let score = 0;
    for (const concern of selectedConcerns) {
      const weight = context.concernWeights?.[concern] ?? 1;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 3) continue;
      const matches = rules
        .filter(
          (rule) =>
            rule.concern === concern &&
            ingredients.has(rule.ingredient) &&
            (candidateScores === null || candidateScores.has(rule.ingredient)),
        )
        .sort(
          (left, right) =>
            right.relevance * (candidateScores?.get(right.ingredient) ?? 1) -
              left.relevance * (candidateScores?.get(left.ingredient) ?? 1) ||
            (left.ingredient < right.ingredient
              ? -1
              : left.ingredient > right.ingredient
                ? 1
                : 0),
        );
      if (matches.length === 0) continue;
      // One reason per concern keeps the score explainable and prevents ingredient-count inflation.
      const match = matches[0];
      score +=
        match.relevance *
        weight *
        (candidateScores?.get(match.ingredient) ?? 1);
      reasons.push({
        concern,
        ingredient: match.ingredient,
        relevance: match.relevance,
      });
    }
    if (score > 0)
      ranked.push({
        product,
        score,
        matchedIngredients: [
          ...new Set(reasons.map(({ ingredient }) => ingredient)),
        ],
        reasons,
      });
  }

  const compareSku = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  const suitable = (product: Product) =>
    context.skinType !== "unsure" &&
    product.suitableSkinTypes.includes(context.skinType)
      ? 1
      : 0;
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      suitable(right.product) - suitable(left.product) ||
      compareSku(left.product.sku, right.product.sku),
  );
  const limit =
    scope.limit === undefined
      ? 3
      : Number.isFinite(scope.limit)
        ? Math.max(0, Math.min(3, Math.floor(scope.limit)))
        : 3;
  if (limit === 0) return [];
  const chosen = new Set<Recommendation>();
  const priorityConcerns = concerns.filter(
    (concern) =>
      selectedConcerns.includes(concern) &&
      scope.priorityConcerns?.includes(concern),
  );
  for (const concern of priorityConcerns) {
    if (chosen.size >= limit) break;
    if (
      [...chosen].some((item) =>
        item.reasons.some((reason) => reason.concern === concern),
      )
    )
      continue;
    const match = ranked.find((item) =>
      item.reasons.some((reason) => reason.concern === concern),
    );
    if (match) chosen.add(match);
  }
  for (const item of ranked) {
    if (chosen.size >= limit) break;
    chosen.add(item);
  }
  // Coverage changes selection, never scores or the original deterministic order.
  return ranked.filter((item) => chosen.has(item));
}
