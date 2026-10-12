import type { CatalogWrite } from "@/application/contracts";
import { prepareCatalogWrite } from "@/application/catalog";
import {
  catalogFields,
  catalogLimits,
  validateCatalogDraftStructure,
  type CatalogField,
  type CatalogFieldErrors,
} from "@/domain";
import { catalogSchema } from "./validation";

const messages: Record<CatalogField, string> = {
  id: "Reopen the product editor and try again.",
  sku: `Use up to ${catalogLimits.skuMax} letters, numbers, periods, underscores or hyphens, or leave a new product's SKU blank.`,
  brand: `Enter a brand with 1–${catalogLimits.brandMax} characters.`,
  name: `Enter a product name with 1–${catalogLimits.nameMax} characters.`,
  category: "Choose cleanser, serum, moisturizer or sunscreen.",
  priceMinor:
    "Enter a USD price from 0 to 1,000,000, with at most two decimal places.",
  currency: "Prices must use USD.",
  stock: `Enter a whole number from 0 to ${catalogLimits.stockMax.toLocaleString("en-US")}.`,
  visible: "Reopen the product editor and try again.",
  ingredients: `Use up to ${catalogLimits.ingredientCountMax} ingredient names, each with 1–${catalogLimits.ingredientNameMax} characters. Paste ingredient names rather than ratings or descriptions.`,
  formulaComplete: "Choose whether the complete formula has been verified.",
  suitableSkinTypes:
    "Choose valid suitable skin types, or leave them unselected.",
};

export class CatalogInputError extends Error {
  readonly status = 422;

  constructor(
    readonly fields: CatalogFieldErrors,
    readonly code: "invalid_input" | "invalid_product" = "invalid_input",
  ) {
    super(
      Object.keys(fields).length
        ? "Correct the highlighted product fields and try again."
        : "Product data contains unsupported fields. Reopen the editor and try again.",
    );
    this.name = "CatalogInputError";
  }
}

/** Return authored messages and known field names, never raw input or schema internals. */
export function parseCatalogWrite(
  input: unknown,
  generateSku: () => string,
): CatalogWrite {
  const result = catalogSchema.safeParse(input);
  if (!result.success) {
    const fields: CatalogFieldErrors = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (
        typeof field === "string" &&
        catalogFields.includes(field as CatalogField)
      )
        fields[field as CatalogField] = messages[field as CatalogField];
    }
    throw new CatalogInputError(fields);
  }
  const product = prepareCatalogWrite(result.data, generateSku);
  const validation = validateCatalogDraftStructure(product);
  if (!validation.valid) {
    const fields: CatalogFieldErrors = {};
    for (const issue of validation.errors) {
      const field =
        issue.column === "price"
          ? "priceMinor"
          : issue.column === "skin_types"
            ? "suitableSkinTypes"
            : issue.column;
      if (
        catalogFields.includes(field as CatalogField) &&
        !fields[field as CatalogField]
      )
        fields[field as CatalogField] = issue.message;
    }
    throw new CatalogInputError(fields, "invalid_product");
  }
  return product;
}
