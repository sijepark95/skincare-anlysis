import { canonicalizeIngredient } from "./ingredients";
import type { Concern } from "./types";

/** Bounded editorial descriptions of cosmetic functions, never efficacy/safety ratings.
 * Sources and review scope: docs/INGREDIENT-GUIDANCE.md.
 * A store-policy association remains necessary; this lookup cannot add recommendations.
 */
const purposes: Readonly<Record<string, string>> = {
  Glycerin:
    "A humectant used in moisturizers to attract and retain water at the skin surface.",
  "Hyaluronic Acid":
    "A water-binding ingredient used in moisturizing formulas for a hydrated skin feel.",
  "Sodium Hyaluronate":
    "A salt of hyaluronic acid used as a water-binding ingredient in moisturizing formulas.",
  Panthenol: "A skin-conditioning humectant used in moisturizing products.",
  Squalane:
    "An emollient used in creams and lotions to soften the feel of the skin surface.",
  "Palmitoyl Tripeptide-1":
    "A skin-conditioning peptide used in cosmetic formulas.",
};

export function ingredientPurpose(
  ingredient: string,
  concern: Concern,
): string | null {
  const canonical = canonicalizeIngredient(ingredient);
  if (!canonical) return null;
  if (canonical === "Niacinamide") {
    if (concern === "uneven_tone")
      return "A form of vitamin B3 studied in specific cosmetic formulations for a more even-looking tone.";
    if (concern === "fine_lines" || concern === "texture")
      return "A form of vitamin B3 studied in specific moisturizers for the appearance of texture and fine lines.";
    return "A form of vitamin B3 used in skin-conditioning formulas.";
  }
  return purposes[canonical] ?? null;
}
