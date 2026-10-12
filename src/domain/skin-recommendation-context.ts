import { visibleRecommendationConcerns, type SkinVision } from "./skin-vision";
import {
  concerns,
  type Concern,
  type Questionnaire,
  type SkinType,
} from "./types";

/** Explicit recommendation facts; never masquerades as a completed questionnaire. */
export interface SkinRecommendationContext {
  skinType: SkinType;
  selectedConcerns: Concern[];
  photoConcerns: Concern[];
  excludedIngredients: string[];
  concernWeights?: Partial<Record<Concern, number>>;
}
export const skincareCategories = [
  "cleanser",
  "serum",
  "moisturizer",
  "sunscreen",
] as const;
export function isSkincareCategory(category: string): boolean {
  return skincareCategories.some((item) => item === category);
}
export function skinRecommendationContext(
  profile: Pick<
    Questionnaire,
    "skinType" | "concerns" | "excludedIngredients" | "concernWeights"
  >,
  vision: SkinVision | null,
): SkinRecommendationContext {
  return {
    skinType: profile.skinType,
    selectedConcerns: concerns.filter((goal) =>
      profile.concerns.includes(goal),
    ),
    photoConcerns: visibleRecommendationConcerns(vision),
    excludedIngredients: [...profile.excludedIngredients],
    ...(profile.concernWeights
      ? { concernWeights: { ...profile.concernWeights } }
      : {}),
  };
}
