import { AppError, type DeviceContext, type Repository } from "./contracts";
import {
  COLOR_PHOTO_NOTICE_VERSION,
  validateColorAnalysis,
  type ColorAnalysis,
} from "@/domain/color-analysis";
import {
  recommendLipShades,
  validColorPreferences,
  type ColorPreferences,
  type ColorMatch,
  type LipShade,
  type LipShadeDraft,
} from "@/domain/personal-color";
import { OPENAI_CONSENT_VERSION } from "@/domain/skin-vision";

export interface ColorSession {
  consent: boolean;
  attempted: boolean;
  analysis: ColorAnalysis | null;
  preferences: ColorPreferences | null;
}
export interface ColorState extends ColorSession {
  photoAvailable: boolean;
  recommendations: ColorMatch[];
}
export interface PersonalColorRepository {
  colorSession(id: string, device: DeviceContext): Promise<ColorSession>;
  colorConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void>;
  claimColorAnalysis(id: string, device: DeviceContext): Promise<boolean>;
  saveColorAnalysis(
    id: string,
    device: DeviceContext,
    analysis: ColorAnalysis,
  ): Promise<void>;
  confirmColorPreferences(
    id: string,
    device: DeviceContext,
    preferences: ColorPreferences,
  ): Promise<void>;
  lipShades(storeId: string): Promise<LipShade[]>;
  publishLipShade(
    storeId: string,
    variantId: string,
    draft: LipShadeDraft,
  ): Promise<void>;
}
export interface ColorAnalysisProvider {
  analyze(requestId: string, image: Uint8Array): Promise<ColorAnalysis>;
}
export class PersonalColors {
  constructor(
    private readonly repository: Repository & PersonalColorRepository,
    private readonly provider: ColorAnalysisProvider | null,
    private readonly newRequestId: () => string,
  ) {}
  private async active(id: string, device: DeviceContext) {
    const session = await this.repository.session(id, device);
    if (!session.consent || !session.answers)
      throw new AppError(
        409,
        "answers_required",
        "Complete consent and your preferences first.",
      );
    return session;
  }
  async read(id: string, device: DeviceContext): Promise<ColorState> {
    await this.active(id, device);
    const [state, products, shades] = await Promise.all([
      this.repository.colorSession(id, device),
      this.repository.products(device.storeId),
      this.repository.lipShades(device.storeId),
    ]);
    // A finish, consent withdrawal or preference change during assembly invalidates this read.
    const currentSession = await this.active(id, device);
    const current = await this.repository.colorSession(id, device);
    if (JSON.stringify(current) !== JSON.stringify(state))
      throw new AppError(
        409,
        "color_changed",
        "Your color choices changed. Open the consultation again.",
      );
    return {
      ...state,
      photoAvailable: this.provider !== null,
      recommendations: state.preferences
        ? recommendLipShades(products, shades, state.preferences, {
            organizationId: device.organizationId,
            storeId: device.storeId,
            excludedIngredients: currentSession.answers!.excludedIngredients,
          })
        : [],
    };
  }
  async consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.active(id, device);
    if (noticeVersion !== COLOR_PHOTO_NOTICE_VERSION)
      throw new AppError(
        422,
        "invalid_consent_version",
        "Refresh the current color-photo notice.",
      );
    if (
      accepted &&
      (!this.provider || session.consentVersion !== OPENAI_CONSENT_VERSION)
    )
      throw new AppError(
        409,
        "color_photo_disabled",
        "Photo color suggestions are not enabled. You can choose a palette yourself.",
      );
    await this.repository.colorConsent(id, device, accepted, noticeVersion);
  }
  async analyze(
    id: string,
    device: DeviceContext,
    image: Uint8Array,
  ): Promise<ColorState> {
    const session = await this.active(id, device);
    if (!this.provider || session.consentVersion !== OPENAI_CONSENT_VERSION)
      throw new AppError(
        409,
        "color_photo_disabled",
        "Photo color suggestions are not enabled. Choose a palette yourself.",
      );
    if (!image.length || image.length > 10 * 1024 * 1024)
      throw new AppError(
        422,
        "invalid_image",
        "Choose a photo smaller than 10 MB.",
      );
    const state = await this.repository.colorSession(id, device);
    if (!state.consent)
      throw new AppError(
        403,
        "color_consent_required",
        "Accept the separate color-photo notice first.",
      );
    // Claim persists before any provider call. Failures and withdrawal never permit a retry.
    if (!(await this.repository.claimColorAnalysis(id, device)))
      throw new AppError(
        409,
        "color_already_attempted",
        "This session already used its color photo attempt. Choose a palette yourself or finish and start again.",
      );
    const requestId = this.newRequestId();
    const result = validateColorAnalysis(
      await this.provider.analyze(requestId, image),
      requestId,
    );
    if (!result)
      throw new AppError(
        503,
        "invalid_color_analysis",
        "The color suggestion could not be verified. You can still choose a palette.",
      );
    await this.active(id, device);
    await this.repository.saveColorAnalysis(id, device, result);
    return this.read(id, device);
  }
  async confirm(
    id: string,
    device: DeviceContext,
    preferences: ColorPreferences,
  ): Promise<ColorState> {
    await this.active(id, device);
    if (!validColorPreferences(preferences))
      throw new AppError(
        422,
        "invalid_color_preferences",
        "Choose a listed palette and finish.",
      );
    await this.repository.confirmColorPreferences(id, device, preferences);
    return this.read(id, device);
  }
}
