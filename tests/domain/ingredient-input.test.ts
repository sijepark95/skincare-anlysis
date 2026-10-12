import { describe, expect, it } from "vitest";
import {
  ingredientInputMaxLength,
  parseIngredientInput,
} from "../../src/domain/ingredient-input";

import { heartleafReport, expectedNames } from "../fixtures/ingredient-report";

describe("ingredient input", () => {
  it("extracts all 38 pasted report names in source order and requires review", () => {
    expect(heartleafReport.length).toBeLessThan(ingredientInputMaxLength);
    expect(parseIngredientInput(heartleafReport)).toEqual({
      format: "report",
      ingredients: expectedNames,
      warnings: [],
      requiresReview: true,
    });
  });

  it("removes only recognized metadata and never corrects source names", () => {
    const { ingredients } = parseIngredientInput(heartleafReport);
    expect(ingredients).toHaveLength(38);
    expect(ingredients[0]).toBe("Aqua");
    expect(ingredients.at(-1)).toBe("Quercetin");
    expect(ingredients).toContain("1,2-Hexanediol");
    expect(ingredients).toContain("Brassica Oleracea Italica (Brocoli) Seed");
    expect(ingredients).toContain("Disodium Edta");
    expect(
      ingredients.some((name) =>
        /purpose|moisturizing|skin barrier protection|brightening|lock in hydration|^\d+(?:-\d+)?$/i.test(
          name,
        ),
      ),
    ).toBe(false);
  });

  it("supports CRLF and case-insensitive report labels", () => {
    const input = heartleafReport
      .replaceAll("All Ingredients", "ALL INGREDIENTS:")
      .replaceAll("Purpose of formulation:", "PURPOSE OF FORMULATION:")
      .replaceAll("\n", "\r\n");
    expect(parseIngredientInput(input).ingredients).toEqual(expectedNames);
  });

  it("warns about missing or ambiguous blocks instead of importing uncertain metadata", () => {
    const result = parseIngredientInput(`All Ingredients
3
1
Aqua
Purpose of formulation: solvent
2
Glycerin
Unknown source benefit
Purpose of formulation: moisturizer
1
Moisturizing
Purpose of formulation: skin conditioning agent`);
    expect(result.ingredients).toEqual(["Aqua"]);
    expect(result.requiresReview).toBe(true);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("block 2");
    expect(result.warnings[1]).toContain("block 3");
    expect(result.warnings[2]).toContain("3 ingredients, but 1 name");
  });

  it("warns about a declared count mismatch and an unfinished trailing block", () => {
    const result = parseIngredientInput(`All Ingredients
2
1
Aqua
Purpose of formulation: solvent
1
Glycerin
Moisturizing`);
    expect(result.ingredients).toEqual(["Aqua"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("without a following");
    expect(result.warnings[1]).toContain("2 ingredients");
  });

  it("flags missing report counts and refuses partial report formats", () => {
    expect(
      parseIngredientInput(
        "All Ingredients\nAqua\nPurpose of formulation: solvent",
      ).warnings[0],
    ).toContain("readable ingredient count");
    for (const raw of [
      "All Ingredients\n38\nAqua\nMoisturizing",
      "Aqua\nPurpose of formulation: solvent",
    ]) {
      expect(parseIngredientInput(raw)).toMatchObject({
        format: "report",
        ingredients: [],
        requiresReview: true,
      });
      expect(parseIngredientInput(raw).warnings[0]).toContain("incomplete");
    }
  });

  it("splits mixed plain-list separators while preserving chemical and grouped commas", () => {
    expect(
      parseIngredientInput(
        "Aqua, Glycerin; 1,2-Hexanediol\r\nExtract (Leaf, Flower), Ingredient [A, B]; Tocopherol",
      ),
    ).toEqual({
      format: "list",
      ingredients: [
        "Aqua",
        "Glycerin",
        "1,2-Hexanediol",
        "Extract (Leaf, Flower)",
        "Ingredient [A, B]",
        "Tocopherol",
      ],
      warnings: [],
      requiresReview: false,
    });
  });

  it("preserves ordering and duplicates for later validation", () => {
    expect(parseIngredientInput('"Aqua; Aqua\nGlycerin"').ingredients).toEqual([
      "Aqua",
      "Aqua",
      "Glycerin",
    ]);
    const manyNames = Array.from(
      { length: 101 },
      (_, index) => `INCI ${index}`,
    );
    expect(parseIngredientInput(manyNames.join(";")).ingredients).toEqual(
      manyNames,
    );
  });

  it("requires review for unmatched or incorrectly nested groups", () => {
    for (const raw of [
      "Aqua, Extract (Leaf, Flower",
      "Aqua, Extract [Leaf, Flower)",
      "Aqua, Extract (Leaf [Flower)]",
      "Aqua, Glycerin)",
    ]) {
      const result = parseIngredientInput(raw);
      expect(result.requiresReview).toBe(true);
      expect(result.warnings[0]).toContain("unmatched");
    }
  });

  it("does not silently truncate oversized input", () => {
    expect(parseIngredientInput("I".repeat(ingredientInputMaxLength))).toEqual({
      format: "list",
      ingredients: ["I".repeat(ingredientInputMaxLength)],
      warnings: [],
      requiresReview: false,
    });
    const result = parseIngredientInput(
      `${heartleafReport}\n${"X".repeat(ingredientInputMaxLength)}`,
    );
    expect(result.ingredients).toEqual([]);
    expect(result.requiresReview).toBe(true);
    expect(result.warnings[0]).toContain("No text was truncated or imported");
  });

  it("returns an empty list for blank input", () => {
    expect(parseIngredientInput(" \n ; , \r\n")).toEqual({
      format: "list",
      ingredients: [],
      warnings: [],
      requiresReview: false,
    });
  });
});
