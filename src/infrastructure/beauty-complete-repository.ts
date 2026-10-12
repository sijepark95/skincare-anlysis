import "server-only";
import { z } from "zod";
import {
  AppError,
  type DeviceContext,
  type Policy,
} from "@/application/contracts";
import type {
  BeautyCompleteRepository,
  BeautyCompleteState,
  BeautyGuestContext,
  CompleteSkinProfile,
  CompletePreviewPlan,
  GuestGender,
  CompleteSavedGuide,
  BeautyDemographics,
} from "@/application/beauty-complete-contracts";
import {
  validateBeautyAnalysis,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import {
  isOpenAIAnalysis,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
  type SkinVision,
} from "@/domain/skin-vision";
import {
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import {
  validBaseChoice,
  validCosmeticShade,
  validCosmeticShadeDraft,
  type BaseChoice,
  type CosmeticShade,
  type CosmeticShadeDraft,
} from "@/domain/cosmetic-shades";
import { skinTypes, concerns, type Recommendation } from "@/domain/types";
import {
  getSupabaseIdentity,
  type SupabaseIdentity,
  type IdentityKind,
} from "./supabase-auth";
import { analysisWriter } from "./supabase-repository";

const uuid = z.string().uuid();
const previewSchema = z
  .object({
    id: uuid,
    deadline: z.string().datetime({ offset: true }),
    cancelled: z.boolean(),
    slots: z
      .array(
        z
          .object({
            slot: z.number().int().min(0).max(8),
            kind: z.enum(["makeup", "hair_style", "hair_color"]),
            status: z.enum([
              "pending",
              "running",
              "complete",
              "failed",
              "cancelled",
            ]),
          })
          .strict(),
      )
      .length(9),
  })
  .strict();
const preferencesSchema = z.custom<BeautyPreferences>(validBeautyPreferences);
const skinSchema = z.custom<SkinVision>((value) =>
  isOpenAIAnalysis({
    request_id: "00000000-0000-4000-8000-000000000000",
    mode: "openai",
    model_version: OPENAI_SKIN_MODEL,
    quality_status: (value as SkinVision)?.image_quality,
    observations: [],
    disclaimer: OPENAI_SKIN_DISCLAIMER,
    vision: value,
  }),
);
export const completeSavedGuideSchema = z
  .object({
    version: z.literal("beauty-complete-guide-v1"),
    expiresAt: z.string().datetime({ offset: true }),
    locale: z.enum(["en", "ko", "es"]),
    preferences: preferencesSchema,
    products: z
      .array(
        z
          .object({
            variantId: uuid,
            category: z.string().max(30),
            formulationVersionId: uuid,
            shadeVersionId: uuid.nullable(),
            name: z.string().min(1).max(160),
            brand: z.string().min(1).max(120),
            shadeName: z.string().max(80).nullable(),
            swatchHex: z
              .string()
              .regex(/^#[0-9a-f]{6}$/i)
              .nullable(),
            priceMinor: z.number().int().nonnegative().nullable(),
            currency: z.string().length(3).nullable(),
            available: z.boolean(),
          })
          .strict(),
      )
      .max(18),
  })
  .strict();
const stateSchema = z
  .object({
    guest: z
      .object({
        ageBand: z.enum([
          "under13",
          "13-15",
          "16-17",
          "18-24",
          "25-34",
          "35-44",
          "45-54",
          "55+",
        ]),
        locale: z.enum(["en", "ko", "es"]),
        analyticsConsent: z.boolean(),
      })
      .strict()
      .nullable(),
    photoConsent: z.boolean(),
    attempted: z.boolean(),
    beauty: z
      .object({
        consent: z.boolean(),
        attempted: z.boolean(),
        analysis: z.unknown().nullable(),
        preferences: preferencesSchema.nullable(),
        excludedIngredients: z.array(z.string()).max(20),
      })
      .strict(),
    skinVision: skinSchema.nullable(),
    skinProfile: z
      .object({
        skinType: z.enum(skinTypes),
        concerns: z.array(z.enum(concerns)).max(4),
        excludedIngredients: z.array(z.string()).max(20),
      })
      .strict(),
    base: z.custom<BaseChoice>(validBaseChoice),
    previewConsent: z.boolean(),
    previewPlan: previewSchema.nullable(),
  })
  .strict();
function failure(code?: string): AppError {
  return new AppError(
    code === "42501"
      ? 403
      : code === "23505"
        ? 409
        : code === "22023"
          ? 422
          : 503,
    "complete_database_error",
    code === "42501"
      ? "This session no longer permits this action."
      : code === "23505"
        ? "This attempt was already used."
        : code === "22023"
          ? "Check the selected choices."
          : "The beauty service is temporarily unavailable.",
  );
}

/** Uses the verified paired/staff identity; no service role and no client tenant identifier. */
export class SupabaseBeautyCompleteRepository implements BeautyCompleteRepository {
  constructor(private readonly identity: SupabaseIdentity) {}
  private device(device: DeviceContext) {
    if (
      this.identity.kind !== "device" ||
      this.identity.context.deviceId !== device.deviceId ||
      this.identity.context.storeId !== device.storeId ||
      this.identity.context.organizationId !== device.organizationId
    )
      throw failure("42501");
  }
  private store(storeId: string, owner = false) {
    if (this.identity.kind === "device") {
      if (owner || this.identity.context.storeId !== storeId)
        throw failure("42501");
    } else if (
      !this.identity.context.stores.some((s) => s.id === storeId) ||
      (owner && this.identity.context.role !== "owner")
    )
      throw failure("42501");
  }
  private async rpc<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const { data, error } = await this.identity.client.rpc(name, args);
    if (error) throw failure(error.code);
    const result = schema.safeParse(data);
    if (!result.success) throw failure();
    return result.data;
  }
  private async mutate(name: string, args: Record<string, unknown>) {
    await this.rpc(name, args, z.unknown());
  }
  async readComplete(
    id: string,
    device: DeviceContext,
  ): Promise<BeautyCompleteState> {
    this.device(device);
    const value = await this.rpc(
      "read_kiosk_beauty_complete",
      { p_session_id: id },
      stateSchema,
    );
    const analysis =
      value.beauty.analysis === null
        ? null
        : validateBeautyAnalysis(value.beauty.analysis);
    if (value.beauty.analysis !== null && !analysis) throw failure();
    return { ...value, beauty: { ...value.beauty, analysis } };
  }
  async setGuestContext(
    id: string,
    device: DeviceContext,
    context: BeautyGuestContext,
  ) {
    this.device(device);
    await this.mutate("kiosk_set_beauty_guest_context", {
      p_session_id: id,
      p_age_band: context.ageBand,
      p_locale: context.locale,
      p_analytics_consent: context.analyticsConsent,
    });
  }
  async completePhotoConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    this.device(device);
    await this.mutate("kiosk_set_complete_photo_consent", {
      p_session_id: id,
      p_accepted: accepted,
      p_notice_version: noticeVersion,
    });
  }
  async claimCompleteAnalysis(id: string, device: DeviceContext) {
    this.device(device);
    return this.rpc(
      "kiosk_claim_complete_analysis",
      { p_session_id: id },
      uuid,
    );
  }
  async saveCompleteAnalysis(
    id: string,
    device: DeviceContext,
    requestId: string,
    beauty: BeautyAnalysis,
    skin: SkinVision,
  ) {
    this.device(device);
    const b = validateBeautyAnalysis(beauty);
    if (
      !b ||
      b.prompt_version !== "beauty-style-suggestion-v2" ||
      b.request_id !== requestId ||
      !skinSchema.safeParse(skin).success
    )
      throw failure("22023");
    const writer = await analysisWriter();
    try {
      await writer`select public.write_openai_complete_analysis(${id}::uuid,${requestId}::uuid,${writer.json({ ...b })}::jsonb,${writer.json({ ...skin })}::jsonb)`;
    } catch {
      throw failure("42501");
    }
  }
  async setSkinProfile(
    id: string,
    device: DeviceContext,
    profile: CompleteSkinProfile,
  ) {
    this.device(device);
    await this.mutate("kiosk_set_complete_skin_profile", {
      p_session_id: id,
      p_skin_type: profile.skinType,
      p_concerns: profile.concerns,
      p_excluded_ingredients: profile.excludedIngredients,
    });
  }
  async setBaseChoice(id: string, device: DeviceContext, base: BaseChoice) {
    this.device(device);
    await this.mutate("kiosk_set_complete_base_choice", {
      p_session_id: id,
      p_depth: base.depth,
      p_undertone: base.undertone,
      p_concealer_purpose: base.concealerPurpose,
    });
  }
  async confirmCompletePreferences(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ) {
    this.device(device);
    await this.mutate("confirm_complete_beauty_preferences", {
      p_session_id: id,
      p_preferences: preferences,
    });
  }
  async saveCompleteRecommendations(
    id: string,
    device: DeviceContext,
    policy: Policy,
    items: Recommendation[],
  ) {
    this.device(device);
    if (
      items.length > 3 ||
      items.some(
        (i) =>
          i.product.organizationId !== device.organizationId ||
          i.product.storeId !== device.storeId,
      )
    )
      throw failure("42501");
    const payload = items.map((i) => ({
      variant_id: i.product.id,
      score: i.score,
      matched_ingredients: i.matchedIngredients,
      reasons: i.reasons.map((r) => ({ ...r })),
    }));
    const writer = await analysisWriter();
    try {
      await writer`select public.persist_complete_recommendations(${id}::uuid,${policy.id}::uuid,${writer.json(payload)}::jsonb)`;
    } catch {
      throw new AppError(
        409,
        "recommendations_changed",
        "Store availability changed. Refresh your guide.",
      );
    }
  }
  async completePreviewConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    this.device(device);
    await this.mutate("kiosk_set_complete_preview_consent", {
      p_session_id: id,
      p_accepted: accepted,
      p_notice_version: noticeVersion,
    });
  }
  async createPreviewPlan(
    id: string,
    device: DeviceContext,
  ): Promise<CompletePreviewPlan> {
    this.device(device);
    return this.rpc(
      "kiosk_create_preview_plan",
      { p_session_id: id },
      previewSchema,
    );
  }
  async claimPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
  ) {
    this.device(device);
    return this.rpc(
      "kiosk_claim_preview_slot",
      { p_session_id: id, p_plan_id: planId, p_slot: slot },
      uuid,
    );
  }
  async assertPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
  ) {
    this.device(device);
    await this.mutate("kiosk_assert_preview_slot", {
      p_session_id: id,
      p_plan_id: planId,
      p_slot: slot,
    });
  }
  async finishPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
    status: "complete" | "failed",
  ) {
    this.device(device);
    await this.mutate("kiosk_complete_preview_slot", {
      p_session_id: id,
      p_plan_id: planId,
      p_slot: slot,
      p_status: status,
    });
  }
  async cancelPreviewPlan(id: string, device: DeviceContext, planId: string) {
    this.device(device);
    await this.mutate("kiosk_cancel_preview_plan", {
      p_session_id: id,
      p_plan_id: planId,
    });
  }
  async finishComplete(
    id: string,
    device: DeviceContext,
    gender: GuestGender | null,
  ) {
    this.device(device);
    await this.mutate("finish_kiosk_beauty_complete", {
      p_session_id: id,
      p_gender: gender,
    });
  }
  async cosmeticShades(storeId: string): Promise<CosmeticShade[]> {
    this.store(storeId);
    return this.rpc(
      "read_store_cosmetic_shades",
      { p_store_id: storeId },
      z.array(z.custom<CosmeticShade>(validCosmeticShade)),
    );
  }
  async publishCosmeticShade(
    storeId: string,
    variantId: string,
    draft: CosmeticShadeDraft,
  ) {
    this.store(storeId, true);
    if (!validCosmeticShadeDraft(draft)) throw failure("22023");
    await this.rpc(
      "publish_cosmetic_shade",
      { p_store_id: storeId, p_variant_id: variantId, p_shade: draft },
      uuid,
    );
  }
  async saveCompleteGuide(
    id: string,
    device: DeviceContext,
    tokenHash: string,
    noticeVersion: string,
    variantIds: string[],
  ) {
    this.device(device);
    return this.rpc(
      "create_complete_beauty_guide",
      {
        p_session_id: id,
        p_token_hash: tokenHash,
        p_notice_version: noticeVersion,
        p_variant_ids: variantIds,
      },
      z.object({ expiresAt: z.string().datetime({ offset: true }) }).strict(),
    );
  }
  async readCompleteGuide(tokenHash: string): Promise<CompleteSavedGuide> {
    return this.rpc(
      "read_complete_beauty_guide",
      { p_token_hash: tokenHash },
      completeSavedGuideSchema,
    );
  }
  async revokeCompleteGuide(tokenHash: string) {
    await this.mutate("revoke_complete_beauty_guide", {
      p_token_hash: tokenHash,
    });
  }
  async demographics(storeId: string): Promise<BeautyDemographics> {
    this.store(storeId);
    return this.rpc(
      "read_staff_beauty_demographics",
      { p_store_id: storeId },
      z
        .object({
          periodStart: z.string(),
          periodEnd: z.string(),
          unit: z.literal("completed_sessions"),
          age: z
            .object({
              suppressed: z.boolean(),
              counts: z.record(z.string(), z.number().int().nonnegative()),
            })
            .strict(),
          gender: z
            .object({
              suppressed: z.boolean(),
              counts: z.record(z.string(), z.number().int().nonnegative()),
            })
            .strict(),
        })
        .strict(),
    );
  }
}
export async function makeSupabaseBeautyCompleteRepository(
  kind: IdentityKind = "device",
): Promise<BeautyCompleteRepository> {
  const identity = await getSupabaseIdentity(kind);
  if (!identity)
    throw new AppError(
      401,
      "authentication_required",
      kind === "staff"
        ? "Please sign in to management."
        : "Pair this device before starting.",
    );
  return new SupabaseBeautyCompleteRepository(identity);
}
