import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import QRCode from "qrcode";
import {
  BeautyConsultations,
  BEAUTY_SAVE_NOTICE_VERSION,
} from "@/application/beauty-consultations";
import { BEAUTY_PHOTO_NOTICE_VERSION } from "@/domain/beauty-analysis";
import {
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import { HttpBeautyAnalysis } from "@/infrastructure/beauty-analysis";
import { HttpBeautyMakeup } from "@/infrastructure/beauty-makeup";
import { BEAUTY_MAKEUP_NOTICE_VERSION } from "@/domain/beauty-makeup";
import {
  beautyPublicOrigin,
  beautyTokenHash,
  newBeautyToken,
  readSavedBeauty,
  SupabaseSavedBeauty,
  readCompleteSavedGuide,
  revokeCompleteSavedGuide,
} from "@/infrastructure/beauty-sharing";
import {
  AppError,
  type DeviceContext,
  type StaffContext,
} from "@/application/contracts";
import { Consultations } from "@/application/consultations";
import { PersonalColors } from "@/application/personal-color";
import { HttpColorAnalysis } from "@/infrastructure/color-analysis";
import { COLOR_PHOTO_NOTICE_VERSION } from "@/domain/color-analysis";
import { readSkinConsultation } from "@/application/skin-consultation";
import { parseCatalogCsv, canonicalIngredientNames } from "@/domain";
import { demoRepository, demoStaff } from "@/infrastructure/demo-repository";
import { appMode, analysisMode, requiredEnv } from "@/infrastructure/config";
import { authEmailDelivery } from "@/infrastructure/email-delivery";
import { HttpAnalysis, LocalMockAnalysis } from "@/infrastructure/analysis";
import {
  configuredExplanationProvider,
  explanationAvailable,
} from "@/infrastructure/explanation-config";
import { EXPLANATION_NOTICE_VERSION } from "@/domain/explanations";
import {
  OPENAI_CONSENT_VERSION,
  VISION_NOTICE_VERSION,
} from "@/domain/skin-vision";
import {
  getStaffContext,
  getDeviceContext,
  loginStaff,
  logoutStaff,
  pairDevice,
  makeSupabaseRepository,
  getOwnerAccount,
  signupOwner,
  verifyOwnerEmail,
  resendOwnerConfirmation,
  createOwnerWorkspace,
} from "@/infrastructure/supabase-auth";
import {
  answersSchema,
  listingSchema,
  assertSameOrigin,
  readJson,
  readEphemeralImage,
  colorPreferencesSchema,
  lipShadeDraftSchema,
} from "./validation";
import { CatalogInputError, parseCatalogWrite } from "./catalog-validation";
import {
  handleCompleteKiosk,
  completeRepository,
} from "./beauty-complete-handler";
import {
  validCosmeticShadeDraft,
  type CosmeticShadeDraft,
} from "@/domain/cosmetic-shades";

const limiter = new Map<string, { count: number; until: number }>();
const activeAnalyses = new Set<string>();
const activeExplanations = new Set<string>();
function rateLimit(key: string, limit = 80) {
  const now = Date.now();
  if (limiter.size >= 10000 && !limiter.has(key)) {
    for (const [k, v] of limiter) if (v.until <= now) limiter.delete(k);
    if (limiter.size >= 10000)
      throw new AppError(
        503,
        "request_capacity",
        "The service is busy. Please try again shortly.",
      );
  }
  const row = limiter.get(key);
  if (row && row.until > now) {
    if (++row.count > limit)
      throw new AppError(
        429,
        "rate_limited",
        "Please wait a moment before trying again.",
      );
  } else limiter.set(key, { count: 1, until: now + 60000 });
}
async function emptyBody(request: Request) {
  z.object({})
    .strict()
    .parse(await readJson(request, 1024));
}
async function staff(): Promise<StaffContext> {
  const result = appMode() === "demo" ? demoStaff : await getStaffContext();
  if (!result)
    throw new AppError(
      401,
      "sign_in_required",
      "Please sign in to your workspace.",
    );
  return result;
}
async function device(required = true): Promise<DeviceContext | null> {
  if (appMode() !== "demo") {
    const d = await getDeviceContext();
    if (!d && required)
      throw new AppError(
        401,
        "pairing_required",
        "Pair this tablet from your management workspace first.",
      );
    return d;
  }
  const jar = await cookies();
  let id = jar.get("sm-demo-device")?.value;
  if (!id) {
    id = randomUUID();
    jar.set("sm-demo-device", id, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 86400,
    });
  }
  try {
    return demoRepository.ensureDevice(id);
  } catch (error) {
    if (required) throw error;
    return null;
  }
}
async function repository(kind: "staff" | "device") {
  return appMode() === "demo" ? demoRepository : makeSupabaseRepository(kind);
}
function authorizeStore(context: StaffContext, storeId: string | null) {
  const id = storeId ?? context.stores[0]?.id;
  if (!id || !context.stores.some((s) => s.id === id))
    throw new AppError(
      403,
      "store_forbidden",
      "You do not have access to this store.",
    );
  return id;
}
function allowRole(context: StaffContext, roles: StaffContext["role"][]) {
  if (!roles.includes(context.role))
    throw new AppError(
      403,
      "role_forbidden",
      "Your workspace role cannot perform this action.",
    );
}
function consultations(repo: Awaited<ReturnType<typeof repository>>) {
  const mode = analysisMode();
  const url = process.env.ANALYSIS_SERVICE_URL;
  const key = url ? requiredEnv("ANALYSIS_API_KEY") : "";
  if ((appMode() === "supabase" || mode !== "mock") && !url)
    throw new AppError(
      503,
      "configuration_required",
      "Configure the private analysis service.",
    );
  if (url && key.length < 32)
    throw new AppError(
      503,
      "configuration_required",
      "The analysis service key must contain at least 32 characters.",
    );
  return new Consultations(
    repo,
    url ? new HttpAnalysis(url, key, analysisMode()) : new LocalMockAnalysis(),
    mode === "openai" ? null : configuredExplanationProvider(),
    mode,
  );
}
function personalColors(repo: Awaited<ReturnType<typeof repository>>) {
  const url = process.env.ANALYSIS_SERVICE_URL;
  const key = process.env.ANALYSIS_API_KEY?.trim();
  const enabled =
    analysisMode() === "openai" && !!url && !!key && key.length >= 32;
  return new PersonalColors(
    repo,
    enabled ? new HttpColorAnalysis(url!, key!) : null,
    randomUUID,
  );
}
function beautyConsultations(repo: Awaited<ReturnType<typeof repository>>) {
  const url = process.env.ANALYSIS_SERVICE_URL;
  const key = process.env.ANALYSIS_API_KEY?.trim();
  const enabled =
    analysisMode() === "openai" && !!url && !!key && key.length >= 32;
  return new BeautyConsultations(
    repo,
    enabled ? new HttpBeautyAnalysis(url!, key!) : null,
    randomUUID,
    appMode() === "supabase" && beautyPublicOrigin() !== null,
    enabled && process.env.ANALYSIS_BEAUTY_MAKEUP_ENABLED === "true"
      ? new HttpBeautyMakeup(url!, key!)
      : null,
  );
}

