import "server-only";
import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  BeautyRepository,
  BeautySession,
} from "@/application/beauty-consultations";
import {
  validateBeautyAnalysis,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import {
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import type {
  ColorSession,
  PersonalColorRepository,
} from "@/application/personal-color";
import {
  validateColorAnalysis,
  type ColorAnalysis,
} from "@/domain/color-analysis";
import {
  paletteIds,
  lipFinishes,
  lipHueFamilies,
  type ColorPreferences,
  type LipShade,
  type LipShadeDraft,
} from "@/domain/personal-color";
import {
  AppError,
  type Analysis,
  type Answers,
  type CatalogWrite,
  type Consultation,
  type DeviceContext,
  type DeviceRecord,
  type Metrics,
  type Policy,
  type Repository,
} from "@/application/contracts";
import { validateCatalogDraft } from "@/domain/catalog";
import { canonicalizeIngredients } from "@/domain/ingredients";
import { isOpenAIAnalysis } from "@/domain/skin-vision";
import {
  concerns,
  productCategories,
  skinTypes,
  type Product,
  type Recommendation,
} from "@/domain/types";
import { requiredEnv } from "./config";
import {
  EXPLANATION_NOTICE_VERSION,
  EXPLANATION_PROMPT_VERSION,
  type RecommendationExplanation,
} from "@/application/explanation-contracts";
import {
  getSupabaseIdentity,
  type IdentityKind,
  type SupabaseIdentity,
} from "./supabase-auth";

const uuid = z.string().uuid();
const colorPreferencesSchema = z
  .object({
    paletteId: z.enum(paletteIds),
    finish: z.enum(["any", ...lipFinishes]),
  })
  .strict();
const lipShadeSchema = z
  .object({
    id: uuid.optional(),
    variantId: uuid,
    organizationId: uuid,
    versionId: uuid,
    version: z.number().int().positive(),
    shadeName: z.string().min(1).max(80),
    hueFamily: z.enum(lipHueFamilies),
    undertone: z.enum(["warm", "cool", "neutral"]),
    intensity: z.enum(["soft", "clear"]),
    finish: z.enum(lipFinishes),
    swatchHex: z.string().regex(/^#[0-9a-f]{6}$/i),
    reviewed: z.literal(true),
  })
  .strict();
const productRowSchema = z.object({
  id: uuid,
  organization_id: uuid,
  store_id: uuid,
  brand: z.string(),
  name: z.string(),
  category: z.enum(productCategories),
  sku: z.string(),
  price_minor: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  stock: z.number().int().nonnegative(),
  visible: z.boolean(),
  status: z.enum(["draft", "published"]).nullable(),
  ingredients: z.array(z.string()),
  skin_types: z.array(z.enum(skinTypes)),
  formulation_complete: z.boolean(),
});
const reasonSchema = z.object({
  concern: z.enum(concerns),
  ingredient: z.string(),
  relevance: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
const persistedRecommendationSchema = z.object({
  variant_id: uuid,
  rank: z.number().int().min(1).max(3),
  score: z.number().nonnegative(),
  matched_ingredients: z.array(z.string()).max(12),
  reasons: z.array(reasonSchema).max(12),
});
const persistedMockAnalysisSchema = z.object({
  id: uuid,
  request_id: uuid,
  mode: z.literal("mock"),
  model_version: z.string(),
  quality_status: z.literal("demo"),
  disclaimer: z.string(),
  observations: z
    .array(
      z.object({
        concern_id: z.enum(concerns),
        level: z.enum(["low", "moderate", "high"]),
        score: z.number().min(0).max(1),
      }),
    )
    .max(4),
});
const persistedExperimentalAnalysisSchema = z.object({
  id: uuid,
  request_id: uuid,
  mode: z.literal("experimental"),
  model_version: z.string().min(1).max(120),
  quality_status: z.literal("experimental"),
  disclaimer: z.string().min(1).max(1000),
  observations: z.tuple([]),
  visual: z
    .object({
      model_version: z.string().min(1).max(120),
      heads: z
        .array(
          z.object({
            key: z.enum([
              "sensitivity",
              "pigmentation",
              "wrinkles",
              "acne",
              "pores",
              "sagging",
              "keratin",
              "redness",
            ]),
            label: z.string().min(1).max(80),
            predicted_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/),
            probabilities: z
              .array(
                z.object({
                  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/),
                  probability: z.number().min(0).max(1),
                }),
              )
              .min(2)
              .max(16),
          }),
        )
        .length(8),
    })
    .nullable(),
  ingredients: z.object({
    model_version: z.string().min(1).max(120),
    candidates: z
      .array(
        z.object({
          ingredient: z.string().min(1).max(160),
          score: z.number().min(0).max(1),
        }),
      )
      .max(128),
    input_coverage: z.array(z.string().min(1).max(120)).max(20),
  }),
});
const persistedAnalysisSchema = z.discriminatedUnion("mode", [
  persistedMockAnalysisSchema,
  persistedExperimentalAnalysisSchema,
  z
    .object({
      id: uuid,
      request_id: uuid,
      mode: z.literal("openai"),
      model_version: z.literal("gpt-4.1-mini-2025-04-14"),
      quality_status: z.enum([
        "usable",
        "limited",
        "not_assessable",
        "not_provided",
      ]),
      observations: z.tuple([]),
      disclaimer: z.string().min(1).max(1000),
      vision: z
        .object({
          prompt_version: z.literal("visible-appearance-eval-v1"),
          image_quality: z.enum(["usable", "limited", "not_assessable"]),
          quality_flags: z
            .array(
              z.enum([
                "no_face",
                "multiple_faces",
                "blur",
                "low_light",
                "uneven_lighting",
                "occlusion",
                "makeup_or_filter",
                "face_not_fully_visible",
                "resolution_limited",
              ]),
            )
            .max(9),
          observed_features: z
            .object({
              visible_redness: z.enum([
                "visible",
                "not_visible",
                "uncertain",
                "not_assessable",
              ]),
              visible_spots: z.enum([
                "visible",
                "not_visible",
                "uncertain",
                "not_assessable",
              ]),
              visible_pores: z.enum([
                "visible",
                "not_visible",
                "uncertain",
                "not_assessable",
              ]),
              visible_fine_lines: z.enum([
                "visible",
                "not_visible",
                "uncertain",
                "not_assessable",
              ]),
              visible_flaking: z.enum([
                "visible",
                "not_visible",
                "uncertain",
                "not_assessable",
              ]),
            })
            .strict(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
]);
const persistedExplanationSchema = z
  .object({
    status: z.enum(["generated", "fallback"]),
    summary: z.string().min(1).max(600),
    products: z
      .array(
        z
          .object({ productId: uuid, text: z.string().min(1).max(600) })
          .strict(),
      )
      .max(3),
    modelVersion: z.string().min(1).max(120).nullable(),
    promptVersion: z.literal(EXPLANATION_PROMPT_VERSION),
  })
  .strict()
  .refine((value) =>
    value.status === "generated"
      ? value.modelVersion !== null
      : value.modelVersion === null,
  );
const sessionRowSchema = z.object({
  id: uuid,
  organization_id: uuid,
  store_id: uuid,
  device_id: uuid,
  status: z.enum(["active", "finished", "expired"]),
  created_at: z.string(),
  consent: z
    .object({ accepted: z.boolean(), policy_version: z.string() })
    .nullable(),
  answers: z
    .object({
      skinType: z.enum(skinTypes),
      concerns: z.array(z.enum(concerns)).min(1).max(4),
      excludedIngredients: z.array(z.string()).max(30),
      sensitive: z.boolean(),
    })
    .nullable(),
  analysis: persistedAnalysisSchema.nullable(),
  recommendations: z.array(persistedRecommendationSchema).max(3).nullable(),
  explanation_consent: z
    .object({
      accepted: z.boolean(),
      notice_version: z.literal(EXPLANATION_NOTICE_VERSION),
    })
    .strict()
    .nullable()
    .optional(),
  explanation: persistedExplanationSchema.nullable().optional(),
  vision_consent: z
    .object({
      accepted: z.boolean(),
      notice_version: z.literal("2026-10-openai-photo-v1"),
    })
    .strict()
    .nullable()
    .optional(),
});
const policySchema = z.object({
  id: uuid,
  version: z.number().int().positive(),
  rules: z.array(reasonSchema),
  source: z.enum(["operator-configured", "mock-onboarding-v1"]).optional(),
});
type SessionRow = z.infer<typeof sessionRowSchema>;

function analysisFromRow(row: NonNullable<SessionRow["analysis"]>): Analysis {
  const { id: _id, ...analysis } = row;
  void _id;
  if (analysis.mode === "openai" && !isOpenAIAnalysis(analysis))
    throw new AppError(
      503,
      "invalid_analysis",
      "The saved photo observations are not valid.",
    );
  return analysis;
}

function databaseError(code?: string): AppError {
  if (code === "42501")
    return new AppError(
      403,
      "permission_denied",
      "You do not have permission for this store or consultation.",
    );
  if (code === "PGRST301" || code === "PGRST302")
    return new AppError(
      401,
      "authentication_required",
      "Please sign in or pair this device again.",
    );
  if (["22023", "22P02", "23514", "23505", "23502"].includes(code ?? ""))
    return new AppError(
      422,
      "invalid_operation",
      "The change could not be saved. Check the fields and the current publication state.",
    );
  if (code === "23503")
    return new AppError(
      409,
      "resource_changed",
      "A related item changed. Refresh and try again.",
    );
  return new AppError(
    503,
    "database_unavailable",
    "The store service is temporarily unavailable.",
  );
}

function transportValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      503,
      "invalid_database_response",
      "The store service returned an unexpected response.",
    );
  return parsed.data;
}

function productFromRow(row: z.infer<typeof productRowSchema>): Product {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    brand: row.brand,
    name: row.name,
    category: row.category,
    sku: row.sku,
    priceMinor: row.price_minor,
    currency: row.currency,
    stock: row.stock,
    visible: row.visible,
    status: row.status ?? "draft",
    ingredients: row.ingredients,
    suitableSkinTypes: row.skin_types,
    formulaComplete: row.formulation_complete,
  };
}

function catalogDto(product: CatalogWrite) {
  return {
    sku: product.sku,
    brand: product.brand,
    name: product.name,
    category: product.category,
    price_minor: product.priceMinor,
    currency: product.currency,
    stock: product.stock,
    ingredients: product.ingredients,
    formulation_complete: product.formulaComplete,
    skin_types: product.suitableSkinTypes,
  };
}

let writerPool: Sql | undefined;
let writerRoleValidation: Promise<void> | undefined;

/** This pool can execute only the narrow writer functions; never use Supabase service_role. */
export async function analysisWriter(): Promise<Sql> {
  if (!writerPool) {
    const connectionString = requiredEnv("ANALYSIS_DATABASE_URL");
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new AppError(
        503,
        "configuration_required",
        "The analysis writer configuration is invalid.",
      );
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new AppError(
        503,
        "configuration_required",
        "The analysis writer configuration is invalid.",
      );
    // Docker's reserved host gateway is used only for the local Supabase stack.
    const local = [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "host.docker.internal",
    ].includes(url.hostname);
    let ssl: false | "verify-full" | { ca: string; rejectUnauthorized: true } =
      local ? false : "verify-full";
    const caFile = process.env.ANALYSIS_DATABASE_CA_FILE;
    if (!local && caFile) {
      try {
        const ca = await readFile(caFile, "utf8");
        if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error();
        ssl = { ca, rejectUnauthorized: true };
      } catch {
        throw new AppError(
          503,
          "configuration_required",
          "The analysis database CA certificate could not be loaded.",
        );
      }
    }
    writerPool = postgres(connectionString, {
      max: 2,
      prepare: false,
      ssl,
      connect_timeout: 5,
      idle_timeout: 20,
      max_lifetime: 600,
      onnotice: () => undefined,
      connection: { application_name: "senmiva-analysis-writer" },
    });
    const connection = writerPool;
    writerRoleValidation = (async () => {
      const roles = await connection<
        { role_name: string; privileged: boolean; writer: boolean }[]
      >`
        select current_user::text as role_name,
          (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb) as privileged,
          pg_catalog.pg_has_role(current_user, 'analysis_writer', 'USAGE') as writer
        from pg_catalog.pg_roles where rolname = current_user
      `;
      const role = roles[0];
      if (
        !role ||
        role.privileged ||
        !role.writer ||
        [
          "postgres",
          "supabase_admin",
          "service_role",
          "authenticated",
          "anon",
        ].includes(role.role_name)
      ) {
        throw new AppError(
          503,
          "writer_role_required",
          "A dedicated restricted analysis writer login is required.",
        );
      }
    })();
  }
  try {
    await writerRoleValidation;
    return writerPool;
  } catch {
    const connection = writerPool;
    writerPool = undefined;
    writerRoleValidation = undefined;
    await connection?.end({ timeout: 1 }).catch(() => undefined);
    throw new AppError(
      503,
      "writer_unavailable",
      "The restricted analysis writer is unavailable.",
    );
  }
}

class SupabaseRepository
  implements Repository, PersonalColorRepository, BeautyRepository
{
  constructor(private readonly identity: SupabaseIdentity) {}

  private async rpc<T>(
    name: string,
    args: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const { data, error } = await this.identity.client.rpc(name, args);
      if (error) throw databaseError(error.code);
      return transportValue(schema, data);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw databaseError();
    }
  }

  private async mutate(
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    await this.rpc(name, args, z.unknown());
  }

  private store(storeId: string, write = false, owner = false): void {
    if (this.identity.kind === "device") {
      if (write || storeId !== this.identity.context.storeId)
        throw databaseError("42501");
      return;
    }
    if (
      !this.identity.context.stores.some((store) => store.id === storeId) ||
      (write && this.identity.context.role === "viewer") ||
      (owner && this.identity.context.role !== "owner")
    )
      throw databaseError("42501");
  }

  private device(device: DeviceContext): void {
    if (this.identity.kind !== "device") throw databaseError("42501");
    const actual = this.identity.context;
    if (
      actual.organizationId !== device.organizationId ||
      actual.storeId !== device.storeId ||
      actual.deviceId !== device.deviceId
    )
      throw databaseError("42501");
  }

  private async record(id: string, device: DeviceContext): Promise<SessionRow> {
    this.device(device);
    const record = await this.rpc(
      "read_kiosk_session",
      { p_session_id: id },
      sessionRowSchema,
    );
    if (
      record.id !== id ||
      record.organization_id !== device.organizationId ||
      record.store_id !== device.storeId ||
      record.device_id !== device.deviceId ||
      record.status !== "active"
    )
      throw databaseError("42501");
    return record;
  }

  private async assertVariant(id: string): Promise<void> {
    if (
      this.identity.kind !== "staff" ||
      this.identity.context.role !== "owner"
    )
      throw databaseError("42501");
    try {
      const { data, error } = await this.identity.client
        .from("product_variants")
        .select("id")
        .eq("org_id", this.identity.context.organizationId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw databaseError(error.code);
      if (!data)
        throw new AppError(404, "product_not_found", "Product not found.");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw databaseError();
    }
  }

  async products(storeId: string): Promise<Product[]> {
    this.store(storeId);
    const rows = await this.rpc(
      "read_store_catalog",
      { p_store_id: storeId },
      z.array(productRowSchema),
    );
    const organizationId = this.identity.context.organizationId;
    if (
      rows.some(
        (row) =>
          row.organization_id !== organizationId || row.store_id !== storeId,
      )
    )
      throw databaseError("42501");
    return rows.map(productFromRow);
  }

  async saveDraft(storeId: string, product: CatalogWrite): Promise<void> {
    this.store(storeId, true, true);
    await this.rpc(
      "save_catalog_draft",
      { p_store_id: storeId, p_product: catalogDto(product) },
      uuid,
    );
  }

  async importDrafts(storeId: string, products: CatalogWrite[]): Promise<void> {
    this.store(storeId, true, true);
    await this.rpc(
      "import_catalog_drafts",
      { p_store_id: storeId, p_products: products.map(catalogDto) },
      z.array(uuid).max(500),
    );
  }

  async publish(id: string): Promise<void> {
    await this.assertVariant(id);
    await this.mutate("publish_catalog_variant", { p_variant_id: id });
  }

  async updateListing(
    storeId: string,
    id: string,
    patch: Pick<Product, "priceMinor" | "stock" | "visible">,
  ): Promise<void> {
    this.store(storeId, true);
    await this.mutate("update_store_listing", {
      p_store_id: storeId,
      p_variant_id: id,
      p_price_minor: patch.priceMinor,
      p_stock: patch.stock,
      p_visible: patch.visible,
    });
  }

  async beautySession(
    id: string,
    device: DeviceContext,
  ): Promise<BeautySession> {
    await this.record(id, device);
    const state = await this.rpc(
      "read_kiosk_beauty_session",
      { p_session_id: id },
      z
        .object({
          consent: z.boolean(),
          attempted: z.boolean(),
          analysis: z.unknown().nullable(),
          preferences: z
            .custom<BeautyPreferences>(validBeautyPreferences)
            .nullable(),
          excludedIngredients: z.array(z.string().min(1).max(160)).max(20),
        })
        .strict(),
    );
    const analysis =
      state.analysis === null ? null : validateBeautyAnalysis(state.analysis);
    if (state.analysis !== null && !analysis)
      throw new AppError(
        503,
        "invalid_beauty_analysis",
        "The saved beauty suggestion could not be verified.",
      );
    return { ...state, analysis };
  }
  async beautyConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    await this.record(id, device);
    await this.mutate("record_beauty_consent", {
      p_session_id: id,
      p_notice_version: noticeVersion,
      p_accepted: accepted,
    });
  }
  async beautyMakeupState(id: string, device: DeviceContext) {
    await this.record(id, device);
    return this.rpc(
      "kiosk_beauty_makeup_state",
      { p_session_id: id },
      z.object({ consent: z.boolean(), attempted: z.boolean() }).strict(),
    );
  }
  async beautyMakeupConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    await this.record(id, device);
    await this.mutate("kiosk_set_beauty_makeup_consent", {
      p_session_id: id,
      p_accepted: accepted,
      p_notice_version: noticeVersion,
    });
  }
  async claimBeautyMakeup(id: string, device: DeviceContext) {
    await this.record(id, device);
    await this.mutate("kiosk_claim_beauty_makeup", { p_session_id: id });
  }
  async assertBeautyMakeup(id: string, device: DeviceContext) {
    await this.record(id, device);
    await this.mutate("kiosk_assert_beauty_makeup", { p_session_id: id });
  }
  async claimBeautyAnalysis(
    id: string,
    device: DeviceContext,
  ): Promise<boolean> {
    await this.record(id, device);
    return this.rpc(
      "claim_kiosk_beauty_analysis",
      { p_session_id: id },
      z.boolean(),
    );
  }
  async saveBeautyAnalysis(
    id: string,
    device: DeviceContext,
    analysis: BeautyAnalysis,
  ) {
    await this.record(id, device);
    const result = validateBeautyAnalysis(analysis);
    if (!result)
      throw new AppError(
        422,
        "invalid_beauty_analysis",
        "The beauty suggestion is invalid.",
      );
    const writer = await analysisWriter();
    try {
      await writer`select public.write_openai_beauty_analysis(${id}::uuid, ${result.request_id}::uuid, ${result.model_version}, ${writer.json({ ...result })}::jsonb)`;
    } catch {
      throw new AppError(
        409,
        "beauty_write_failed",
        "This consultation changed before the beauty result could be saved.",
      );
    }
  }
  async confirmBeautyPreferences(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ) {
    await this.record(id, device);
    if (!validBeautyPreferences(preferences))
      throw new AppError(
        422,
        "invalid_beauty_preferences",
        "Choose listed style preferences.",
      );
    await this.mutate("confirm_kiosk_beauty_preferences", {
      p_session_id: id,
      p_preferences: preferences,
    });
  }
  async beautyExclusions(
    id: string,
    device: DeviceContext,
    ingredients: string[],
  ) {
    await this.record(id, device);
    await this.mutate("record_beauty_exclusions", {
      p_session_id: id,
      p_excluded_ingredients: ingredients,
    });
  }
  async createBeautyGuide(
    id: string,
    device: DeviceContext,
    tokenHash: string,
    noticeVersion: string,
  ) {
    await this.record(id, device);
    return this.rpc(
      "create_kiosk_beauty_guide",
      {
        p_session_id: id,
        p_token_hash: tokenHash,
        p_notice_version: noticeVersion,
        p_accepted: true,
      },
      z.object({ expiresAt: z.string().datetime({ offset: true }) }).strict(),
    );
  }
  async colorSession(id: string, device: DeviceContext): Promise<ColorSession> {
    await this.record(id, device);
    const state = await this.rpc(
      "read_kiosk_color_session",
      { p_session_id: id },
      z
        .object({
          consent: z.boolean(),
          attempted: z.boolean(),
          analysis: z.unknown().nullable(),
          preferences: colorPreferencesSchema.nullable(),
        })
        .strict(),
    );
    const analysis =
      state.analysis === null ? null : validateColorAnalysis(state.analysis);
    if (state.analysis !== null && !analysis)
      throw new AppError(
        503,
        "invalid_color_analysis",
        "The saved color suggestion could not be verified.",
      );
    return { ...state, analysis };
  }
  async colorConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    await this.record(id, device);
    await this.mutate("record_color_consent", {
      p_session_id: id,
      p_notice_version: noticeVersion,
      p_accepted: accepted,
    });
  }
  async claimColorAnalysis(
    id: string,
    device: DeviceContext,
  ): Promise<boolean> {
    await this.record(id, device);
    return this.rpc(
      "claim_kiosk_color_analysis",
      { p_session_id: id },
      z.boolean(),
    );
  }
  async saveColorAnalysis(
    id: string,
    device: DeviceContext,
    analysis: ColorAnalysis,
  ) {
    await this.record(id, device);
    const result = validateColorAnalysis(analysis);
    if (!result)
      throw new AppError(
        422,
        "invalid_color_analysis",
        "The color suggestion is invalid.",
      );
    const writer = await analysisWriter();
    try {
      await writer`select public.write_openai_color_analysis(${id}::uuid, ${result.request_id}::uuid, ${result.model_version}, ${writer.json({ ...result })}::jsonb)`;
    } catch {
      throw new AppError(
        409,
        "color_write_failed",
        "This consultation changed before the color result could be saved.",
      );
    }
  }
  async confirmColorPreferences(
    id: string,
    device: DeviceContext,
    preferences: ColorPreferences,
  ) {
    await this.record(id, device);
    const value = transportValue(colorPreferencesSchema, preferences);
    await this.mutate("confirm_kiosk_color_preferences", {
      p_session_id: id,
      p_palette: value.paletteId,
      p_finish: value.finish,
    });
  }
  async lipShades(storeId: string): Promise<LipShade[]> {
    this.store(storeId);
    return this.rpc(
      "read_store_lip_shades",
      { p_store_id: storeId },
      z.array(lipShadeSchema),
    );
  }
  async publishLipShade(
    storeId: string,
    variantId: string,
    draft: LipShadeDraft,
  ) {
    this.store(storeId, true, true);
    await this.rpc(
      "publish_lip_shade",
      { p_store_id: storeId, p_variant_id: variantId, p_shade: draft },
      uuid,
    );
  }
  async start(device: DeviceContext): Promise<Consultation> {
    this.device(device);
    const id = await this.rpc("start_kiosk_session", undefined, uuid);
    return this.session(id, device);
  }

  async session(id: string, device: DeviceContext): Promise<Consultation> {
    const row = await this.record(id, device);
    let recommendations: Recommendation[] | null = null;
    if (row.recommendations !== null) {
      const products = await this.products(device.storeId);
      const exclusions = canonicalizeIngredients(
        row.answers?.excludedIngredients ?? [],
      ).canonical;
      recommendations = row.recommendations
        .sort((left, right) => left.rank - right.rank)
        .flatMap((item) => {
          const product = products.find(
            (candidate) => candidate.id === item.variant_id,
          );
          if (
            !product ||
            !validateCatalogDraft(product).valid ||
            product.status !== "published" ||
            !product.visible ||
            product.stock <= 0
          )
            return [];
          const ingredients = new Set(
            canonicalizeIngredients(product.ingredients).canonical,
          );
          // A listing/formula can change after a run. Never show a newly ineligible product.
          if (
            exclusions.some((ingredient) => ingredients.has(ingredient)) ||
            item.matched_ingredients.some(
              (ingredient) => !ingredients.has(ingredient),
            )
          )
            return [];
          return [
            {
              product,
              score: item.score,
              matchedIngredients: item.matched_ingredients,
              reasons: item.reasons,
            },
          ];
        });
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      storeId: row.store_id,
      deviceId: row.device_id,
      createdAt: row.created_at,
      consent: row.consent?.accepted ?? false,
      ...(row.consent?.accepted
        ? { consentVersion: row.consent.policy_version }
        : {}),
      answers: row.answers,
      analysis: row.analysis ? analysisFromRow(row.analysis) : null,
      recommendations,
      visionConsent: row.vision_consent
        ? {
            accepted: row.vision_consent.accepted,
            noticeVersion: row.vision_consent.notice_version,
          }
        : null,
      explanationConsent: row.explanation_consent
        ? {
            accepted: row.explanation_consent.accepted,
            noticeVersion: row.explanation_consent.notice_version,
          }
        : null,
      explanation:
        row.explanation &&
        recommendations &&
        row.explanation.products.length === recommendations.length &&
        row.explanation.products.every(
          (product, index) =>
            product.productId === recommendations[index].product.id,
        )
          ? row.explanation
          : null,
    };
  }

  async consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion = "2026-10-mvp",
  ): Promise<void> {
    await this.record(id, device);
    await this.mutate("record_consent", {
      p_session_id: id,
      p_policy_version: noticeVersion,
      p_accepted: accepted,
    });
  }

  async answers(
    id: string,
    device: DeviceContext,
    answers: Answers,
  ): Promise<void> {
    await this.record(id, device);
    await this.mutate("save_answers", {
      p_session_id: id,
      p_skin_type: answers.skinType,
      p_concerns: answers.concerns,
      p_excluded_ingredients: answers.excludedIngredients,
      p_sensitive: answers.sensitive,
    });
  }
  async explanationConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void> {
    await this.record(id, device);
    await this.mutate("record_explanation_consent", {
      p_session_id: id,
      p_notice_version: noticeVersion,
      p_accepted: accepted,
    });
  }
  async claimExplanation(id: string, device: DeviceContext): Promise<boolean> {
    await this.record(id, device);
    return this.rpc(
      "claim_kiosk_explanation",
      { p_session_id: id },
      z.boolean(),
    );
  }
  async visionConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ): Promise<void> {
    await this.record(id, device);
    await this.mutate("record_vision_consent", {
      p_session_id: id,
      p_notice_version: noticeVersion,
      p_accepted: accepted,
    });
  }
  async claimVisionAnalysis(
    id: string,
    device: DeviceContext,
  ): Promise<boolean> {
    await this.record(id, device);
    return this.rpc(
      "claim_kiosk_vision_analysis",
      { p_session_id: id },
      z.boolean(),
    );
  }
  async saveExplanation(
    id: string,
    device: DeviceContext,
    explanation: RecommendationExplanation,
  ): Promise<void> {
    await this.record(id, device);
    const value = transportValue(persistedExplanationSchema, explanation);
    const writer = await analysisWriter();
    try {
      await writer`select public.complete_recommendation_explanation(${id}::uuid, ${value.status}, ${value.summary}, ${writer.json(value.products)}::jsonb, ${value.modelVersion}, ${value.promptVersion})`;
    } catch {
      throw new AppError(
        409,
        "explanation_write_failed",
        "This consultation changed before its explanation could be saved.",
      );
    }
  }

  async saveAnalysis(
    id: string,
    device: DeviceContext,
    analysis: Analysis,
  ): Promise<void> {
    await this.record(id, device);
    if (analysis.mode === "openai" && !isOpenAIAnalysis(analysis))
      throw new AppError(
        422,
        "invalid_analysis",
        "The photo observations are not valid.",
      );
    if (
      analysis.request_id !== id ||
      !(
        (analysis.mode === "mock" && analysis.quality_status === "demo") ||
        (analysis.mode === "experimental" &&
          analysis.quality_status === "experimental") ||
        (analysis.mode === "openai" &&
          ["usable", "limited", "not_assessable", "not_provided"].includes(
            analysis.quality_status,
          ))
      )
    )
      throw new AppError(
        422,
        "invalid_analysis",
        "The analysis result does not match this consultation.",
      );
    const writer = await analysisWriter();
    try {
      if (analysis.mode === "experimental") {
        await writer`select public.write_experimental_analysis(${id}::uuid, ${analysis.request_id}::uuid, ${analysis.model_version}, ${analysis.disclaimer}, ${analysis.visual ? writer.json(analysis.visual) : null}::jsonb, ${writer.json(analysis.ingredients)}::jsonb)`;
      } else if (analysis.mode === "openai") {
        const value = transportValue(persistedAnalysisSchema, {
          id,
          ...analysis,
        });
        if (value.mode !== "openai") throw new Error("Invalid OpenAI analysis");
        await writer`select public.write_openai_analysis(${id}::uuid, ${value.request_id}::uuid, ${value.model_version}, ${value.quality_status}, ${value.disclaimer}, ${value.vision ? writer.json(value.vision) : null}::jsonb)`;
      } else {
        await writer`select public.write_analysis_result(${id}::uuid, ${analysis.request_id}::uuid, ${analysis.mode}, ${analysis.model_version}, ${analysis.quality_status}, ${writer.json(analysis.observations)}::jsonb)`;
      }
    } catch {
      throw new AppError(
        503,
        "analysis_write_failed",
        "The analysis result could not be saved. Please retry this consultation.",
      );
    }
  }

  async saveRecommendations(
    id: string,
    device: DeviceContext,
    policy: Policy,
    items: Recommendation[],
  ): Promise<void> {
    const row = await this.record(id, device);
    if (!row.analysis)
      throw new AppError(
        409,
        "analysis_required",
        "Complete the analysis first.",
      );
    if (
      items.length > 3 ||
      items.some(
        (item) =>
          item.product.organizationId !== device.organizationId ||
          item.product.storeId !== device.storeId,
      )
    )
      throw databaseError("42501");
    const writer = await analysisWriter();
    const dto = items.map((item) => ({
      variant_id: item.product.id,
      score: item.score,
      matched_ingredients: item.matchedIngredients,
      reasons: item.reasons.map(({ concern, ingredient, relevance }) => ({
        concern,
        ingredient,
        relevance,
      })),
    }));
    try {
      await writer`select public.persist_recommendations(${id}::uuid, ${row.analysis.id}::uuid, ${policy.id}::uuid, ${writer.json(dto)}::jsonb)`;
    } catch {
      throw new AppError(
        409,
        "recommendations_changed",
        "Store availability changed. Please retry to refresh your recommendations.",
      );
    }
  }

  async finish(id: string, device: DeviceContext): Promise<void> {
    this.device(device);
    // The database validates ownership and treats an already finished session as a no-op.
    await this.mutate("finish_kiosk_session", { p_session_id: id });
  }

  async policy(device: DeviceContext, sessionId?: string): Promise<Policy> {
    this.device(device);
    const row = await this.rpc(
      sessionId
        ? "read_kiosk_recommendation_policy"
        : "read_recommendation_policy",
      sessionId ? { p_session_id: sessionId } : undefined,
      policySchema,
    );
    return {
      id: row.id,
      version: String(row.version),
      rules: row.rules,
      ...(row.source ? { source: row.source } : {}),
    };
  }

  async metrics(storeId: string): Promise<Metrics> {
    if (this.identity.kind !== "staff") throw databaseError("42501");
    this.store(storeId);
    const rows = await this.rpc(
      "read_store_metrics",
      { p_store_id: storeId },
      z.array(
        z.object({
          day: z.string(),
          sessions_started: z.number().int().nonnegative(),
          sessions_completed: z.number().int().nonnegative(),
          sessions_analyzed: z.number().int().nonnegative(),
        }),
      ),
    );
    const todayUtc = new Date().toISOString().slice(0, 10);
    return rows
      .filter((row) => row.day === todayUtc)
      .reduce(
        (total, row) => ({
          started: total.started + row.sessions_started,
          completed: total.completed + row.sessions_completed,
          analyzed: total.analyzed + row.sessions_analyzed,
        }),
        { started: 0, completed: 0, analyzed: 0 },
      );
  }

  async devices(storeId: string): Promise<DeviceRecord[]> {
    this.store(storeId, true);
    const rows = await this.rpc(
      "read_store_devices",
      { p_store_id: storeId },
      z.array(
        z.object({
          id: uuid,
          label: z.string(),
          status: z.enum(["active", "revoked"]),
          last_seen_at: z.string().nullable(),
        }),
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      storeId,
      revoked: row.status === "revoked",
      lastSeen: row.last_seen_at,
    }));
  }

  async pairingCode(
    storeId: string,
    label: string,
  ): Promise<{ code: string; expiresAt: string }> {
    this.store(storeId, true);
    const row = await this.rpc(
      "create_pairing_code",
      { p_store_id: storeId, p_label: label },
      z.object({
        pairing_code: z.string().regex(/^[A-F0-9]{16}$/),
        expires_at: z.string(),
      }),
    );
    return { code: row.pairing_code, expiresAt: row.expires_at };
  }

  async revokeDevice(id: string): Promise<void> {
    if (
      this.identity.kind !== "staff" ||
      this.identity.context.role === "viewer"
    )
      throw databaseError("42501");
    try {
      const { data, error } = await this.identity.client
        .from("devices")
        .select("store_id")
        .eq("org_id", this.identity.context.organizationId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw databaseError(error.code);
      if (!data)
        throw new AppError(404, "device_not_found", "Device not found.");
      const row = transportValue(z.object({ store_id: uuid }), data);
      this.store(row.store_id, true);
      await this.mutate("revoke_device", { p_device_id: id });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw databaseError();
    }
  }
}

export async function makeSupabaseRepository(
  kind: IdentityKind,
): Promise<Repository & PersonalColorRepository & BeautyRepository> {
  const identity = await getSupabaseIdentity(kind);
  if (!identity)
    throw new AppError(
      401,
      "authentication_required",
      kind === "staff"
        ? "Please sign in to management."
        : "Pair this device before starting a consultation.",
    );
  return new SupabaseRepository(identity);
}
