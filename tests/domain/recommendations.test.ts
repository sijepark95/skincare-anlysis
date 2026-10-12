import { describe, expect, it } from "vitest";
import {
  validateCatalogDraft,
  validateCatalogDraftStructure,
} from "../../src/domain/catalog";
import {
  demoProducts,
  DEMO_ORGANIZATION_ID,
  DEMO_STORE_ID,
} from "../../src/domain/demo-catalog";
import {
  canonicalizeIngredient,
  canonicalizeIngredients,
} from "../../src/domain/ingredients";
import { recommendProducts } from "../../src/domain/recommendations";
import { type Product, type Questionnaire } from "../../src/domain/types";

const scope = { organizationId: DEMO_ORGANIZATION_ID, storeId: DEMO_STORE_ID };
const questionnaire: Questionnaire = {
  skinType: "dry",
  concerns: ["dehydration"],
  excludedIngredients: [],
};
const product = (changes: Partial<Product> = {}): Product => ({
  ...demoProducts[1],
  ...changes,
});

describe("ingredient vocabulary and publication", () => {
  it("canonicalizes reviewed aliases and detects unresolved names", () => {
    expect(canonicalizeIngredient("  water  ")).toBe("Aqua");
    expect(canonicalizeIngredient("vitamin b3")).toBe("Niacinamide");
    expect(
      canonicalizeIngredients(["Water", "Aqua", "Unknown extract"]),
    ).toEqual({ canonical: ["Aqua"], unknown: ["Unknown extract"] });
  });

  it("keeps all fictional seed formulations publishable", () => {
    expect(demoProducts.every((item) => validateCatalogDraft(item).valid)).toBe(
      true,
    );
  });

  it("allows incomplete formulas as drafts while enforcing publication review", () => {
    const incomplete = product({
      formulaComplete: false,
      ingredients: ["Unreviewed Extract"],
    });
    expect(validateCatalogDraftStructure(incomplete).valid).toBe(true);
    expect(validateCatalogDraft(incomplete).valid).toBe(false);
    expect(
      validateCatalogDraftStructure(product({ priceMinor: -1 })).valid,
    ).toBe(false);
  });

  it.each([
    { formulaComplete: false },
    { ingredients: [] },
    { ingredients: ["Aqua", "Unreviewed Extract"] },
    { priceMinor: 100.5 },
    { stock: -1 },
  ])("blocks invalid publication: %o", (changes) => {
    expect(validateCatalogDraft(product(changes)).valid).toBe(false);
  });
});

