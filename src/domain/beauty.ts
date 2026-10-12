import {
  lipFinishes,
  paletteIds,
  personalColorPalettes,
  type LipFinish,
  type PaletteId,
  type PersonalPalette,
} from "./personal-color";

export const BEAUTY_GUIDE_VERSION = "beauty-style-guide-v1" as const;
export const faceShapes = [
  "oval",
  "round",
  "square",
  "oblong",
  "heart",
  "diamond",
  "unsure",
] as const;
export const hairLengths = ["any", "short", "medium", "long"] as const;
export const beautyMoods = ["soft", "fresh", "defined"] as const;
export type BeautyFaceShape = (typeof faceShapes)[number];
export type BeautyHairLength = (typeof hairLengths)[number];
export type BeautyMood = (typeof beautyMoods)[number];
export interface BeautyPreferences {
  paletteId: PaletteId;
  faceShape: BeautyFaceShape;
  hairLength: BeautyHairLength;
  mood: BeautyMood;
  finish: "any" | LipFinish;
}
export interface BeautyStyleIdea {
  id: string;
  title: string;
  description: string;
}
export interface BeautyGuide {
  version: typeof BEAUTY_GUIDE_VERSION;
  palette: PersonalPalette;
  confirmedFaceShape: BeautyFaceShape;
  mood: BeautyMood;
  makeupMoods: BeautyStyleIdea[];
  hairCuts: BeautyStyleIdea[];
  hairColors: BeautyStyleIdea[];
  jewelry: BeautyStyleIdea[];
}

/** The guide accepts confirmed choices only; a photo suggestion never fills them in. */
export function validBeautyPreferences(
  value: unknown,
): value is BeautyPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 5 &&
    paletteIds.some((item) => item === row.paletteId) &&
    faceShapes.some((item) => item === row.faceShape) &&
    hairLengths.some((item) => item === row.hairLength) &&
    beautyMoods.some((item) => item === row.mood) &&
    (row.finish === "any" || lipFinishes.some((item) => item === row.finish))
  );
}

interface HairIdea extends BeautyStyleIdea {
  length: Exclude<BeautyHairLength, "any">;
}
const cuts: Record<BeautyFaceShape, readonly HairIdea[]> = {
  oval: [
    {
      id: "oval-short",
      length: "short",
      title: "Soft cropped shape",
      description:
        "Explore a cropped cut with soft texture, shaped around your preferred parting.",
    },
    {
      id: "oval-medium",
      length: "medium",
      title: "Collarbone layers",
      description:
        "Try light collarbone layers and choose where you want movement around the face.",
    },
    {
      id: "oval-long",
      length: "long",
      title: "Long flowing layers",
      description:
        "Explore longer layers with movement that follows your hair's natural texture.",
    },
  ],
  round: [
    {
      id: "round-short",
      length: "short",
      title: "Textured crop",
      description:
        "Try a textured crop with optional height at the crown if you enjoy a longer visual line.",
    },
    {
      id: "round-medium",
      length: "medium",
      title: "Angled long bob",
      description:
        "Explore a long bob with a slight angle and your preferred amount of cheek framing.",
    },
    {
      id: "round-long",
      length: "long",
      title: "Long face-framing layers",
      description:
        "Try longer framing pieces with movement below the chin, adjusting the line with a stylist.",
    },
  ],
  square: [
    {
      id: "square-short",
      length: "short",
      title: "Soft textured crop",
      description:
        "Explore a short textured cut with a soft side fringe if you like less defined edges.",
    },
    {
      id: "square-medium",
      length: "medium",
      title: "Wavy collarbone cut",
      description:
        "Try a collarbone cut with loose movement and choose how closely the ends frame the jaw.",
    },
    {
      id: "square-long",
      length: "long",
      title: "Long curved layers",
      description:
        "Explore rounded layers and a flexible parting for a softer framing effect.",
    },
  ],
  oblong: [
    {
      id: "oblong-short",
      length: "short",
      title: "Rounded textured bob",
      description:
        "Try a shorter rounded bob with optional fringe when you want more movement at the sides.",
    },
    {
      id: "oblong-medium",
      length: "medium",
      title: "Shoulder-length movement",
      description:
        "Explore shoulder-length waves with optional curtain fringe for a fuller framing effect.",
    },
    {
      id: "oblong-long",
      length: "long",
      title: "Long layers with side volume",
      description:
        "Try longer layers with movement around the cheeks and discuss fringe options with a stylist.",
    },
  ],
  heart: [
    {
      id: "heart-short",
      length: "short",
      title: "Chin-length textured bob",
      description:
        "Explore a textured bob with movement near the chin and your preferred parting.",
    },
    {
      id: "heart-medium",
      length: "medium",
      title: "Soft lob and fringe",
      description:
        "Try a soft long bob with optional side fringe and gently curved ends.",
    },
    {
      id: "heart-long",
      length: "long",
      title: "Long tapered framing",
      description:
        "Explore longer layers with movement below the cheekbones, adjusted to your hair texture.",
    },
  ],
  diamond: [
    {
      id: "diamond-short",
      length: "short",
      title: "Soft side-parted crop",
      description:
        "Try a short side-parted shape with light texture around the temples.",
    },
    {
      id: "diamond-medium",
      length: "medium",
      title: "Chin-to-shoulder bob",
      description:
        "Explore a bob with softly curved ends and choose the amount of cheekbone framing you enjoy.",
    },
    {
      id: "diamond-long",
      length: "long",
      title: "Long layers and curtain fringe",
      description:
        "Try long layers with an optional light curtain fringe, adapted with a stylist.",
    },
  ],
  unsure: [
    {
      id: "unsure-short",
      length: "short",
      title: "Adaptable textured crop",
      description:
        "Explore a short textured shape. A stylist can adjust its silhouette to your preferred framing.",
    },
    {
      id: "unsure-medium",
      length: "medium",
      title: "Versatile collarbone cut",
      description:
        "Try a collarbone cut with flexible parting and movement suited to your hair texture.",
    },
    {
      id: "unsure-long",
      length: "long",
      title: "Long movement layers",
      description:
        "Explore longer layers and choose where you would like more or less face framing.",
    },
  ],
};
const makeup: Record<BeautyMood, BeautyStyleIdea> = {
  soft: {
    id: "makeup-soft",
    title: "Softly blended",
    description:
      "Diffuse your chosen palette through a softly blended lip and a light wash of cheek color.",
  },
  fresh: {
    id: "makeup-fresh",
    title: "Fresh color",
    description:
      "Explore a sheer lip and a small, bright touch of cheek color from your chosen palette.",
  },
  defined: {
    id: "makeup-defined",
    title: "Quiet definition",
    description:
      "Try a more defined lip edge and focused eye detail, keeping your chosen palette as the color direction.",
  },
};
const colors: Record<PersonalPalette["undertone"], readonly BeautyStyleIdea[]> =
  {
    warm: [
      {
        id: "hair-warm-chestnut",
        title: "Warm chestnut",
        description:
          "Explore warm brown references with a colorist before deciding on an actual shade.",
      },
      {
        id: "hair-warm-caramel",
        title: "Soft caramel accents",
        description:
          "Compare caramel-toned accents in person. Your current hair and color history affect the result.",
      },
    ],
    cool: [
      {
        id: "hair-cool-brown",
        title: "Cool brown",
        description:
          "Explore cooler brown references and compare swatches with a colorist in neutral light.",
      },
      {
        id: "hair-cool-mushroom",
        title: "Mushroom-toned accents",
        description:
          "Compare muted cool accents in person. Your starting shade and hair history affect the result.",
      },
    ],
    neutral: [
      {
        id: "hair-neutral-brown",
        title: "Balanced brown",
        description:
          "Compare balanced brown references and choose the warm or cool nuances you prefer in person.",
      },
      {
        id: "hair-neutral-beige",
        title: "Beige-toned accents",
        description:
          "Explore balanced beige accents with a colorist, accounting for your current hair and color history.",
      },
    ],
  };
