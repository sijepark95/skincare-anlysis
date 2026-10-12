import { canonicalizeIngredients } from "./ingredients";
import {
  productCategories,
  skinTypes,
  type CatalogDraft,
  type CatalogValidation,
} from "./types";

/** Shared business limits for manual entry, CSV imports and HTTP adapters. */
export const catalogLimits = {
  skuMin: 1,
  skuMax: 64,
  brandMax: 120,
  nameMax: 160,
  ingredientNameMax: 120,
  ingredientCountMax: 100,
  priceMinorMax: 100_000_000,
  stockMax: 1_000_000,
} as const;

export const catalogFields = [
  "id",
  "sku",
  "brand",
  "name",
  "category",
  "priceMinor",
  "currency",
  "stock",
  "visible",
  "ingredients",
  "formulaComplete",
  "suitableSkinTypes",
] as const;

export type CatalogField = (typeof catalogFields)[number];

export type CatalogFieldErrors = Partial<Record<CatalogField, string>>;

const textLimits = {
  sku: catalogLimits.skuMax,
  brand: catalogLimits.brandMax,
  name: catalogLimits.nameMax,
} as const;

const unsafeControlCharacters =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Drafts may retain unresolved ingredients while the catalog owner reviews them. */
export function validateCatalogDraftStructure(
  draft: CatalogDraft,
): CatalogValidation {
  const errors: CatalogValidation["errors"] = [];
  for (const column of ["sku", "brand", "name"] as const) {
    const value = draft[column];
    if (!value.trim())
      errors.push({ column, message: `${column} is required.` });
    else if (value.length > textLimits[column])
      errors.push({ column, message: `${column} is too long.` });
    else if (unsafeControlCharacters.test(value) || /[<>]/.test(value))
      errors.push({ column, message: `${column} must contain plain text.` });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(draft.sku))
    errors.push({
      column: "sku",
      message:
        "SKU may contain letters, numbers, periods, underscores and hyphens.",
    });
  if (!productCategories.includes(draft.category))
    errors.push({
      column: "category",
      message: "Choose a supported skincare or cosmetic category.",
    });
  if (
    !Number.isSafeInteger(draft.priceMinor) ||
    draft.priceMinor < 0 ||
    draft.priceMinor > catalogLimits.priceMinorMax
  )
    errors.push({
      column: "price",
      message:
        "Price must be a non-negative USD amount with at most two decimal places.",
    });
  if (draft.currency !== "USD")
    errors.push({ column: "currency", message: "The MVP supports USD only." });
  if (
    !Number.isSafeInteger(draft.stock) ||
    draft.stock < 0 ||
    draft.stock > catalogLimits.stockMax
  )
    errors.push({
      column: "stock",
      message: "Stock must be a whole number from 0 to 1,000,000.",
    });
  if (draft.ingredients.length > catalogLimits.ingredientCountMax)
    errors.push({
      column: "ingredients",
      message: `A formulation may contain at most ${catalogLimits.ingredientCountMax} ingredients.`,
    });
  if (
    draft.ingredients.some(
      (ingredient) =>
        !ingredient.trim() ||
        ingredient.length > catalogLimits.ingredientNameMax ||
        unsafeControlCharacters.test(ingredient) ||
        /[<>]/.test(ingredient),
    )
  )
    errors.push({
      column: "ingredients",
      message: `Ingredient names must be non-empty plain text with at most ${catalogLimits.ingredientNameMax} characters.`,
    });
  if (draft.suitableSkinTypes.some((type) => !skinTypes.includes(type)))
    errors.push({ column: "skin_types", message: "Unknown skin type." });
  return { valid: errors.length === 0, errors };
}

/** Validate before publishing a formulation/listing. Drafts may be stored before review. */
export function validateCatalogDraft(draft: CatalogDraft): CatalogValidation {
  const { errors } = validateCatalogDraftStructure(draft);
  if (!draft.formulaComplete || draft.ingredients.length === 0)
    errors.push({
      column: "ingredients",
      message: "Confirm the complete ingredient list before publication.",
    });
  const { unknown } = canonicalizeIngredients(draft.ingredients);
  if (unknown.length)
    errors.push({
      column: "ingredients",
      message: `Unknown INCI name(s): ${unknown.join(", ")}. Review the ingredient dictionary before publication.`,
    });
  return { valid: errors.length === 0, errors };
}
