import { z } from "zod";
import {
  concerns,
  skinTypes,
  productCategories,
  catalogLimits,
} from "@/domain";
import { AppError } from "@/application/contracts";
import { optionalEnv, requiredEnv } from "@/infrastructure/config";
import {
  paletteIds,
  lipFinishes,
  lipHueFamilies,
} from "@/domain/personal-color";
export const colorPreferencesSchema = z
  .object({
    paletteId: z.enum(paletteIds),
    finish: z.enum(["any", ...lipFinishes]),
  })
  .strict();
export const lipShadeDraftSchema = z
  .object({
    shadeName: z.string().trim().min(1).max(80),
    hueFamily: z.enum(lipHueFamilies),
    undertone: z.enum(["warm", "cool", "neutral"]),
    intensity: z.enum(["soft", "clear"]),
    finish: z.enum(lipFinishes),
    swatchHex: z.string().regex(/^#[0-9a-f]{6}$/i),
    reviewed: z.literal(true),
  })
  .strict();
export const answersSchema = z
  .object({
    skinType: z.enum(skinTypes),
    concerns: z
      .array(z.enum(concerns))
      .min(1)
      .max(4)
      .refine((v) => new Set(v).size === v.length),
    excludedIngredients: z.array(z.string().trim().min(1).max(100)).max(20),
    sensitive: z.boolean(),
  })
  .strict();
export const catalogSchema = z
  .object({
    id: z.string().uuid().optional(),
    sku: z.string().trim().max(catalogLimits.skuMax).default(""),
    brand: z.string().trim().min(1).max(catalogLimits.brandMax),
    name: z.string().trim().min(1).max(catalogLimits.nameMax),
    category: z.enum(productCategories),
    priceMinor: z.number().int().min(0).max(catalogLimits.priceMinorMax),
    currency: z.literal("USD"),
    stock: z.number().int().min(0).max(catalogLimits.stockMax),
    visible: z.boolean(),
    ingredients: z
      .array(z.string().trim().min(1).max(catalogLimits.ingredientNameMax))
      .max(catalogLimits.ingredientCountMax),
    formulaComplete: z.boolean(),
    suitableSkinTypes: z.array(z.enum(skinTypes)).max(5),
  })
  .strict();
export const listingSchema = catalogSchema.pick({
  priceMinor: true,
  stock: true,
  visible: true,
});
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const configuredUrl =
    process.env.NODE_ENV === "production"
      ? requiredEnv("NEXT_PUBLIC_APP_URL")
      : optionalEnv("NEXT_PUBLIC_APP_URL");
  let expected: string;
  try {
    const url = new URL(configuredUrl || request.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid app origin");
    expected = url.origin;
  } catch {
    throw new AppError(
      503,
      "configuration_required",
      "Server application origin configuration is invalid.",
    );
  }
  if (origin === expected) return;
  if (process.env.NODE_ENV !== "production") {
    try {
      const configured = new URL(expected);
      const actual = new URL(request.url);
      const loopback = ["localhost", "127.0.0.1", "[::1]"];
      const fetchSite = request.headers.get("sec-fetch-site");
      if (
        loopback.includes(configured.hostname) &&
        loopback.includes(actual.hostname) &&
        actual.protocol === configured.protocol &&
        actual.port === configured.port &&
        !actual.username &&
        !actual.password &&
        origin === actual.origin &&
        (fetchSite === null || fetchSite === "same-origin")
      )
        return;
    } catch {
      // Malformed request URLs never expand the configured origin boundary.
    }
  }
  throw new AppError(
    403,
    "origin_rejected",
    "This request must come from the application.",
  );
}
export async function readJson(
  request: Request,
  maxBytes = 32768,
): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    throw new AppError(
      415,
      "json_required",
      "Send JSON with an application/json content type.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "body_required", "A request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError(413, "body_too_large", "This request is too large.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new AppError(
      400,
      "invalid_json",
      "The request contains invalid JSON.",
    );
  }
}

/** Read a bounded in-memory image; multipart would risk temporary file spooling. */
export async function readEphemeralImage(
  request: Request,
): Promise<Uint8Array> {
  const type = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!type || !["image/jpeg", "image/png", "image/webp"].includes(type))
    throw new AppError(
      415,
      "image_required",
      "Choose a JPEG, PNG or WebP photo.",
    );
  const max = 10 * 1024 * 1024;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new AppError(
      413,
      "body_too_large",
      "Choose a photo smaller than 10 MB.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "body_required", "Choose a photo first.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError(
          408,
          "upload_timeout",
          "Photo upload took too long. Please try again.",
        ),
      );
      void reader.cancel().catch(() => undefined);
    }, 10000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new AppError(
          413,
          "body_too_large",
          "Choose a photo smaller than 10 MB.",
        );
      }
      chunks.push(value);
    }
    if (!total || (declared && Number(declared) !== total))
      throw new AppError(
        400,
        "invalid_image",
        "The photo upload is incomplete. Please try again.",
      );
    const image = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      image.set(chunk, offset);
      offset += chunk.length;
    }
    return image;
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}
