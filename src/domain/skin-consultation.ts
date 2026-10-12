import { validateCatalogDraft } from "./catalog";
import { ingredientPurpose } from "./ingredient-knowledge";
import { canonicalizeIngredient, canonicalizeIngredients } from "./ingredients";
import {
  isSkincareCategory,
  type SkinRecommendationContext,
} from "./skin-recommendation-context";
import { concernLabels } from "./recommendations";
import {
  VISION_FEATURE_LABELS,
  VISION_FEATURES,
  VISION_QUALITY_LABELS,
  VISION_VALUE_LABELS,
  visibleRecommendationConcerns,
  type SkinVision,
  type VisionFeature,
  type VisionValue,
} from "./skin-vision";
import {
  concerns,
  type Concern,
  type IngredientRule,
  type Questionnaire,
  type Recommendation,
} from "./types";

export type SkinConsultationSource = "selected" | "photo" | "both";

export interface SkinConsultationObservation {
  feature: VisionFeature;
  label: string;
  value: VisionValue;
  statusLabel: string;
  interpretation: string;
  recommendationUse: string;
}

export interface SkinConsultationGoal {
  concern: Concern;
  label: string;
  source: SkinConsultationSource;
  explanation: string;
  approvedIngredientCount: number;
  recommendedProductCount: number;
  coverage: "matched_products" | "ingredients_only" | "no_eligible_ingredients";
  coverageExplanation: string;
}

export interface SkinConsultationIngredient {
  ingredient: string;
  goals: Concern[];
  rationale: string;
  availableInMatchedProducts: boolean;
  matchedProductIds: string[];
}

export interface SkinConsultationProductReason {
  concern: Concern;
  ingredient: string;
  source: SkinConsultationSource;
  explanation: string;
}

export interface SkinConsultationProduct {
  productId: string;
  reasons: SkinConsultationProductReason[];
  explanation: string;
}

export interface SkinConsultationReport {
  version: "skin-consultation-v1";
  status:
    | "photo_based"
    | "limited_photo"
    | "unassessable_photo"
    | "questionnaire_only";
  title: string;
  summary: string;
  paragraphs: string[];
  observations: SkinConsultationObservation[];
  goals: SkinConsultationGoal[];
  ingredients: SkinConsultationIngredient[];
  products: SkinConsultationProduct[];
  policyVersion: string | null;
  limitations: string[];
}

export interface SkinConsultationInput {
  vision: SkinVision | null;
  questionnaire?: Questionnaire;
  context?: SkinRecommendationContext;
  /** Only the applicable reviewed policy; there is deliberately no demo fallback. */
  rules: readonly IngredientRule[];
  /** Existing, tenant-scoped eligible matches, never a newly generated catalog. */
  recommendations: readonly Recommendation[];
  policyVersion?: string | null;
  policySource?: string;
}

const featureInterpretations: Record<
  VisionFeature,
  Record<VisionValue, string>
