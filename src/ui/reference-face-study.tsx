import { Eye, ScanFace, Smile } from "lucide-react";
import type { BeautyLocale } from "@/application/beauty-complete-contracts";
import type { BeautyPreferences } from "@/domain/beauty";
import type { BeautyCompleteAnalysis } from "@/domain/beauty-complete";
import type { FaceRatios } from "@/domain/face-ratios";
import { bt, beautyLabel } from "./beauty-i18n";

const animalEmoji = {
  cat: "🐱",
  dog: "🐶",
  rabbit: "🐰",
  fox: "🦊",
  deer: "🦌",
  bear: "🐻",
} as const;

/** An appearance study with actual local image-plane ratios, never confidence or beauty scores. */
export function ReferenceFaceStudy({
  analysis,
  portrait,
  ratios,
  faceShape,
  locale,
}: {
  analysis: BeautyCompleteAnalysis | null;
  portrait: string;
  ratios: FaceRatios | null;
  faceShape: BeautyPreferences["faceShape"] | undefined;
  locale: BeautyLocale;
}) {
  const text = (key: Parameters<typeof bt>[1]) => bt(locale, key);
  const label = (id: string) => beautyLabel(locale, id);
  const animal =
    analysis?.animalVibe && analysis.animalVibe !== "uncertain"
      ? analysis.animalVibe
      : null;
  const metrics = [
    {
      key: "eyeHeightWidth",
      title: "eyes",
      formula: "eyeRatio",
      low: "eyeRatioLow",
      high: "eyeRatioHigh",
      feature: analysis?.beauty.eye_shape,
      icon: Eye,
    },
    {
      key: "noseFaceWidth",
      title: "nose",
      formula: "noseRatio",
      low: "noseRatioLow",
      high: "noseRatioHigh",
      feature: analysis?.beauty.nose_shape,
      icon: ScanFace,
    },
    {
      key: "lipMouthWidth",
      title: "lips",
      formula: "lipRatio",
      low: "lipRatioLow",
      high: "lipRatioHigh",
      feature: analysis?.beauty.lip_fullness,
      icon: Smile,
    },
  ] as const;
  return (
    <div className="reference-face-study">
      <div className="reference-face-headline">
        <span className="reference-vibe-emoji" aria-hidden="true">
          {animal ? animalEmoji[animal] : "( •ᴗ• )"}
        </span>
        <div>
          <span className="beauty-eyebrow">{text("faceSignature")}</span>
          <h3 data-testid="face-vibe-title">
            {animal && <span>#{label(animal)}</span>}
            <span>#{label(faceShape ?? "unsure")}</span>
          </h3>
          <p>{text("faceSignatureBody")}</p>
        </div>
      </div>
      <div className="reference-face-grid">
        <div className="reference-portrait">
          {portrait ? (
            <>
              {/* Memory-only customer imagery must bypass persistent image optimizers. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={portrait} alt={text("ownPhoto")} />
              <span className="reference-face-outline" aria-hidden="true" />
            </>
          ) : (
            <ScanFace size={72} aria-hidden="true" />
          )}
          <span className="reference-portrait-label">
            <ScanFace size={15} aria-hidden="true" />
            {text("ownPhoto")}
          </span>
          <span className="reference-shape-label">
            {text("faceShape")} · {label(faceShape ?? "unsure")}
          </span>
        </div>
        <div className="reference-feature-list">
          {metrics.map((metric) => {
            const raw =
              ratios?.status === "measured" ? ratios[metric.key] : null;
            const value =
              raw !== null && Number.isFinite(raw) && raw > 0 && raw < 100
                ? raw
                : null;
            return (
              <article
                className="reference-feature-row"
                key={metric.key}
                data-ratio-key={metric.key}
              >
                <div className="reference-feature-heading">
                  <span className="reference-feature-icon">
                    <metric.icon size={22} aria-hidden="true" />
                  </span>
                  <h4>{text(metric.title)}</h4>
                  <strong>{label(metric.feature ?? "uncertain")}</strong>
                </div>
                <div className="reference-ratio-detail">
                  <span>{text(metric.formula)}</span>
                  <span className="reference-ratio-value">
                    {value === null ? "—" : `${value.toFixed(1)}%`}
                  </span>
                </div>
                {value === null ? (
                  <div
                    className="reference-ratio-track unavailable"
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    className="reference-ratio-track"
                    role="meter"
                    aria-label={text(metric.formula)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={value}
                    aria-valuetext={`${value.toFixed(1)}% · ${text(metric.formula)}`}
                  >
                    <span
                      className="reference-ratio-marker"
                      style={{ left: `${value}%` }}
                      aria-hidden="true"
                    />
                  </div>
                )}
                <div className="reference-ratio-ends">
                  <span>{text(metric.low)}</span>
                  <span>{text(metric.high)}</span>
                </div>
              </article>
            );
          })}
          {ratios?.status === "measured" &&
            metrics.some(
              (metric) =>
                Number.isFinite(ratios[metric.key]) &&
                ratios[metric.key] > 0 &&
                ratios[metric.key] < 100,
            ) && <p className="reference-ratio-scale">{text("ratioScale")}</p>}
          <p className="reference-ratio-note">
            {text(
              ratios?.status === "measured"
                ? "ratiosNotice"
                : "ratiosUnavailable",
            )}
          </p>
        </div>
      </div>
      {animal && (
        <p className="reference-animal-note">
          <span aria-hidden="true">✧</span>
          {text("animalNotice")}
        </p>
      )}
    </div>
  );
}
