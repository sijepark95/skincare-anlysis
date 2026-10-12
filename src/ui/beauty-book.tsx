"use client";

import { useRef, useState } from "react";
import {
  Check,
  Scissors,
  Sparkles,
  Gem,
  Eye,
  ScanFace,
  Smile,
  ImagePlus,
  ArrowUpRight,
  WandSparkles,
  Download,
} from "lucide-react";
import {
  beautyMoods,
  type BeautyGuide,
  type BeautyMood,
  type BeautyHairLength,
} from "@/domain/beauty";
import type { BeautyAnalysis } from "@/domain/beauty-analysis";
import type { ColorMatch } from "@/domain/personal-color";
import type { SavedBeautyProduct } from "@/application/beauty-consultations";
import {
  renderBeautyGuideHtml,
  type BeautyGuideExport,
} from "./beauty-guide-export";
import "./beauty-kiosk.css";

export interface MakeupPreview {
  mood: BeautyMood;
  url: string;
}
const moodNames: Record<BeautyMood, string> = {
  soft: "Soft glow",
  fresh: "Fresh bloom",
  defined: "Modern definition",
};
const tabs = [
  { id: "hairCuts", title: "Hairstyles", icon: Scissors },
  { id: "hairColors", title: "Hair color", icon: Sparkles },
  { id: "jewelry", title: "Jewelry", icon: Gem },
] as const;
const hairTones: Record<string, string[]> = {
  "hair-warm-chestnut": ["#50382D", "#704A38", "#936345", "#AC7852"],
  "hair-warm-caramel": ["#82583B", "#B18050", "#CC9D63", "#DBB784"],
  "hair-cool-brown": ["#373438", "#534A4C", "#71646B", "#8B7D83"],
  "hair-cool-mushroom": ["#6A6061", "#968688", "#AD9A97", "#C6B8C5"],
  "hair-neutral-brown": ["#473A33", "#68564B", "#8B7565", "#AC927F"],
  "hair-neutral-beige": ["#8F7966", "#AB9580", "#C1AE98", "#D7C5AF"],
};
const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");

/** Original generated inspiration asset; never a customer reconstruction or try-on. */
export function HairPhoto({
  index = 0,
  label,
  className = "",
}: {
  index?: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={`beauty-hair-photo hair-look-${Math.max(0, Math.min(index, 5))} ${className}`}
    />
  );
}

