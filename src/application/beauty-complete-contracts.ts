import type { DeviceContext, Policy } from "./contracts";
import type { BeautyAnalysis } from "@/domain/beauty-analysis";
import type { BeautySession } from "./beauty-consultations";
import type { SkinVision } from "@/domain/skin-vision";
import type { Concern, SkinType, Recommendation } from "@/domain/types";
import type { BeautyPreferences } from "@/domain/beauty";
import type {
  BaseChoice,
  CosmeticShade,
  CosmeticShadeDraft,
} from "@/domain/cosmetic-shades";

export const COMPLETE_PHOTO_NOTICE_VERSION =
  "2026-10-beauty-complete-photo-v1" as const;
export const COMPLETE_PREVIEW_NOTICE_VERSION =
  "2026-10-beauty-preview-v1" as const;
export const COMPLETE_SAVE_NOTICE_VERSION = "2026-10-complete-save-v1" as const;
export const guestAgeBands = [
  "under13",
  "13-15",
  "16-17",
  "18-24",
  "25-34",
  "35-44",
  "45-54",
  "55+",
] as const;
export type GuestAgeBand = (typeof guestAgeBands)[number];
export type BeautyLocale = "en" | "ko" | "es";
export type GuestGender =
  "woman" | "man" | "nonbinary" | "self_described" | "prefer_not_to_say";
export interface BeautyGuestContext {
  ageBand: GuestAgeBand;
  locale: BeautyLocale;
  analyticsConsent: boolean;
}
export interface CompleteSkinProfile {
  skinType: SkinType;
  concerns: Concern[];
  excludedIngredients: string[];
}
export type PreviewKind = "makeup" | "hair_style" | "hair_color";
export type PreviewStatus =
  "pending" | "running" | "complete" | "failed" | "cancelled";
export interface CompletePreviewSlot {
  slot: number;
  kind: PreviewKind;
  status: PreviewStatus;
}
export interface CompletePreviewPlan {
  id: string;
  deadline: string;
  slots: CompletePreviewSlot[];
  cancelled: boolean;
}
export interface BeautyCompleteState {
  guest: BeautyGuestContext | null;
  photoConsent: boolean;
  attempted: boolean;
  beauty: BeautySession;
  skinVision: SkinVision | null;
  skinProfile: CompleteSkinProfile;
  base: BaseChoice;
  previewConsent: boolean;
  previewPlan: CompletePreviewPlan | null;
}
export interface CompleteSavedProduct {
  variantId: string;
  category: string;
  formulationVersionId: string;
  shadeVersionId: string | null;
  name: string;
  brand: string;
  shadeName: string | null;
  swatchHex: string | null;
  priceMinor: number | null;
  currency: string | null;
  available: boolean;
}
export interface CompleteSavedGuide {
  version: "beauty-complete-guide-v1";
  expiresAt: string;
  locale: BeautyLocale;
  preferences: NonNullable<BeautySession["preferences"]>;
  products: CompleteSavedProduct[];
}
export interface BeautyDemographics {
  periodStart: string;
  periodEnd: string;
  unit: "completed_sessions";
  age: { suppressed: boolean; counts: Record<string, number> };
  gender: { suppressed: boolean; counts: Record<string, number> };
}
export interface BeautyCompleteRepository {
  readComplete(id: string, device: DeviceContext): Promise<BeautyCompleteState>;
  setGuestContext(
    id: string,
    device: DeviceContext,
    context: BeautyGuestContext,
  ): Promise<void>;
  completePhotoConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  claimCompleteAnalysis(id: string, device: DeviceContext): Promise<string>;
  saveCompleteAnalysis(
    id: string,
    device: DeviceContext,
    requestId: string,
    beauty: BeautyAnalysis,
    skin: SkinVision,
  ): Promise<void>;
  setSkinProfile(
    id: string,
    device: DeviceContext,
    profile: CompleteSkinProfile,
  ): Promise<void>;
  setBaseChoice(
    id: string,
    device: DeviceContext,
    base: BaseChoice,
  ): Promise<void>;
  confirmCompletePreferences(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ): Promise<void>;
  saveCompleteRecommendations(
    id: string,
    device: DeviceContext,
    policy: Policy,
    items: Recommendation[],
  ): Promise<void>;
  completePreviewConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  createPreviewPlan(
    id: string,
    device: DeviceContext,
  ): Promise<CompletePreviewPlan>;
  claimPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
  ): Promise<string>;
  assertPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
  ): Promise<void>;
  finishPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
    status: "complete" | "failed",
  ): Promise<void>;
  cancelPreviewPlan(
    id: string,
    device: DeviceContext,
    planId: string,
  ): Promise<void>;
  finishComplete(
    id: string,
    device: DeviceContext,
    gender: GuestGender | null,
  ): Promise<void>;
  cosmeticShades(storeId: string): Promise<CosmeticShade[]>;
  publishCosmeticShade(
    storeId: string,
    variantId: string,
    draft: CosmeticShadeDraft,
  ): Promise<void>;
  saveCompleteGuide(
    id: string,
    device: DeviceContext,
    tokenHash: string,
    noticeVersion: string,
    variantIds: string[],
  ): Promise<{ expiresAt: string }>;
  readCompleteGuide(tokenHash: string): Promise<CompleteSavedGuide>;
  revokeCompleteGuide(tokenHash: string): Promise<void>;
  demographics(storeId: string): Promise<BeautyDemographics>;
}
