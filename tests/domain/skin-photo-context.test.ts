import { describe, expect, it } from "vitest";
import { skinRecommendationContext } from "@/domain/skin-recommendation-context";
import { rankSkinProducts } from "@/domain/recommendations";
import { buildSkinConsultation } from "@/domain/skin-consultation";
import {
  OPENAI_SKIN_PROMPT_VERSION,
  type SkinVision,
} from "@/domain/skin-vision";
import type { Product, IngredientRule } from "@/domain/types";

const vision: SkinVision = {
  prompt_version: OPENAI_SKIN_PROMPT_VERSION,
  image_quality: "usable",
  quality_flags: [],
  observed_features: {
    visible_pores: "visible",
    visible_spots: "not_visible",
    visible_fine_lines: "not_visible",
    visible_redness: "visible",
    visible_flaking: "visible",
  },
};
const profile = {
  skinType: "unsure" as const,
  concerns: [],
  excludedIngredients: [],
};
const product: Product = {
  id: "product",
  organizationId: "org",
  storeId: "store",
  sku: "SERUM-1",
  brand: "Registered",
  name: "Texture serum",
  category: "serum",
  priceMinor: 2300,
  currency: "USD",
  stock: 2,
  visible: true,
  ingredients: ["Aqua", "Niacinamide"],
  formulaComplete: true,
  suitableSkinTypes: ["oily"],
  status: "published",
};
const rules: IngredientRule[] = [
  { concern: "texture", ingredient: "Niacinamide", relevance: 2 },
];
const scope = { organizationId: "org", storeId: "store", rules };
describe("observation-only skincare", () => {
  it("routes usable pores without manufacturing selected answers or skin type", () => {
    const context = skinRecommendationContext(profile, vision);
    expect(context).toMatchObject({
      skinType: "unsure",
      selectedConcerns: [],
      photoConcerns: ["texture"],
    });
    expect(profile).toEqual({
      skinType: "unsure",
      concerns: [],
      excludedIngredients: [],
    });
    const matches = rankSkinProducts([product], context, scope);
    expect(matches).toHaveLength(1);
    const report = buildSkinConsultation({
      context,
      vision,
      rules,
      recommendations: matches,
    });
    expect(report.goals.map((goal) => [goal.concern, goal.source])).toEqual([
      ["texture", "photo"],
    ]);
    expect(report.products[0].reasons[0].ingredient).toBe("Niacinamide");
    expect(report.paragraphs.join(" ")).toContain(
      "No questionnaire was completed",
    );
    expect(
      report.observations
        .filter((item) =>
          ["visible_redness", "visible_flaking"].includes(item.feature),
        )
        .every((item) => !item.interpretation.includes("you supplied")),
    ).toBe(true);
  });
  it.each([
    "lip_color",
    "blush",
    "eye_color",
    "foundation",
    "concealer",
  ] as const)(
    "never routes %s into skincare merely because it has niacinamide",
    (category) => {
      const cosmetic = { ...product, category };
      const context = skinRecommendationContext(profile, vision);
      expect(rankSkinProducts([cosmetic], context, scope)).toEqual([]);
      const report = buildSkinConsultation({
        context,
        vision,
        rules,
        recommendations: [
          {
            product: cosmetic,
            score: 2,
            matchedIngredients: ["Niacinamide"],
            reasons: [
              { concern: "texture", ingredient: "Niacinamide", relevance: 2 },
            ],
          },
        ],
      });
      expect(report.products).toEqual([]);
      expect(report.ingredients[0].availableInMatchedProducts).toBe(false);
    },
  );
  it("withholds photo goals when quality is limited and preserves genuine optional selections", () => {
    const context = skinRecommendationContext(
      { ...profile, concerns: ["dehydration"] },
      { ...vision, image_quality: "limited", quality_flags: ["blur"] },
    );
    expect(context.photoConcerns).toEqual([]);
    expect(context.selectedConcerns).toEqual(["dehydration"]);
    expect(rankSkinProducts([product], context, scope)).toEqual([]);
  });
  it("keeps ingredient guidance when all store products are unavailable", () => {
    const context = skinRecommendationContext(profile, vision);
    const matches = rankSkinProducts(
      [{ ...product, stock: 0 }],
      context,
      scope,
    );
    const report = buildSkinConsultation({
      context,
      vision,
      rules,
      recommendations: matches,
    });
    expect(report.products).toEqual([]);
    expect(report.ingredients[0].ingredient).toBe("Niacinamide");
    expect(report.goals[0].coverage).toBe("ingredients_only");
  });
});
