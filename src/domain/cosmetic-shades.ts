import { validateCatalogDraft } from "./catalog";
import { canonicalizeIngredients } from "./ingredients";
import {
  personalColorPalettes,
  type PaletteId,
  type ColorUndertone,
} from "./personal-color";
import type { Product } from "./types";

export const cosmeticCategories = [
  "lip_color",
  "blush",
  "eye_color",
  "foundation",
  "concealer",
] as const;
export type CosmeticCategory = (typeof cosmeticCategories)[number];
export const baseDepths = ["fair", "light", "medium", "tan", "deep"] as const;
export type BaseDepth = (typeof baseDepths)[number];
export interface BaseChoice {
  depth: BaseDepth | "unknown";
  undertone: ColorUndertone | "unknown";
  concealerPurpose: "match" | "brighten";
}
export const cosmeticFinishes = [
  "gloss",
  "satin",
  "matte",
  "shimmer",
  "natural",
  "radiant",
] as const;
export type CosmeticFinish = (typeof cosmeticFinishes)[number];
export const cosmeticHueFamilies = [
  "peach",
  "coral",
  "rose",
  "berry",
  "nude",
  "red",
  "mauve",
  "brown",
  "gold",
  "taupe",
  "silver",
  "plum",
  "neutral",
] as const;
export type CosmeticHueFamily = (typeof cosmeticHueFamilies)[number];
interface Common {
  category: CosmeticCategory;
  shadeName: string;
  undertone: ColorUndertone;
  finish: CosmeticFinish;
  swatchHex: string;
  reviewed: true;
}
export type CosmeticShadeDraft = Common &
  (
    | {
        category: "lip_color" | "blush" | "eye_color";
        hueFamily: CosmeticHueFamily;
        intensity: "soft" | "clear";
      }
    | {
        category: "foundation" | "concealer";
        depth: BaseDepth;
        coverage: "sheer" | "medium" | "full";
      }
  );
