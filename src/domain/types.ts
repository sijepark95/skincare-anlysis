/** Domain read models are independent of transport, persistence and UI frameworks. */
export const concerns = [
  "dehydration",
  "texture",
  "uneven_tone",
  "fine_lines",
] as const;
export type Concern = (typeof concerns)[number];

export const skinTypes = [
  "normal",
  "dry",
  "oily",
  "combination",
  "unsure",
] as const;
export type SkinType = (typeof skinTypes)[number];

export const productCategories = [
  "cleanser",
  "serum",
  "moisturizer",
  "sunscreen",
  "lip_color",
  "blush",
  "eye_color",
  "foundation",
  "concealer",
] as const;
export type ProductCategory = (typeof productCategories)[number];
export type PublicationStatus = "draft" | "published";

/** A flattened view of a catalog formulation and its store listing, not a table definition. */
export interface CatalogDraft {
  sku: string;
  brand: string;
  name: string;
  category: ProductCategory;
  priceMinor: number;
  currency: "USD";
  stock: number;
  visible: boolean;
  ingredients: string[];
  formulaComplete: boolean;
  suitableSkinTypes: SkinType[];
}

export interface Product extends CatalogDraft {
  id: string;
  organizationId: string;
  storeId: string;
  status: PublicationStatus;
}

export interface Questionnaire {
  skinType: SkinType;
  concerns: Concern[];
  excludedIngredients: string[];
  concernWeights?: Partial<Record<Concern, number>>;
}

export interface RecommendationReason {
  concern: Concern;
  ingredient: string;
  relevance: number;
}

export interface Recommendation {
  product: Product;
  score: number;
  matchedIngredients: string[];
  reasons: RecommendationReason[];
}

/** The application supplies this scope from an authenticated membership or device. */
export interface RecommendationScope {
  organizationId: string;
  storeId: string;
  limit?: number;
  /** Trusted applicable photo goals; coverage selects only already eligible ranked products. */
  priorityConcerns?: readonly Concern[];
  /** Inject the tenant's approved, versioned policy; omitted only for the demo adapter. */
  rules?: readonly IngredientRule[];
  /** Present only for experimental inference. Empty candidates intentionally yield no matches. */
  ingredientCandidates?: readonly { ingredient: string; score: number }[];
}

export interface IngredientRule {
  concern: Concern;
  ingredient: string;
  relevance: 1 | 2 | 3;
}

export interface CatalogIssue {
  column: string;
  message: string;
}

export interface CatalogValidation {
  valid: boolean;
  errors: CatalogIssue[];
}

export interface CsvIssue extends CatalogIssue {
  /** Human-readable record number; 1 is the header. Multiline quoted cells are one record. */
  row: number;
}

export interface CsvPreview {
  /** Import is all-or-nothing: any error leaves this array empty. */
  rows: CatalogDraft[];
  errors: CsvIssue[];
  valid: boolean;
}