> = {
  visible_redness: {
    visible:
      "Redness is visible as a color feature in your photo. We keep this in your appearance summary and use the sensitivity preferences you supplied for product matching.",
    not_visible:
      "Your captured skin appearance does not show clearly visible redness. Lighting and makeup can change how color appears in a single photo.",
    uncertain:
      "Redness is not clear enough to characterize in this photo. Your reported sensitivity preferences remain the basis for matching suitable catalog options.",
    not_assessable:
      "Visible redness could not be assessed from this image. Your selected cosmetic goals and sensitivity preferences still provide a starting point for this consultation.",
  },
  visible_spots: {
    visible:
      "Spots are visible as differences in your skin's captured appearance. A usable observation can inform an even-looking tone goal; the image does not identify the type or cause of a spot.",
    not_visible:
      "Your photo does not show clearly visible spots. Any even-looking tone goal you selected remains part of matching, because one image may not capture every area or subtle variation.",
    uncertain:
      "Tone differences could not be characterized clearly in this photo. Uneven light, makeup or limited image detail can make spots difficult to distinguish.",
    not_assessable:
      "Visible spots could not be assessed from this image. An even-looking tone goal can still be included when it is one of the preferences you selected.",
  },
  visible_pores: {
    visible:
      "Pores are part of the visible surface texture in your photo. This supports exploring smoother-looking texture; it does not measure pore size or oil production, and does not establish that an ingredient will shrink pores.",
    not_visible:
      "Pores are not clearly visible at this photo's captured distance and detail. A smoother-looking texture goal you selected still contributes to the ingredient shortlist.",
    uncertain:
      "Pore visibility is unclear in this photo. Camera detail and lighting can influence surface texture, so matching follows your selected texture preference.",
    not_assessable:
      "Pore appearance could not be assessed from this image. Your selected texture goal remains useful when comparing the store's ingredient-led cosmetic formulas.",
  },
  visible_fine_lines: {
    visible:
      "Fine lines are visible in the captured skin surface. A usable observation can inform a cosmetic fine-lines goal when comparing formulas; this is not a measurement of line depth.",
    not_visible:
      "Fine lines are not clearly visible in this captured view. Expression, lighting and image detail affect their appearance, while any fine-lines goal you selected still guides matching.",
    uncertain:
      "Fine-line detail is unclear in this photo. Your selected fine-lines preference can still guide ingredient discovery without adding a priority from this uncertain observation.",
    not_assessable:
      "Fine-line appearance could not be assessed from this image. The consultation can still compare cosmetic formulas using the goals you selected.",
  },
  visible_flaking: {
    visible:
      "Surface flaking is visible in your photo and is included as context in your appearance summary. Your hydration preference comes from your answers, because visible flakes do not measure skin moisture.",
    not_visible:
      "Your captured skin surface does not show clearly visible flaking. Hydration matching continues to follow your preferences, since how skin feels is not fully captured in a photo.",
    uncertain:
      "Surface flaking is not clear enough to characterize in this photo. Reflections, makeup or limited detail can affect how the skin surface appears.",
    not_assessable:
      "Surface flaking could not be assessed from this image. Your stated hydration preferences still guide the moisturizing ingredients considered in the store's guide.",
  },
};

const goalFeature: Partial<Record<Concern, VisionFeature>> = {
  texture: "visible_pores",
  uneven_tone: "visible_spots",
  fine_lines: "visible_fine_lines",
};

