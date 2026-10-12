import { describe, expect, it, vi } from "vitest";
import { prepareCatalogWrite } from "@/application/catalog";
import type { CatalogWrite } from "@/application/contracts";

const draft: CatalogWrite = {
  sku: "",
  brand: " Retail Lab ",
  name: " Heartleaf pad ",
  category: "serum",
  priceMinor: 2400,
  currency: "USD",
  stock: 10,
  visible: false,
  ingredients: [" Aqua ", " 1,2-Hexanediol "],
  formulaComplete: false,
  suitableSkinTypes: [],
};

describe("catalog write preparation", () => {
  it("assigns only a new blank SKU and trims text without modifying the input", () => {
    const generateSku = vi.fn(() => "SMV-server-generated");
    const prepared = prepareCatalogWrite(draft, generateSku);
    expect(prepared).toMatchObject({
      sku: "SMV-server-generated",
      brand: "Retail Lab",
      name: "Heartleaf pad",
      ingredients: ["Aqua", "1,2-Hexanediol"],
    });
    expect(generateSku).toHaveBeenCalledOnce();
    expect(draft.ingredients[0]).toBe(" Aqua ");
    expect(draft.sku).toBe("");
  });
  it.each([
    [{ sku: " A " }, "A"],
    [{ id: "existing-product", sku: "" }, ""],
    [{ id: "existing-product", sku: " B " }, "B"],
  ])("preserves supplied or existing identity for %j", (patch, expected) => {
    const generateSku = vi.fn(() => "unwanted-replacement");
    expect(prepareCatalogWrite({ ...draft, ...patch }, generateSku).sku).toBe(
      expected,
    );
    expect(generateSku).not.toHaveBeenCalled();
  });
});