describe("store ingredient recommendations", () => {
  it("resolves only reviewed candidate case and aliases, without guessing ingredient families", () => {
    const products = [
      product({
        ingredients: ["Aqua", "Panthenol", "Glycerin", "Ceramide NP"],
      }),
    ];
    for (const ingredient of [" PANTHENOL ", "Provitamin B5", "GLYCEROL"]) {
      expect(
        recommendProducts(products, questionnaire, {
          ...scope,
          ingredientCandidates: [{ ingredient, score: 0.8 }],
        }),
      ).toHaveLength(1);
    }
    expect(
      recommendProducts(products, questionnaire, {
        ...scope,
        ingredientCandidates: [{ ingredient: "Ceramides", score: 1 }],
      }),
    ).toEqual([]);
  });

  it("uses experimental candidate scores to rank approved canonical ingredient matches", () => {
    const glycerin = product({ sku: "A", ingredients: ["Aqua", "Glycerin"] });
    const panthenol = product({ sku: "B", ingredients: ["Aqua", "Panthenol"] });
    const result = recommendProducts([glycerin, panthenol], questionnaire, {
      ...scope,
      ingredientCandidates: [
        { ingredient: "Glycerin", score: 0.1 },
        { ingredient: "Panthenol", score: 0.9 },
      ],
    });
    expect(result.map(({ product: item }) => item.sku)).toEqual(["B", "A"]);
    expect(result[0].score).toBeCloseTo(1.8);
    expect(result[0].reasons).toEqual([
      { concern: "dehydration", ingredient: "Panthenol", relevance: 2 },
    ]);
  });

  it("does not treat model labels as policy approval or allow missing and invalid candidates", () => {
    const products = [product({ ingredients: ["Aqua", "Glycerin"] })];
    for (const ingredientCandidates of [
      [],
      [{ ingredient: "Aqua", score: 1 }],
      [{ ingredient: "Unknown", score: 1 }],
      [{ ingredient: "Glycerin", score: 0 }],
      [{ ingredient: "Glycerin", score: NaN }],
      [{ ingredient: "Glycerin", score: 2 }],
    ]) {
      expect(
        recommendProducts(products, questionnaire, {
          ...scope,
          ingredientCandidates,
        }),
      ).toEqual([]);
    }
  });

  it("retains exclusions and publication checks when experimental candidates favor a product", () => {
    const products = [
      product({ ingredients: ["Aqua", "Niacinamide", "Glycerin"] }),
      product({ sku: "DRAFT", status: "draft", ingredients: ["Glycerin"] }),
    ];
    expect(
      recommendProducts(
        products,
        { ...questionnaire, excludedIngredients: ["Vitamin B3"] },
        {
          ...scope,
          ingredientCandidates: [{ ingredient: "Glycerin", score: 1 }],
        },
      ),
    ).toEqual([]);
  });

  it("returns at most three eligible products with explainable ingredient matches", () => {
    const result = recommendProducts(demoProducts, questionnaire, scope);
    expect(result).toHaveLength(3);
    for (const recommendation of result) {
      expect(recommendation.score).toBeGreaterThan(0);
      expect(recommendation.matchedIngredients.length).toBeGreaterThan(0);
      expect(
        recommendation.reasons.every((reason) =>
          recommendation.product.ingredients.includes(reason.ingredient),
        ),
      ).toBe(true);
    }
  });

  it("never returns another organization or store listing", () => {
    const products = [
      product({ organizationId: "other-org" }),
      product({ storeId: "other-store" }),
      product(),
    ];
    expect(
      recommendProducts(products, questionnaire, scope).map(
        (result) => result.product.id,
      ),
    ).toEqual([product().id]);
    expect(
      recommendProducts(products, questionnaire, {
        ...scope,
        organizationId: "",
      }),
    ).toEqual([]);
  });

  it.each([
    { status: "draft" as const },
    { stock: 0 },
    { visible: false },
    { formulaComplete: false },
    { ingredients: ["Glycerin", "Unreviewed Extract"] },
  ])("filters ineligible product: %o", (changes) => {
    expect(recommendProducts([product(changes)], questionnaire, scope)).toEqual(
      [],
    );
  });

  it("excludes ingredient aliases and fails closed for unresolved exclusions", () => {
    const products = [
      product({ ingredients: ["Aqua", "Niacinamide", "Glycerin"] }),
    ];
    expect(
      recommendProducts(
        products,
        { ...questionnaire, excludedIngredients: ["Vitamin B3"] },
        scope,
      ),
    ).toEqual([]);
    expect(
      recommendProducts(
        products,
        { ...questionnaire, excludedIngredients: ["Unreviewed Extract"] },
        scope,
      ),
    ).toEqual([]);
  });

  it("counts each concern once rather than inflating score with more matching ingredients", () => {
    const sparse = product({ sku: "A", ingredients: ["Aqua", "Glycerin"] });
    const dense = product({
      sku: "B",
      ingredients: [
        "Aqua",
        "Glycerin",
        "Sodium Hyaluronate",
        "Panthenol",
        "Squalane",
      ],
    });
    const result = recommendProducts([dense, sparse], questionnaire, scope);
    expect(result.map(({ score }) => score)).toEqual([3, 3]);
  });

  it("ranks tied scores by skin-type suitability then a stable SKU order", () => {
    const products = [
      product({ sku: "B", suitableSkinTypes: ["dry"] }),
      product({ sku: "A", suitableSkinTypes: ["dry"] }),
      product({ sku: "0", suitableSkinTypes: ["oily"] }),
    ];
    const result = recommendProducts(products, questionnaire, scope);
    expect(result.map(({ product: item }) => item.sku)).toEqual([
      "A",
      "B",
      "0",
    ]);
    expect(
      recommendProducts([...products].reverse(), questionnaire, scope),
    ).toEqual(result);
    expect(
      recommendProducts(
        products,
        { ...questionnaire, skinType: "unsure" },
        scope,
      ).map(({ product: item }) => item.sku),
    ).toEqual(["0", "A", "B"]);
  });

  it("honors the injected published policy and does not fall back when it is empty", () => {
    const rule = {
      concern: "dehydration" as const,
      ingredient: "Panthenol",
      relevance: 1 as const,
    };
    const result = recommendProducts([product()], questionnaire, {
      ...scope,
      rules: [rule],
    });
    expect(result[0].score).toBe(1);
    expect(result[0].matchedIngredients).toEqual(["Panthenol"]);
    expect(
      recommendProducts(demoProducts, questionnaire, { ...scope, rules: [] }),
    ).toEqual([]);
  });

  it("applies bounded concern weights without duplicating repeated concern selections", () => {
    const selected: Questionnaire = {
      ...questionnaire,
      concerns: ["dehydration", "dehydration", "fine_lines"],
      concernWeights: { dehydration: 2, fine_lines: 1 },
    };
    const result = recommendProducts([product()], selected, scope);
    expect(result[0].score).toBe(8);
    expect(result[0].reasons).toHaveLength(2);
  });

  it("returns no invented matches when no concerns or matching ingredients are available", () => {
    expect(
      recommendProducts(
        demoProducts,
        { ...questionnaire, concerns: [] },
        scope,
      ),
    ).toEqual([]);
    expect(
      recommendProducts(
        [product({ ingredients: ["Aqua", "Zinc Oxide"] })],
        questionnaire,
        scope,
      ),
    ).toEqual([]);
  });

  it("caps explicit limits and deduplicates duplicate store SKU read models", () => {
    expect(
      recommendProducts(demoProducts, questionnaire, { ...scope, limit: 100 }),
    ).toHaveLength(3);
    expect(
      recommendProducts(demoProducts, questionnaire, { ...scope, limit: 0 }),
    ).toEqual([]);
    expect(
      recommendProducts([product(), product()], questionnaire, scope),
    ).toHaveLength(1);
  });

  it("reserves a product for an applicable photo goal without changing scores or ranked order", () => {
    const selected: Questionnaire = {
      ...questionnaire,
      concerns: ["dehydration", "uneven_tone", "fine_lines", "texture"],
    };
    const catalog = ["A", "B", "C"].map((sku) =>
      product({
        id: sku,
        sku,
        ingredients: [
          "Aqua",
          "Glycerin",
          "Ascorbyl Glucoside",
          "Palmitoyl Tripeptide-1",
        ],
      }),
    );
    catalog.push(
      product({
        id: "Z-PORES",
        sku: "Z-PORES",
        ingredients: ["Aqua", "Salicylic Acid"],
      }),
    );
    const original = recommendProducts(catalog, selected, scope);
    expect(original.map((item) => item.product.sku)).toEqual(["A", "B", "C"]);
    const result = recommendProducts(catalog, selected, {
      ...scope,
      priorityConcerns: ["texture"],
    });
    expect(result.map((item) => [item.product.sku, item.score])).toEqual([
      ["A", 9],
      ["B", 9],
      ["Z-PORES", 3],
    ]);
    expect(result[2].reasons).toEqual([
      { concern: "texture", ingredient: "Salicylic Acid", relevance: 3 },
    ]);
    expect(
      recommendProducts([...catalog].reverse(), selected, {
        ...scope,
        priorityConcerns: ["texture"],
      }),
    ).toEqual(result);
  });

  it("lets one existing product cover multiple photo goals and fills remaining places by original rank", () => {
    const selected: Questionnaire = {
      ...questionnaire,
      concerns: ["dehydration", "texture", "uneven_tone"],
    };
    const catalog = [
      product({ id: "A", sku: "A", ingredients: ["Aqua", "Niacinamide"] }),
      product({ id: "B", sku: "B", ingredients: ["Aqua", "Glycerin"] }),
      product({ id: "C", sku: "C", ingredients: ["Aqua", "Glycerin"] }),
      product({ id: "Z", sku: "Z", ingredients: ["Aqua", "Ascorbic Acid"] }),
    ];
    const result = recommendProducts(catalog, selected, {
      ...scope,
      priorityConcerns: ["uneven_tone", "texture", "texture"],
    });
    expect(result.map((item) => item.product.sku)).toEqual(["A", "B", "C"]);
    expect(result[0].reasons.map((reason) => reason.concern)).toEqual([
      "texture",
      "uneven_tone",
    ]);
    expect(
      recommendProducts(catalog, selected, {
        ...scope,
        priorityConcerns: ["texture"],
        limit: 0,
      }),
    ).toEqual([]);
    expect(
      recommendProducts(catalog, selected, {
        ...scope,
        priorityConcerns: ["texture"],
        limit: 1,
      }),
    ).toEqual([result[0]]);
  });

  it.each<Partial<Product>>([
    { visible: false },
    { stock: 0 },
    { status: "draft" },
    { formulaComplete: false },
    { ingredients: ["Aqua", "Salicylic Acid", "Unknown ingredient"] },
    { organizationId: "other-org" },
    { storeId: "other-store" },
  ])(
    "photo-goal coverage cannot promote an ineligible catalog product: %j",
    (change) => {
      const catalog = [
        product({ id: "H", sku: "H", ingredients: ["Aqua", "Glycerin"] }),
        product({
          id: "T",
          sku: "T",
          ingredients: ["Aqua", "Salicylic Acid"],
          ...change,
        }),
      ];
      expect(
        recommendProducts(
          catalog,
          { ...questionnaire, concerns: ["dehydration", "texture"] },
          { ...scope, priorityConcerns: ["texture"] },
        ).map((item) => item.product.sku),
      ).toEqual(["H"]);
    },
  );

  it("does not override exclusions, empty policy, or absent effective goals for coverage", () => {
    const poreProduct = product({ ingredients: ["Aqua", "Salicylic Acid"] });
    const selected: Questionnaire = {
      ...questionnaire,
      concerns: ["texture"],
      excludedIngredients: ["Salicylic Acid"],
    };
    expect(
      recommendProducts([poreProduct], selected, {
        ...scope,
        priorityConcerns: ["texture"],
      }),
    ).toEqual([]);
    expect(
      recommendProducts(
        [poreProduct],
        { ...selected, excludedIngredients: [] },
        { ...scope, rules: [], priorityConcerns: ["texture"] },
      ),
    ).toEqual([]);
    expect(
      recommendProducts([poreProduct], questionnaire, {
        ...scope,
        priorityConcerns: ["texture"],
      }),
    ).toEqual([]);
  });
});
