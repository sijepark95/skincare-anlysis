import { AppError, type DeviceContext, type Repository } from "./contracts";
import {
  BEAUTY_PHOTO_NOTICE_VERSION,
  validateBeautyAnalysis,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import {
  BEAUTY_GUIDE_VERSION,
  buildBeautyGuide,
  validBeautyPreferences,
  type BeautyGuide,
  type BeautyPreferences,
} from "@/domain/beauty";
import {
  recommendLipShades,
  type ColorMatch,
  type LipShade,
  type LipFinish,
  type LipHueFamily,
} from "@/domain/personal-color";
import {
  canonicalizeIngredient,
  canonicalIngredientNames,
} from "@/domain/ingredients";
import { OPENAI_CONSENT_VERSION } from "@/domain/skin-vision";
import {
  BEAUTY_MAKEUP_NOTICE_VERSION,
  validateBeautyMakeupResult,
  type BeautyMakeupResult,
} from "@/domain/beauty-makeup";
import type { PaletteId } from "@/domain/personal-color";

export const BEAUTY_SAVE_NOTICE_VERSION = "2026-10-beauty-save-v1" as const;
export interface BeautySession {
  consent: boolean;
  attempted: boolean;
  analysis: BeautyAnalysis | null;
  preferences: BeautyPreferences | null;
  excludedIngredients: string[];
}
export interface BeautyState extends BeautySession {
  guide: BeautyGuide | null;
  recommendations: ColorMatch[];
  ingredients: string[];
  photoAvailable: boolean;
  sharingAvailable: boolean;
  shareUnavailableReason?: string;
  makeup?: { consent: boolean; attempted: boolean; available: boolean };
}
export interface SavedBeautyProduct {
  variantId: string;
  shadeVersionId: string;
  name: string;
  brand: string;
  priceMinor: number | null;
  currency: string | null;
  shadeName: string;
  hueFamily: LipHueFamily;
  undertone: "warm" | "cool" | "neutral";
  intensity: "soft" | "clear";
  finish: LipFinish;
  swatchHex: string;
  available: boolean;
}
export interface SavedBeautySnapshot {
  guideVersion: typeof BEAUTY_GUIDE_VERSION;
  expiresAt: string;
  preferences: BeautyPreferences;
  products: SavedBeautyProduct[];
}
export interface SavedBeautyResult extends SavedBeautySnapshot {
  guide: BeautyGuide;
}
export interface BeautyRepository {
  beautyMakeupState(
    id: string,
    device: DeviceContext,
  ): Promise<{ consent: boolean; attempted: boolean }>;
  beautyMakeupConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  claimBeautyMakeup(id: string, device: DeviceContext): Promise<void>;
  assertBeautyMakeup(id: string, device: DeviceContext): Promise<void>;
  beautySession(id: string, device: DeviceContext): Promise<BeautySession>;
  beautyConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  claimBeautyAnalysis(id: string, device: DeviceContext): Promise<boolean>;
  saveBeautyAnalysis(
    id: string,
    device: DeviceContext,
    analysis: BeautyAnalysis,
  ): Promise<void>;
  confirmBeautyPreferences(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ): Promise<void>;
  beautyExclusions(
    id: string,
    device: DeviceContext,
    ingredients: string[],
  ): Promise<void>;
  lipShades(storeId: string): Promise<LipShade[]>;
  createBeautyGuide(
    id: string,
    device: DeviceContext,
    tokenHash: string,
    noticeVersion: string,
  ): Promise<{ expiresAt: string }>;
}
export interface SavedBeautyRepository {
  readSavedBeautyGuide(tokenHash: string): Promise<SavedBeautySnapshot>;
  revokeSavedBeautyGuide(tokenHash: string): Promise<void>;
}
export interface BeautyAnalysisProvider {
  analyze(requestId: string, image: Uint8Array): Promise<BeautyAnalysis>;
}
export interface BeautyMakeupProvider {
  generate(
    requestId: string,
    image: Uint8Array,
    paletteId: PaletteId,
  ): Promise<BeautyMakeupResult>;
}

/** Styling uses confirmed preferences; photos never silently confirm a palette or face shape. */
export class BeautyConsultations {
  constructor(
    private readonly repository: Repository & BeautyRepository,
    private readonly provider: BeautyAnalysisProvider | null,
    private readonly newRequestId: () => string,
    private readonly sharingAvailable = false,
    private readonly makeupProvider: BeautyMakeupProvider | null = null,
  ) {}
  private async active(id: string, device: DeviceContext) {
    const session = await this.repository.session(id, device);
    if (!session.consent)
      throw new AppError(
        403,
        "consent_required",
        "Accept the privacy notice first.",
      );
    return session;
  }
  async read(id: string, device: DeviceContext): Promise<BeautyState> {
    await this.active(id, device);
    const [state, products, shades, makeup] = await Promise.all([
      this.repository.beautySession(id, device),
      this.repository.products(device.storeId),
      this.repository.lipShades(device.storeId),
      this.repository.beautyMakeupState(id, device),
    ]);
    await this.active(id, device);
    const current = await this.repository.beautySession(id, device);
    if (JSON.stringify(current) !== JSON.stringify(state))
      throw new AppError(
        409,
        "beauty_changed",
        "Your choices changed. Open your guide again.",
      );
    return {
      ...state,
      guide: state.preferences ? buildBeautyGuide(state.preferences) : null,
      recommendations: state.preferences
        ? recommendLipShades(products, shades, state.preferences, {
            organizationId: device.organizationId,
            storeId: device.storeId,
            excludedIngredients: state.excludedIngredients,
          })
        : [],
      ingredients: [...canonicalIngredientNames],
      photoAvailable: this.provider !== null,
      makeup: {
        ...makeup,
        available: this.provider !== null && this.makeupProvider !== null,
      },
      sharingAvailable: this.sharingAvailable,
      ...(!this.sharingAvailable
        ? {
            shareUnavailableReason:
              "Phone sharing is available after this kiosk is deployed to a public HTTPS address. You can download your guide here.",
          }
        : {}),
    };
  }
  async consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.active(id, device);
    if (noticeVersion !== BEAUTY_PHOTO_NOTICE_VERSION)
      throw new AppError(
        422,
        "invalid_consent_version",
        "Refresh the current beauty-photo notice.",
      );
    if (
      accepted &&
      (!this.provider || session.consentVersion !== OPENAI_CONSENT_VERSION)
    )
      throw new AppError(
        409,
        "beauty_photo_disabled",
        "Photo suggestions are unavailable. You can choose your style yourself.",
      );
    await this.repository.beautyConsent(id, device, accepted, noticeVersion);
  }
  async analyze(id: string, device: DeviceContext, image: Uint8Array) {
    const session = await this.active(id, device);
    if (!this.provider || session.consentVersion !== OPENAI_CONSENT_VERSION)
      throw new AppError(
        409,
        "beauty_photo_disabled",
        "Photo suggestions are unavailable. Choose your style yourself.",
      );
    if (!image.length || image.length > 10 * 1024 * 1024)
      throw new AppError(
        422,
        "invalid_image",
        "Choose a photo smaller than 10 MB.",
      );
    if (!(await this.repository.beautySession(id, device)).consent)
      throw new AppError(
        403,
        "beauty_consent_required",
        "Accept the separate beauty-photo notice first.",
      );
    if (!(await this.repository.claimBeautyAnalysis(id, device)))
      throw new AppError(
        409,
        "beauty_already_attempted",
        "This session already used its photo attempt. Choose your style yourself or finish and start again.",
      );
    const requestId = this.newRequestId();
    const result = validateBeautyAnalysis(
      await this.provider.analyze(requestId, image),
      requestId,
    );
    if (!result)
      throw new AppError(
        503,
        "invalid_beauty_analysis",
        "The photo suggestion could not be verified. Choose your style yourself.",
      );
    await this.active(id, device);
    await this.repository.saveBeautyAnalysis(id, device, result);
    return this.read(id, device);
  }
  async confirm(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ) {
    await this.active(id, device);
    if (!validBeautyPreferences(preferences))
      throw new AppError(
        422,
        "invalid_beauty_preferences",
        "Choose a listed palette, face shape, length, mood and finish.",
      );
    await this.repository.confirmBeautyPreferences(id, device, preferences);
    return this.read(id, device);
  }
  async makeupConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    await this.active(id, device);
    if (noticeVersion !== BEAUTY_MAKEUP_NOTICE_VERSION)
      throw new AppError(
        422,
        "invalid_makeup_consent",
        "Refresh the makeup-preview notice.",
      );
    if (accepted && (!this.provider || !this.makeupProvider))
      throw new AppError(
        409,
        "makeup_disabled",
        "Makeup previews are unavailable on this kiosk.",
      );
    await this.repository.beautyMakeupConsent(
      id,
      device,
      accepted,
      noticeVersion,
    );
  }
  /** Only a bounded synchronous response; guest portraits and generated pixels are never persisted. */
  async makeup(
    id: string,
    device: DeviceContext,
    image: Uint8Array,
  ): Promise<BeautyMakeupResult> {
    const session = await this.active(id, device);
    if (
      !this.provider ||
      !this.makeupProvider ||
      session.consentVersion !== OPENAI_CONSENT_VERSION
    )
      throw new AppError(
        409,
        "makeup_disabled",
        "Makeup previews are unavailable on this kiosk.",
      );
    if (!image.length || image.length > 10 * 1024 * 1024)
      throw new AppError(
        422,
        "invalid_image",
        "Choose a photo smaller than 10 MB.",
      );
    const state = await this.repository.beautySession(id, device);
    const makeup = await this.repository.beautyMakeupState(id, device);
    if (!state.consent || !makeup.consent)
      throw new AppError(
        403,
        "makeup_consent_required",
        "Accept the separate makeup-preview notice first.",
      );
    if (
      !state.preferences ||
      !state.analysis ||
      state.analysis.prompt_version !== "beauty-style-suggestion-v2" ||
      state.analysis.image_quality !== "usable"
    )
      throw new AppError(
        409,
        "makeup_confirmation_required",
        "Confirm your photo suggestions before creating your makeup previews.",
      );
    if (makeup.attempted)
      throw new AppError(
        409,
        "makeup_already_attempted",
        "This session already used its makeup-preview attempt.",
      );
    await this.repository.claimBeautyMakeup(id, device);
    // Bind the provider request to the same choices the atomic claim pinned.
    const claimed = await this.repository.beautySession(id, device);
    if (
      JSON.stringify(claimed.preferences) !==
        JSON.stringify(state.preferences) ||
      claimed.analysis?.request_id !== state.analysis.request_id
    )
      throw new AppError(
        409,
        "makeup_changed",
        "Your choices changed before the previews could begin.",
      );
    const requestId = this.newRequestId();
    const result = validateBeautyMakeupResult(
      await this.makeupProvider.generate(
        requestId,
        image,
        state.preferences.paletteId,
      ),
      requestId,
    );
    if (!result)
      throw new AppError(
        503,
        "invalid_makeup_preview",
        "Your makeup previews could not be verified. Your beauty guide is still available.",
      );
    await this.active(id, device);
    await this.repository.assertBeautyMakeup(id, device);
    return result;
  }
  async exclusions(id: string, device: DeviceContext, ingredients: string[]) {
    await this.active(id, device);
    const canonical = ingredients.map(canonicalizeIngredient);
    if (ingredients.length > 20 || canonical.some((item) => !item))
      throw new AppError(
        422,
        "invalid_exclusions",
        "Choose up to 20 ingredients from the list. Ask staff about any unlisted sensitivities.",
      );
    await this.repository.beautyExclusions(id, device, [
      ...new Set(canonical as string[]),
    ]);
    return this.read(id, device);
  }
  async save(
    id: string,
    device: DeviceContext,
    tokenHash: string,
    accepted: boolean,
    noticeVersion: string,
  ) {
    await this.active(id, device);
    if (!this.sharingAvailable)
      throw new AppError(
        409,
        "sharing_unavailable",
        "Deploy this kiosk to a public HTTPS address to enable phone sharing.",
      );
    if (
      !accepted ||
      noticeVersion !== BEAUTY_SAVE_NOTICE_VERSION ||
      !/^[a-f0-9]{64}$/.test(tokenHash)
    )
      throw new AppError(
        422,
        "save_consent_required",
        "Accept the current seven-day guide-sharing notice first.",
      );
    if (!(await this.repository.beautySession(id, device)).preferences)
      throw new AppError(
        409,
        "confirmation_required",
        "Confirm your style choices before saving a guide.",
      );
    return this.repository.createBeautyGuide(
      id,
      device,
      tokenHash,
      noticeVersion,
    );
  }
}
