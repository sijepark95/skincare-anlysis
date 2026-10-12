import type { CatalogWrite } from "./contracts";

/** Manual products may omit a merchant SKU; stored variants always have a stable code. */
export function prepareCatalogWrite(
  input: CatalogWrite,
  generateSku: () => string,
): CatalogWrite {
  return {
    ...input,
    sku: input.sku.trim() || (input.id ? "" : generateSku()),
    brand: input.brand.trim(),
    name: input.name.trim(),
    ingredients: input.ingredients.map((ingredient) => ingredient.trim()),
  };
}