const metals: Record<PersonalPalette["undertone"], BeautyStyleIdea> = {
  warm: {
    id: "jewelry-warm-metal",
    title: "Golden accents",
    description:
      "Compare gold and warm-toned metal near the face as a companion to your chosen warm palette.",
  },
  cool: {
    id: "jewelry-cool-metal",
    title: "Silver-toned accents",
    description:
      "Compare silver and cool-toned metal near the face as a companion to your chosen cool palette.",
  },
  neutral: {
    id: "jewelry-neutral-metal",
    title: "Mixed-metal accents",
    description:
      "Compare silver, gold and mixed-metal pieces and keep the combination you enjoy most.",
  },
};

/** Fixed editorial ideas, never generated product stock, a diagnosis or a rule about attractiveness. */
export function buildBeautyGuide(
  preferences: BeautyPreferences,
): BeautyGuide | null {
  if (!validBeautyPreferences(preferences)) return null;
  const palette = personalColorPalettes.find(
    (item) => item.id === preferences.paletteId,
  )!;
  const finish =
    preferences.finish === "any"
      ? "Compare finishes in person."
      : `Explore your selected ${preferences.finish} lip finish.`;
  const intensity =
    palette.intensity === "soft"
      ? "Keep transitions softly blended."
      : "Compare a clearer focal accent.";
  return {
    version: BEAUTY_GUIDE_VERSION,
    palette: { ...palette, swatches: [...palette.swatches] },
    confirmedFaceShape: preferences.faceShape,
    mood: preferences.mood,
    makeupMoods: beautyMoods.map((mood) => ({
      ...makeup[mood],
      description: `${makeup[mood].description} ${finish} ${intensity}`,
    })),
    hairCuts: cuts[preferences.faceShape]
      .filter(
        (idea) =>
          preferences.hairLength === "any" ||
          idea.length === preferences.hairLength,
      )
      .map(({ id, title, description }) => ({ id, title, description })),
    hairColors: colors[palette.undertone].map((idea) => ({ ...idea })),
    jewelry: [
      { ...metals[palette.undertone] },
      {
        id: "jewelry-preferred-shape",
        title:
          preferences.mood === "defined"
            ? "Sculptural detail"
            : preferences.mood === "fresh"
              ? "Light-catching detail"
              : "Gentle curves",
        description:
          preferences.faceShape === "unsure"
            ? "Compare simple hoops, studs and longer shapes in a mirror. Keep the scale and silhouette you prefer."
            : `With your confirmed ${preferences.faceShape} direction, compare hoops, studs and longer shapes in a mirror. Choose the silhouette you enjoy; it does not need to correct your features.`,
      },
    ],
  };
}