export type CosmeticShade = CosmeticShadeDraft & {
  organizationId: string;
  variantId: string;
  versionId: string;
  version: number;
};
export interface CosmeticMatch {
  product: Product;
  shade: CosmeticShade;
  reasonCodes: (
    | "palette_tone"
    | "palette_intensity"
    | "base_tone"
    | "base_depth"
    | "brightening_candidate"
  )[];
}
export function isCosmeticCategory(value: string): value is CosmeticCategory {
  return cosmeticCategories.includes(value as CosmeticCategory);
}
export function validBaseChoice(input: unknown): input is BaseChoice {
  const value = input as BaseChoice;
  return (
    !!value &&
    [...baseDepths, "unknown"].includes(value.depth) &&
    ["warm", "cool", "neutral", "unknown"].includes(value.undertone) &&
    ["match", "brighten"].includes(value.concealerPurpose)
  );
}
export function validCosmeticShadeDraft(
  input: unknown,
): input is CosmeticShadeDraft {
  const value = input as CosmeticShadeDraft;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = [
    "category",
    "shadeName",
    "undertone",
    "finish",
    "swatchHex",
    "reviewed",
    ...(["foundation", "concealer"].includes(value.category)
      ? ["depth", "coverage"]
      : ["hueFamily", "intensity"]),
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    return false;
  if (
    !value ||
    !isCosmeticCategory(value.category) ||
    value.reviewed !== true ||
    typeof value.shadeName !== "string" ||
    !value.shadeName.trim() ||
    value.shadeName.length > 80 ||
    /[<>\u0000-\u001f]/.test(value.shadeName) ||
    !["warm", "cool", "neutral"].includes(value.undertone) ||
    !cosmeticFinishes.includes(value.finish) ||
    !/^#[0-9a-f]{6}$/i.test(value.swatchHex)
  )
    return false;
  if ("depth" in value)
    return (
      ["foundation", "concealer"].includes(value.category) &&
      baseDepths.includes(value.depth) &&
      ["sheer", "medium", "full"].includes(value.coverage) &&
      ["matte", "satin", "natural", "radiant"].includes(value.finish)
    );
  return (
    "hueFamily" in value &&
    ["lip_color", "blush", "eye_color"].includes(value.category) &&
    cosmeticHueFamilies.includes(value.hueFamily) &&
    ["soft", "clear"].includes(value.intensity) &&
    (value.category !== "lip_color" ||
      (["gloss", "satin", "matte"].includes(value.finish) &&
        ["peach", "coral", "rose", "berry", "nude", "red", "mauve"].includes(
          value.hueFamily,
        )))
  );
}
export function validCosmeticShade(input: unknown): input is CosmeticShade {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const { organizationId, variantId, versionId, version, ...draft } =
    input as CosmeticShade;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return (
    [organizationId, variantId, versionId].every(
      (v) => typeof v === "string" && uuid.test(v),
    ) &&
    Number.isInteger(version) &&
    version > 0 &&
    validCosmeticShadeDraft(draft)
  );
}

/** Registered store shades only. Camera color is never treated as calibrated foundation matching. */
export function recommendCosmeticShades(
  products: readonly Product[],
  shades: readonly CosmeticShade[],
  preferences: { paletteId: PaletteId; finish: string; base: BaseChoice },
  scope: {
    organizationId: string;
    storeId: string;
    excludedIngredients: readonly string[];
  },
): CosmeticMatch[] {
  const palette = personalColorPalettes.find(
    (p) => p.id === preferences.paletteId,
  );
  const excluded = canonicalizeIngredients(scope.excludedIngredients);
  if (!palette || !validBaseChoice(preferences.base) || excluded.unknown.length)
    return [];
  const ranked: { match: CosmeticMatch; score: number }[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    if (
      seen.has(product.id) ||
      !isCosmeticCategory(product.category) ||
      product.organizationId !== scope.organizationId ||
      product.storeId !== scope.storeId ||
      product.status !== "published" ||
      !product.visible ||
      product.stock <= 0 ||
      !validateCatalogDraft(product).valid
    )
      continue;
    const formula = canonicalizeIngredients(product.ingredients);
    if (
      formula.unknown.length ||
      excluded.canonical.some((i) => formula.canonical.includes(i))
    )
      continue;
    const shade = shades.find(
      (s) =>
        s.variantId === product.id &&
        s.organizationId === scope.organizationId &&
        s.category === product.category,
    );
    if (!shade || !validCosmeticShade(shade)) continue;
    const reasonCodes: CosmeticMatch["reasonCodes"] = [];
    let score = 0;
    if ("depth" in shade) {
      const base = preferences.base;
      if (base.depth === "unknown" || base.undertone === "unknown") continue;
      const targetDepth =
        baseDepths.indexOf(base.depth) -
        (shade.category === "concealer" && base.concealerPurpose === "brighten"
          ? 1
          : 0);
      if (
        baseDepths.indexOf(shade.depth) !== Math.max(0, targetDepth) ||
        (shade.undertone !== base.undertone && shade.undertone !== "neutral")
      )
        continue;
      reasonCodes.push("base_depth", "base_tone");
      if (
        shade.category === "concealer" &&
        base.concealerPurpose === "brighten"
      )
        reasonCodes.push("brightening_candidate");
      score = shade.undertone === base.undertone ? 3 : 2;
    } else {
      if (
        palette.undertone !== "neutral" &&
        shade.undertone !== "neutral" &&
        shade.undertone !== palette.undertone
      )
        continue;
      const allowedHues =
        palette.undertone === "warm"
          ? [
              "peach",
              "coral",
              "nude",
              "red",
              "brown",
              "gold",
              "taupe",
              "neutral",
            ]
          : palette.undertone === "cool"
            ? [
                "rose",
                "berry",
                "mauve",
                "red",
                "nude",
                "brown",
                "taupe",
                "silver",
                "plum",
                "neutral",
              ]
            : [...cosmeticHueFamilies];
      if (!allowedHues.includes(shade.hueFamily)) continue;
      if (
        shade.category === "lip_color" &&
        preferences.finish !== "any" &&
        shade.finish !== preferences.finish
      )
        continue;
      reasonCodes.push("palette_tone");
      score = shade.undertone === palette.undertone ? 2 : 1;
      if (shade.intensity === palette.intensity) {
        reasonCodes.push("palette_intensity");
        score += 2;
      }
    }
    seen.add(product.id);
    ranked.push({ match: { product, shade, reasonCodes }, score });
  }
  const counts = new Map<CosmeticCategory, number>();
  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.match.product.sku.localeCompare(b.match.product.sku, "en-US"),
    )
    .filter(({ match }) => {
      const count = counts.get(match.shade.category) ?? 0;
      counts.set(match.shade.category, count + 1);
      return count < 3;
    })
    .map(({ match }) => match);
}
