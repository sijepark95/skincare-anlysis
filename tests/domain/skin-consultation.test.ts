import { describe, expect, it } from "vitest";
import {
  buildSkinConsultation,
  type SkinConsultationInput,
} from "../../src/domain/skin-consultation";
import {
  OPENAI_SKIN_PROMPT_VERSION,
  VISION_FEATURES,
  type SkinVision,
  type VisionValue,
} from "../../src/domain/skin-vision";
import type {
  IngredientRule,
  Product,
  Questionnaire,
  Recommendation,
} from "../../src/domain/types";

const answers: Questionnaire = {
  skinType: "dry",
  concerns: ["dehydration"],
  excludedIngredients: [],
};
const rules: IngredientRule[] = [
  { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
  { concern: "dehydration", ingredient: "Panthenol", relevance: 2 },
  { concern: "texture", ingredient: "Niacinamide", relevance: 2 },
  { concern: "uneven_tone", ingredient: "Niacinamide", relevance: 3 },
  { concern: "fine_lines", ingredient: "Sodium Hyaluronate", relevance: 2 },
];
function vision(changes: Partial<SkinVision> = {}): SkinVision {
  return {
    prompt_version: OPENAI_SKIN_PROMPT_VERSION,
    image_quality: "usable",
    quality_flags: [],
    observed_features: {
      visible_redness: "not_visible",
      visible_spots: "not_visible",
      visible_pores: "visible",
      visible_fine_lines: "not_visible",
      visible_flaking: "not_visible",
    },
    ...changes,
  };
}
const product: Product = {
  id: "store-product-1",
  organizationId: "verified-org",
  storeId: "verified-store",
  sku: "HYDRATION-1",
  brand: "Registered brand",
  name: "Registered serum",
  category: "serum",
  priceMinor: 2500,
  currency: "USD",
  stock: 3,
  visible: true,
  ingredients: ["Aqua", "Glycerin", "Niacinamide"],
  formulaComplete: true,
  suitableSkinTypes: ["dry"],
  status: "published",
};
const match: Recommendation = {
  product,
  score: 5,
  matchedIngredients: ["Glycerin", "Niacinamide"],
  reasons: [
    { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
    { concern: "texture", ingredient: "Niacinamide", relevance: 2 },
  ],
};
function build(changes: Partial<SkinConsultationInput> = {}) {
  return buildSkinConsultation({
    vision: vision(),
    questionnaire: answers,
    rules,
    recommendations: [match],
    policyVersion: "reviewed-policy-2",
    ...changes,
  });
}

describe("professional appearance interpretation", () => {
  it("explains observed features and distinct questionnaire/photo provenance", () => {
    const report = build();
    expect(report.status).toBe("photo_based");
    expect(report.summary).toContain("pores");
    expect(report.observations).toHaveLength(5);
    expect(
      report.observations.find((item) => item.feature === "visible_pores"),
    ).toMatchObject({
      value: "visible",
      interpretation: expect.stringContaining("does not measure pore size"),
      recommendationUse: expect.stringContaining("smooth texture"),
    });
    expect(report.goals).toEqual([
      expect.objectContaining({ concern: "dehydration", source: "selected" }),
      expect.objectContaining({ concern: "texture", source: "photo" }),
    ]);
    expect(report.policyVersion).toBe("reviewed-policy-2");
    expect(report.paragraphs.at(-1)).toContain("one new product at a time");
  });

  it("recognizes both sources without duplicating the same goal", () => {
    const report = build({
      questionnaire: { ...answers, concerns: ["texture"] },
    });
    expect(report.goals).toHaveLength(1);
    expect(report.goals[0]).toMatchObject({
      concern: "texture",
      source: "both",
    });
    expect(report.goals[0].explanation).toContain(
      "selected goal and usable photo observation",
    );
    expect(report.products[0].reasons).toHaveLength(1);
    expect(report.products[0].reasons[0].source).toBe("both");
  });

  for (const feature of VISION_FEATURES) {
    it.each<VisionValue>([
      "visible",
      "not_visible",
      "uncertain",
      "not_assessable",
    ])(
      `explains ${feature}=%s without replacing it with another observation`,
      (value) => {
        const input = vision();
        input.observed_features[feature] = value;
        const observation = build({ vision: input }).observations.find(
          (item) => item.feature === feature,
        )!;
        expect(observation.value).toBe(value);
        expect(observation.interpretation.length).toBeGreaterThan(90);
        expect(observation.interpretation).not.toContain("undefined");
        expect(observation).not.toHaveProperty("score");
        expect(observation).not.toHaveProperty("diagnosis");
      },
    );
  }

  it("never infers hydration or sensitivity from redness and flaking", () => {
    const report = build({
      questionnaire: { ...answers, concerns: [] },
      vision: vision({
        observed_features: {
          visible_redness: "visible",
          visible_spots: "uncertain",
          visible_pores: "not_visible",
          visible_fine_lines: "not_assessable",
          visible_flaking: "visible",
        },
      }),
    });
    expect(report.goals).toEqual([]);
    expect(report.ingredients).toEqual([]);
    expect(report.products).toEqual([]);
    expect(report.observations[0].recommendationUse).toContain(
      "does not add sensitivity or hydration",
    );
  });

  it("explains limited findings but does not use them for photo-driven recommendations", () => {
    const report = build({
      vision: vision({
        image_quality: "limited",
        quality_flags: ["low_light", "blur"],
      }),
    });
    expect(report.status).toBe("limited_photo");
    expect(report.summary).toContain("selected preferences only");
    expect(
      report.observations.find((item) => item.feature === "visible_pores")
        ?.recommendationUse,
    ).toContain("Does not add a photo-based goal");
    expect(report.goals.map((goal) => goal.concern)).toEqual(["dehydration"]);
    expect(report.ingredients.map((item) => item.ingredient)).not.toContain(
      "Niacinamide",
    );
    expect(report.limitations[0]).toContain(
      "low lighting and photo is blurred",
    );
  });

  it.each(["no_face", "multiple_faces"] as const)(
    "keeps %s observations unassessable",
    (flag) => {
      const photo = vision({
        image_quality: "not_assessable",
        quality_flags: [flag],
      });
      for (const feature of VISION_FEATURES)
        photo.observed_features[feature] = "not_assessable";
      const report = build({ vision: photo });
      expect(report.status).toBe("unassessable_photo");
      expect(report.summary).toContain(
        flag === "no_face" ? "not detected" : "More than one face",
      );
      expect(
        report.observations.every((item) => item.value === "not_assessable"),
      ).toBe(true);
      expect(report.goals.every((goal) => goal.source === "selected")).toBe(
        true,
      );
      expect(
        report.products[0].reasons.every(
          (reason) => reason.source === "selected",
        ),
      ).toBe(true);
    },
  );

  it("creates a useful photo-free consultation without claiming photo findings", () => {
    const report = build({ vision: null });
    expect(report.status).toBe("questionnaire_only");
    expect(report.summary).toContain("No photo findings are used");
    expect(report.observations).toEqual([]);
    expect(report.ingredients.map((item) => item.ingredient)).toEqual([
      "Glycerin",
      "Panthenol",
    ]);
    expect(report.products[0].reasons).toHaveLength(1);
    expect(report.products[0].reasons[0].source).toBe("selected");
  });
});

describe("reviewed ingredient-to-registered-product consultation", () => {
  it("explains verified ingredient functions before their personalized policy rationale", () => {
    const report = build({
      questionnaire: { ...answers, concerns: ["dehydration", "uneven_tone"] },
    });
    expect(
      report.ingredients.find((item) => item.ingredient === "Glycerin")
        ?.rationale,
    ).toMatch(/^A humectant used in moisturizers/);
    expect(
      report.ingredients.find((item) => item.ingredient === "Niacinamide")
        ?.rationale,
    ).toMatch(
      /^A form of vitamin B3 studied in specific cosmetic formulations for a more even-looking tone/,
    );
    expect(
      report.ingredients.find((item) => item.ingredient === "Panthenol")
        ?.rationale,
    ).toMatch(/^A skin-conditioning humectant/);
  });

  it("does not invent a scientific benefit for ingredients without an editorial function", () => {
    const report = build({
      questionnaire: { ...answers, concerns: ["texture"] },
      recommendations: [],
      rules: [{ concern: "texture", ingredient: "Lactic Acid", relevance: 3 }],
    });
    expect(report.ingredients[0].rationale).toMatch(
      /^The store's reviewed ingredient policy/,
    );
    expect(report.ingredients[0].rationale).not.toMatch(
      /exfoliat|keratolytic|collagen|treat|effective/i,
    );
  });

  it("identifies an onboarding example guide without portraying its policy as reviewed", () => {
    const report = build({ policySource: "mock-onboarding-v1" });
    expect(report.summary).toContain("example store guide");
    expect(report.ingredients[0].rationale).toContain("example store guide");
    expect(report.ingredients[0].rationale).not.toContain("reviewed");
    expect(report.products[0].explanation).toContain("example store guide");
    expect(report.products[0].explanation).not.toContain("reviewed");
    expect(report.limitations).toContain(
      "Ingredient matches use an example store guide that staff should review before live use.",
    );
  });

  it("recommends ingredients even when the store has no matching products", () => {
    const report = build({ recommendations: [] });
    expect(report.ingredients.map((item) => item.ingredient)).toEqual([
      "Glycerin",
      "Niacinamide",
      "Panthenol",
    ]);
    expect(report.products).toEqual([]);
    expect(
      report.ingredients.every(
        (item) =>
          !item.availableInMatchedProducts &&
          item.matchedProductIds.length === 0,
      ),
    ).toBe(true);
    expect(report.ingredients[0].rationale).toContain(
      "not in these recommended products",
    );
  });

  it("prioritizes available matched ingredients and narrates only actual registered formula reasons", () => {
    const report = build({
      rules: [
        ...rules,
        { concern: "dehydration", ingredient: "Hyaluronic Acid", relevance: 3 },
      ],
    });
    expect(report.ingredients.map((item) => item.ingredient)).toEqual([
      "Glycerin",
      "Niacinamide",
      "Hyaluronic Acid",
      "Panthenol",
    ]);
    expect(report.ingredients[1]).toMatchObject({
      ingredient: "Niacinamide",
      availableInMatchedProducts: true,
      matchedProductIds: [product.id],
    });
    expect(report.ingredients[1].rationale).toContain(
      "usable photo observation",
    );
    expect(report.products.map((item) => item.productId)).toEqual([product.id]);
    expect(report.products[0].reasons).toEqual([
      expect.objectContaining({
        ingredient: "Glycerin",
        concern: "dehydration",
        source: "selected",
      }),
      expect.objectContaining({
        ingredient: "Niacinamide",
        concern: "texture",
        source: "photo",
      }),
    ]);
    expect(report.products[0].explanation).toContain("Glycerin (hydration)");
    expect(report.products[0].explanation).toContain(
      "Niacinamide (visible pores & texture)",
    );
  });

  it("deduplicates aliases and goals, takes strongest reviewed duplicate, and caps the ingredient list", () => {
    const extra: IngredientRule[] = [
      { concern: "dehydration", ingredient: "Vitamin B3", relevance: 1 },
      { concern: "dehydration", ingredient: "Niacinamide", relevance: 3 },
      { concern: "dehydration", ingredient: "Squalane", relevance: 2 },
      { concern: "dehydration", ingredient: "Betaine", relevance: 2 },
      { concern: "dehydration", ingredient: "Ceramide NP", relevance: 2 },
      { concern: "dehydration", ingredient: "Hyaluronic Acid", relevance: 3 },
      {
        concern: "dehydration",
        ingredient: "Sodium Hyaluronate",
        relevance: 3,
      },
    ];
    const input = {
      rules: [...rules, ...extra],
      questionnaire: {
        ...answers,
        concerns: [
          "dehydration",
          "texture",
          "uneven_tone",
        ] as Questionnaire["concerns"],
      },
    };
    const report = build(input);
    expect(report.ingredients).toHaveLength(6);
    expect(report.ingredients[0].ingredient).toBe("Niacinamide");
    expect(report.ingredients[0].goals).toEqual([
      "dehydration",
      "texture",
      "uneven_tone",
    ]);
    expect(
      report.ingredients.filter((item) => item.ingredient === "Niacinamide"),
    ).toHaveLength(1);
    expect(
      build({ ...input, rules: [...input.rules].reverse() }).ingredients,
    ).toEqual(report.ingredients);
  });

  it("uses weights for deterministic ranking, without exposing them as health scores", () => {
    const report = build({
      recommendations: [],
      questionnaire: { ...answers, concernWeights: { texture: 3 } },
    });
    expect(report.ingredients[0].ingredient).toBe("Niacinamide");
    expect(report.ingredients[0]).not.toHaveProperty("score");
    expect(
      build({
        questionnaire: {
          ...answers,
          concernWeights: { dehydration: 0, texture: NaN },
        },
      }).ingredients,
    ).toEqual([]);
  });

  it("never fills an unreviewed or empty policy with demo ingredients", () => {
    for (const inputRules of [
      [],
      [
        {
          concern: "dehydration",
          ingredient: "Unknown miracle extract",
          relevance: 3,
        } as IngredientRule,
      ],
    ]) {
      const report = build({ rules: inputRules });
      expect(report.ingredients).toEqual([]);
      expect(report.products).toEqual([]);
      expect(report.paragraphs[1]).toContain(
        "no reviewed ingredient-policy matches",
      );
    }
  });

  it("honors canonical exclusions and withholds suggestions for unresolved exclusions", () => {
    const excluded = build({
      questionnaire: { ...answers, excludedIngredients: ["Vitamin B3"] },
    });
    expect(excluded.ingredients.map((item) => item.ingredient)).not.toContain(
      "Niacinamide",
    );
    expect(excluded.products).toEqual([]);
    const unresolved = build({
      questionnaire: {
        ...answers,
        excludedIngredients: ["Unknown personal allergen"],
      },
    });
    expect(unresolved.ingredients).toEqual([]);
    expect(unresolved.products).toEqual([]);
    expect(unresolved.paragraphs[1]).toContain("could not be resolved");
  });

  it.each([
    { status: "draft" as const },
    { visible: false },
    { stock: 0 },
    { formulaComplete: false },
    { ingredients: ["Glycerin", "Unknown Extract"] },
  ])("does not narrate or count ineligible product: %o", (changes) => {
    const report = build({
      recommendations: [{ ...match, product: { ...product, ...changes } }],
    });
    expect(report.products).toEqual([]);
    expect(
      report.ingredients.every((item) => item.matchedProductIds.length === 0),
    ).toBe(true);
  });

  it("ignores reasons absent from the actual formula, applicable goals or reviewed policy", () => {
    const report = build({
      recommendations: [
        {
          ...match,
          reasons: [
            { concern: "dehydration", ingredient: "Panthenol", relevance: 2 },
            { concern: "fine_lines", ingredient: "Glycerin", relevance: 3 },
            { concern: "texture", ingredient: "Aqua", relevance: 3 },
          ],
        },
      ],
    });
    expect(report.products).toEqual([]);
    expect(
      report.ingredients.every((item) => !item.availableInMatchedProducts),
    ).toBe(true);
  });

  it("limits product summaries to supplied matches and avoids duplicate product/goal explanations", () => {
    const recommendations = [
      match,
      match,
      ...[2, 3, 4].map((number) => ({
        ...match,
        product: {
          ...product,
          id: `store-product-${number}`,
          sku: `SKU-${number}`,
        },
        reasons: [...match.reasons, match.reasons[0]],
      })),
    ];
    const report = build({ recommendations });
    expect(report.products.map((item) => item.productId)).toEqual([
      "store-product-1",
      "store-product-2",
      "store-product-3",
    ]);
    expect(report.products.every((item) => item.reasons.length === 2)).toBe(
      true,
    );
    expect(report.ingredients[0].matchedProductIds).toHaveLength(3);
  });

  it("does not mutate the saved observations, questionnaire, policy or recommendations", () => {
    const input: SkinConsultationInput = {
      vision: vision(),
      questionnaire: answers,
      rules,
      recommendations: [match],
    };
    const before = JSON.stringify(input);
    buildSkinConsultation(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("retains a pore-related ingredient when available hydration ingredients would crowd out texture", () => {
    const hydrationNames = [
      "Glycerin",
      "Sodium Hyaluronate",
      "Hyaluronic Acid",
      "Panthenol",
      "Ceramide NP",
      "Squalane",
      "Betaine",
    ];
    const hydrationRules: IngredientRule[] = hydrationNames.map(
      (ingredient) => ({ concern: "dehydration", ingredient, relevance: 3 }),
    );
    const hydrationMatch: Recommendation = {
      ...match,
      product: { ...product, ingredients: ["Aqua", ...hydrationNames] },
      matchedIngredients: ["Glycerin"],
      reasons: [
        { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
      ],
    };
    const input = {
      rules: [
        ...hydrationRules,
        {
          concern: "texture",
          ingredient: "Salicylic Acid",
          relevance: 3,
        } as IngredientRule,
      ],
      recommendations: [hydrationMatch],
    };
    const report = build(input);
    expect(report.ingredients).toHaveLength(6);
    expect(report.ingredients).toContainEqual(
      expect.objectContaining({
        ingredient: "Salicylic Acid",
        goals: ["texture"],
        availableInMatchedProducts: false,
      }),
    );
    expect(
      report.goals.find((goal) => goal.concern === "texture"),
    ).toMatchObject({
      label: "Visible pores & texture",
      approvedIngredientCount: 1,
      recommendedProductCount: 0,
      coverage: "ingredients_only",
    });
    expect(
      report.ingredients.find((item) => item.ingredient === "Salicylic Acid")
        ?.rationale,
    ).toContain("visible pores & texture");
    expect(
      build({ ...input, rules: [...input.rules].reverse() }).ingredients,
    ).toEqual(report.ingredients);
  });

  it("reports actual recommended-product coverage separately from filtered ingredient-guide coverage", () => {
    const report = build();
    expect(
      report.goals.find((goal) => goal.concern === "texture"),
    ).toMatchObject({
      approvedIngredientCount: 1,
      recommendedProductCount: 1,
      coverage: "matched_products",
    });
    const withoutProducts = build({ recommendations: [] });
    expect(
      withoutProducts.goals.find((goal) => goal.concern === "texture"),
    ).toMatchObject({
      approvedIngredientCount: 1,
      recommendedProductCount: 0,
      coverage: "ingredients_only",
    });
    expect(
      withoutProducts.goals.find((goal) => goal.concern === "texture")
        ?.coverageExplanation,
    ).toContain("not represented in these recommended products");
    const excluded = build({
      questionnaire: { ...answers, excludedIngredients: ["Vitamin B3"] },
    });
    expect(
      excluded.goals.find((goal) => goal.concern === "texture"),
    ).toMatchObject({
      approvedIngredientCount: 0,
      recommendedProductCount: 0,
      coverage: "no_eligible_ingredients",
    });
    expect(
      excluded.ingredients.some((ingredient) =>
        ingredient.goals.includes("texture"),
      ),
    ).toBe(false);
  });

  it("covers every applicable goal within six ingredients when all three usable photo goals compete with hydration", () => {
    const hydrationNames = [
      "Glycerin",
      "Sodium Hyaluronate",
      "Hyaluronic Acid",
      "Panthenol",
      "Ceramide NP",
      "Squalane",
      "Betaine",
    ];
    const inputVision = vision();
    inputVision.observed_features.visible_spots = "visible";
    inputVision.observed_features.visible_fine_lines = "visible";
    const report = build({
      vision: inputVision,
      rules: [
        ...hydrationNames.map<IngredientRule>((ingredient) => ({
          concern: "dehydration",
          ingredient,
          relevance: 3,
        })),
        { concern: "texture", ingredient: "Salicylic Acid", relevance: 3 },
        {
          concern: "uneven_tone",
          ingredient: "Ascorbyl Glucoside",
          relevance: 3,
        },
        {
          concern: "fine_lines",
          ingredient: "Palmitoyl Tripeptide-1",
          relevance: 3,
        },
      ],
      recommendations: [
        {
          ...match,
          product: { ...product, ingredients: ["Aqua", ...hydrationNames] },
          matchedIngredients: ["Glycerin"],
          reasons: [
            { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
          ],
        },
      ],
    });
    expect(report.ingredients).toHaveLength(6);
    expect(
      new Set(report.ingredients.flatMap((ingredient) => ingredient.goals)),
    ).toEqual(new Set(["dehydration", "texture", "uneven_tone", "fine_lines"]));
    expect(
      report.goals
        .filter((goal) => goal.source === "photo")
        .every((goal) => goal.coverage === "ingredients_only"),
    ).toBe(true);
  });

  it("does not add pore coverage for limited photos, or imply pore shrinkage for usable photos", () => {
    const limited = build({
      vision: vision({
        image_quality: "limited",
        quality_flags: ["low_light"],
      }),
    });
    expect(limited.goals.map((goal) => goal.concern)).toEqual(["dehydration"]);
    expect(
      limited.ingredients.every(
        (ingredient) => !ingredient.goals.includes("texture"),
      ),
    ).toBe(true);
    const usable = build();
    expect(
      usable.goals.find((goal) => goal.concern === "texture")?.explanation,
    ).toContain("not a promise to shrink pores");
    const selected = build({
      vision: null,
      questionnaire: { ...answers, concerns: ["texture"] },
    });
    expect(selected.goals[0].label).toBe("Smooth texture");
    expect(selected.goals[0].source).toBe("selected");
  });
});
