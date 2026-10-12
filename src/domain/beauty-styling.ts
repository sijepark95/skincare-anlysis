/** Session-only editorial direction. It describes styling, never a person's identity. */
export const stylingDirections = ["balanced", "masculine", "feminine"] as const;
export type StylingDirection = (typeof stylingDirections)[number];

export function isStylingDirection(value: unknown): value is StylingDirection {
  return stylingDirections.some((direction) => direction === value);
}

/** Only an explicit choice supplies a default; absent/declined/other choices stay open. */
export function stylingDirectionForGender(
  gender: string | null | undefined,
): StylingDirection {
  if (gender === "man") return "masculine";
  if (gender === "woman") return "feminine";
  return "balanced";
}

export type StylingPreviewKind = "makeup" | "hair_style" | "hair_color";
export type StylingPreviewId =
  | "soft"
  | "fresh"
  | "defined"
  | "hairShort"
  | "hairMedium"
  | "hairLong"
  | "colorSoft"
  | "colorLight"
  | "colorDeep"
  | "makeup-natural"
  | "makeup-groomed"
  | "makeup-definition"
  | "hair-textured-crop"
  | "hair-curtain-part"
  | "hair-soft-quiff";

/** Stable presentation IDs match the three independent edit prompts, not inferred traits. */
export function stylingPreviewIds(
  kind: StylingPreviewKind,
  direction: StylingDirection = "balanced",
): readonly [StylingPreviewId, StylingPreviewId, StylingPreviewId] {
  if (kind === "hair_color") return ["colorSoft", "colorLight", "colorDeep"];
  if (direction === "masculine") {
    return kind === "makeup"
      ? ["makeup-natural", "makeup-groomed", "makeup-definition"]
      : ["hair-textured-crop", "hair-curtain-part", "hair-soft-quiff"];
  }
  return kind === "makeup"
    ? ["soft", "fresh", "defined"]
    : ["hairShort", "hairMedium", "hairLong"];
}