export function FaceFeatures({
  analysis,
}: {
  analysis?: BeautyAnalysis | null;
}) {
  const observed = analysis as
    | (BeautyAnalysis & {
        eye_shape?: string;
        nose_shape?: string;
        lip_fullness?: string;
      })
    | null
    | undefined;
  const usable = observed?.image_quality === "usable";
  const entries = [
    {
      title: "Eye shape",
      value: usable ? observed?.eye_shape : undefined,
      icon: Eye,
      description: "A starting point for eye makeup placement.",
    },
    {
      title: "Nose shape",
      value: usable ? observed?.nose_shape : undefined,
      icon: ScanFace,
      description: "A visible outline, influenced by angle and light.",
    },
    {
      title: "Lip fullness",
      value: usable ? observed?.lip_fullness : undefined,
      icon: Smile,
      description: "Explore color and finish without changing your shape.",
    },
  ];
  return (
    <div className="beauty-face-features">
      {entries.map(({ title, value, icon: Icon, description }) => (
        <div className="beauty-feature-row" key={title}>
          <span className="beauty-feature-icon">
            <Icon size={22} />
          </span>
          <div>
            <span>{title}</span>
            <strong>
              {value && value !== "uncertain"
                ? titleCase(value)
                : "Not determined"}
            </strong>
            <p>{description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function BeautyBook({
  guide,
  recommendations,
  onMoodChange,
  onHairLengthChange,
  hairLength = "any",
  busy = false,
  saved = false,
  savedProducts,
  analysis,
  portraitUrl,
  makeupImages = [],
  makeupBusy = false,
  makeupStatus = "",
  onMakeupGenerate,
}: {
  guide: BeautyGuide;
  recommendations: ColorMatch[];
  onMoodChange?: (mood: BeautyMood) => void;
  onHairLengthChange?: (length: BeautyHairLength) => void;
  hairLength?: BeautyHairLength;
  busy?: boolean;
  saved?: boolean;
  savedProducts?: SavedBeautyProduct[];
  analysis?: BeautyAnalysis | null;
  portraitUrl?: string;
  makeupImages?: MakeupPreview[];
  makeupBusy?: boolean;
  makeupStatus?: string;
  onMakeupGenerate?: () => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("hairCuts");
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const usable = analysis?.image_quality === "usable";
  return (
    <div className="beauty-book" aria-label="Your beauty book">
      <section className="beauty-book-lead">
        <div className="beauty-result-title">
          <span className="beauty-eyebrow">
            <Sparkles size={16} /> YOUR PERSONAL BEAUTY REPORT
          </span>
          <h1 tabIndex={-1}>
            A new way to see <span>yourself.</span>
          </h1>
          <p>Your features. Your colors. Your next look.</p>
        </div>
        <div className="beauty-face-report">
          <div
            className={`beauty-book-portrait ${portraitUrl ? "has-photo" : "no-photo"}`}
          >
            {portraitUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={portraitUrl}
                  alt="Your beauty consultation photo, kept only in this session"
                />
                <span className="beauty-photo-tag">
                  YOUR PHOTO · SESSION ONLY
                </span>
              </>
            ) : (
              <div className="beauty-no-portrait">
                <ScanFace size={52} />
                <strong>
                  {saved
                    ? "Your saved style direction"
                    : "Your style starts here"}
                </strong>
                <p>
                  {saved
                    ? "Your photo and feature observations were not saved."
                    : "No face observations are assumed without a usable photo."}
                </p>
              </div>
            )}
          </div>
          <div className="beauty-face-report-copy">
            <span className="beauty-eyebrow">01 / FACE & FEATURES</span>
            <h2>
              {guide.confirmedFaceShape === "unsure" ? (
                "Every feature, your own."
              ) : (
                <>
                  {titleCase(guide.confirmedFaceShape)}{" "}
                  <span>face direction.</span>
                </>
              )}
            </h2>
            {saved ? (
              <p className="beauty-small">
                Confirmed outline:{" "}
                {guide.confirmedFaceShape === "unsure"
                  ? "Open to exploring"
                  : guide.confirmedFaceShape}
                . Photo observations stay off the saved guide.
              </p>
            ) : (
              <>
                <FaceFeatures analysis={analysis} />
                <p className="beauty-analysis-note">
                  {usable
                    ? "AI appearance suggestions, not measured proportions. Camera angle, light and makeup can change the result."
                    : "The photo did not support reliable feature suggestions. Your confirmed choices still shape this guide."}
                </p>
              </>
            )}
          </div>
        </div>
      </section>
      <section
        className="beauty-palette-section"
        aria-labelledby="beauty-palette-heading"
      >
        <div>
          <span className="beauty-eyebrow">02 / PERSONAL PALETTE</span>
          <h2 id="beauty-palette-heading">{guide.palette.name}</h2>
          <p>{guide.palette.description}</p>
          <span className="beauty-confirmed-chip">
            <Check size={14} /> Confirmed by you
          </span>
        </div>
        <div className="beauty-book-swatches">
          {guide.palette.swatches.map((swatch, index) => (
            <div key={swatch}>
              <i style={{ background: swatch }} />
              <span>Shade {index + 1}</span>
              <small>{swatch}</small>
            </div>
          ))}
        </div>
        <p className="beauty-small">
          Screen colors are approximate. Compare real swatches in even light.
        </p>
      </section>
      <section aria-labelledby="beauty-mood-heading">
        <div className="beauty-section-heading">
          <div>
            <span className="beauty-eyebrow">03 / YOUR MAKEUP MOODS</span>
            <h2 id="beauty-mood-heading">
              Three looks. <span>Still you.</span>
            </h2>
          </div>
          <p>
            {saved
              ? "Your confirmed makeup direction. Generated portraits are never included in saved guides."
              : "Tap a mood to explore its styling direction and matching store shades."}
          </p>
        </div>
        <div className="beauty-mood-grid">
          {beautyMoods.map((mood, index) => {
            const idea = guide.makeupMoods.find(
              (item) => item.id === `makeup-${mood}`,
            );
            const preview = makeupImages.find((item) => item.mood === mood);
            const content = (
              <>
                <div className={`beauty-mood-art mood-${mood}`}>
                  {preview ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={preview.url}
                        alt={`AI-generated ${moodNames[mood].toLowerCase()} makeup preview using your photo`}
                      />
                      <span className="beauty-generated-label">
                        AI MAKEUP PREVIEW
                      </span>
                    </>
                  ) : (
                    <div
                      className="beauty-mood-placeholder"
                      style={
                        {
                          "--mood-color": guide.palette.swatches[index],
                        } as React.CSSProperties
                      }
                    >
                      <ImagePlus size={30} />
                      <span>
                        {makeupBusy
                          ? "Creating your look…"
                          : saved
                            ? "Portrait not saved"
                            : "Your photo preview"}
                      </span>
                      <small>
                        {saved
                          ? "Keep this as a styling direction"
                          : "Available after separate image permission"}
                      </small>
                    </div>
                  )}
                  <span className="beauty-mood-number">0{index + 1}</span>
                  {guide.mood === mood && (
                    <span className="beauty-mood-check">
                      <Check size={16} />
                    </span>
                  )}
                </div>
                <div className="beauty-mood-copy">
                  <h3>{moodNames[mood]}</h3>
                  <p>
                    {idea?.description ??
                      "Explore this look with your confirmed palette."}
                  </p>
                  <span>
                    {guide.mood === mood
                      ? "Selected direction"
                      : "Explore this look"}
                    <ArrowUpRight size={15} />
                  </span>
                </div>
              </>
            );
            return onMoodChange ? (
              <button
                type="button"
                key={mood}
                className={`beauty-mood-card ${guide.mood === mood ? "selected" : ""}`}
                aria-pressed={guide.mood === mood}
                disabled={busy || makeupBusy}
                onClick={() => onMoodChange(mood)}
              >
                {content}
              </button>
            ) : (
              <article
                key={mood}
                className={`beauty-mood-card ${guide.mood === mood ? "selected" : ""}`}
              >
                {content}
              </article>
            );
          })}
        </div>
        {!saved && makeupImages.length === 0 && (
          <div className="beauty-makeup-create">
            <div>
              <WandSparkles size={22} />
              <p>
                {makeupStatus ||
                  "See these three moods on your own photo. Image generation needs separate permission."}
              </p>
            </div>
            {onMakeupGenerate && (
              <button
                className="button secondary"
                disabled={busy || makeupBusy}
                onClick={onMakeupGenerate}
              >
                {makeupBusy
                  ? "Creating three looks…"
                  : "Create my 3 makeup looks"}
                <ArrowUpRight size={18} />
              </button>
            )}
          </div>
        )}
        {makeupImages.length > 0 && (
          <>
            <div className="beauty-preview-downloads">
              {beautyMoods.map((mood) => {
                const preview = makeupImages.find((item) => item.mood === mood);
                return preview ? (
                  <a
                    key={mood}
                    className="beauty-text-button"
                    href={preview.url}
                    download={`aelune-${mood}-makeup-preview.jpg`}
                  >
                    <Download size={16} />
                    Save {moodNames[mood]} preview
                  </a>
                ) : null;
              })}
            </div>
            <p className="beauty-small">
              AI-generated styling previews can alter appearance. These are
              illustrative edits, not predictions of cosmetic results. Images
              disappear when this session ends.
            </p>
          </>
        )}
      </section>
      <section
        className="beauty-styling"
        aria-labelledby="beauty-styling-heading"
      >
        <div className="beauty-section-heading">
          <div>
            <span className="beauty-eyebrow">04 / YOUR STYLE EDIT</span>
            <h2 id="beauty-styling-heading">
              Find your next <span>signature.</span>
            </h2>
          </div>
          <p>
            Visual ideas to take to your stylist. These reference models are not
            your face.
          </p>
        </div>
        <div className="beauty-tabs" role="tablist" aria-label="Styling ideas">
          {tabs.map(({ id, title, icon: Icon }, index) => (
            <button
              key={id}
              ref={(element) => {
                tabButtons.current[index] = element;
              }}
              role="tab"
              id={`beauty-tab-${id}`}
              aria-controls={`beauty-panel-${id}`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  setTab(tabs[next].id);
                  tabButtons.current[next]?.focus();
                }
              }}
            >
              <Icon size={18} />
              {title}
            </button>
          ))}
        </div>
        {tab === "hairCuts" && onHairLengthChange && (
          <div
            className="beauty-length-options"
            role="group"
            aria-label="Hair length to explore"
          >
            {(["any", "short", "medium", "long"] as const).map((length) => (
              <button
                key={length}
                type="button"
                aria-pressed={hairLength === length}
                disabled={busy}
                onClick={() => onHairLengthChange(length)}
              >
                {length === "any" ? (
                  <span className="beauty-length-all">
                    <Scissors size={22} />
                  </span>
                ) : (
                  <HairPhoto
                    index={length === "short" ? 0 : length === "medium" ? 3 : 4}
                    label={`${titleCase(length)} hair reference`}
                  />
                )}
                <span>
                  {length === "any" ? "All lengths" : titleCase(length)}
                </span>
                {hairLength === length && <Check size={15} />}
              </button>
            ))}
          </div>
        )}
        <div
          role="tabpanel"
          id={`beauty-panel-${tab}`}
          aria-labelledby={`beauty-tab-${tab}`}
          tabIndex={0}
          className="beauty-idea-grid"
        >
          {guide[tab].map((idea, index) => (
            <article className="beauty-idea-card" key={idea.id}>
              {tab === "jewelry" ? (
                <div
                  className={`beauty-jewelry-photo ${index ? "jewelry-drop" : "jewelry-hoop"} ${guide.palette.undertone === "cool" ? "silver" : "gold"}`}
                  role="img"
                  aria-label="Illustrative jewelry reference"
                >
                  <div />
                  <div />
                  <span>ILLUSTRATIVE REFERENCE</span>
                </div>
              ) : (
                <div className="beauty-idea-art">
                  <HairPhoto
                    index={
                      tab === "hairCuts"
                        ? (idea.id.endsWith("short")
                            ? 0
                            : idea.id.endsWith("long")
                              ? 4
                              : 2) +
                          (["round", "heart", "oblong"].includes(
                            guide.confirmedFaceShape,
                          )
                            ? 1
                            : 0)
                        : index + 3
                    }
                    label={`${idea.title} — illustrative hairstyle reference`}
                  />
                  <span>STYLE INSPIRATION</span>
                </div>
              )}
              <div className="beauty-idea-copy">
                <h3>{idea.title}</h3>
                <p>{idea.description}</p>
                {tab === "hairColors" && (
                  <div
                    className="beauty-hair-swatches"
                    aria-label="Illustrative hair color references"
                  >
                    {(hairTones[idea.id] ?? ["#68564B"]).map((tone) => (
                      <span key={tone}>
                        <i style={{ background: tone }} />
                        <small>{tone}</small>
                      </span>
                    ))}
                    <p>Illustrative tones · compare a real swatch.</p>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section
        className="beauty-store-matches"
        aria-labelledby="beauty-store-heading"
      >
        <div className="beauty-section-heading">
          <div>
            <span className="beauty-eyebrow">05 / AVAILABLE HERE</span>
            <h2 id="beauty-store-heading">
              Your lip color <span>match.</span>
            </h2>
          </div>
          <p>
            {saved
              ? "Saved store shade references. Confirm availability with staff."
              : "Registered store shades matched to your confirmed palette."}
          </p>
        </div>
        {savedProducts ? (
          savedProducts.length ? (
            <div className="beauty-lip-grid">
              {savedProducts.map((product) => (
                <article className="beauty-lip-card" key={product.variantId}>
                  <div
                    className="beauty-lip-art"
                    style={{ background: product.swatchHex }}
                  >
                    <span>Saved shade reference</span>
                  </div>
                  <span className="beauty-eyebrow">{product.brand}</span>
                  <h3>{product.name}</h3>
                  <p>
                    {product.shadeName} · {product.finish}
                  </p>
                  {product.priceMinor !== null && product.currency && (
                    <strong>
                      {new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: product.currency,
                      }).format(product.priceMinor / 100)}
                    </strong>
                  )}
                  <p className="beauty-small">
                    {product.available
                      ? "Check availability with the store."
                      : "Currently unavailable. Keep this as a shade reference."}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <div className="beauty-empty">
              <Smile size={24} />
              <p>This saved guide contains no registered lip matches.</p>
            </div>
          )
        ) : recommendations.length ? (
          <div className="beauty-lip-grid">
            {recommendations.map(({ product, shade, reasons }) => (
              <article className="beauty-lip-card" key={product.id}>
                <div
                  className="beauty-lip-art"
                  style={{ background: shade.swatchHex }}
                >
                  <span>Registered shade</span>
                </div>
                <span className="beauty-eyebrow">{product.brand}</span>
                <h3>{product.name}</h3>
                <p>
                  {shade.shadeName} · {shade.finish}
                </p>
                <strong>
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: product.currency,
                  }).format(product.priceMinor / 100)}
                </strong>
                <ul>
                  {reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        ) : (
          <div className="beauty-empty">
            <Smile size={24} />
            <div>
              <p>
                No eligible registered lip shades match this store&apos;s
                current catalog and your choices.
              </p>
              <span>
                Ask staff to explore shades with you. Your styling guide is
                still ready.
              </span>
            </div>
          </div>
        )}
        <p className="beauty-small">
          Compare a tester and check the full label. Color matching does not
          establish suitability or allergy safety.
        </p>
      </section>
    </div>
  );
}

export function downloadBeautyGuide(value: BeautyGuideExport) {
  const url = URL.createObjectURL(
    new Blob([renderBeautyGuideHtml(value)], {
      type: "text/html;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "aelune-beauty-guide.html";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
