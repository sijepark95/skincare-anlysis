import { describe, expect, it } from "vitest";
import {
  personalColorPalettes,
  paletteIds,
  recommendLipShades,
  suggestedPalette,
  validColorPreferences,
  validLipShadeDraft,
  type ColorPreferences,
  type LipShade,
} from "@/domain/personal-color";
import type { Product } from "@/domain/types";

const scope = {
  organizationId: "organization-a",
  storeId: "store-a",
  excludedIngredients: [] as string[],
};
const preferences: ColorPreferences = { paletteId: "warm_soft", finish: "any" };
function product(id = "lip-a", changes: Partial<Product> = {}): Product {
  return {
    id,
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    sku: id,
    brand: "Test merchant",
    name: "Test lip colour",
    category: "lip_color",
    priceMinor: 2000,
    currency: "USD",
    stock: 1,
    visible: true,
    ingredients: ["Aqua", "Glycerin"],
    formulaComplete: true,
    suitableSkinTypes: [],
    status: "published",
    ...changes,
  };
}
function shade(id = "lip-a", changes: Partial<LipShade> = {}): LipShade {
  return {
    variantId: id,
    organizationId: scope.organizationId,
    versionId: `version-${id}`,
    version: 1,
    shadeName: "Soft coral",
    hueFamily: "coral",
    undertone: "warm",
    intensity: "soft",
    finish: "satin",
    swatchHex: "#B88A72",
    reviewed: true,
    ...changes,
  };
}

