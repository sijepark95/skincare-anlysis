"use client";

import { Download, Sparkles } from "lucide-react";
import type { CompleteBeautyView } from "@/application/beauty-complete";
import type {
  BeautyLocale,
  CompleteSavedGuide,
} from "@/application/beauty-complete-contracts";
import type { FaceRatios } from "@/domain/face-ratios";
import type { BeautyCompleteAnalysis } from "@/domain/beauty-complete";
import { personalColorPalettes } from "@/domain/personal-color";
import type { OwnBeautyPreview } from "./use-beauty-previews";
import { HairPhoto } from "./beauty-book";
import { bt, beautyLabel } from "./beauty-i18n";
import { localizedBeautyIdeas } from "./beauty-style-copy";
import { ReferenceFaceStudy } from "./reference-face-study";
import { ReferenceColorStudy } from "./reference-color-study";
import {
  stylingPreviewIds,
  type StylingDirection,
} from "@/domain/beauty-styling";

export function CompleteBeautyBook({
  value,
  analysis,
  portrait,
  ratios,
  locale,
  slots,
  previewAccepted,
  generating,
  onCancel,
  onEditSkin,
  stylingDirection = "balanced",
}: {
  value: CompleteBeautyView;
  analysis: BeautyCompleteAnalysis | null;
  portrait: string;
  ratios: FaceRatios | null;
  locale: BeautyLocale;
  slots: OwnBeautyPreview[];
  previewAccepted: boolean;
  generating: boolean;
  onCancel: () => void;
  onEditSkin: () => void;
  stylingDirection?: StylingDirection;
}) {
  const text = (key: Parameters<typeof bt>[1]) => bt(locale, key);
  const label = (id: string) => beautyLabel(locale, id);
  const preferences = value.beauty.preferences;
  const stylingIdeas = preferences
    ? localizedBeautyIdeas(preferences, locale, stylingDirection)
    : null;
  const palette = personalColorPalettes.find(
    (item) => item.id === preferences?.paletteId,
  );
  const features = [
    "visible_redness",
    "visible_spots",
    "visible_pores",
    "visible_fine_lines",
    "visible_flaking",
  ] as const;
  function previewSection(
    kind: OwnBeautyPreview["kind"],
    title: "makeupTitle" | "hairTitle" | "hairColorTitle",
  ) {
    const names = stylingPreviewIds(kind, stylingDirection);
    const descriptions =
      kind === "makeup"
        ? stylingDirection === "masculine"
          ? ([
              "guideNaturalBody",
              "guideGroomedBody",
              "guideDefinitionBody",
            ] as const)
          : (["guideSoftBody", "guideFreshBody", "guideDefinedBody"] as const)
        : kind === "hair_style"
          ? stylingDirection === "masculine"
            ? (["guideCropBody", "guideCurtainBody", "guideQuiffBody"] as const)
            : (["guideShortBody", "guideMediumBody", "guideLongBody"] as const)
          : ([
              "previewColorSoftBody",
              "previewColorLightBody",
              "previewColorDeepBody",
            ] as const);
    return (
      <section
        className={`complete-section reference-stylebook reference-stylebook-${kind}`}
        aria-label={text(title)}
      >
        <div className="complete-section-heading">
          <span className="complete-number">
            {kind === "makeup" ? "03" : kind === "hair_style" ? "04" : "05"}
          </span>
          <div>
            <h2>
              <span className="complete-heading-emoji" aria-hidden="true">
                {kind === "makeup" ? "💄" : kind === "hair_style" ? "✂️" : "🎨"}
              </span>
              {text(title)}
            </h2>
            <p>
              {text(
                kind === "makeup"
                  ? "makeupBookBody"
                  : kind === "hair_style"
                    ? "hairBookBody"
                    : "hairColorBookBody",
              )}
            </p>
          </div>
        </div>
        <div className="complete-three">
          {slots
            .filter((item) => item.kind === kind)
            .map((item) => (
              <article
                className="complete-look"
                key={item.slot}
                data-preview-id={names[item.index]}
              >
                <div className="complete-look-image">
                  <span className="reference-look-number" aria-hidden="true">
                    0{item.index + 1}
                  </span>
                  {item.url ? (
                    <>
                      {/* Session blob URLs bypass image optimizers to keep portraits private. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.url}
                        alt={`${label(names[item.index])} · ${text("generated")}`}
                      />
                      <span className="complete-image-tag">
                        {text("generated")}
                      </span>
                    </>
                  ) : (
                    <div className="complete-image-empty">
                      <Sparkles size={30} />
                      <span className="complete-tiny-face" aria-hidden="true">
                        ( •ᴗ• )
                      </span>
                      <strong>
                        {previewAccepted &&
                        analysis?.beauty.image_quality === "usable" &&
                        value.preview.available
                          ? text(item.status)
                          : text("noPreview")}
                      </strong>
                      <span>{text("ownPhoto")}</span>
                    </div>
                  )}
                </div>
                <div className="complete-look-caption">
                  <h3>{label(names[item.index])}</h3>
                  <p>{text(descriptions[item.index])}</p>
                  {kind === "hair_color" && palette && (
                    <div
                      className="reference-look-swatches"
                      role="group"
                      aria-label={text("paletteColors")}
                    >
                      {palette.swatches.map((hex) => (
                        <span
                          key={hex}
                          style={{ backgroundColor: hex }}
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                  )}
                  {item.url && (
                    <a
                      href={item.url}
                      download={`aelune-${kind}-${item.index + 1}.jpg`}
                      className="text-button"
                    >
                      <Download size={18} />
                      {text("downloadPreview")}
                    </a>
                  )}
                </div>
              </article>
            ))}
        </div>
        <p className="reference-stylebook-note">{text("generatedNotice")}</p>
        {kind === "makeup" && (
          <>
            <h3 className="complete-subheading">{text("cosmeticsTitle")}</h3>
            <p>{text("catalogNotice")}</p>
            <div className="complete-products">
              {["lip_color", "blush", "eye_color"]
                .flatMap((category) =>
                  value.cosmetics
                    .filter((item) => item.shade.category === category)
                    .slice(0, 3),
                )
                .map((item) => (
                  <article
                    className="complete-product"
                    key={`${item.product.id}-${item.shade.versionId}`}
                  >
                    <span
                      className="complete-swatch"
                      style={{ backgroundColor: item.shade.swatchHex }}
                      aria-hidden="true"
                    />
                    <div>
                      <span>{label(item.shade.category)}</span>
                      <h3>{item.product.name}</h3>
                      <p>
                        {item.product.brand} · {item.shade.shadeName}
                      </p>
                    </div>
                  </article>
                ))}
            </div>
            {!value.cosmetics.some((item) =>
              ["lip_color", "blush", "eye_color"].includes(item.shade.category),
            ) && <p className="complete-empty">{text("noProducts")}</p>}
          </>
        )}
      </section>
    );
  }
  return (
    <div className="complete-book">
      <div className="complete-report-title">
        <div className="complete-report-copy">
          <span className="beauty-eyebrow">{text("studio")}</span>
          <h1 tabIndex={-1}>{text("reportTitle")}</h1>
        </div>
        <span className="complete-report-sticker" aria-hidden="true">
          ✧ (｡•̀ᴗ-)✧
        </span>
      </div>
      <div className="complete-style-direction" data-testid="styling-direction">
        <span aria-hidden="true">✨</span>
        <div>
          <span>{text("stylingDirection")}</span>
          <strong>
            {text(
              stylingDirection === "masculine"
                ? "stylingMasculine"
                : stylingDirection === "feminine"
                  ? "stylingFeminine"
                  : "stylingBalanced",
            )}
          </strong>
        </div>
        <p>{text("stylingNotice")}</p>
      </div>
      <section
        className="complete-section complete-skin"
        aria-label={text("skinTitle")}
      >
        <div className="complete-section-heading">
          <span className="complete-number">01</span>
          <div>
            <h2>
              <span className="complete-heading-emoji" aria-hidden="true">
                🫧
              </span>
              {text("skinTitle")}
            </h2>
            <p>{text("skinNotice")}</p>
          </div>
          <button className="text-button" onClick={onEditSkin}>
            {text("skinOptions")}
          </button>
        </div>
        <div className="complete-observations">
          {features.map((feature) => (
            <article key={feature}>
              <span>{text(feature)}</span>
              <strong>
                {label(
                  analysis?.skin.observed_features[feature] ?? "not_assessable",
                )}
              </strong>
            </article>
          ))}
        </div>
        <div className="complete-skin-columns">
          <div>
            <h3>{text("ingredients")}</h3>
            <div className="complete-ingredients">
              {value.skinReport?.ingredients.map((item) => (
                <span key={item.ingredient}>
                  {item.ingredient}
                  <small>{item.goals.map(label).join(" · ")}</small>
                </span>
              ))}
            </div>
            {!value.skinReport?.ingredients.length && (
              <p>{text("noIngredients")}</p>
            )}
          </div>
          <div>
            <h3>{text("products")}</h3>
            <div className="complete-products">
              {value.skinRecommendations.slice(0, 3).map((item, index) => (
                <article className="complete-product" key={item.product.id}>
                  <span className="complete-product-number">0{index + 1}</span>
                  <div>
                    <span>{item.product.brand}</span>
                    <h3>{item.product.name}</h3>
                    <p>{item.matchedIngredients.join(" · ")}</p>
                  </div>
                </article>
              ))}
            </div>
            {!value.skinRecommendations.length && (
              <p className="complete-empty">{text("noProducts")}</p>
            )}
          </div>
        </div>
        <p className="complete-fineprint">{text("presenceOnly")}</p>
      </section>
      <section className="complete-section" aria-label={text("faceTitle")}>
        <div className="complete-section-heading">
          <span className="complete-number">02</span>
          <div>
            <h2>
              <span className="complete-heading-emoji" aria-hidden="true">
                👀
              </span>
              {text("faceTitle")}
            </h2>
            <p>{text("styleNotice")}</p>
          </div>
        </div>
        <ReferenceFaceStudy
          analysis={analysis}
          portrait={portrait}
          ratios={ratios}
          faceShape={preferences?.faceShape}
          locale={locale}
        />
        <ReferenceColorStudy
          palette={palette}
          base={value.base}
          locale={locale}
        />
        <h3 className="complete-subheading">{text("baseTitle")}</h3>
        <p>{text("baseNotice")}</p>
        <div className="complete-products">
          {["foundation", "concealer"]
            .flatMap((category) =>
              value.cosmetics
                .filter((item) => item.shade.category === category)
                .slice(0, 3),
            )
            .map((item) => (
              <article
                className="complete-product"
                key={`${item.product.id}-${item.shade.versionId}`}
              >
                <span
                  className="complete-swatch"
                  style={{ backgroundColor: item.shade.swatchHex }}
                  aria-hidden="true"
                />
                <div>
                  <span>
                    {label(
                      item.shade.category === "concealer"
                        ? "categoryConcealer"
                        : item.shade.category,
                    )}
                  </span>
                  <h3>{item.product.name}</h3>
                  <p>{item.shade.shadeName}</p>
                </div>
              </article>
            ))}
        </div>
        {!value.cosmetics.some((item) =>
          ["foundation", "concealer"].includes(item.shade.category),
        ) && <p className="complete-empty">{text("noProducts")}</p>}
      </section>
      {previewSection("makeup", "makeupTitle")}
      {previewSection("hair_style", "hairTitle")}
      {previewSection("hair_color", "hairColorTitle")}
      {!previewAccepted && (
        <section className="complete-section">
          <h2>{text("reference")}</h2>
          <p>{text("noPreview")}</p>
          <div className="complete-three">
            {stylingDirection === "masculine"
              ? stylingIdeas?.hair.map((item) => (
                  <article className="complete-style-note" key={item.id}>
                    <span aria-hidden="true">✂️</span>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </article>
                ))
              : [0, 3, 4].map((index, i) => (
                  <article className="complete-look" key={index}>
                    <HairPhoto
                      index={index}
                      label={`${text("reference")} · ${label(["short", "medium", "long"][i])}`}
                    />
                    <h3>{label(["hairShort", "hairMedium", "hairLong"][i])}</h3>
                  </article>
                ))}
          </div>
        </section>
      )}
      {(previewAccepted || generating) && (
        <div
          className={`complete-generation${generating ? " is-active" : ""}`}
          role="status"
        >
          <Sparkles size={20} />
          <div>
            <strong>
              {bt(locale, "generationCount", {
                done: slots.filter((item) => item.status === "complete").length,
                failed: slots.filter((item) =>
                  ["failed", "cancelled"].includes(item.status),
                ).length,
                pending: slots.filter((item) =>
                  ["pending", "running"].includes(item.status),
                ).length,
              })}
            </strong>
            <span>{text("generationNotice")}</span>
          </div>
          {generating && (
            <button className="text-button" onClick={onCancel}>
              {text("cancelGeneration")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CompleteSavedGuideView({
  saved,
  locale,
}: {
  saved: CompleteSavedGuide;
  locale: BeautyLocale;
}) {
  const palette = personalColorPalettes.find(
    (item) => item.id === saved.preferences.paletteId,
  );
  const ideas = localizedBeautyIdeas(saved.preferences, locale);
  return (
    <div className="complete-book">
      <section className="complete-section">
        <h1>{bt(locale, "reportTitle")}</h1>
        <p>{bt(locale, "downloadNotice")}</p>
        <div className="complete-palette">
          <div>
            <span>{bt(locale, "palette")}</span>
            <h2>{beautyLabel(locale, saved.preferences.paletteId)}</h2>
            <p>
              {bt(locale, "faceShape")}:{" "}
              {beautyLabel(locale, saved.preferences.faceShape)}
            </p>
          </div>
          <div className="complete-palette-swatches">
            {palette?.swatches.map((hex) => (
              <span
                key={hex}
                style={{ backgroundColor: hex }}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>
        <div className="complete-products">
          {saved.products.map((item) => (
            <article className="complete-product" key={item.variantId}>
              {item.swatchHex && (
                <span
                  className="complete-swatch"
                  style={{ backgroundColor: item.swatchHex }}
                  aria-hidden="true"
                />
              )}
              <div>
                <span>{item.brand}</span>
                <h3>{item.name}</h3>
                <p>
                  {item.shadeName}{" "}
                  {!item.available && `· ${bt(locale, "unavailable")}`}
                </p>
              </div>
            </article>
          ))}
        </div>
        {!saved.products.length && <p>{bt(locale, "noProducts")}</p>}
        {ideas &&
          (
            [
              { title: "makeupTitle", items: ideas.makeup },
              { title: "hairTitle", items: ideas.hair },
              { title: "hairColorTitle", items: ideas.color },
            ] as const
          ).map((group) => (
            <section key={group.title}>
              <h2>{bt(locale, group.title)}</h2>
              <p>{bt(locale, "reference")}</p>
              <div className="complete-three">
                {group.items.map((item) => (
                  <article className="complete-look" key={item.id}>
                    {group.title === "hairTitle" && (
                      <HairPhoto
                        index={
                          item.id.endsWith("-short")
                            ? 0
                            : item.id.endsWith("-medium")
                              ? 3
                              : 4
                        }
                        label={bt(locale, "reference")}
                      />
                    )}
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </article>
                ))}
              </div>
            </section>
          ))}
        <p>
          {bt(locale, "expires", {
            date: new Date(saved.expiresAt).toLocaleDateString(locale),
          })}
        </p>
      </section>
    </div>
  );
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
/** Explicit export allowlist: no observation, demographic, image, capability or session data. */
export function renderCompleteGuideHtml(
  saved: CompleteSavedGuide,
  locale: BeautyLocale,
  stylingDirection: StylingDirection = "balanced",
) {
  const title = bt(locale, "reportTitle");
  const ideas = localizedBeautyIdeas(
    saved.preferences,
    locale,
    stylingDirection,
  );
  const sections = ideas
    ? (
        [
          { title: "makeupTitle", items: ideas.makeup },
          { title: "hairTitle", items: ideas.hair },
          { title: "hairColorTitle", items: ideas.color },
        ] as const
      )
        .map(
          (group) =>
            `<section><h2>${escape(bt(locale, group.title))}</h2>${group.items.map((item) => `<article><h3>${escape(item.title)}</h3><p>${escape(item.description)}</p></article>`).join("")}</section>`,
        )
        .join("")
    : "";
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:17px/1.6 Arial,sans-serif;color:#172036;max-width:760px;padding:32px;margin:auto}article{border-bottom:1px solid #dce2ef;padding:16px 0}h1{font-size:34px}small{color:#606a7d}@media print{body{padding:0}}</style><h1>${escape(title)}</h1><p>${escape(bt(locale, "downloadNotice"))}</p><h2>${escape(beautyLabel(locale, saved.preferences.paletteId))}</h2><p>${escape(bt(locale, "faceShape"))}: ${escape(beautyLabel(locale, saved.preferences.faceShape))}</p><h2>${escape(bt(locale, "products"))}</h2>${saved.products.map((item) => `<article><small>${escape(item.brand)}</small><h3>${escape(item.name)}</h3><p>${escape(item.shadeName ?? "")} ${!item.available ? escape(bt(locale, "unavailable")) : ""}</p></article>`).join("")}${sections}</html>`;
}
export function downloadCompleteGuide(
  saved: CompleteSavedGuide,
  locale: BeautyLocale,
  stylingDirection: StylingDirection = "balanced",
) {
  const html = renderCompleteGuideHtml(saved, locale, stylingDirection);
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aelune-beauty-guide-${locale}.html`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
