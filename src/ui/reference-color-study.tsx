import { Check, Palette } from "lucide-react";
import type { BeautyLocale } from "@/application/beauty-complete-contracts";
import type { BaseChoice } from "@/domain/cosmetic-shades";
import type { PersonalPalette } from "@/domain/personal-color";
import { bt, beautyLabel } from "./beauty-i18n";

/** Confirmed choices and fixed style swatches, never sampled or calibrated facial colors. */
export function ReferenceColorStudy({
  palette,
  base,
  locale,
}: {
  palette: PersonalPalette | undefined;
  base: BaseChoice;
  locale: BeautyLocale;
}) {
  const text = (key: Parameters<typeof bt>[1]) => bt(locale, key);
  const label = (id: string) => beautyLabel(locale, id);
  return (
    <section
      className="reference-color-study"
      aria-label={text("colorStudyTitle")}
    >
      <div className="reference-color-heading">
        <div>
          <span className="beauty-eyebrow">{text("palette")}</span>
          <h3>
            <span aria-hidden="true">🎨</span>
            {text("colorStudyTitle")}
          </h3>
          <p>{text("colorStudyBody")}</p>
        </div>
        <span className="reference-confirmed">
          <Check size={15} aria-hidden="true" />
          {text("confirmed")}
        </span>
      </div>
      <div className="reference-color-cards">
        <article className="reference-color-palette" data-color-card="palette">
          <span className="reference-card-label">{text("palette")}</span>
          <h4>{palette ? label(palette.id) : text("unknown")}</h4>
          {palette && (
            <div
              className="reference-color-swatches"
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
          <p>
            {palette
              ? `${text("paletteUndertone")} · ${label(palette.undertone)}`
              : text("paletteChoiceNotice")}
          </p>
        </article>
        <article data-color-card="undertone">
          <span className="reference-color-symbol" aria-hidden="true">
            ◐
          </span>
          <span className="reference-card-label">{text("baseUndertone")}</span>
          <h4>{label(base.undertone)}</h4>
          <p>{text("baseChoiceNotice")}</p>
        </article>
        <article data-color-card="depth">
          <span className="reference-color-symbol" aria-hidden="true">
            ◒
          </span>
          <span className="reference-card-label">{text("baseDepthLabel")}</span>
          <h4>
            {base.depth === "medium" ? text("mediumDepth") : label(base.depth)}
          </h4>
          <p>{text("baseChoiceNotice")}</p>
        </article>
        <article data-color-card="chroma">
          <span className="reference-color-symbol" aria-hidden="true">
            <Palette size={24} />
          </span>
          <span className="reference-card-label">
            {text("paletteIntensity")}
          </span>
          <h4>
            {palette
              ? text(
                  palette.intensity === "soft" ? "paletteSoft" : "paletteClear",
                )
              : text("unknown")}
          </h4>
          <p>{text("paletteChoiceNotice")}</p>
        </article>
      </div>
      <p className="reference-color-note">{text("paletteColorNotice")}</p>
    </section>
  );
}
