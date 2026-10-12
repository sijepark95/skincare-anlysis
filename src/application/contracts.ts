import type {
  Concern,
  IngredientRule,
  Product,
  Questionnaire,
  Recommendation,
} from "@/domain/types";
import type { RecommendationExplanation } from "./explanation-contracts";
import type { SkinConsultationReport } from "@/domain/skin-consultation";

export type Role = "owner" | "manager" | "viewer";
export interface Store {
  id: string;
  name: string;
  location: string;
  currency: string;
}
export interface StaffContext {
  organizationId: string;
  organizationName: string;
  role: Role;
  stores: Store[];
}
export interface AccountStatus {
  authenticated: boolean;
  needsWorkspace: boolean;
  staff: StaffContext | null;
}
export type AccountNext = "management" | "setup";
export interface DeviceContext {
  organizationId: string;
  storeId: string;
  deviceId: string;
}
export interface Answers extends Questionnaire {
  sensitive: boolean;
}
export interface MockAnalysis {
  request_id: string;
  mode: "mock";
  model_version: string;
  quality_status: "demo";
  observations: {
    concern_id: Concern;
    level: "low" | "moderate" | "high";
    score: number;
  }[];
  disclaimer: string;
}
/** Experimental model outputs stay categorical; they are not clinical measurements. */
export interface ExperimentalAnalysis {
  request_id: string;
  mode: "experimental";
  model_version: string;
  quality_status: "experimental";
  observations: [];
  disclaimer: string;
  visual: {
    model_version: string;
    heads: {
      key: string;
      label: string;
      predicted_code: string;
      probabilities: { code: string; probability: number }[];
    }[];
  } | null;
  ingredients: {
    model_version: string;
    candidates: { ingredient: string; score: number }[];
    input_coverage: string[];
  };
}
/** Visible appearance categories from a separately consented external photo request. */
export interface OpenAIAnalysis {
  request_id: string;
  mode: "openai";
  model_version: "gpt-4.1-mini-2025-04-14";
  quality_status: "usable" | "limited" | "not_assessable" | "not_provided";
  observations: [];
  disclaimer: string;
  vision: {
    prompt_version: "visible-appearance-eval-v1";
    image_quality: "usable" | "limited" | "not_assessable";
    quality_flags: (
      | "no_face"
      | "multiple_faces"
      | "blur"
      | "low_light"
      | "uneven_lighting"
      | "occlusion"
      | "makeup_or_filter"
      | "face_not_fully_visible"
      | "resolution_limited"
    )[];
    observed_features: Record<
      | "visible_redness"
      | "visible_spots"
      | "visible_pores"
      | "visible_fine_lines"
      | "visible_flaking",
      "visible" | "not_visible" | "uncertain" | "not_assessable"
    >;
  } | null;
}
export type Analysis = MockAnalysis | ExperimentalAnalysis | OpenAIAnalysis;
export interface Consultation {
  id: string;
  organizationId: string;
  storeId: string;
  deviceId: string;
  createdAt: string;
  consent: boolean;
  consentVersion?: string;
  answers: Answers | null;
  analysis: Analysis | null;
  recommendations: Recommendation[] | null;
  explanationConsent?: { accepted: boolean; noticeVersion: string } | null;
  visionConsent?: { accepted: boolean; noticeVersion: string } | null;
  explanation?: RecommendationExplanation | null;
  /** Derived from saved observations, pinned policy and currently eligible registered products. */
  skinConsultation?: SkinConsultationReport | null;
}
export interface Policy {
  id: string;
  version: string;
  rules: IngredientRule[];
  source?: "operator-configured" | "mock-onboarding-v1";
}
export interface DeviceRecord {
  id: string;
  label: string;
  storeId: string;
  revoked: boolean;
  lastSeen: string | null;
}
export interface Metrics {
  started: number;
  completed: number;
  analyzed: number;
}
export interface CatalogWrite {
  id?: string;
  sku: string;
  brand: string;
  name: string;
  category: Product["category"];
  priceMinor: number;
  currency: "USD";
  stock: number;
  visible: boolean;
  ingredients: string[];
  formulaComplete: boolean;
  suitableSkinTypes: Product["suitableSkinTypes"];
}
const appErrorBrand = Symbol.for("senmiva.application.AppError.v1");

export class AppError extends Error {
  /** Global demo adapters can outlive their constructor's development module. */
  static [Symbol.hasInstance](value: unknown): boolean {
    try {
      if (!(value instanceof Error)) return false;
      const brand = Object.getOwnPropertyDescriptor(value, appErrorBrand);
      const status = Object.getOwnPropertyDescriptor(value, "status")?.value;
      const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
      const message = Object.getOwnPropertyDescriptor(value, "message")?.value;
      return (
        brand?.value === true &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599 &&
        typeof code === "string" &&
        /^[a-z][a-z0-9_]{0,79}$/.test(code) &&
        typeof message === "string"
      );
    } catch {
      return false;
    }
  }

  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    Object.defineProperty(this, appErrorBrand, { value: true });
  }
}
export interface Repository {
  products(storeId: string): Promise<Product[]>;
  saveDraft(storeId: string, product: CatalogWrite): Promise<void>;
  importDrafts(storeId: string, products: CatalogWrite[]): Promise<void>;
  publish(id: string): Promise<void>;
  updateListing(
    storeId: string,
    id: string,
    patch: Pick<Product, "priceMinor" | "stock" | "visible">,
  ): Promise<void>;
  start(device: DeviceContext): Promise<Consultation>;
  session(id: string, device: DeviceContext): Promise<Consultation>;
  consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion?: string,
  ): Promise<void>;
  answers(id: string, device: DeviceContext, answers: Answers): Promise<void>;
  saveAnalysis(
    id: string,
    device: DeviceContext,
    analysis: Analysis,
  ): Promise<void>;
  saveRecommendations(
    id: string,
    device: DeviceContext,
    policy: Policy,
    items: Recommendation[],
  ): Promise<void>;
  explanationConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  claimExplanation(id: string, device: DeviceContext): Promise<boolean>;
  visionConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  claimVisionAnalysis(id: string, device: DeviceContext): Promise<boolean>;
  saveExplanation(
    id: string,
    device: DeviceContext,
    explanation: RecommendationExplanation,
  ): Promise<void>;
  finish(id: string, device: DeviceContext): Promise<void>;
  /** A completed consultation uses the immutable policy version saved with its recommendation run. */
  policy(device: DeviceContext, sessionId?: string): Promise<Policy>;
  metrics(storeId: string): Promise<Metrics>;
  devices(storeId: string): Promise<DeviceRecord[]>;
  pairingCode(
    storeId: string,
    label: string,
  ): Promise<{ code: string; expiresAt: string }>;
  revokeDevice(id: string): Promise<void>;
}
export interface AnalysisProvider {
  analyze(
    sessionId: string,
    answers: Answers,
    image?: Uint8Array,
  ): Promise<Analysis>;
}