describe("confirmed palette and reviewed merchant lip matching", () => {
  it("offers six unique style directions without seasonal or diagnostic labels", () => {
    expect(personalColorPalettes.map((item) => item.id)).toEqual(paletteIds);
    expect(new Set(paletteIds).size).toBe(6);
    for (const palette of personalColorPalettes) {
      expect(
        validColorPreferences({ paletteId: palette.id, finish: "any" }),
      ).toBe(true);
      expect(
        palette.swatches.every((value) => /^#[0-9a-f]{6}$/i.test(value)),
      ).toBe(true);
    }
  });

  it.each([
    { image_quality: "limited", undertone: "warm", chroma: "soft" },
    { image_quality: "not_assessable", undertone: "cool", chroma: "clear" },
    { image_quality: "usable", undertone: "uncertain", chroma: "soft" },
    { image_quality: "usable", undertone: "warm", chroma: "uncertain" },
    { image_quality: "usable", undertone: "spring", chroma: "soft" },
    null,
  ])(
    "makes no palette suggestion from inadequate or uncertain evidence: %o",
    (analysis) => {
      expect(suggestedPalette(analysis)).toBeNull();
    },
  );

  it("returns a direction only for usable complete observations", () => {
    expect(
      suggestedPalette({
        image_quality: "usable",
        undertone: "cool",
        chroma: "clear",
      }),
    ).toBe("cool_clear");
  });

  it.each([
    { paletteId: "spring", finish: "any" },
    { paletteId: "warm_soft", finish: "sparkle" },
  ])("rejects unsupported preferences: %o", (value) => {
    expect(validColorPreferences(value as ColorPreferences)).toBe(false);
    expect(
      recommendLipShades(
        [product()],
        [shade()],
        value as ColorPreferences,
        scope,
      ),
    ).toEqual([]);
  });

  it.each([
    { organizationId: "other-organization" },
    { storeId: "other-store" },
    { stock: 0 },
    { stock: -1 },
    { stock: 0.5 },
    { visible: false },
    { status: "draft" as const },
    { formulaComplete: false },
    { ingredients: [] },
    { ingredients: ["Unreviewed Secret Compound"] },
    { category: "serum" as const },
    { category: "moisturizer" as const },
  ])(
    "excludes catalog rows outside the eligible reviewed store inventory: %o",
    (changes) => {
      expect(
        recommendLipShades(
          [product("lip-a", changes)],
          [shade()],
          preferences,
          scope,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { organizationId: "other-organization" },
    { variantId: "other-variant" },
    { reviewed: false },
    { versionId: "" },
    { version: 0 },
    { version: 1.5 },
    { shadeName: " " },
    { swatchHex: "red" },
    { finish: "sparkle" },
  ])("requires matching reviewed, versioned shade metadata: %o", (changes) => {
    const candidate = { ...shade(), ...changes } as LipShade;
    expect(
      recommendLipShades([product()], [candidate], preferences, scope),
    ).toEqual([]);
  });

  it("fails closed for missing shades, incomplete scope and unknown ingredient exclusions", () => {
    expect(recommendLipShades([product()], [], preferences, scope)).toEqual([]);
    expect(
      recommendLipShades([product()], [shade()], preferences, {
        ...scope,
        organizationId: "",
      }),
    ).toEqual([]);
    expect(
      recommendLipShades([product()], [shade()], preferences, {
        ...scope,
        storeId: "",
      }),
    ).toEqual([]);
    expect(
      recommendLipShades([product()], [shade()], preferences, {
        ...scope,
        excludedIngredients: ["Unknown Allergen"],
      }),
    ).toEqual([]);
  });

  it("uses canonical ingredient aliases for guest exclusions", () => {
    expect(
      recommendLipShades(
        [product("lip-a", { ingredients: ["Aqua", "Niacinamide"] })],
        [shade()],
        preferences,
        { ...scope, excludedIngredients: ["Vitamin B3"] },
      ),
    ).toEqual([]);
    expect(
      recommendLipShades([product()], [shade()], preferences, {
        ...scope,
        excludedIngredients: ["Vitamin B3"],
      }),
    ).toHaveLength(1);
  });

  it("respects the selected finish and excludes the opposing warm/cool direction", () => {
    const products = [
      product("warm"),
      product("neutral"),
      product("cool"),
      product("gloss"),
    ];
    const shades = [
      shade("warm"),
      shade("neutral", { undertone: "neutral" }),
      shade("cool", { undertone: "cool" }),
      shade("gloss", { finish: "gloss" }),
    ];
    expect(
      recommendLipShades(
        products,
        shades,
        { ...preferences, finish: "satin" },
        scope,
      ).map((item) => item.product.id),
    ).toEqual(["warm", "neutral"]);
    expect(
      recommendLipShades(
        products,
        shades,
        { paletteId: "cool_soft", finish: "satin" },
        scope,
      ).map((item) => item.product.id),
    ).toEqual(["cool", "neutral"]);
  });

  it("ranks registered undertone and intensity deterministically, deduplicates and caps at three", () => {
    const products = [
      product("d"),
      product("b"),
      product("a"),
      product("c"),
      product("a"),
    ];
    const shades = [
      shade("d", { intensity: "clear" }),
      shade("b"),
      shade("a"),
      shade("c", { undertone: "neutral" }),
    ];
    const matches = recommendLipShades(products, shades, preferences, scope);
    expect(matches.map((item) => item.product.id)).toEqual(["a", "b", "c"]);
    expect(matches[0].reasons).toEqual([
      "You confirmed the soft warmth palette.",
      "The store describes Soft coral as warm, soft and satin.",
      "Its registered intensity follows your confirmed palette direction.",
    ]);
  });

  it("allows warm/cool alternatives for neutral choices without representing them as an exact tone match", () => {
    const products = [product("warm"), product("neutral"), product("cool")];
    const shades = [
      shade("warm"),
      shade("neutral", { undertone: "neutral" }),
      shade("cool", { undertone: "cool" }),
    ];
    expect(
      recommendLipShades(
        products,
        shades,
        { paletteId: "neutral_soft", finish: "any" },
        scope,
      ).map((item) => item.product.id),
    ).toEqual(["neutral", "cool", "warm"]);
  });

  it("does not mutate the catalog, shade versions, preferences or exclusions", () => {
    const inputs = {
      products: [product()],
      shades: [shade()],
      preferences,
      scope,
    };
    const before = structuredClone(inputs);
    recommendLipShades(
      inputs.products,
      inputs.shades,
      inputs.preferences,
      inputs.scope,
    );
    expect(inputs).toEqual(before);
    expect(validLipShadeDraft(shade())).toBe(true);
  });
});