const goalInterpretations: Record<Concern, string> = {
  dehydration:
    "Focus on moisturizing formulas that fit your preferred routine and skin feel. The ingredient shortlist uses your stated hydration preference.",
  texture:
    "Focus on a smoother-looking skin surface. Compare the complete formulas and their labeled use when choosing a product for your texture preference.",
  uneven_tone:
    "Focus on a more even-looking tone. The ingredient guide helps compare cosmetic formulas associated with the appearance of visible tone differences.",
  fine_lines:
    "Focus on the cosmetic appearance of fine lines. Use the ingredient shortlist and full product label to choose a formula that fits a simple routine.",
};

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function joinLabels(labels: readonly string[]): string {
  if (labels.length < 2) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function sourceText(source: SkinConsultationSource): string {
  if (source === "both")
    return "your selected goal and usable photo observation";
  if (source === "photo") return "your usable photo observation";
  return "your selected goal";
}

/**
 * Interpret only the saved, bounded observations and reviewed matching facts.
 * This is a deterministic cosmetic consultation, not another provider request,
 * a new skin classifier, an ingredient-efficacy model or a catalog generator.
 */
export function buildSkinConsultation({
  vision,
  questionnaire,
  context,
  rules,
  recommendations,
  policyVersion,
  policySource,
}: SkinConsultationInput): SkinConsultationReport {
  if (!questionnaire && !context) throw new Error("skin_context_required");
  const selectedConcerns = context?.selectedConcerns ?? questionnaire!.concerns;
  const excludedIngredients =
    context?.excludedIngredients ?? questionnaire!.excludedIngredients;
  const concernWeights =
    context?.concernWeights ?? questionnaire?.concernWeights;
  const examplePolicy = policySource === "mock-onboarding-v1";
  const policyName = examplePolicy
    ? "example store guide"
    : "reviewed ingredient policy";
  const photoGoals = new Set(visibleRecommendationConcerns(vision));
  const selectedGoals = new Set(selectedConcerns);
  const goals: SkinConsultationGoal[] = concerns
    .filter((concern) => selectedGoals.has(concern) || photoGoals.has(concern))
    .map((concern) => {
      const source: SkinConsultationSource = selectedGoals.has(concern)
        ? photoGoals.has(concern)
          ? "both"
          : "selected"
        : "photo";
      return {
        concern,
        label:
          concern === "texture" && photoGoals.has(concern)
            ? "Visible pores & texture"
            : concernLabels[concern],
        source,
        explanation: `${concern === "texture" && photoGoals.has(concern) ? "Visible pores & texture" : concernLabels[concern]} is a matching priority based on ${sourceText(source)}. ${concern === "texture" && photoGoals.has(concern) ? "Visible pore appearance is linked to a smoother-looking texture goal, not a promise to shrink pores. " : ""}${goalInterpretations[concern]}`,
        approvedIngredientCount: 0,
        recommendedProductCount: 0,
        coverage: "no_eligible_ingredients",
        coverageExplanation: "",
      };
    });
  const goalByConcern = new Map(goals.map((goal) => [goal.concern, goal]));
  const exclusions = canonicalizeIngredients(excludedIngredients);
  const excluded = new Set(exclusions.canonical);
  const approved = new Map<string, IngredientRule>();
  if (exclusions.unknown.length === 0) {
    for (const rule of rules) {
      const ingredient = canonicalizeIngredient(rule.ingredient);
      const weight = concernWeights?.[rule.concern] ?? 1;
      if (
        !ingredient ||
        excluded.has(ingredient) ||
        !goalByConcern.has(rule.concern) ||
        ![1, 2, 3].includes(rule.relevance) ||
        !Number.isFinite(weight) ||
        weight <= 0 ||
        weight > 3
      )
        continue;
      const key = `${rule.concern}:${ingredient}`;
      const previous = approved.get(key);
      if (!previous || previous.relevance < rule.relevance)
        approved.set(key, { ...rule, ingredient });
    }
  }

  const products: SkinConsultationProduct[] = [];
  const productIngredients = new Map<string, Set<string>>();
  const seenProducts = new Set<string>();
  for (const recommendation of recommendations) {
    const { product } = recommendation;
    const formula = new Set(
      canonicalizeIngredients(product.ingredients).canonical,
    );
    if (
      products.length >= 3 ||
      seenProducts.has(product.id) ||
      !isSkincareCategory(product.category) ||
      product.status !== "published" ||
      !product.visible ||
      product.stock <= 0 ||
      !validateCatalogDraft(product).valid ||
      exclusions.unknown.length > 0 ||
      [...excluded].some((ingredient) => formula.has(ingredient))
    )
      continue;
    const reasons: SkinConsultationProductReason[] = [];
    const reasonGoals = new Set<Concern>();
    for (const reason of recommendation.reasons) {
      const ingredient = canonicalizeIngredient(reason.ingredient);
      const goal = goalByConcern.get(reason.concern);
      if (
        !ingredient ||
        !goal ||
        reasonGoals.has(reason.concern) ||
        !formula.has(ingredient) ||
        !approved.has(`${reason.concern}:${ingredient}`)
      )
        continue;
      reasonGoals.add(reason.concern);
      reasons.push({
        concern: reason.concern,
        ingredient,
        source: goal.source,
        explanation: `Its registered formula lists ${ingredient}. This store's ${policyName} links that ingredient to ${goal.label.toLowerCase()}, included from ${sourceText(goal.source)}.`,
      });
    }
    if (reasons.length === 0) continue;
    seenProducts.add(product.id);
    productIngredients.set(product.id, formula);
    const reasonLabels = reasons.map(
      (reason) =>
        `${reason.ingredient} (${goalByConcern.get(reason.concern)!.label.toLowerCase()})`,
    );
    products.push({
      productId: product.id,
      reasons,
      explanation: `This store-registered product matches through ${joinLabels(reasonLabels)} in its listed formula and the store's ${policyName}. It meets the current publication, availability and ingredient-exclusion rules.`,
    });
  }

  for (const goal of goals) {
    goal.approvedIngredientCount = new Set(
      [...approved.values()]
        .filter((rule) => rule.concern === goal.concern)
        .map((rule) => rule.ingredient),
    ).size;
    goal.recommendedProductCount = products.filter((product) =>
      product.reasons.some((reason) => reason.concern === goal.concern),
    ).length;
    goal.coverage =
      goal.recommendedProductCount > 0
        ? "matched_products"
        : goal.approvedIngredientCount > 0
          ? "ingredients_only"
          : "no_eligible_ingredients";
    goal.coverageExplanation =
      goal.recommendedProductCount > 0
        ? `${goal.recommendedProductCount} of these recommended store ${goal.recommendedProductCount === 1 ? "products has" : "products have"} a validated ingredient match for ${goal.label.toLowerCase()}.`
        : goal.approvedIngredientCount > 0
          ? `The store's ${policyName} includes ${goal.approvedIngredientCount} ${goal.approvedIngredientCount === 1 ? "ingredient" : "ingredients"} for this goal and your current preferences. This goal is not represented in these recommended products.`
          : `No ingredient in the store's ${policyName} matches this goal and your current preferences.`;
  }

  const grouped = new Map<
    string,
    { goals: Concern[]; score: number; matchedProductIds: string[] }
  >();
  for (const rule of approved.values()) {
    const entry = grouped.get(rule.ingredient) ?? {
      goals: [],
      score: 0,
      matchedProductIds: [...productIngredients.entries()]
        .filter(([, formula]) => formula.has(rule.ingredient))
        .map(([productId]) => productId),
    };
    entry.goals.push(rule.concern);
    entry.score += rule.relevance * (concernWeights?.[rule.concern] ?? 1);
    grouped.set(rule.ingredient, entry);
  }
  const rankedIngredients = [...grouped.entries()].sort(
    ([leftName, left], [rightName, right]) =>
      Number(right.matchedProductIds.length > 0) -
        Number(left.matchedProductIds.length > 0) ||
      right.score - left.score ||
      compareText(leftName, rightName),
  );
  const shortlisted = new Set<string>();
  const coveredGoals = new Set<Concern>();
  for (const goal of goals) {
    if (coveredGoals.has(goal.concern)) continue;
    const match = rankedIngredients.find(([, entry]) =>
      entry.goals.includes(goal.concern),
    );
    if (!match) continue;
    shortlisted.add(match[0]);
    match[1].goals.forEach((concern) => coveredGoals.add(concern));
  }
  for (const [ingredient] of rankedIngredients) {
    if (shortlisted.size >= 6) break;
    shortlisted.add(ingredient);
  }
  const ingredients: SkinConsultationIngredient[] = rankedIngredients
    .filter(([ingredient]) => shortlisted.has(ingredient))
    .map(([ingredient, entry]) => {
      const ingredientGoals = concerns.filter((concern) =>
        entry.goals.includes(concern),
      );
      const labels = ingredientGoals.map((concern) =>
        goalByConcern.get(concern)!.label.toLowerCase(),
      );
      const origins = new Set(
        ingredientGoals.flatMap((concern) => {
          const source = goalByConcern.get(concern)!.source;
          return source === "both" ? ["selected", "photo"] : [source];
        }),
      );
      const source: SkinConsultationSource =
        origins.size === 2
          ? "both"
          : origins.has("photo")
            ? "photo"
            : "selected";
      const purposeGoal =
        ingredient === "Niacinamide" && ingredientGoals.includes("uneven_tone")
          ? "uneven_tone"
          : ingredientGoals[0];
      const purpose = ingredientPurpose(ingredient, purposeGoal);
      return {
        ingredient,
        goals: ingredientGoals,
        rationale: `${purpose ? `${purpose} ` : ""}The store's ${policyName} recommends ${ingredient} for ${joinLabels(labels)}, based on ${sourceText(source)}. ${entry.matchedProductIds.length > 0 ? `It is listed in ${entry.matchedProductIds.length} of your matched store ${entry.matchedProductIds.length === 1 ? "product" : "products"}.` : "It is not in these recommended products."}`,
        availableInMatchedProducts: entry.matchedProductIds.length > 0,
        matchedProductIds: entry.matchedProductIds,
      };
    });

  const observations: SkinConsultationObservation[] = vision
    ? VISION_FEATURES.map((feature) => {
        const value = vision.observed_features[feature];
        const routedConcern = concerns.find(
          (concern) => goalFeature[concern] === feature,
        );
        return {
          feature,
          label: VISION_FEATURE_LABELS[feature],
          value,
          statusLabel: VISION_VALUE_LABELS[value],
          interpretation: context
            ? `${VISION_FEATURE_LABELS[feature]}: ${VISION_VALUE_LABELS[value].toLowerCase()}. ${feature === "visible_pores" ? "Lighting and image detail affect visibility; this does not measure pore size or oil production." : feature === "visible_spots" ? "This does not identify the type or cause of a spot." : feature === "visible_fine_lines" ? "This does not measure line depth." : "This describes appearance only; skin sensitivity and moisture have not been inferred."}`
            : featureInterpretations[feature][value],
          recommendationUse:
            routedConcern && photoGoals.has(routedConcern)
              ? `Contributes to your ${concernLabels[routedConcern].toLowerCase()} goal in the store's ${policyName}.`
              : feature === "visible_redness" || feature === "visible_flaking"
                ? "Shown as an appearance observation; it does not add sensitivity or hydration assumptions to your recommendations."
                : "Does not add a photo-based goal. Your selected preferences still guide ingredient and product matching.",
        };
      })
    : [];

  const status: SkinConsultationReport["status"] = !vision
    ? "questionnaire_only"
    : vision.image_quality === "usable"
      ? "photo_based"
      : vision.image_quality === "limited"
        ? "limited_photo"
        : "unassessable_photo";
  const visible = observations
    .filter((observation) => observation.value === "visible")
    .map((observation) => observation.label.toLowerCase());
  const summary =
    status === "questionnaire_only"
      ? "Your consultation is based on the preferences you shared. No photo findings are used in these ingredient and store-product recommendations."
      : status === "unassessable_photo"
        ? vision!.quality_flags.includes("no_face")
          ? "A usable face was not detected in this photo. Your ingredient and store-product recommendations follow the preferences you shared, without photo-based assumptions."
          : vision!.quality_flags.includes("multiple_faces")
            ? "More than one face was detected, so this photo cannot support an individual skin observation. Your ingredient and store-product recommendations follow your preferences only."
            : "This photo could not support reliable skin-appearance observations. Your ingredient and store-product recommendations follow your preferences only."
        : status === "limited_photo"
          ? "Photo quality limits the skin observations. They are explained below for context; your ingredient and store-product recommendations use your selected preferences only."
          : visible.length > 0
            ? `Your photo shows ${joinLabels(visible)}. The observations below explain what can be seen and how eligible cosmetic goals connect to this store's ${policyName}.`
            : "No feature was recorded as clearly visible in this photo. Your selected cosmetic goals still guide ingredient and store-product recommendations; a single photo cannot establish the absence of a skin concern.";

  const paragraphs = [
    status === "photo_based" && photoGoals.size > 0
      ? `Your matching priorities combine your selected preferences with ${joinLabels([...photoGoals].map((concern) => concernLabels[concern].toLowerCase()))} from usable photo observations. Redness and flaking remain descriptive and do not change your reported skin type or sensitivity preferences.`
      : "Your reported skin type, selected cosmetic goals and excluded ingredients guide matching. A photo does not establish moisture levels, sensitivity, a diagnosis or ingredient suitability.",
    ingredients.length > 0
      ? `The ingredient shortlist comes from this store's ${policyName}, with ingredients present in eligible matched products shown first. Product recommendations use registered formulas and current store availability; a recommended ingredient may be unavailable in the current catalog.`
      : exclusions.unknown.length > 0
        ? "An excluded ingredient could not be resolved to the reviewed ingredient vocabulary. Ingredient and product suggestions are withheld until staff can clarify the full ingredient name."
        : `There are no ${examplePolicy ? "example ingredient-guide" : "reviewed ingredient-policy"} matches for these goals and exclusions. Ask store staff to review the policy and catalog rather than substituting unrelated products.`,
    "For a simple starting routine, introduce one new product at a time, follow its label and ask staff to check the full formula against your preferences and exclusions.",
  ];
  const limitations = [
    "These are cosmetic appearance observations, not a diagnosis, clinical grade or calibrated skin measurement.",
    `Ingredient matching uses the store's ${examplePolicy ? "example" : "reviewed"} goal associations. Ingredient presence does not establish concentration, efficacy, allergy safety or individual suitability.`,
  ];
  if (examplePolicy)
    limitations.push(
      "Ingredient matches use an example store guide that staff should review before live use.",
    );
  if (vision && vision.quality_flags.length > 0)
    limitations.unshift(
      `Photo limitations: ${joinLabels(vision.quality_flags.map((flag) => VISION_QUALITY_LABELS[flag].toLowerCase()))}.`,
    );

  return {
    version: "skin-consultation-v1",
    status,
    title: "Your skin consultation",
    summary:
      context && goals.length === 0
        ? "This photo does not provide a usable cosmetic matching goal. You can optionally choose a skincare goal below; no skin type, sensitivity or moisture level has been assumed."
        : summary,
    paragraphs: context
      ? [
          selectedGoals.size === 0
            ? "Matching uses usable visible pores, spots and fine lines only. No questionnaire was completed and no skin type, sensitivity or moisture level has been inferred."
            : "Matching combines the cosmetic goals you selected with usable visible observations. Unanswered preferences remain unknown.",
          ...paragraphs.slice(1),
        ]
      : paragraphs,
    observations,
    goals,
    ingredients,
    products,
    policyVersion: policyVersion ?? null,
    limitations,
  };
}
