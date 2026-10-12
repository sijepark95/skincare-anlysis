import { buildBeautyGuide, type BeautyPreferences } from "@/domain/beauty";
import type { BeautyLocale } from "@/application/beauty-complete-contracts";
import { bt, beautyLabel } from "./beauty-i18n";
import {
  stylingPreviewIds,
  type StylingDirection,
} from "@/domain/beauty-styling";

/** Translate only fixed editorial IDs, never generate or change the confirmed recommendation. */
export function localizedBeautyIdeas(
  preferences: BeautyPreferences,
  locale: BeautyLocale,
  stylingDirection: StylingDirection = "balanced",
) {
  const guide = buildBeautyGuide(preferences);
  if (!guide) return null;
  return {
    makeup:
      stylingDirection === "masculine"
        ? stylingPreviewIds("makeup", stylingDirection).map((id, index) => ({
            id,
            title: beautyLabel(locale, id),
            description: bt(
              locale,
              (
                [
                  "guideNaturalBody",
                  "guideGroomedBody",
                  "guideDefinitionBody",
                ] as const
              )[index],
            ),
          }))
        : guide.makeupMoods.map((item) => ({
            id: item.id,
            title: beautyLabel(locale, item.id.replace("makeup-", "")),
            description: bt(
              locale,
              item.id === "makeup-soft"
                ? "guideSoftBody"
                : item.id === "makeup-fresh"
                  ? "guideFreshBody"
                  : "guideDefinedBody",
            ),
          })),
    hair:
      stylingDirection === "masculine"
        ? stylingPreviewIds("hair_style", stylingDirection).map(
            (id, index) => ({
              id,
              title: beautyLabel(locale, id),
              description: bt(
                locale,
                (
                  [
                    "guideCropBody",
                    "guideCurtainBody",
                    "guideQuiffBody",
                  ] as const
                )[index],
              ),
            }),
          )
        : guide.hairCuts.map((item) => ({
            id: item.id,
            title: beautyLabel(locale, item.id),
            description: bt(
              locale,
              item.id.endsWith("-short")
                ? "guideShortBody"
                : item.id.endsWith("-medium")
                  ? "guideMediumBody"
                  : "guideLongBody",
            ),
          })),
    color: [
      ...guide.hairColors.map((item) => ({
        id: item.id,
        title: beautyLabel(locale, item.id),
        description: bt(locale, "guideColorBody"),
      })),
      {
        id: `hair-${guide.palette.undertone}-depth`,
        title: bt(locale, "colorDeep"),
        description: bt(locale, "guideColorBody"),
      },
    ],
  };
}