export async function handle(
  request: Request,
  segments: string[],
): Promise<Response> {
  const requestId = randomUUID();
  const ok = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": "no-store, private",
        "X-Request-ID": requestId,
      },
    });
  try {
    const route = segments.join("/");
    const method = request.method;
    const url = new URL(request.url);
    if (method !== "GET") assertSameOrigin(request);
    const mode = appMode();
    if (route === "healthz" && method === "GET")
      return ok({ status: "ok", mode, analysis: analysisMode() });
    if (
      [
        "shared-results/read",
        "shared-results/revoke",
        "shared-results/complete-read",
        "shared-results/complete-revoke",
      ].includes(route) &&
      method === "POST"
    ) {
      rateLimit(
        `shared-results:${request.headers.get("x-forwarded-for")?.split(",")[0]?.slice(0, 80) ?? "local"}`,
        30,
      );
      const { token } = z
        .object({ token: z.string().max(43) })
        .strict()
        .parse(await readJson(request, 1024));
      const tokenHash = beautyTokenHash(token);
      if (mode !== "supabase")
        throw new AppError(
          404,
          "guide_not_found",
          "This guide is unavailable or has expired.",
        );
      const shared = new SupabaseSavedBeauty();
      if (route === "shared-results/complete-read")
        return ok(await readCompleteSavedGuide(tokenHash));
      if (route === "shared-results/complete-revoke") {
        await revokeCompleteSavedGuide(tokenHash);
        return ok({ ok: true });
      }
      if (route === "shared-results/read") {
        try {
          return ok(await readSavedBeauty(shared, tokenHash));
        } catch (cause) {
          if (!(cause instanceof AppError) || cause.status !== 404) throw cause;
          return ok(await readCompleteSavedGuide(tokenHash));
        }
      }
      await shared.revokeSavedBeautyGuide(tokenHash);
      await revokeCompleteSavedGuide(tokenHash);
      return ok({ ok: true });
    }
    if (route === "auth/email-delivery" && method === "GET")
      return ok(authEmailDelivery(mode));
    if (route === "context" && method === "GET")
      return ok({
        mode,
        staff: mode === "demo" ? demoStaff : await getStaffContext(),
        device: await device(false),
        analysisMode: analysisMode(),
        explanationAvailable:
          analysisMode() !== "openai" && explanationAvailable(),
      });
    if (route === "auth/login" && method === "POST") {
      rateLimit(
        "login:" +
          (request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local"),
        10,
      );
      const body = z
        .object({
          email: z.string().email().max(200),
          password: z.string().min(1).max(256),
        })
        .strict()
        .parse(await readJson(request));
      const result =
        mode === "demo"
          ? { next: "management" }
          : await loginStaff(body.email, body.password);
      return ok({ ok: true, ...result });
    }
    if (route === "auth/account" && method === "GET")
      return ok(
        mode === "demo"
          ? { authenticated: true, needsWorkspace: false, staff: demoStaff }
          : await getOwnerAccount(),
      );
    if (
      method === "POST" &&
      [
        "auth/signup",
        "auth/verify-email",
        "auth/resend-confirmation",
        "auth/workspace",
      ].includes(route)
    ) {
      if (mode !== "supabase")
        throw new AppError(
          503,
          "signup_requires_supabase",
          "Account registration needs a connected Supabase project. The demonstration workspace does not create accounts.",
        );
      rateLimit(
        route +
          ":" +
          (request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local"),
        route === "auth/resend-confirmation" ? 3 : 10,
      );
      if (route === "auth/signup") {
        const body = z
          .object({
            email: z.string().trim().email().max(200),
            password: z.string().min(12).max(128),
          })
          .strict()
          .parse(await readJson(request, 4096));
        return ok(await signupOwner(body.email, body.password));
      }
      if (route === "auth/verify-email") {
        const body = z
          .object({
            email: z.string().trim().email().max(200),
            token: z
              .string()
              .trim()
              .regex(/^\d{6,10}$/),
          })
          .strict()
          .parse(await readJson(request, 4096));
        return ok(await verifyOwnerEmail(body.email, body.token));
      }
      if (route === "auth/resend-confirmation") {
        const body = z
          .object({
            email: z.string().trim().email().max(200),
          })
          .strict()
          .parse(await readJson(request, 4096));
        await resendOwnerConfirmation(body.email);
        return ok({ sent: true });
      }
      const body = z
        .object({
          organizationName: z.string().trim().min(1).max(120),
          storeName: z.string().trim().min(1).max(120),
        })
        .strict()
        .parse(await readJson(request, 4096));
      return ok({
        staff: await createOwnerWorkspace(
          body.organizationName,
          body.storeName,
        ),
      });
    }
    if (route === "auth/logout" && method === "POST") {
      await emptyBody(request);
      if (mode !== "demo") await logoutStaff();
      return ok({ ok: true });
    }
    if (route === "device/pair" && method === "POST") {
      const body = z
        .object({
          code: z
            .string()
            .trim()
            .regex(/^[A-Fa-f0-9]{16}$/),
        })
        .strict()
        .parse(await readJson(request));
      rateLimit(
        "pair:" +
          (request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local"),
        10,
      );
      if (mode === "demo") {
        const id = randomUUID();
        const result = demoRepository.pair(body.code, id);
        (await cookies()).set("sm-demo-device", id, {
          httpOnly: true,
          sameSite: "strict",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 86400,
        });
        return ok(result);
      }
      return ok(await pairDevice(body.code));
    }
    if (segments[0] === "management") {
      const context = await staff();
      const storeId = authorizeStore(context, url.searchParams.get("storeId"));
      const repo = await repository("staff");
      rateLimit(`staff:${context.organizationId}:${context.role}`);
      if (route === "management/cosmetic-shades" && method === "GET") {
        allowRole(context, ["owner", "manager"]);
        return ok({
          shades: await (
            await completeRepository("staff")
          ).cosmeticShades(storeId),
        });
      }
      if (route === "management/beauty-demographics" && method === "GET") {
        allowRole(context, ["owner", "manager"]);
        return ok(
          await (await completeRepository("staff")).demographics(storeId),
        );
      }
      if (
        segments.length === 4 &&
        segments[1] === "products" &&
        segments[3] === "cosmetic-shade" &&
        method === "POST"
      ) {
        allowRole(context, ["owner"]);
        const draft = z
          .custom<CosmeticShadeDraft>((value) =>
            validCosmeticShadeDraft(value as CosmeticShadeDraft),
          )
          .parse(await readJson(request, 4096));
        await (
          await completeRepository("staff")
        ).publishCosmeticShade(
          storeId,
          z.string().uuid().parse(segments[2]),
          draft,
        );
        return ok({ ok: true });
      }
      if (route === "management/lip-shades" && method === "GET") {
        allowRole(context, ["owner", "manager"]);
        return ok({ shades: await repo.lipShades(storeId) });
      }
      if (
        segments.length === 3 &&
        segments[1] === "lip-shades" &&
        method === "PUT"
      ) {
        allowRole(context, ["owner"]);
        await repo.publishLipShade(
          storeId,
          z.string().uuid().parse(segments[2]),
          lipShadeDraftSchema.parse(await readJson(request, 4096)),
        );
        return ok({ ok: true });
      }
      if (route === "management/catalog" && method === "GET")
        return ok({
          products: await repo.products(storeId),
          ingredients: canonicalIngredientNames,
        });
      if (route === "management/overview" && method === "GET") {
        if (context.role === "viewer")
          return ok({
            products: [],
            metrics: await repo.metrics(storeId),
            devices: [],
          });
        const [products, metrics, devices] = await Promise.all([
          repo.products(storeId),
          repo.metrics(storeId),
          repo.devices(storeId),
        ]);
        return ok({ products, metrics, devices });
      }
      if (route === "management/devices" && method === "GET")
        return ok({ devices: await repo.devices(storeId) });
      if (route === "management/products" && method === "POST") {
        allowRole(context, ["owner"]);
        const product = parseCatalogWrite(
          // Accommodate all bounded catalog fields even with multibyte names.
          await readJson(request, 65_536),
          () => `SMV-${randomUUID().replaceAll("-", "")}`,
        );
        await repo.saveDraft(storeId, product);
        return ok({ ok: true }, 201);
      }
      if (
        segments.length === 4 &&
        segments[1] === "products" &&
        segments[2] &&
        segments[3] === "publish" &&
        method === "POST"
      ) {
        allowRole(context, ["owner"]);
        await emptyBody(request);
        await repo.publish(z.string().uuid().parse(segments[2]));
        return ok({ ok: true });
      }
      if (
        segments.length === 4 &&
        segments[1] === "products" &&
        segments[2] &&
        segments[3] === "listing" &&
        method === "PATCH"
      ) {
        allowRole(context, ["owner", "manager"]);
        await repo.updateListing(
          storeId,
          z.string().uuid().parse(segments[2]),
          listingSchema.parse(await readJson(request)),
        );
        return ok({ ok: true });
      }
      if (route.startsWith("management/import") && method === "POST") {
        allowRole(context, ["owner"]);
        const { csv } = z
          .object({ csv: z.string().max(1048576) })
          .strict()
          .parse(await readJson(request, 1572864));
        const preview = parseCatalogCsv(csv);
        if (route === "management/import/preview") return ok(preview);
        if (route === "management/import") {
          if (!preview.valid)
            throw new AppError(
              422,
              "invalid_csv",
              "Fix the errors in the CSV preview before importing.",
            );
          await repo.importDrafts(storeId, preview.rows);
          return ok({ imported: preview.rows.length });
        }
      }
      if (route === "management/pairing-codes" && method === "POST") {
        allowRole(context, ["owner", "manager"]);
        const { label } = z
          .object({ label: z.string().trim().min(1).max(80) })
          .strict()
          .parse(await readJson(request));
        return ok(await repo.pairingCode(storeId, label));
      }
      if (
        segments.length === 3 &&
        segments[1] === "devices" &&
        segments[2] &&
        method === "DELETE"
      ) {
        allowRole(context, ["owner", "manager"]);
        if (request.body) await emptyBody(request);
        const id = z.string().uuid().parse(segments[2]);
        if (!(await repo.devices(storeId)).some((d) => d.id === id))
          throw new AppError(404, "device_not_found", "Device not found.");
        await repo.revokeDevice(id);
        return ok({ ok: true });
      }
    }
    if (segments[0] === "kiosk" && segments[1] === "sessions") {
      const context = (await device())!;
      rateLimit(`device:${context.deviceId}`, 40);
      const repo = await repository("device");
      if (segments.length === 2 && method === "POST") {
        await emptyBody(request);
        return ok(await repo.start(context), 201);
      }
      const id = z.string().uuid().parse(segments[2]);
      const completeResponse = await handleCompleteKiosk(
        request,
        segments,
        id,
        context,
        repo,
        activeAnalyses,
        ok,
      );
      if (completeResponse) return completeResponse;
      if (segments.length === 4 && segments[3] === "beauty" && method === "GET")
        return ok(await beautyConsultations(repo).read(id, context));
      if (
        segments.length === 4 &&
        segments[3] === "beauty-consent" &&
        method === "POST"
      ) {
        const body = z
          .object({
            accepted: z.boolean(),
            noticeVersion: z.literal(BEAUTY_PHOTO_NOTICE_VERSION),
          })
          .strict()
          .parse(await readJson(request, 1024));
        await beautyConsultations(repo).consent(
          id,
          context,
          body.accepted,
          body.noticeVersion,
        );
        return ok({ ok: true });
      }
      if (
        segments.length === 4 &&
        segments[3] === "beauty-preferences" &&
        method === "POST"
      )
        return ok(
          await beautyConsultations(repo).confirm(
            id,
            context,
            z
              .custom<BeautyPreferences>(validBeautyPreferences)
              .parse(await readJson(request, 1024)),
          ),
        );
      if (
        segments.length === 4 &&
        segments[3] === "beauty-exclusions" &&
        method === "POST"
      ) {
        const body = z
          .object({
            excludedIngredients: z.array(z.string().min(1).max(160)).max(20),
          })
          .strict()
          .parse(await readJson(request, 8192));
        return ok(
          await beautyConsultations(repo).exclusions(
            id,
            context,
            body.excludedIngredients,
          ),
        );
      }
      if (
        segments.length === 4 &&
        segments[3] === "beauty-share" &&
        method === "POST"
      ) {
        const body = z
          .object({
            accepted: z.literal(true),
            noticeVersion: z.literal(BEAUTY_SAVE_NOTICE_VERSION),
          })
          .strict()
          .parse(await readJson(request, 1024));
        const origin = beautyPublicOrigin();
        const token = newBeautyToken();
        const saved = await beautyConsultations(repo).save(
          id,
          context,
          beautyTokenHash(token),
          body.accepted,
          body.noticeVersion,
        );
        const link = `${origin}/result#${token}`;
        return ok(
          {
            url: link,
            expiresAt: saved.expiresAt,
            qrDataUrl: await QRCode.toDataURL(link, {
              errorCorrectionLevel: "M",
              width: 320,
              margin: 2,
            }),
          },
          201,
        );
      }
      if (
        segments.length === 4 &&
        segments[3] === "beauty-makeup-consent" &&
        method === "POST"
      ) {
        const body = z
          .object({
            accepted: z.boolean(),
            noticeVersion: z.literal(BEAUTY_MAKEUP_NOTICE_VERSION),
          })
          .strict()
          .parse(await readJson(request, 1024));
        await beautyConsultations(repo).makeupConsent(
          id,
          context,
          body.accepted,
          body.noticeVersion,
        );
        return ok({ ok: true });
      }
      if (
        segments.length === 4 &&
        segments[3] === "beauty-makeup" &&
        method === "POST"
      ) {
        rateLimit(`beauty-makeup:${context.deviceId}`, 3);
        if (activeAnalyses.has(context.deviceId) || activeAnalyses.size >= 4)
          throw new AppError(
            429,
            "analysis_busy",
            "A photo request is already in progress. Please wait a moment.",
          );
        activeAnalyses.add(context.deviceId);
        let image: Uint8Array | undefined;
        try {
          const state = await beautyConsultations(repo).read(id, context);
          if (
            !state.makeup?.available ||
            !state.makeup.consent ||
            state.makeup.attempted ||
            !state.preferences ||
            state.analysis?.prompt_version !== "beauty-style-suggestion-v2" ||
            state.analysis.image_quality !== "usable"
          )
            throw new AppError(
              409,
              "makeup_unavailable",
              "Accept the makeup-preview notice and confirm a usable photo suggestion first. Each session has one preview attempt.",
            );
          image = await readEphemeralImage(request);
          const result = await beautyConsultations(repo).makeup(
            id,
            context,
            image,
          );
          if (request.signal.aborted)
            throw new AppError(
              409,
              "makeup_cancelled",
              "The preview request has ended.",
            );
          return ok(result);
        } finally {
          image?.fill(0);
          activeAnalyses.delete(context.deviceId);
        }
      }
      if (
        segments.length === 4 &&
        segments[3] === "beauty-analysis" &&
        method === "POST"
      ) {
        rateLimit(`beauty-analysis:${context.deviceId}`, 6);
        if (activeAnalyses.has(context.deviceId) || activeAnalyses.size >= 4)
          throw new AppError(
            429,
            "analysis_busy",
            "Analysis is already in progress. Please wait a moment.",
          );
        activeAnalyses.add(context.deviceId);
        let image: Uint8Array | undefined;
        try {
          const state = await beautyConsultations(repo).read(id, context);
          if (!state.photoAvailable || !state.consent || state.attempted)
            throw new AppError(
              409,
              "beauty_photo_unavailable",
              "Accept the beauty-photo notice or choose your style yourself if this session already used its photo attempt.",
            );
          image = await readEphemeralImage(request);
          return ok(
            await beautyConsultations(repo).analyze(id, context, image),
          );
        } finally {
          image?.fill(0);
          activeAnalyses.delete(context.deviceId);
        }
      }
      if (segments.length === 4 && segments[3] === "color" && method === "GET")
        return ok(await personalColors(repo).read(id, context));
      if (
        segments.length === 4 &&
        segments[3] === "color-consent" &&
        method === "POST"
      ) {
        const body = z
          .object({
            accepted: z.boolean(),
            noticeVersion: z.literal(COLOR_PHOTO_NOTICE_VERSION),
          })
          .strict()
          .parse(await readJson(request, 1024));
        await personalColors(repo).consent(
          id,
          context,
          body.accepted,
          body.noticeVersion,
        );
        return ok({ ok: true });
      }
      if (
        segments.length === 4 &&
        segments[3] === "color-preferences" &&
        method === "POST"
      )
        return ok(
          await personalColors(repo).confirm(
            id,
            context,
            colorPreferencesSchema.parse(await readJson(request, 1024)),
          ),
        );
      if (
        segments.length === 4 &&
        segments[3] === "color-analysis" &&
        method === "POST"
      ) {
        rateLimit(`color-analysis:${context.deviceId}`, 6);
        if (activeAnalyses.has(context.deviceId) || activeAnalyses.size >= 4)
          throw new AppError(
            429,
            "analysis_busy",
            "Analysis is already in progress. Please wait a moment.",
          );
        activeAnalyses.add(context.deviceId);
        let image: Uint8Array | undefined;
        try {
          // Consent is checked before accepting an image body; the use case rechecks before claim.
          const state = await personalColors(repo).read(id, context);
          if (!state.photoAvailable || !state.consent || state.attempted)
            throw new AppError(
              409,
              "color_photo_unavailable",
              "Accept the color-photo notice, or choose a palette yourself if this session already used its photo attempt.",
            );
          image = await readEphemeralImage(request);
          return ok(await personalColors(repo).analyze(id, context, image));
        } finally {
          image?.fill(0);
          activeAnalyses.delete(context.deviceId);
        }
      }
      if (segments.length === 3 && method === "GET")
        return ok(await readSkinConsultation(repo, id, context));
      if (
        segments.length === 4 &&
        segments[3] === "consent" &&
        method === "POST"
      ) {
        const { accepted, explanationAccepted, visionAccepted } = z
          .object({
            accepted: z.boolean(),
            explanationAccepted: z.boolean().optional(),
            visionAccepted: z.boolean().optional().default(false),
          })
          .strict()
          .parse(await readJson(request));
        const providerMode = analysisMode();
        if (
          explanationAccepted &&
          (!accepted || providerMode === "openai" || !explanationAvailable())
        )
          throw new AppError(
            409,
            "explanation_unavailable",
            "AI explanations are not available. You can continue without them.",
          );
        if (visionAccepted && (!accepted || providerMode !== "openai"))
          throw new AppError(
            409,
            "vision_unavailable",
            "External photo analysis is not enabled for this kiosk.",
          );
        // Main privacy consent also supports photo-free discovery without an inference service.
        await repo.session(id, context);
        await repo.consent(
          id,
          context,
          accepted,
          providerMode === "experimental"
            ? "2026-10-experimental-v1"
            : providerMode === "openai"
              ? OPENAI_CONSENT_VERSION
              : "2026-10-mvp",
        );
        if (!accepted) await repo.finish(id, context);
        if (accepted && explanationAccepted !== undefined)
          await repo.explanationConsent(
            id,
            context,
            explanationAccepted,
            EXPLANATION_NOTICE_VERSION,
          );
        if (accepted && providerMode === "openai")
          await repo.visionConsent(
            id,
            context,
            visionAccepted,
            VISION_NOTICE_VERSION,
          );
        return ok({ ok: true });
      }
      if (
        segments.length === 4 &&
        segments[3] === "answers" &&
        method === "PUT"
      ) {
        await consultations(repo).answers(
          id,
          context,
          answersSchema.parse(await readJson(request)),
        );
        return ok({ ok: true });
      }
      if (
        segments.length === 4 &&
        segments[3] === "analysis" &&
        method === "POST"
      ) {
        const session = await repo.session(id, context);
        if (!session.consent || !session.answers)
          throw new AppError(
            409,
            "answers_required",
            "Complete consent and your preferences first.",
          );
        const providerMode = analysisMode();
        const noticeVersion =
          providerMode === "experimental"
            ? "2026-10-experimental-v1"
            : providerMode === "openai"
              ? OPENAI_CONSENT_VERSION
              : undefined;
        if (noticeVersion && session.consentVersion !== noticeVersion)
          throw new AppError(
            409,
            "consent_required",
            "Start a new session and accept the current privacy notice before analysis.",
          );
        rateLimit(`analysis:${context.deviceId}`, 6);
        if (activeAnalyses.has(context.deviceId) || activeAnalyses.size >= 4)
          throw new AppError(
            429,
            "analysis_busy",
            "Analysis is already in progress. Please wait a moment.",
          );
        activeAnalyses.add(context.deviceId);
        let image: Uint8Array | undefined;
        try {
          if (
            request.headers
              .get("content-type")
              ?.toLowerCase()
              .startsWith("image/")
          ) {
            if (providerMode !== "experimental" && providerMode !== "openai")
              throw new AppError(
                415,
                "photo_analysis_disabled",
                "Photo analysis is not enabled for this kiosk.",
              );
            if (
              providerMode === "openai" &&
              (session.visionConsent?.accepted !== true ||
                session.visionConsent.noticeVersion !== VISION_NOTICE_VERSION)
            )
              throw new AppError(
                409,
                "vision_consent_required",
                "Accept the separate photo-transfer notice before using AI photo analysis.",
              );
            image = await readEphemeralImage(request);
          } else await emptyBody(request);
          return ok(
            await consultations(repo).analyze(
              id,
              context,
              image,
              noticeVersion,
            ),
          );
        } finally {
          image?.fill(0);
          activeAnalyses.delete(context.deviceId);
        }
      }
      if (
        segments.length === 4 &&
        segments[3] === "explanation" &&
        method === "POST"
      ) {
        if (analysisMode() === "openai")
          throw new AppError(
            409,
            "explanation_disabled",
            "Your photo observations are ready without a separate AI explanation request.",
          );
        await emptyBody(request);
        rateLimit(`explanation:${context.deviceId}`, 6);
        if (
          activeExplanations.has(context.deviceId) ||
          activeExplanations.size >= 4
        )
          throw new AppError(
            429,
            "explanation_busy",
            "Recommendation notes are busy. Your product matches are ready.",
          );
        activeExplanations.add(context.deviceId);
        try {
          return ok(await consultations(repo).explain(id, context));
        } finally {
          activeExplanations.delete(context.deviceId);
        }
      }
      if (
        segments.length === 4 &&
        segments[3] === "finish" &&
        method === "POST"
      ) {
        await emptyBody(request);
        await repo.finish(id, context);
        return ok({ ok: true });
      }
    }
    throw new AppError(404, "not_found", "This endpoint does not exist.");
  } catch (error) {
    if (error instanceof CatalogInputError)
      return ok(
        {
          error: {
            code: error.code,
            message: error.message,
            fields: error.fields,
            requestId,
          },
        },
        error.status,
      );
    if (error instanceof AppError)
      return ok(
        { error: { code: error.code, message: error.message, requestId } },
        error.status,
      );
    if (error instanceof z.ZodError)
      return ok(
        {
          error: {
            code: "invalid_input",
            message: "Check the submitted fields and try again.",
            requestId,
          },
        },
        422,
      );
    return ok(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong. Please try again.",
          requestId,
        },
      },
      500,
    );
  }
}
