import { describe, expect, it } from "vitest";
import {
  catalogLimits,
  catalogFields,
  validateCatalogDraft,
  validateCatalogDraftStructure,
  type CatalogDraft,
  type CatalogFieldErrors,
} from "../../src/domain";
import { parseCatalogCsv } from "../../src/domain/csv";
import {
  catalogSchema,
  listingSchema,
} from "../../src/interfaces/http/validation";

function draft(patch: Partial<CatalogDraft> = {}): CatalogDraft {
  return {
    sku: "A",
    brand: "Senmiva Lab",
    name: "Hydrating Serum",
    category: "serum",
    priceMinor: 2450,
    currency: "USD",
    stock: 12,
    visible: false,
    ingredients: ["Aqua", "Glycerin"],
    formulaComplete: true,
    suitableSkinTypes: ["normal", "dry"],
    ...patch,
  };
}

describe("shared catalog validation boundaries", () => {
  it("accepts a one-character SKU and full-length normalized fields at both boundaries", () => {
    const longDraft = draft({
      sku: " A ",
      brand: ` ${"B".repeat(catalogLimits.brandMax)} `,
      name: ` ${"N".repeat(catalogLimits.nameMax)} `,
      ingredients: [` ${"I".repeat(catalogLimits.ingredientNameMax)} `],
      priceMinor: catalogLimits.priceMinorMax,
      stock: catalogLimits.stockMax,
      formulaComplete: false,
    });
    const normalized = catalogSchema.parse(longDraft);
    expect(normalized).toMatchObject({
      sku: "A",
      brand: "B".repeat(120),
      name: "N".repeat(160),
      ingredients: ["I".repeat(120)],
      priceMinor: 100_000_000,
      stock: 1_000_000,
    });
    expect(validateCatalogDraftStructure(normalized)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("accepts the longest application SKU and ingredient list", () => {
    const value = draft({
      sku: "A".repeat(catalogLimits.skuMax),
      ingredients: Array.from(
        { length: catalogLimits.ingredientCountMax },
        (_, index) => `Reviewed draft ingredient ${index}`,
      ),
      formulaComplete: false,
    });
    expect(catalogSchema.safeParse(value).success).toBe(true);
    expect(validateCatalogDraftStructure(value).valid).toBe(true);
  });

  it.each([
    ["sku", { sku: "A".repeat(catalogLimits.skuMax + 1) }],
    ["brand", { brand: "B".repeat(catalogLimits.brandMax + 1) }],
    ["name", { name: "N".repeat(catalogLimits.nameMax + 1) }],
    [
      "ingredients",
      { ingredients: ["I".repeat(catalogLimits.ingredientNameMax + 1)] },
    ],
    [
      "ingredients",
      {
        ingredients: Array.from(
          { length: catalogLimits.ingredientCountMax + 1 },
          () => "Aqua",
        ),
      },
    ],
    ["ingredients", { ingredients: [""] }],
    ["ingredients", { ingredients: ["   "] }],
    ["price", { priceMinor: catalogLimits.priceMinorMax + 1 }],
    ["price", { priceMinor: -1 }],
    ["price", { priceMinor: 12.5 }],
    ["stock", { stock: catalogLimits.stockMax + 1 }],
    ["stock", { stock: -1 }],
    ["stock", { stock: 2.5 }],
  ] satisfies [string, Partial<CatalogDraft>][])(
    "rejects invalid %s consistently in domain and HTTP",
    (column, patch) => {
      const value = draft(patch);
      expect(catalogSchema.safeParse(value).success).toBe(false);
      expect(validateCatalogDraftStructure(value)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([expect.objectContaining({ column })]),
      });
    },
  );

  it("accepts omitted or blank SKU at transport while requiring a stored domain SKU", () => {
    const { sku: omitted, ...withoutSku } = draft();
    expect(omitted).toBe("A");
    for (const value of [
      withoutSku,
      draft({ sku: "" }),
      draft({ sku: "   " }),
    ]) {
      const parsed = catalogSchema.parse(value);
      expect(parsed.sku).toBe("");
      expect(validateCatalogDraftStructure(parsed).errors).toContainEqual(
        expect.objectContaining({ column: "sku" }),
      );
    }
    expect(catalogLimits.skuMin).toBe(1);
  });

  it.each(["sku", "brand", "name", "ingredients"] as const)(
    "keeps plain-text enforcement for %s in the domain",
    (column) => {
      for (const value of [
        "<script>",
        "text\u0000content",
        "text\u0007content",
      ]) {
        const candidate = draft({
          [column]: column === "ingredients" ? [value] : value,
        });
        expect(validateCatalogDraftStructure(candidate).errors).toContainEqual(
          expect.objectContaining({ column }),
        );
      }
    },
  );

  it("allows an unfinished draft while retaining publication requirements", () => {
    const value = draft({ ingredients: [], formulaComplete: false });
    expect(catalogSchema.safeParse(value).success).toBe(true);
    expect(validateCatalogDraftStructure(value).valid).toBe(true);
    expect(validateCatalogDraft(value)).toMatchObject({ valid: false });
    expect(
      validateCatalogDraft(draft({ ingredients: ["Unreviewed Ingredient"] }))
        .valid,
    ).toBe(false);
  });

  it("uses the same price and stock bounds for store listing updates", () => {
    const listing = {
      priceMinor: catalogLimits.priceMinorMax,
      stock: catalogLimits.stockMax,
      visible: false,
    };
    expect(listingSchema.parse(listing)).toEqual(listing);
    expect(
      listingSchema.safeParse({
        ...listing,
        priceMinor: listing.priceMinor + 1,
      }).success,
    ).toBe(false);
    expect(
      listingSchema.safeParse({ ...listing, stock: listing.stock + 1 }).success,
    ).toBe(false);
    expect(
      listingSchema.safeParse({ ...listing, organizationId: "untrusted" })
        .success,
    ).toBe(false);
  });

  it("exports typed field errors without introducing transport fields into drafts", () => {
    const errors: CatalogFieldErrors = {
      priceMinor: "Enter a whole minor-unit amount.",
      suitableSkinTypes: "Choose a supported skin type.",
    };
    expect(Object.keys(errors)).toEqual(["priceMinor", "suitableSkinTypes"]);
    expect(
      Object.keys(errors).every((field) =>
        catalogFields.includes(field as keyof typeof errors),
      ),
    ).toBe(true);
    expect(catalogSchema.safeParse({ ...draft(), errors }).success).toBe(false);
  });
});

describe("CSV inherits shared domain limits", () => {
  const header = "sku,brand,name,category,price,stock,ingredients";
  const record = (value: CatalogDraft) =>
    [
      value.sku,
      value.brand,
      value.name,
      value.category,
      (value.priceMinor / 100).toFixed(2),
      value.stock,
      value.ingredients.join(";"),
    ].join(",");

  it("accepts one-character SKU, full-length brand/name and maximum price", () => {
    const value = draft({
      brand: "B".repeat(catalogLimits.brandMax),
      name: "N".repeat(catalogLimits.nameMax),
      priceMinor: catalogLimits.priceMinorMax,
      stock: catalogLimits.stockMax,
    });
    const result = parseCatalogCsv(`${header}\n${record(value)}`);
    expect(result.valid).toBe(true);
    expect(result.rows[0]).toMatchObject({
      sku: value.sku,
      brand: value.brand,
      name: value.name,
      priceMinor: value.priceMinor,
      stock: value.stock,
      ingredients: value.ingredients,
    });
  });

  it.each([
    ["sku", { sku: "A".repeat(catalogLimits.skuMax + 1) }],
    ["brand", { brand: "B".repeat(catalogLimits.brandMax + 1) }],
    ["name", { name: "N".repeat(catalogLimits.nameMax + 1) }],
    ["price", { priceMinor: catalogLimits.priceMinorMax + 1 }],
  ] satisfies [string, Partial<CatalogDraft>][])(
    "rejects over-limit %s and retains all-or-nothing import behavior",
    (column, patch) => {
      const result = parseCatalogCsv(
        `${header}\n${record(draft())}\n${record(draft({ sku: "B", ...patch }))}`,
      );
      expect(result.valid).toBe(false);
      expect(result.rows).toEqual([]);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 3, column }),
      );
    },
  );
});
