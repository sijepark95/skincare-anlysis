import { describe, it, expect } from "vitest";
import {
  validCosmeticShadeDraft,
  validCosmeticShade,
  recommendCosmeticShades,
  type CosmeticShade,
  type CosmeticShadeDraft,
} from "@/domain/cosmetic-shades";
import type { Product } from "@/domain/types";
const org = "ab100000-0000-4000-8000-000000000001",
  store = "ab200000-0000-4000-8000-000000000001",
  variant = "ab300000-0000-4000-8000-000000000001",
  version = "ab400000-0000-4000-8000-000000000001";
const color: CosmeticShadeDraft = {
  category: "blush",
  shadeName: "Soft rose",
  undertone: "cool",
  finish: "satin",
  swatchHex: "#C799AB",
  reviewed: true,
  hueFamily: "rose",
  intensity: "soft",
};
const base: CosmeticShadeDraft = {
  category: "foundation",
  shadeName: "Medium cool",
  undertone: "cool",
  finish: "natural",
  swatchHex: "#C08F7D",
  reviewed: true,
  depth: "medium",
  coverage: "medium",
};
const product = (patch: Partial<Product> = {}): Product => ({
  id: variant,
  organizationId: org,
  storeId: store,
  sku: "BLUSH-1",
  brand: "Store",
  name: "Reviewed cosmetic",
  category: "blush",
  ingredients: ["Aqua", "Glycerin"],
  formulaComplete: true,
  suitableSkinTypes: [],
  stock: 5,
  visible: true,
  priceMinor: 1000,
  currency: "USD",
  status: "published",
  ...patch,
});
const shade = (draft: CosmeticShadeDraft = color): CosmeticShade => ({
  ...draft,
  organizationId: org,
  variantId: variant,
  versionId: version,
  version: 1,
});
const preferences = {
  paletteId: "cool_soft" as const,
  finish: "any",
  base: {
    depth: "medium" as const,
    undertone: "cool" as const,
    concealerPurpose: "match" as const,
  },
};
const scope = {
  organizationId: org,
  storeId: store,
  excludedIngredients: [] as string[],
};
describe("category-specific reviewed cosmetics", () => {
  it("rejects arbitrary metadata, crossed subtypes and unreviewed colors", () => {
    expect(validCosmeticShadeDraft(color)).toBe(true);
    expect(validCosmeticShadeDraft(base)).toBe(true);
    expect(validCosmeticShade(shade())).toBe(true);
    for (const value of [
      { ...color, depth: "medium" },
      { ...base, hueFamily: "rose" },
      { ...base, category: "blush" },
      { ...color, reviewed: false },
      { ...color, shadeName: "<script>" },
      { ...color, shadeName: "x\n" },
      { ...base, finish: "gloss" },
      { ...color, category: "lip_color", hueFamily: "gold" },
      shade(),
    ])
      expect(validCosmeticShadeDraft(value)).toBe(false);
  });
  it("matches registered hue and palette, rejects store/tenant/formula/exclusion/availability failures", () => {
    expect(
      recommendCosmeticShades([product()], [shade()], preferences, scope),
    ).toHaveLength(1);
    for (const patch of [
      { organizationId: "another" },
      { storeId: "another" },
      { stock: 0 },
      { visible: false },
      { status: "draft" as const },
      { ingredients: ["unknown extract"] },
      { formulaComplete: false },
      { category: "serum" as const },
    ])
      expect(
        recommendCosmeticShades(
          [product(patch)],
          [shade()],
          preferences,
          scope,
        ),
      ).toEqual([]);
    expect(
      recommendCosmeticShades(
        [product()],
        [shade({ ...color, hueFamily: "gold" })],
        preferences,
        scope,
      ),
    ).toEqual([]);
    expect(
      recommendCosmeticShades([product()], [shade()], preferences, {
        ...scope,
        excludedIngredients: ["Glycerin"],
      }),
    ).toEqual([]);
  });
  it("requires confirmed base depth and undertone and keeps brightening opt-in", () => {
    const p = product({ category: "foundation" });
    expect(
      recommendCosmeticShades([p], [shade(base)], preferences, scope),
    ).toHaveLength(1);
    expect(
      recommendCosmeticShades(
        [p],
        [shade(base)],
        { ...preferences, base: { ...preferences.base, depth: "unknown" } },
        scope,
      ),
    ).toEqual([]);
    expect(
      recommendCosmeticShades(
        [p],
        [shade({ ...base, depth: "light" })],
        preferences,
        scope,
      ),
    ).toEqual([]);
    const concealer = {
      ...base,
      category: "concealer" as const,
      depth: "light" as const,
    };
    const cp = product({ category: "concealer" });
    expect(
      recommendCosmeticShades([cp], [shade(concealer)], preferences, scope),
    ).toEqual([]);
    expect(
      recommendCosmeticShades(
        [cp],
        [shade(concealer)],
        {
          ...preferences,
          base: { ...preferences.base, concealerPurpose: "brighten" },
        },
        scope,
      )[0].reasonCodes,
    ).toContain("brightening_candidate");
  });
  it("limits each category to three without duplicates", () => {
    const products = Array.from({ length: 5 }, (_, i) =>
      product({
        id: `ab300000-0000-4000-8000-00000000000${i}`,
        sku: `BLUSH-${i}`,
      }),
    );
    const shades = products.map((p) => ({ ...shade(), variantId: p.id }));
    expect(
      recommendCosmeticShades(
        [...products, products[0]],
        shades,
        preferences,
        scope,
      ),
    ).toHaveLength(3);
  });
});
