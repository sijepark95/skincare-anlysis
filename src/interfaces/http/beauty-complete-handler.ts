import { z } from "zod";
import type { DeviceContext, Repository } from "@/application/contracts";
import { AppError } from "@/application/contracts";
import type { BeautyRepository } from "@/application/beauty-consultations";
import { BeautyCompleteConsultations } from "@/application/beauty-complete";
import {
  guestAgeBands,
  COMPLETE_PHOTO_NOTICE_VERSION,
  COMPLETE_PREVIEW_NOTICE_VERSION,
  COMPLETE_SAVE_NOTICE_VERSION,
} from "@/application/beauty-complete-contracts";
import {
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import { baseDepths } from "@/domain/cosmetic-shades";
import {
  isStylingDirection,
  type StylingDirection,
} from "@/domain/beauty-styling";
import { skinTypes, concerns } from "@/domain/types";
import { analysisMode, appMode } from "@/infrastructure/config";
import {
  HttpBeautyCompleteProvider,
  HttpBeautyPreviewProvider,
} from "@/infrastructure/beauty-complete-provider";
import { makeSupabaseBeautyCompleteRepository } from "@/infrastructure/beauty-complete-repository";
import { demoBeautyCompleteRepository } from "@/infrastructure/demo-beauty-complete";
import {
  beautyPublicOrigin,
  beautyTokenHash,
  newBeautyToken,
} from "@/infrastructure/beauty-sharing";
import { readJson, readEphemeralImage } from "./validation";
import QRCode from "qrcode";

export async function completeRepository(kind: "staff" | "device" = "device") {
  return appMode() === "demo"
    ? demoBeautyCompleteRepository
    : makeSupabaseBeautyCompleteRepository(kind);
}
export async function completeConsultations(
  base: Repository & BeautyRepository,
) {
  const url = process.env.ANALYSIS_SERVICE_URL;
  const key = process.env.ANALYSIS_API_KEY?.trim();
  const enabled =
    analysisMode() === "openai" && !!url && !!key && key.length >= 32;
  return new BeautyCompleteConsultations(
    base,
    await completeRepository(),
    enabled ? new HttpBeautyCompleteProvider(url!, key!) : null,
    enabled && process.env.ANALYSIS_BEAUTY_PREVIEW_ENABLED === "true"
      ? new HttpBeautyPreviewProvider(url!, key!)
      : null,
    {
      sharingAvailable:
        appMode() === "supabase" && beautyPublicOrigin() !== null,
      teenPhotoEnabled: process.env.BEAUTY_TEEN_PHOTO_ENABLED === "true",
    },
  );
}

const contextSchema = z
  .object({
    ageBand: z.enum(guestAgeBands),
    locale: z.enum(["en", "ko", "es"]),
    analyticsConsent: z.boolean(),
  })
  .strict();
const choiceSchema = z
  .object({
    preferences: z.custom<BeautyPreferences>(validBeautyPreferences),
    baseDepth: z.enum([...baseDepths, "unknown"]).default("unknown"),
    baseUndertone: z
      .enum(["warm", "cool", "neutral", "unknown"])
      .default("unknown"),
    concealerPurpose: z.enum(["match", "brighten"]).default("match"),
  })
  .strict();
const skinSchema = z
  .object({
    skinType: z.enum(skinTypes),
    concerns: z.array(z.enum(concerns)).max(4),
    excludedIngredients: z.array(z.string().min(1).max(160)).max(20),
  })
  .strict();
const emptySchema = z.object({}).strict();
const completeActions = new Set([
  "beauty-complete",
  "beauty-context",
  "beauty-complete-consent",
  "beauty-complete-analysis",
  "beauty-complete-preferences",
  "beauty-complete-skin",
  "beauty-preview-consent",
  "beauty-preview",
  "beauty-preview-cancel",
  "beauty-complete-share",
  "beauty-complete-finish",
]);
function previewStylingDirection(request: Request): StylingDirection {
  const value = request.headers.get("X-Beauty-Styling-Direction") ?? "balanced";
  if (!isStylingDirection(value))
    throw new AppError(
      422,
      "invalid_styling_direction",
      "Choose a registered styling direction.",
    );
  return value;
}

/** Uses the same shared device admission lock as legacy photo requests. */
export async function handleCompleteKiosk(
  request: Request,
  segments: string[],
  id: string,
  device: DeviceContext,
  base: Repository & BeautyRepository,
  activeAnalyses: Set<string>,
  ok: (value: unknown, status?: number) => Response,
): Promise<Response | null> {
  const action = segments[3];
  if (!completeActions.has(action)) return null;
  const method = request.method.toUpperCase();
  const app = await completeConsultations(base);
  if (segments.length === 4 && action === "beauty-complete" && method === "GET")
    return ok(await app.read(id, device));
  if (method !== "POST") return null;
  if (segments.length === 4 && action === "beauty-context")
    return ok(
      await app.context(
        id,
        device,
        contextSchema.parse(await readJson(request, 2048)),
      ),
    );
  if (segments.length === 4 && action === "beauty-complete-consent") {
    const body = z
      .object({
        accepted: z.boolean(),
        noticeVersion: z.literal(COMPLETE_PHOTO_NOTICE_VERSION),
      })
      .strict()
      .parse(await readJson(request, 1024));
    return ok(await app.consent(id, device, body.accepted, body.noticeVersion));
  }
  if (segments.length === 4 && action === "beauty-complete-preferences") {
    const body = choiceSchema.parse(await readJson(request, 2048));
    return ok(
      await app.confirm(id, device, body.preferences, {
        depth: body.baseDepth,
        undertone: body.baseUndertone,
        concealerPurpose: body.concealerPurpose,
      }),
    );
  }
  if (segments.length === 4 && action === "beauty-complete-skin")
    return ok(
      await app.skin(
        id,
        device,
        skinSchema.parse(await readJson(request, 8192)),
      ),
    );
  if (segments.length === 4 && action === "beauty-preview-consent") {
    const body = z
      .object({
        accepted: z.boolean(),
        noticeVersion: z.literal(COMPLETE_PREVIEW_NOTICE_VERSION),
      })
      .strict()
      .parse(await readJson(request, 1024));
    return ok(
      await app.previewConsent(id, device, body.accepted, body.noticeVersion),
    );
  }
  if (segments.length === 4 && action === "beauty-preview-cancel") {
    emptySchema.parse(await readJson(request, 1024));
    await app.cancelPreview(id, device);
    return ok({ ok: true });
  }
  if (
    (segments.length === 4 && action === "beauty-complete-analysis") ||
    (segments.length === 5 && action === "beauty-preview")
  ) {
    if (activeAnalyses.has(device.deviceId) || activeAnalyses.size >= 4)
      throw new AppError(
        429,
        "analysis_busy",
        "A photo request is already in progress.",
      );
    const slot =
      action === "beauty-preview"
        ? z.coerce.number().int().min(0).max(8).parse(segments[4])
        : null;
    const stylingDirection =
      slot === null ? "balanced" : previewStylingDirection(request);
    activeAnalyses.add(device.deviceId);
    let image: Uint8Array | undefined;
    try {
      image = await readEphemeralImage(request);
      if (request.signal.aborted)
        throw new AppError(
          409,
          "request_cancelled",
          "The photo request has ended.",
        );
      const result =
        slot === null
          ? await app.analyze(id, device, image)
          : await app.preview(id, device, slot, image, stylingDirection);
      if (request.signal.aborted)
        throw new AppError(
          409,
          "request_cancelled",
          "The photo request has ended.",
        );
      return ok(result);
    } finally {
      image?.fill(0);
      activeAnalyses.delete(device.deviceId);
    }
  }
  if (segments.length === 4 && action === "beauty-complete-share") {
    const body = z
      .object({
        accepted: z.literal(true),
        noticeVersion: z.literal(COMPLETE_SAVE_NOTICE_VERSION),
      })
      .strict()
      .parse(await readJson(request, 1024));
    const origin = beautyPublicOrigin();
    if (!origin)
      throw new AppError(
        409,
        "sharing_unavailable",
        "Phone sharing needs a public HTTPS address. Download your guide here.",
      );
    const token = newBeautyToken();
    const saved = await app.save(
      id,
      device,
      beautyTokenHash(token),
      body.noticeVersion,
    );
    const url = `${origin}/result#${token}`;
    return ok(
      {
        url,
        expiresAt: saved.expiresAt,
        qrDataUrl: await QRCode.toDataURL(url, {
          errorCorrectionLevel: "M",
          width: 320,
          margin: 2,
        }),
      },
      201,
    );
  }
  if (segments.length === 4 && action === "beauty-complete-finish") {
    const body = z
      .object({
        gender: z
          .enum([
            "woman",
            "man",
            "nonbinary",
            "self_described",
            "prefer_not_to_say",
          ])
          .nullable()
          .default(null),
      })
      .strict()
      .parse(await readJson(request, 1024));
    await app.finish(id, device, body.gender);
    return ok({ ok: true });
  }
  return null;
}
