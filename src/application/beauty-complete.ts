import { AppError, type DeviceContext, type Repository } from "./contracts";
import type { BeautyRepository, BeautyState } from "./beauty-consultations";
import {
  COMPLETE_PHOTO_NOTICE_VERSION,
  COMPLETE_PREVIEW_NOTICE_VERSION,
  COMPLETE_SAVE_NOTICE_VERSION,
  guestAgeBands,
  type BeautyCompleteRepository,
  type BeautyGuestContext,
  type CompleteSkinProfile,
  type GuestGender,
  type CompletePreviewSlot,
} from "./beauty-complete-contracts";
import {
  buildBeautyGuide,
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import {
  canonicalIngredientNames,
  canonicalizeIngredients,
} from "@/domain/ingredients";
import { recommendLipShades } from "@/domain/personal-color";
import {
  recommendCosmeticShades,
  validBaseChoice,
  type BaseChoice,
  type CosmeticMatch,
} from "@/domain/cosmetic-shades";
import {
  BEAUTY_COMPLETE_PROMPT_VERSION,
  validateBeautyCompleteAnalysis,
  validateBeautyPreviewResult,
  type BeautyCompleteAnalysis,
  type BeautyPreviewIndex,
  type BeautyPreviewKind,
  type BeautyPreviewResult,
} from "@/domain/beauty-complete";
import { skinRecommendationContext } from "@/domain/skin-recommendation-context";
import { rankSkinProducts } from "@/domain/recommendations";
import {
  buildSkinConsultation,
  type SkinConsultationReport,
} from "@/domain/skin-consultation";
import { concerns, skinTypes, type Recommendation } from "@/domain/types";
import {
  isStylingDirection,
  type StylingDirection,
} from "@/domain/beauty-styling";

export interface CompleteAnalysisProvider {
  analyze(
    requestId: string,
    image: Uint8Array,
  ): Promise<BeautyCompleteAnalysis>;
}
export interface CompletePreviewProvider {
  generate(
    requestId: string,
    image: Uint8Array,
    paletteId: BeautyPreferences["paletteId"],
    kind: BeautyPreviewKind,
    index: BeautyPreviewIndex,
    faceShape: BeautyPreferences["faceShape"],
    stylingDirection?: StylingDirection,
  ): Promise<BeautyPreviewResult>;
}
export interface CompleteBeautyView {
  beauty: BeautyState;
  analysis: BeautyCompleteAnalysis | null;
  context: BeautyGuestContext | null;
  completeConsent: boolean;
  attempted: boolean;
  skinProfile: CompleteSkinProfile;
  base: BaseChoice;
  skinReport: SkinConsultationReport | null;
  skinRecommendations: Recommendation[];
  cosmetics: CosmeticMatch[];
  baseCandidates: CosmeticMatch[];
  preview: {
    consent: boolean;
    available: boolean;
    slots: (CompletePreviewSlot & { id: number })[];
    deadline: string | null;
  };
  teenPhotoEnabled: boolean;
}
export interface CompleteOptions {
  sharingAvailable: boolean;
  teenPhotoEnabled: boolean;
}
const error = (code: string, message: string) =>
  new AppError(409, code, message);
/** SQL JSON keys and normalized enum lists need not retain provider insertion order. */
function sameFacts(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    const strings =
      left.every((item) => typeof item === "string") &&
      right.every((item) => typeof item === "string");
    const a = strings ? [...left].sort() : left;
    const b = strings ? [...right].sort() : right;
    return a.every((item, index) => sameFacts(item, b[index]));
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        sameFacts(a[key], b[key]),
    )
  );
}
export function isTeen(context: BeautyGuestContext): boolean {
  return context.ageBand === "13-15" || context.ageBand === "16-17";
}

