import { validateCatalogDraft } from "./catalog";
import { canonicalizeIngredients } from "./ingredients";
import type { Product } from "./types";

export const paletteIds = [
  "warm_soft",
  "warm_clear",
  "cool_soft",
  "cool_clear",
  "neutral_soft",
  "neutral_clear",
] as const;
export type PaletteId = (typeof paletteIds)[number];
export const lipFinishes = ["gloss", "satin", "matte"] as const;
export type LipFinish = (typeof lipFinishes)[number];
export const lipHueFamilies = [
  "peach",
  "coral",
  "rose",
  "berry",
  "nude",
  "red",
  "mauve",
] as const;
export type LipHueFamily = (typeof lipHueFamilies)[number];
export type ColorUndertone = "warm" | "cool" | "neutral";
export type ColorIntensity = "soft" | "clear";
export interface PersonalPalette {
  id: PaletteId;
  name: string;
  undertone: ColorUndertone;
  intensity: ColorIntensity;
  description: string;
  swatches: readonly string[];
}

/** Style directions to compare and confirm, not seasonal or calibrated colour diagnoses. */
export const personalColorPalettes: readonly PersonalPalette[] = [
  {
    id: "warm_soft",
    name: "Soft warmth",
    undertone: "warm",
    intensity: "soft",
    description: "Muted peach, soft coral and warm nude shades.",
    swatches: ["#C98C79", "#C88174", "#B78A73", "#D5A18D"],
  },
  {
    id: "warm_clear",
    name: "Clear warmth",
    undertone: "warm",
    intensity: "clear",
    description: "Lively coral, warm red and bright peach shades.",
    swatches: ["#E47159", "#CD4F3C", "#E89976", "#BB563A"],
  },
  {
    id: "cool_soft",
    name: "Soft cool",
    undertone: "cool",
    intensity: "soft",
    description: "Muted rose, mauve and softly blended berry shades.",
    swatches: ["#B77D93", "#A1748F", "#A86A83", "#C699AA"],
  },
  {
    id: "cool_clear",
    name: "Clear cool",
    undertone: "cool",
    intensity: "clear",
    description: "Vivid rose, cool red and clear berry shades.",
    swatches: ["#C94B79", "#B92F50", "#9D3768", "#D85C91"],
  },
  {
    id: "neutral_soft",
    name: "Soft balance",
    undertone: "neutral",
    intensity: "soft",
    description: "Balanced rose and nude shades with a softer finish.",
    swatches: ["#B98788", "#BA8B7C", "#A87583", "#C99D93"],
  },
  {
    id: "neutral_clear",
    name: "Clear balance",
    undertone: "neutral",
    intensity: "clear",
    description: "Balanced red, rose and berry shades with more contrast.",
    swatches: ["#C95261", "#BC526D", "#AB4567", "#D97475"],
  },
];
export interface ColorPreferences {
  paletteId: PaletteId;
  finish: LipFinish | "any";
}
export interface LipShadeDraft {
  shadeName: string;
  hueFamily: LipHueFamily;
  undertone: ColorUndertone;
  intensity: ColorIntensity;
  finish: LipFinish;
  swatchHex: string;
  reviewed: true;
}
export interface LipShade extends LipShadeDraft {
  variantId: string;
  organizationId: string;
  versionId: string;
  version: number;
}
export interface ColorMatch {
  product: Product;
  shade: LipShade;
  reasons: string[];
}

export function validColorPreferences(value: ColorPreferences): boolean {
  return (
    paletteIds.includes(value.paletteId) &&
    (value.finish === "any" || lipFinishes.includes(value.finish))
  );
}
export function validLipShadeDraft(value: LipShadeDraft): boolean {
  return (
    value.reviewed === true &&
    typeof value.shadeName === "string" &&
    value.shadeName.trim().length > 0 &&
    value.shadeName.length <= 80 &&
    /^#[0-9a-f]{6}$/i.test(value.swatchHex) &&
    lipHueFamilies.includes(value.hueFamily) &&
    lipFinishes.includes(value.finish) &&
    ["warm", "cool", "neutral"].includes(value.undertone) &&
    ["soft", "clear"].includes(value.intensity)
  );
}

export function suggestedPalette(
  analysis: {
    image_quality: string;
    undertone: string;
    chroma: string;
  } | null,
): PaletteId | null {
  if (analysis?.image_quality !== "usable") return null;
  const id = `${analysis.undertone}_${analysis.chroma}`;
  return paletteIds.includes(id as PaletteId) ? (id as PaletteId) : null;
}

/** A separate cosmetics matcher; no skincare concern scores or AI-generated inventory. */
export function recommendLipShades(
  products: readonly Product[],
  shades: readonly LipShade[],
  preferences: ColorPreferences,
  scope: {
    organizationId: string;
    storeId: string;
    excludedIngredients: readonly string[];
  },
): ColorMatch[] {
  const palette = personalColorPalettes.find(
    (item) => item.id === preferences.paletteId,
  );
  if (
    !palette ||
    !validColorPreferences(preferences) ||
    !scope.organizationId ||
    !scope.storeId
  )
    return [];
  const exclusions = canonicalizeIngredients(scope.excludedIngredients);
  if (exclusions.unknown.length) return [];
  const seen = new Set<string>();
  const ranked: { match: ColorMatch; score: number }[] = [];
  for (const product of products) {
    if (
      seen.has(product.id) ||
      product.organizationId !== scope.organizationId ||
      product.storeId !== scope.storeId ||
      product.category !== "lip_color" ||
      product.status !== "published" ||
      !product.visible ||
      product.stock <= 0 ||
      !validateCatalogDraft(product).valid
    )
      continue;
    const formula = canonicalizeIngredients(product.ingredients);
    if (exclusions.canonical.some((name) => formula.canonical.includes(name)))
      continue;
    const shade = shades.find(
      (item) =>
        item.variantId === product.id &&
        item.organizationId === scope.organizationId,
    );
    if (
      !shade ||
      !validLipShadeDraft(shade) ||
      !Number.isInteger(shade.version) ||
      shade.version < 1 ||
      !shade.versionId
    )
      continue;
    if (preferences.finish !== "any" && shade.finish !== preferences.finish)
      continue;
    // Neutral metadata can accompany either direction; opposing warm/cool metadata cannot.
    if (
      palette.undertone !== "neutral" &&
      shade.undertone !== "neutral" &&
      shade.undertone !== palette.undertone
    )
      continue;
    seen.add(product.id);
    const tone = shade.undertone === palette.undertone;
    const intensity = shade.intensity === palette.intensity;
    ranked.push({
      score: (tone ? 2 : 1) + (intensity ? 2 : 0),
      match: {
        product,
        shade,
        reasons: [
          `You confirmed the ${palette.name.toLowerCase()} palette.`,
          `The store describes ${shade.shadeName} as ${shade.undertone}, ${shade.intensity} and ${shade.finish}.`,
          intensity
            ? "Its registered intensity follows your confirmed palette direction."
            : "This is an alternative intensity within your chosen color direction.",
        ],
      },
    });
  }
  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.match.product.sku.localeCompare(b.match.product.sku, "en-US"),
    )
    .slice(0, 3)
    .map(({ match }) => match);
}