/** One fresh-capture purpose, independently bounded skin/style facts, deterministic store matching. */
export class BeautyCompleteConsultations {
  constructor(
    private readonly repository: Repository & BeautyRepository,
    private readonly complete: BeautyCompleteRepository,
    private readonly analyzer: CompleteAnalysisProvider | null,
    private readonly previewer: CompletePreviewProvider | null,
    private readonly options: CompleteOptions,
  ) {}
  private async active(id: string, device: DeviceContext, consent = true) {
    const session = await this.repository.session(id, device);
    if (consent && !session.consent)
      throw error("consent_required", "Accept the privacy notice first.");
    return session;
  }
  private photoEligible(context: BeautyGuestContext | null): boolean {
    return (
      !!context &&
      context.ageBand !== "under13" &&
      (!isTeen(context) || this.options.teenPhotoEnabled)
    );
  }
  async context(
    id: string,
    device: DeviceContext,
    context: BeautyGuestContext,
  ) {
    await this.active(id, device, false);
    if (
      !guestAgeBands.includes(context.ageBand) ||
      !["en", "ko", "es"].includes(context.locale) ||
      typeof context.analyticsConsent !== "boolean"
    )
      throw error("invalid_guest_context", "Choose an age range and language.");
    await this.complete.setGuestContext(id, device, {
      ...context,
      analyticsConsent:
        context.ageBand === "under13" || isTeen(context)
          ? false
          : context.analyticsConsent,
    });
    return this.read(id, device);
  }
  async consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    notice: string,
  ) {
    await this.active(id, device);
    if (notice !== COMPLETE_PHOTO_NOTICE_VERSION)
      throw error("notice_changed", "Read the current photo notice.");
    const state = await this.complete.readComplete(id, device);
    if (accepted && (!this.analyzer || !this.photoEligible(state.guest)))
      throw error(
        "photo_unavailable",
        "Photo features are unavailable for this age range or device. Continue without a photo.",
      );
    await this.complete.completePhotoConsent(id, device, accepted, notice);
    return this.read(id, device);
  }
  async read(
    id: string,
    device: DeviceContext,
    transient?: BeautyCompleteAnalysis,
  ): Promise<CompleteBeautyView> {
    const session = await this.active(id, device, false);
    const state = await this.complete.readComplete(id, device);
    const [products, shades, lipShades, policy] = await Promise.all([
      this.repository.products(device.storeId),
      this.complete.cosmeticShades(device.storeId),
      this.repository.lipShades(device.storeId),
      this.repository.policy(device, id),
    ]);
    const context = skinRecommendationContext(
      state.skinProfile,
      state.skinVision,
    );
    const skinRecommendations = session.consent
      ? rankSkinProducts(products, context, {
          organizationId: device.organizationId,
          storeId: device.storeId,
          rules: policy.rules,
          priorityConcerns: context.photoConcerns,
          limit: 3,
        })
      : [];
    const preferences = state.beauty.preferences;
    const cosmetics = preferences
      ? recommendCosmeticShades(
          products,
          shades,
          { ...preferences, base: state.base },
          {
            organizationId: device.organizationId,
            storeId: device.storeId,
            excludedIngredients: state.skinProfile.excludedIngredients,
          },
        )
      : [];
    if (
      transient &&
      (!session.consent ||
        !state.photoConsent ||
        !state.attempted ||
        !sameFacts(state.beauty.analysis, transient.beauty) ||
        !sameFacts(state.skinVision, transient.skin))
    )
      throw error(
        "beauty_changed",
        "Photo permission or observations changed. Open the report again.",
      );
    let analysis = transient ?? null;
    if (
      !analysis &&
      state.beauty.analysis?.prompt_version === "beauty-style-suggestion-v2" &&
      state.skinVision
    ) {
      analysis = {
        request_id: state.beauty.analysis.request_id,
        mode: "openai_beauty_complete",
        model_version: state.beauty.analysis.model_version,
        prompt_version: BEAUTY_COMPLETE_PROMPT_VERSION,
        beauty: state.beauty.analysis,
        skin: state.skinVision,
        animalVibe: "uncertain",
        baseDepth: "uncertain",
      };
    }
    const proposedBase: BaseChoice =
      analysis &&
      analysis.baseDepth !== "uncertain" &&
      analysis.beauty.undertone !== "uncertain"
        ? {
            depth: analysis.baseDepth,
            undertone: analysis.beauty.undertone,
            concealerPurpose: "match",
          }
        : state.base;
    const proposalPalette =
      analysis?.beauty.undertone !== "uncertain" &&
      analysis?.beauty.chroma !== "uncertain" &&
      analysis
        ? (`${analysis.beauty.undertone}_${analysis.beauty.chroma}` as BeautyPreferences["paletteId"])
        : preferences?.paletteId;
    const baseCandidates = proposalPalette
      ? recommendCosmeticShades(
          products,
          shades,
          {
            paletteId: proposalPalette,
            finish: "any",
            base: proposedBase,
          },
          {
            organizationId: device.organizationId,
            storeId: device.storeId,
            excludedIngredients: state.skinProfile.excludedIngredients,
          },
        ).filter((item) => item.shade.category === "foundation")
      : [];
    const current = await this.complete.readComplete(id, device);
    const currentSession = await this.active(id, device, false);
    if (
      currentSession.consent !== session.consent ||
      !sameFacts(current, state)
    )
      throw error(
        "beauty_changed",
        "Your choices changed. Open the report again.",
      );
    return {
      context: state.guest,
      analysis,
      completeConsent: state.photoConsent,
      attempted: state.attempted,
      skinProfile: state.skinProfile,
      base: state.base,
      cosmetics,
      baseCandidates,
      skinRecommendations,
      skinReport: session.consent
        ? buildSkinConsultation({
            vision: state.skinVision,
            context,
            rules: policy.rules,
            recommendations: skinRecommendations,
            policyVersion: policy.version,
            policySource: policy.source,
          })
        : null,
      beauty: {
        ...state.beauty,
        guide: preferences ? buildBeautyGuide(preferences) : null,
        recommendations: preferences
          ? recommendLipShades(products, lipShades, preferences, {
              organizationId: device.organizationId,
              storeId: device.storeId,
              excludedIngredients: state.skinProfile.excludedIngredients,
            })
          : [],
        ingredients: [...canonicalIngredientNames],
        photoAvailable:
          this.analyzer !== null && this.photoEligible(state.guest),
        sharingAvailable: this.options.sharingAvailable,
      },
      preview: {
        consent: state.previewConsent,
        available: !!this.previewer && this.photoEligible(state.guest),
        slots: (state.previewPlan?.slots ?? []).map((slot) => ({
          ...slot,
          id: slot.slot,
        })),
        deadline: state.previewPlan?.deadline ?? null,
      },
      teenPhotoEnabled: this.options.teenPhotoEnabled,
    };
  }
  async analyze(id: string, device: DeviceContext, image: Uint8Array) {
    await this.active(id, device);
    const state = await this.complete.readComplete(id, device);
    if (
      !this.analyzer ||
      !this.photoEligible(state.guest) ||
      !state.photoConsent ||
      state.attempted
    )
      throw error(
        "complete_photo_unavailable",
        "Accept the current photo notice before a new photo analysis.",
      );
    const requestId = await this.complete.claimCompleteAnalysis(id, device);
    await this.active(id, device);
    const admitted = await this.complete.readComplete(id, device);
    if (
      !admitted.photoConsent ||
      !admitted.attempted ||
      !this.photoEligible(admitted.guest)
    )
      throw error("complete_photo_unavailable", "Photo permission has ended.");
    const result = validateBeautyCompleteAnalysis(
      await this.analyzer.analyze(requestId, image),
      requestId,
    );
    if (!result)
      throw error(
        "invalid_analysis",
        "The photo observations could not be verified.",
      );
    await this.active(id, device);
    await this.complete.saveCompleteAnalysis(
      id,
      device,
      requestId,
      result.beauty,
      result.skin,
    );
    await this.persistRecommendations(id, device);
    return this.read(id, device, result);
  }
  async confirm(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
    base: BaseChoice,
  ) {
    await this.active(id, device);
    if (!validBeautyPreferences(preferences) || !validBaseChoice(base))
      throw error(
        "invalid_preferences",
        "Check the selected palette and base color.",
      );
    const before = await this.complete.readComplete(id, device);
    if (
      before.previewPlan &&
      !before.previewPlan.cancelled &&
      (!sameFacts(before.beauty.preferences, preferences) ||
        !sameFacts(before.base, base))
    )
      await this.complete.cancelPreviewPlan(id, device, before.previewPlan.id);
    await this.complete.confirmCompletePreferences(id, device, preferences);
    await this.complete.setBaseChoice(id, device, base);
    return this.read(id, device);
  }
  async skin(id: string, device: DeviceContext, profile: CompleteSkinProfile) {
    await this.active(id, device);
    if (
      !skinTypes.includes(profile.skinType) ||
      profile.concerns.some((goal) => !concerns.includes(goal)) ||
      profile.excludedIngredients.length > 20
    )
      throw error(
        "invalid_skin_profile",
        "Check your optional skincare preferences.",
      );
    const ingredients = canonicalizeIngredients(profile.excludedIngredients);
    if (ingredients.unknown.length)
      throw error(
        "unknown_ingredient",
        "Choose ingredients from the registered list.",
      );
    await this.complete.setSkinProfile(id, device, {
      ...profile,
      concerns: [...new Set(profile.concerns)],
      excludedIngredients: ingredients.canonical,
    });
    const state = await this.complete.readComplete(id, device);
    if (state.skinVision) await this.persistRecommendations(id, device);
    return this.read(id, device);
  }
  private async persistRecommendations(id: string, device: DeviceContext) {
    const [state, products, policy] = await Promise.all([
      this.complete.readComplete(id, device),
      this.repository.products(device.storeId),
      this.repository.policy(device, id),
    ]);
    const context = skinRecommendationContext(
      state.skinProfile,
      state.skinVision,
    );
    const items = rankSkinProducts(products, context, {
      organizationId: device.organizationId,
      storeId: device.storeId,
      rules: policy.rules,
      priorityConcerns: context.photoConcerns,
      limit: 3,
    });
    await this.active(id, device);
    if (!sameFacts(await this.complete.readComplete(id, device), state))
      throw error(
        "beauty_changed",
        "Your choices changed. Open the report again.",
      );
    await this.complete.saveCompleteRecommendations(id, device, policy, items);
  }
  async previewConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    notice: string,
  ) {
    await this.active(id, device);
    const state = await this.complete.readComplete(id, device);
    if (
      notice !== COMPLETE_PREVIEW_NOTICE_VERSION ||
      (accepted &&
        (!this.previewer ||
          !this.photoEligible(state.guest) ||
          !state.photoConsent))
    )
      throw error(
        "preview_unavailable",
        "Accept the current preview notice after photo permission.",
      );
    await this.complete.completePreviewConsent(id, device, accepted, notice);
    return this.read(id, device);
  }
  async preview(
    id: string,
    device: DeviceContext,
    slot: number,
    image: Uint8Array,
    stylingDirection: StylingDirection = "balanced",
  ): Promise<BeautyPreviewResult> {
    if (!isStylingDirection(stylingDirection))
      throw error(
        "invalid_styling_direction",
        "Choose a registered styling direction.",
      );
    await this.active(id, device);
    const state = await this.complete.readComplete(id, device);
    if (
      !this.previewer ||
      !state.previewConsent ||
      !state.photoConsent ||
      !this.photoEligible(state.guest) ||
      !state.beauty.preferences ||
      state.beauty.analysis?.prompt_version !== "beauty-style-suggestion-v2" ||
      state.beauty.analysis.image_quality !== "usable" ||
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot > 8
    )
      throw error(
        "preview_unavailable",
        "Confirm a usable photo direction and preview permission first.",
      );
    const plan =
      state.previewPlan ?? (await this.complete.createPreviewPlan(id, device));
    const requestId = await this.complete.claimPreviewSlot(
      id,
      device,
      plan.id,
      slot,
    );
    const kind: BeautyPreviewKind =
      slot < 3 ? "makeup" : slot < 6 ? "hair_style" : "hair_color";
    const index = (slot % 3) as BeautyPreviewIndex;
    try {
      await this.active(id, device);
      await this.complete.assertPreviewSlot(id, device, plan.id, slot);
      const admitted = await this.complete.readComplete(id, device);
      if (
        !admitted.photoConsent ||
        !admitted.previewConsent ||
        !this.photoEligible(admitted.guest) ||
        admitted.previewPlan?.id !== plan.id ||
        admitted.previewPlan.cancelled ||
        !sameFacts(admitted.beauty.preferences, state.beauty.preferences) ||
        !sameFacts(admitted.beauty.analysis, state.beauty.analysis)
      )
        throw error(
          "preview_changed",
          "Your photo permission or direction changed.",
        );
      const result = validateBeautyPreviewResult(
        await this.previewer.generate(
          requestId,
          image,
          state.beauty.preferences.paletteId,
          kind,
          index,
          state.beauty.preferences.faceShape,
          stylingDirection,
        ),
        requestId,
        kind,
        index,
      );
      if (!result)
        throw error(
          "invalid_preview",
          "The generated preview could not be verified.",
        );
      await this.active(id, device);
      await this.complete.assertPreviewSlot(id, device, plan.id, slot);
      await this.complete.finishPreviewSlot(
        id,
        device,
        plan.id,
        slot,
        "complete",
      );
      await this.active(id, device);
      const finished = await this.complete.readComplete(id, device);
      if (
        !finished.photoConsent ||
        !finished.previewConsent ||
        finished.previewPlan?.id !== plan.id ||
        finished.previewPlan.cancelled ||
        finished.previewPlan.slots.find((item) => item.slot === slot)
          ?.status !== "complete" ||
        !sameFacts(finished.beauty.preferences, state.beauty.preferences) ||
        !sameFacts(finished.beauty.analysis, state.beauty.analysis)
      )
        throw error(
          "preview_changed",
          "Your photo permission or direction changed.",
        );
      return result;
    } catch (cause) {
      try {
        await this.complete.finishPreviewSlot(
          id,
          device,
          plan.id,
          slot,
          "failed",
        );
      } catch {
        /* ended or revoked */
      }
      throw cause;
    }
  }
  async cancelPreview(id: string, device: DeviceContext) {
    await this.active(id, device);
    const state = await this.complete.readComplete(id, device);
    if (state.previewPlan)
      await this.complete.cancelPreviewPlan(id, device, state.previewPlan.id);
  }
  async save(
    id: string,
    device: DeviceContext,
    tokenHash: string,
    notice: string,
  ) {
    if (!this.options.sharingAvailable)
      throw error(
        "sharing_unavailable",
        "Phone sharing needs a public HTTPS address. Download your guide here.",
      );
    if (notice !== COMPLETE_SAVE_NOTICE_VERSION)
      throw error("notice_changed", "Read the current save notice.");
    const state = await this.read(id, device);
    if (!state.beauty.preferences)
      throw error("preferences_required", "Confirm your palette first.");
    return this.complete.saveCompleteGuide(id, device, tokenHash, notice, [
      ...state.skinRecommendations.map((item) => item.product.id),
      ...state.cosmetics.map((item) => item.product.id),
    ]);
  }
  async finish(id: string, device: DeviceContext, gender: GuestGender | null) {
    await this.complete.finishComplete(id, device, gender);
  }
}
