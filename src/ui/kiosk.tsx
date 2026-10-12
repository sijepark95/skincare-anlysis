"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Leaf,
  LockKeyhole,
  RotateCcw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  Answers,
  Consultation,
  DeviceContext,
  StaffContext,
} from "@/application/contracts";
import {
  concerns,
  concernLabels,
  skinTypes,
  type Concern,
  type SkinType,
  canonicalizeIngredient,
} from "@/domain";
import {
  VISION_FEATURE_LABELS as visionFeatureLabels,
  VISION_VALUE_LABELS as visionValueLabels,
  VISION_QUALITY_LABELS as visionQualityLabels,
} from "@/domain/skin-vision";
import type { SkinConsultationReport } from "@/domain/skin-consultation";
import { api, json } from "./api";
import { Brand } from "./brand";
import { ProductArt } from "./product-art";
import { Modal } from "./modal";
import { useFaceCamera } from "./use-face-camera";
import { PersonalColor } from "./personal-color";

type Step =
  | "welcome"
  | "consent"
  | "skin"
  | "concerns"
  | "preferences"
  | "camera"
  | "analyzing"
  | "results";
const initialAnswers: Answers = {
  skinType: "unsure",
  concerns: [],
  sensitive: false,
  excludedIngredients: [],
};
const skinDescriptions: Record<SkinType, string> = {
  normal: "Usually comfortable and balanced",
  dry: "Often feels tight or dry",
  oily: "Often looks shiny",
  combination: "A little oily, a little dry",
  unsure: "I'm still getting to know my skin",
};
const visualLabels: Record<string, string> = {
  sensitivity: "Sensitivity",
  pigmentation: "Pigmentation",
  wrinkles: "Wrinkles",
  acne: "Acne",
  pores: "Pores",
  sagging: "Sagging",
  keratin: "Keratin",
  redness: "Redness",
};
const stepNames: Record<Step, string> = {
  welcome: "Welcome",
  consent: "Your privacy",
  skin: "About your skin",
  concerns: "Your focus",
  preferences: "Your preferences",
  camera: "Your photo",
  analyzing: "A moment for you",
  results: "Your discoveries",
};

function NextAction({
  title,
  onClick,
  disabled = false,
  busy = false,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      className="button primary wide"
      onClick={onClick}
      disabled={busy || disabled}
    >
      {busy ? "One moment…" : title}
      <ArrowRight size={20} />
    </button>
  );
}

const consultationSourceLabels = {
  selected: "Your selected goal",
  photo: "Visible in your photo",
  both: "Your photo & selected goal",
} as const;

function SkinConsultation({ report }: { report: SkinConsultationReport }) {
  return (
    <section
      className="skin-consultation"
      aria-label="Personal skin consultation"
    >
      <p className="consultation-lead">{report.summary}</p>
      {report.paragraphs.map((paragraph) => (
        <p className="consultation-paragraph" key={paragraph}>
          {paragraph}
        </p>
      ))}
      {report.goals.length > 0 && (
        <div
          className="consultation-priorities"
          aria-label="Your care priorities"
        >
          {report.goals.map((goal) => (
            <article className="consultation-priority" key={goal.concern}>
              <div className="consultation-priority-label">
                <Leaf size={20} aria-hidden="true" />
                <h3>{goal.label}</h3>
              </div>
              <span className="consultation-source">
                {consultationSourceLabels[goal.source]}
              </span>
              <p>{goal.explanation}</p>
              <p className="consultation-coverage">
                {goal.coverageExplanation}
              </p>
            </article>
          ))}
        </div>
      )}
      {report.observations.length > 0 && (
        <details className="consultation-observations analysis-details">
          <summary>
            <ScanFace size={20} aria-hidden="true" />
            <span>Explore your five photo observations</span>
            <ChevronDown size={20} aria-hidden="true" />
          </summary>
          <div className="analysis-details-content">
            <div className="vision-feature-grid">
              {report.observations.map((observation) => (
                <article className="vision-feature" key={observation.feature}>
                  <h3>{observation.label}</h3>
                  <p
                    className={`vision-value ${observation.value === "visible" ? "is-visible" : ""}`}
                  >
                    {observation.statusLabel}
                  </p>
                  <p className="vision-interpretation">
                    {observation.interpretation}
                  </p>
                  <p className="vision-recommendation-use">
                    {observation.recommendationUse}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

function IngredientRecommendations({
  report,
  productIds,
}: {
  report: SkinConsultationReport;
  productIds: ReadonlySet<string>;
}) {
  return (
    <section
      className="consultation-ingredients"
      aria-labelledby="consultation-ingredients-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR INGREDIENT GUIDE</span>
          <h2 id="consultation-ingredients-title">
            Ingredients with a purpose.
          </h2>
        </div>
        <span className="subtle">
          Selected through this store's ingredient guide
        </span>
      </div>
      {report.ingredients.length ? (
        <div className="consultation-ingredient-grid">
          {report.ingredients.map((item) => {
            const matchedIds = item.matchedProductIds.filter((id) =>
              productIds.has(id),
            );
            return (
              <article
                className="consultation-ingredient"
                key={item.ingredient}
              >
                <span className="consultation-ingredient-icon">
                  <Leaf size={22} aria-hidden="true" />
                </span>
                <h3>{item.ingredient}</h3>
                <div className="consultation-ingredient-goals">
                  {item.goals.map((goal) => (
                    <span key={goal}>{concernLabels[goal]}</span>
                  ))}
                </div>
                <p>{item.rationale}</p>
                {matchedIds.length ? (
                  <a
                    className="consultation-store-link"
                    href={`#store-product-${matchedIds[0]}`}
                  >
                    <Check size={17} aria-hidden="true" />
                    View {matchedIds.length} store{" "}
                    {matchedIds.length === 1 ? "match" : "matches"}
                    <ArrowRight size={17} aria-hidden="true" />
                  </a>
                ) : (
                  <p className="consultation-unavailable">
                    This ingredient is not in the products recommended here.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="notice">
          This store has no ingredient-guide matches for your current goals and
          exclusions. Ask staff to help you explore suitable options.
        </p>
      )}
    </section>
  );
}

export function Kiosk() {
  const [step, setStep] = useState<Step>("welcome");
  const [session, setSession] = useState<Consultation | null>(null);
  const [answers, setAnswers] = useState<Answers>(initialAnswers);
  const [context, setContext] = useState<{
    device: DeviceContext | null;
    staff: StaffContext | null;
    mode: string;
    analysisMode: "mock" | "experimental" | "openai";
    explanationAvailable: boolean;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [visionAccepted, setVisionAccepted] = useState(false);
  const [visionAttempted, setVisionAttempted] = useState(false);
  const [explanationAccepted, setExplanationAccepted] = useState(false);
  const [explanationBusy, setExplanationBusy] = useState(false);
  const [idleWarning, setIdleWarning] = useState(false);
  const main = useRef<HTMLElement>(null);
  const photoUrl = useRef<string | null>(null);
  const photoBytes = useRef<Blob | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const analysisRequest = useRef<AbortController | null>(null);
  const explanationRequest = useRef<AbortController | null>(null);
  const sessionId = useRef<string | null>(null);
  const epoch = useRef(0);
  const lastActivity = useRef(0);
  const openai = context?.analysisMode === "openai";
  const experimental = context?.analysisMode === "experimental";
  const photoPermitted = !openai || visionAccepted;
  const clearPhoto = useCallback(() => {
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = null;
    photoBytes.current = null;
    if (photoInput.current) photoInput.current.value = "";
    setPhoto(null);
  }, []);
  const faceCamera = useFaceCamera({
    active:
      step === "camera" &&
      photoPermitted &&
      !(openai && visionAttempted) &&
      !photo &&
      !idleWarning,
    onCapture(blob) {
      if (!photoPermitted) return;
      clearPhoto();
      const url = URL.createObjectURL(blob);
      photoUrl.current = url;
      photoBytes.current = blob;
      setPhoto(url);
      void analyze();
    },
  });
  const { video, streaming, stopCamera, openCamera } = faceCamera;
  const reset = useCallback(
    async (beacon = false) => {
      epoch.current++;
      analysisRequest.current?.abort();
      analysisRequest.current = null;
      explanationRequest.current?.abort();
      explanationRequest.current = null;
      const id = sessionId.current;
      sessionId.current = null;
      stopCamera();
      clearPhoto();
      setSession(null);
      setAnswers(initialAnswers);
      setAccepted(false);
      setVisionAccepted(false);
      setVisionAttempted(false);
      setExplanationAccepted(false);
      setExplanationBusy(false);
      setStep("welcome");
      setBusy(false);
      setError("");
      setCameraError("");
      setIdleWarning(false);
      if (id) {
        if (beacon) {
          navigator.sendBeacon(
            `/api/v1/kiosk/sessions/${id}/finish`,
            new Blob(["{}"], { type: "application/json" }),
          );
          return;
        }
        try {
          await api(`kiosk/sessions/${id}/finish`, {
            method: "POST",
            body: "{}",
          });
        } catch {
          /* Server expiry purges abandoned sessions. */
        }
      }
    },
    [clearPhoto, stopCamera],
  );
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    api<NonNullable<typeof context>>("context", { signal: controller.signal })
      .then((value) => {
        if (active) setContext(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  useEffect(() => {
    const activity = () => {
      lastActivity.current = Date.now();
    };
    ["pointerdown", "keydown"].forEach((event) =>
      window.addEventListener(event, activity),
    );
    const timer = window.setInterval(() => {
      if (!sessionId.current) return;
      const idle = Date.now() - lastActivity.current;
      if (idle >= 120000) void reset();
      else if (idle >= 90000) setIdleWarning(true);
    }, 1000);
    const leave = () => {
      void reset(true);
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void reset(true);
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", restored);
    return () => {
      window.clearInterval(timer);
      ["pointerdown", "keydown"].forEach((event) =>
        window.removeEventListener(event, activity),
      );
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", restored);
      leave();
    };
  }, [reset, stopCamera]);
  useEffect(() => {
    // Keep keyboard and assistive-technology users at the new task, rather
    // than leaving focus on a button that disappeared with the previous step.
    main.current
      ?.querySelector<HTMLElement>("h1")
      ?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    const current = epoch.current;
    try {
      await work();
      return true;
    } catch (e) {
      if (current === epoch.current)
        setError(e instanceof Error ? e.message : "Please try again.");
      return false;
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  async function start() {
    const current = epoch.current;
    await action(async () => {
      const value = await api<Consultation>("kiosk/sessions", {
        method: "POST",
        body: "{}",
      });
      if (current !== epoch.current) {
        await api(`kiosk/sessions/${value.id}/finish`, {
          method: "POST",
          body: "{}",
        });
        return;
      }
      sessionId.current = value.id;
      setSession(value);
      lastActivity.current = Date.now();
      setStep("consent");
    });
  }
  async function consent() {
    const current = epoch.current;
    await action(async () => {
      await api(`kiosk/sessions/${sessionId.current}/consent`, {
        method: "POST",
        body: json({
          accepted: true,
          ...(openai ? { visionAccepted } : {}),
          ...(!openai && context?.explanationAvailable
            ? { explanationAccepted }
            : {}),
        }),
      });
      if (current === epoch.current) setStep("skin");
    });
  }
  function choosePhoto(file?: File) {
    if (!file || !photoPermitted || (openai && visionAttempted)) return;
    clearPhoto();
    stopCamera();
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size === 0 ||
      file.size > 10 * 1024 * 1024
    ) {
      setCameraError("Choose a JPEG, PNG or WebP photo smaller than 10 MB.");
      return;
    }
    setCameraError("");
    const url = URL.createObjectURL(file);
    photoUrl.current = url;
    photoBytes.current = file;
    setPhoto(url);
  }
  async function analyze() {
    if (analysisRequest.current) return;
    stopCamera();
    const current = epoch.current;
    const capturedPhoto = photoPermitted ? photoBytes.current : null;
    if (openai && capturedPhoto && visionAttempted) return;
    const controller = new AbortController();
    analysisRequest.current = controller;
    const succeeded = await action(async () => {
      await api(`kiosk/sessions/${sessionId.current}/answers`, {
        method: "PUT",
        body: json(answers),
        signal: controller.signal,
      });
      if (current !== epoch.current) return;
      setStep("analyzing");
      if (openai && capturedPhoto) setVisionAttempted(true);
      const value = await api<Consultation>(
        `kiosk/sessions/${sessionId.current}/analysis`,
        {
          method: "POST",
          ...((experimental || openai) && capturedPhoto
            ? {
                body: capturedPhoto,
                headers: { "Content-Type": capturedPhoto.type },
              }
            : { body: "{}" }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(70000),
          ]),
        },
      );
      if (current !== epoch.current) return;
      clearPhoto();
      setSession(value);
      setStep("results");
      if (!openai && value.explanationConsent?.accepted && !value.explanation)
        void explain(value.id, current);
    });
    if (!succeeded && current === epoch.current) setStep("camera");
    if (analysisRequest.current === controller) analysisRequest.current = null;
  }
  async function explain(id: string, current: number) {
    explanationRequest.current?.abort();
    const controller = new AbortController();
    explanationRequest.current = controller;
    setExplanationBusy(true);
    try {
      const value = await api<Consultation>(
        `kiosk/sessions/${id}/explanation`,
        {
          method: "POST",
          body: "{}",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
        },
      );
      if (
        current === epoch.current &&
        sessionId.current === id &&
        value.id === id &&
        !controller.signal.aborted
      )
        setSession((active) => {
          if (active?.id !== id || current !== epoch.current) return active;
          // Refresh eligibility without giving the explanation response ranking authority.
          const eligible = new Set(
            value.recommendations?.map((item) => item.product.id) ?? [],
          );
          const recommendations =
            active.recommendations?.filter((item) =>
              eligible.has(item.product.id),
            ) ?? null;
          const retained = new Set(
            recommendations?.map((item) => item.product.id) ?? [],
          );
          return {
            ...active,
            recommendations,
            explanation: value.explanation
              ? {
                  ...value.explanation,
                  products: value.explanation.products.filter((item) =>
                    retained.has(item.productId),
                  ),
                }
              : value.explanation,
          };
        });
    } catch {
      // Reviewed ingredient reasons remain visible if the optional notes fail.
    } finally {
      if (explanationRequest.current === controller) {
        explanationRequest.current = null;
        if (current === epoch.current) setExplanationBusy(false);
      }
    }
  }
  const ingredientCoverage =
    session?.analysis?.mode === "experimental"
      ? session.analysis.ingredients.input_coverage
      : [];
  const photoInformedRanking =
    session?.analysis?.mode === "experimental" &&
    Boolean(session.analysis.visual) &&
    ingredientCoverage.includes("visual_condition_used_source_contract_v1");
  const skinConsultation =
    session?.analysis?.mode === "openai" ? session.skinConsultation : undefined;
  const unseenPhotoCondition =
    session?.analysis?.mode === "experimental" &&
    Boolean(session.analysis.visual) &&
    ingredientCoverage.includes("visual_condition_unseen_in_training_omitted");
  const faceStatus =
    faceCamera.countdown !== null
      ? faceCamera.countdown === 0
        ? "Capturing your photo…"
        : `Hold still. Capturing in ${faceCamera.countdown}…`
      : faceCamera.detectorState === "unavailable"
        ? "Face positioning is unavailable on this browser."
        : faceCamera.detectorState === "loading"
          ? "Starting face positioning…"
          : {
              "no-face": "Center your face in the guide.",
              "multiple-faces": "One person at a time, please.",
              "too-far": "Move a little closer to the camera.",
              "too-close": "Move a little farther from the camera.",
              "off-center": "Move your face into the center.",
              ready: "Face centered. Hold still for your scan.",
              invalid: "Face the camera and keep your face in the guide.",
            }[faceCamera.assessment?.status ?? "no-face"];
  const visibleFace = faceCamera.assessment?.face;
  const index = [
    "consent",
    "skin",
    "concerns",
    "preferences",
    "camera",
    "results",
  ].indexOf(step === "analyzing" ? "camera" : step);
  const back = () => {
    setError("");
    if (step === "skin") setStep("consent");
    if (step === "concerns") setStep("skin");
    if (step === "preferences") setStep("concerns");
    if (step === "camera") {
      stopCamera();
      clearPhoto();
      setStep("preferences");
    }
  };
  return (
    <main ref={main} className={`kiosk step-${step}`}>
      <header className="kiosk-header">
        <Brand />
        <span className="kiosk-store">
          {context?.staff?.stores.find((s) => s.id === context.device?.storeId)
            ?.name ?? "Your in-store skin experience"}
        </span>
        <span className="pill">
          {openai
            ? "OpenAI photo analysis"
            : experimental
              ? "Experimental AI"
              : "Mock AI demo"}
        </span>
      </header>
      {step !== "welcome" && (
        <div className="kiosk-toolbar">
          <button
            className="text-button"
            onClick={back}
            disabled={
              busy || ["consent", "analyzing", "results"].includes(step)
            }
          >
            <ArrowLeft size={18} />
            Back
          </button>
          <div className="step-status">
            <span className="step-label">
              Step {index + 1} of 6
              <span className="step-title">
                {" "}
                <span aria-hidden="true">·</span> {stepNames[step]}
              </span>
            </span>
            <div
              className="step-progress"
              role="group"
              aria-label={stepNames[step]}
            >
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={i <= index ? "active" : ""} />
              ))}
            </div>
          </div>
          <button className="text-button" onClick={() => void reset()}>
            <X size={18} />
            End session
          </button>
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          {step === "analyzing" && (
            <button className="text-button" onClick={() => void analyze()}>
              Try again
            </button>
          )}
        </div>
      )}
      {step === "welcome" && (
        <section className="kiosk-welcome">
          <div className="welcome-visual">
            <img
              src="/media/hero-poster.png"
              alt="A beauty shopper discovering skincare at a smart mirror"
            />
            <span className="visual-caption">A LITTLE MORE YOU.</span>
            <span className="campaign-label">Promotional concept</span>
          </div>
          <div className="welcome-copy">
            <span className="eyebrow">WELCOME TO YOUR SKIN MOMENT</span>
            <h1 tabIndex={-1}>
              A little insight.
              <br />
              <em>A brighter you.</em>
            </h1>
            <p>
              Discover ingredients and in-store skincare that fit what matters
              to you.
            </p>
            <div className="welcome-details">
              <span>
                <LockKeyhole size={17} />
                No account needed
              </span>
              <span>
                <Sparkles size={17} />
                About 2 minutes
              </span>
            </div>
            <ol className="welcome-journey" aria-label="Your consultation">
              <li>
                <span>01</span> Your goals
              </li>
              <li>
                <span>02</span> Optional photo
              </li>
              <li>
                <span>03</span> Store matches
              </li>
            </ol>
            {ready && context && !context.device ? (
              <Link className="button primary wide" href="/kiosk/pair">
                Pair this tablet <ArrowRight size={18} />
              </Link>
            ) : (
              <NextAction
                title="Let's get started"
                onClick={() => void start()}
                disabled={!ready || !context}
                busy={busy}
              />
            )}
            <p className="fine-print">
              {openai
                ? "With separate permission, OpenAI observes visible skin features in your photo. These cosmetic observations are unvalidated and do not diagnose your skin."
                : experimental
                  ? "Try experimental photo analysis and ingredient matching. Results are unvalidated and do not diagnose your skin."
                  : "This demonstration uses simulated results. It does not measure or diagnose your skin."}
            </p>
          </div>
        </section>
      )}
      {step === "consent" && (
        <section className="kiosk-card consent-card">
          <div className="consent-intro">
            <div className="round-icon">
              <ShieldCheck />
            </div>
            <span className="eyebrow">YOUR PRIVACY COMES FIRST</span>
            <h1 tabIndex={-1}>
              A moment for you.
              <br />
              <em>With your permission.</em>
            </h1>
            <div className="privacy-list">
              <p>
                <Check />
                {openai
                  ? "A photo is optional. It is sent to OpenAI only if you separately agree below."
                  : experimental
                    ? "With your permission, your photo is sent to this installation's private analysis service and processed in memory. It is never saved."
                    : "Your photo stays in this browser. It is never uploaded in this demo."}
              </p>
              <p>
                <Check />
                {openai
                  ? "Your goals and the store's reviewed ingredient policy guide product matches. Visible photo features can contribute when that policy supports them."
                  : experimental
                    ? "Your answers and supported codes from your optional photo help rank ingredients and match the store's products."
                    : "Your answers help match ingredients to the store's products."}
              </p>
              <p>
                <Check />
                {openai
                  ? "This application clears your temporary photo, answers and results when you finish or after inactivity. OpenAI's separate retention is explained below."
                  : "Your photo, answers and results are cleared when you finish or after inactivity."}
              </p>
            </div>
            <p className="fine-print">
              {openai
                ? "Cosmetic photo observations, not a medical diagnosis or calibrated skin measurement."
                : experimental
                  ? "Experimental cosmetic guidance, not a medical diagnosis."
                  : "Simulated cosmetic guidance, not a medical diagnosis."}{" "}
              {openai
                ? "If you agree to photo analysis, "
                : "At the photo step, "}
              the camera opens automatically. A centered face starts a 3-second
              countdown, capture and analysis. You can pause or skip the photo.
              No identification or training use. Abandoned server sessions
              expire within 15 minutes.
            </p>
          </div>
          <div className="consent-choices">
            <span className="eyebrow">YOU'RE IN CONTROL</span>
            <label className="check-row">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                I agree to this temporary session{" "}
                {openai
                  ? "and understand these cosmetic suggestions are unvalidated."
                  : experimental
                    ? "and optional private photo processing. I understand the results are experimental."
                    : "and understand the results are simulated."}
              </span>
            </label>
            {openai && (
              <div className="ai-consent vision-consent">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={visionAccepted}
                    onChange={(e) => setVisionAccepted(e.target.checked)}
                    aria-describedby="vision-privacy"
                  />
                  <span>Analyze my photo with OpenAI (optional)</span>
                </label>
                <p className="fine-print" id="vision-privacy">
                  I am an adult and the only person in my photo. A metadata-free
                  face photo is sent outside this device to OpenAI for visible
                  cosmetic observations. This application does not save photos
                  or use them for training. OpenAI API data is not used for
                  training by default; abuse-monitoring logs may be kept for up
                  to 30 days, even with response storage disabled. Leave this
                  unchecked to continue with your answers and store policy,
                  without camera access or photo transmission.
                </p>
              </div>
            )}
            {!openai && context?.explanationAvailable && (
              <div className="ai-consent">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={explanationAccepted}
                    onChange={(e) => setExplanationAccepted(e.target.checked)}
                    aria-describedby="explanation-privacy"
                  />
                  <span>Add an AI explanation (optional)</span>
                </label>
                <p className="fine-print" id="explanation-privacy">
                  OpenAI receives only your matching goals and matched
                  ingredient names with anonymous product references. No photo,
                  identity, raw analysis or training records are sent.
                  Processing takes place outside this device; abuse-monitoring
                  logs may be kept for up to 30 days. You can continue without
                  this option.
                </p>
              </div>
            )}
            <NextAction
              title="I agree, let's begin"
              onClick={() => void consent()}
              disabled={!accepted}
              busy={busy}
            />
            <button
              className="text-button centered"
              onClick={() => void reset()}
            >
              No thanks, end session
            </button>
          </div>
        </section>
      )}
      {step === "skin" && (
        <section className="kiosk-card">
          <span className="eyebrow">A LITTLE ABOUT YOU</span>
          <h1 tabIndex={-1}>
            How does your skin
            <br />
            <em>usually feel?</em>
          </h1>
          <p className="lead">
            Your own experience is the best place to start.
          </p>
          <div className="options">
            {skinTypes.map((type) => (
              <button
                key={type}
                className={`option ${answers.skinType === type ? "selected" : ""}`}
                aria-pressed={answers.skinType === type}
                onClick={() => setAnswers({ ...answers, skinType: type })}
              >
                <span>
                  <strong>
                    {type === "unsure"
                      ? "Not sure yet"
                      : type[0].toUpperCase() + type.slice(1)}
                  </strong>
                  <small>{skinDescriptions[type]}</small>
                </span>
                <span className="selection-dot">
                  {answers.skinType === type && <Check size={17} />}
                </span>
              </button>
            ))}
          </div>
          <NextAction
            title="Continue"
            onClick={() => setStep("concerns")}
            busy={busy}
          />
        </section>
      )}
      {step === "concerns" && (
        <section className="kiosk-card">
          <span className="eyebrow">YOUR SKINCARE FOCUS</span>
          <h1 tabIndex={-1}>
            What would you like
            <br />
            <em>to focus on?</em>
          </h1>
          <p className="lead">Choose one or more. There's no wrong answer.</p>
          <div className="options concern-options">
            {concerns.map((concern: Concern) => (
              <button
                key={concern}
                className={`option ${answers.concerns.includes(concern) ? "selected" : ""}`}
                aria-pressed={answers.concerns.includes(concern)}
                onClick={() =>
                  setAnswers({
                    ...answers,
                    concerns: answers.concerns.includes(concern)
                      ? answers.concerns.filter((c) => c !== concern)
                      : [...answers.concerns, concern],
                  })
                }
              >
                <Leaf size={23} />
                <strong>{concernLabels[concern]}</strong>
                <span className="selection-dot">
                  {answers.concerns.includes(concern) && <Check size={17} />}
                </span>
              </button>
            ))}
          </div>
          <NextAction
            title="Continue"
            onClick={() => setStep("preferences")}
            disabled={!answers.concerns.length}
            busy={busy}
          />
        </section>
      )}
      {step === "preferences" && (
        <section className="kiosk-card">
          <span className="eyebrow">A LITTLE EXTRA CARE</span>
          <h1 tabIndex={-1}>
            Let's make it
            <br />
            <em>comfortable for you.</em>
          </h1>
          <p className="lead">
            These preferences help narrow your product matches.
          </p>
          <label className="check-row large">
            <input
              type="checkbox"
              checked={answers.sensitive}
              onChange={(e) =>
                setAnswers({ ...answers, sensitive: e.target.checked })
              }
            />
            <span>
              My skin often feels sensitive.
              <small>We'll show a reminder to introduce products gently.</small>
            </span>
          </label>
          <p className="field-title">Ingredients you'd like to avoid</p>
          <div className="chip-options">
            {["Parfum", "Alcohol Denat."].map((ingredient) => (
              <button
                key={ingredient}
                aria-pressed={answers.excludedIngredients.includes(ingredient)}
                className={`chip ${answers.excludedIngredients.includes(ingredient) ? "selected" : ""}`}
                onClick={() =>
                  setAnswers({
                    ...answers,
                    excludedIngredients: answers.excludedIngredients.includes(
                      ingredient,
                    )
                      ? answers.excludedIngredients.filter(
                          (i) => i !== ingredient,
                        )
                      : [...answers.excludedIngredients, ingredient],
                  })
                }
              >
                {answers.excludedIngredients.includes(ingredient) && (
                  <Check size={16} />
                )}{" "}
                {ingredient === "Parfum" ? "Fragrance" : "Alcohol denat."}
              </button>
            ))}
          </div>
          <p className="fine-print">
            This short preference list cannot cover every allergy. Check the
            full product label and ask store staff about your specific needs.
          </p>
          <NextAction
            title={
              openai && !visionAccepted
                ? "See my store matches"
                : "Continue to photo"
            }
            onClick={() =>
              openai && !visionAccepted ? void analyze() : setStep("camera")
            }
            busy={busy}
          />
        </section>
      )}
      {step === "camera" && openai && !visionAccepted && (
        <section className="kiosk-card">
          <span className="eyebrow">YOUR CHOICE, RESPECTED</span>
          <h1 tabIndex={-1}>
            Your goals.
            <br />
            <em>Your store matches.</em>
          </h1>
          <p className="lead">
            You chose to continue without photo analysis. Your camera stays off.
          </p>
          <NextAction
            title="See my store matches"
            onClick={() => void analyze()}
            busy={busy}
          />
        </section>
      )}
      {step === "camera" && photoPermitted && (
        <section className="kiosk-card camera-card">
          <span className="eyebrow">YOUR SKIN MOMENT</span>
          <h1 tabIndex={-1}>
            Find your
            <br />
            <em>natural light.</em>
          </h1>
          <p className="lead">
            Center your face and hold still. A 3-second countdown starts
            automatically.
          </p>
          <div className="camera-layout">
            <div className="camera-stage">
              <div className="camera-frame">
                {photo ? (
                  <img src={photo} alt="Your temporary photo preview" />
                ) : streaming ? (
                  <video
                    ref={video}
                    muted
                    playsInline
                    aria-label="Live camera preview"
                  />
                ) : (
                  <div className="camera-empty">
                    <ScanFace size={64} />
                    <span>
                      {openai
                        ? "With your permission, analyzed by OpenAI"
                        : experimental
                          ? "Your photo is processed privately"
                          : "Your photo stays on this device"}
                    </span>
                  </div>
                )}
                {streaming && (
                  <>
                    <svg
                      className={`face-position-overlay ${faceCamera.scanReady ? "is-ready" : ""}`}
                      viewBox={`0 0 ${faceCamera.frameSize.width} ${faceCamera.frameSize.height}`}
                      preserveAspectRatio="xMidYMid meet"
                      aria-hidden="true"
                    >
                      <ellipse
                        className="face-position-guide"
                        cx={faceCamera.frameSize.width * 0.5}
                        cy={faceCamera.frameSize.height * 0.46}
                        rx={faceCamera.frameSize.width * 0.23}
                        ry={faceCamera.frameSize.height * 0.35}
                      />
                      {visibleFace && (
                        <g className="detected-face">
                          <rect
                            x={visibleFace.box.x * faceCamera.frameSize.width}
                            y={visibleFace.box.y * faceCamera.frameSize.height}
                            width={
                              visibleFace.box.width * faceCamera.frameSize.width
                            }
                            height={
                              visibleFace.box.height *
                              faceCamera.frameSize.height
                            }
                            rx={20}
                          />
                          {visibleFace.keypoints.map((point, i) => (
                            <circle
                              key={i}
                              cx={point.x * faceCamera.frameSize.width}
                              cy={point.y * faceCamera.frameSize.height}
                              r={4}
                            />
                          ))}
                        </g>
                      )}
                    </svg>
                    {faceCamera.countdown !== null &&
                      faceCamera.countdown > 0 && (
                        <div className="capture-countdown" aria-hidden="true">
                          {faceCamera.countdown}
                        </div>
                      )}
                  </>
                )}
              </div>
              {(cameraError || faceCamera.error) && (
                <p className="notice" role="status">
                  {cameraError || faceCamera.error}
                </p>
              )}
              <p className="camera-private">
                <LockKeyhole size={16} />
                {openai
                  ? "Sent to OpenAI for cosmetic observations."
                  : experimental
                    ? "Processed in memory. Never saved."
                    : "Stays in this browser. Never uploaded."}
              </p>
            </div>
            <div className="camera-controls">
              <div className="camera-instructions">
                <span className="eyebrow">
                  {openai && visionAttempted
                    ? "CONTINUE YOUR WAY"
                    : photo
                      ? "YOUR PHOTO IS READY"
                      : "A PHOTO IS OPTIONAL"}
                </span>
                <h2>
                  {openai && visionAttempted
                    ? "Your choices still matter."
                    : photo
                      ? "Ready when you are."
                      : "Your scan starts here."}
                </h2>
                <p>
                  {openai && visionAttempted
                    ? "Continue with your answers and the store's ingredient policy. A new photo analysis needs a new session."
                    : photo
                      ? "Use this photo or retake it before continuing."
                      : "Your camera opens automatically. Keep one face centered in even light. After the countdown, we'll capture and continue to your results."}
                </p>
              </div>
              <div className="camera-actions">
                {photo ? (
                  <button
                    className="button secondary"
                    disabled={busy || (openai && visionAttempted)}
                    onClick={() => {
                      setCameraError("");
                      clearPhoto();
                    }}
                  >
                    <RotateCcw size={18} />
                    Retake
                  </button>
                ) : streaming ? (
                  <div
                    className="face-position-status"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    <ScanFace size={24} aria-hidden="true" />
                    <strong>{faceStatus}</strong>
                    <span>Position check only · No identity recognition</span>
                  </div>
                ) : (
                  <button
                    className="button primary wide"
                    disabled={faceCamera.opening || (openai && visionAttempted)}
                    onClick={() => {
                      setCameraError("");
                      void openCamera();
                    }}
                  >
                    <Camera size={20} />
                    {faceCamera.opening ? "Opening camera…" : "Retry camera"}
                  </button>
                )}
              </div>
              {streaming && (
                <button className="text-button centered" onClick={stopCamera}>
                  Pause camera
                </button>
              )}
              {(experimental || openai) && (
                <div className="photo-upload">
                  <input
                    ref={photoInput}
                    type="file"
                    hidden
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy || (openai && visionAttempted)}
                    onChange={(e) => choosePhoto(e.target.files?.[0])}
                  />
                  <button
                    className="button secondary"
                    disabled={busy || (openai && visionAttempted)}
                    onClick={() => photoInput.current?.click()}
                  >
                    Choose a photo
                  </button>
                </div>
              )}
              {photo ? (
                <>
                  <NextAction
                    title={
                      experimental || openai
                        ? "Analyze my photo"
                        : "Show my mock results"
                    }
                    onClick={() => void analyze()}
                    busy={busy}
                    disabled={openai && visionAttempted}
                  />
                  {openai && (
                    <button
                      className="text-button centered"
                      disabled={busy}
                      onClick={() => {
                        clearPhoto();
                        void analyze();
                      }}
                    >
                      Continue without a photo <ArrowRight size={18} />
                    </button>
                  )}
                </>
              ) : (
                <button
                  className="text-button centered"
                  disabled={busy}
                  onClick={() => void analyze()}
                >
                  {experimental || openai
                    ? "Continue without a photo"
                    : "Continue with mock experience"}{" "}
                  <ArrowRight size={18} />
                </button>
              )}
              {openai && visionAttempted && (
                <p className="notice" role="status">
                  A photo analysis was already attempted for this session.
                  Continue without a photo, or end this session and start again
                  to analyze another photo.
                </p>
              )}
              <p className="fine-print">
                {openai
                  ? "Face positioning runs on this device. Your photo is sent to OpenAI after capture; position guidance does not validate skin quality or lighting. Uploaded photos bypass positioning. This application never saves photos. OpenAI abuse-monitoring logs may be kept for up to 30 days."
                  : experimental
                    ? "Face detection checks position on this device, not skin quality or lighting. Your captured photo goes only to the private analysis service. Uploaded photos bypass the live position check. Photos are never saved or used for training."
                    : "Live face detection checks position on this device. Mock skin results are simulated and do not process your photo. Photos are never saved or uploaded."}
              </p>
            </div>
          </div>
        </section>
      )}
      {step === "analyzing" && (
        <section className="kiosk-card analyzing">
          <div className="analysis-orbit">
            <Sparkles size={38} />
          </div>
          <span className="eyebrow">THOUGHTFULLY MATCHING</span>
          <h1 tabIndex={-1}>
            A little care,
            <br />
            <em>coming your way.</em>
          </h1>
          <p className="lead">
            {openai
              ? photo
                ? "OpenAI is observing visible skin features in your photo. Then we'll check the store's ingredient policy and available products."
                : "Matching your selected goals to the store's ingredient policy and available products. No new photo request is made."
              : experimental
                ? "Running the local models and matching ingredient candidates to your store's available products."
                : "Preparing simulated observations and matching ingredients to your store's catalog."}
          </p>
          <p className="fine-print">
            {openai
              ? "Cosmetic observations · No diagnostic scores"
              : experimental
                ? "Experimental AI · Private processing"
                : "Mock AI · No photo processing"}
          </p>
        </section>
      )}
      {step === "results" && session?.analysis && (
        <section className="results">
          <div className="results-heading">
            <span className="eyebrow">MADE FOR YOUR SKIN MOMENT</span>
            <h1 tabIndex={-1}>
              Your next chapter
              <br />
              <em>starts with care.</em>
            </h1>
            <p>
              {session.analysis.mode === "openai"
                ? session.analysis.vision
                  ? "A closer look at visible features in your photo."
                  : "Store matches guided by your selected skincare goals."
                : "Ingredient matches for your selected skincare goals."}
            </p>
            <span className="pill lavender">
              {session.analysis.mode === "openai"
                ? session.analysis.vision
                  ? "Photo observations · OpenAI"
                  : "Photo-free · Store policy"
                : session.analysis.mode === "experimental"
                  ? "Experimental results · Local models"
                  : `Simulated results · ${session.analysis.model_version}`}
            </span>
            <div className="result-goals" aria-label="Your selected goals">
              {answers.concerns.map((concern) => (
                <span key={concern}>
                  <Leaf size={15} />
                  {concernLabels[concern]}
                </span>
              ))}
            </div>
            {session.analysis.mode === "experimental" && (
              <p className="fine-print result-disclosure">
                Experimental cosmetic suggestions, not a diagnosis. Accuracy,
                effectiveness and suitability are unverified.
              </p>
            )}
          </div>
          {session.analysis.mode === "openai" && (
            <section
              className="vision-results"
              aria-labelledby="vision-results-title"
            >
              <div className="section-heading">
                <div>
                  <span className="eyebrow">YOUR PHOTO ANALYSIS</span>
                  <h2 id="vision-results-title">
                    {skinConsultation?.title ??
                      (session.analysis.vision
                        ? "What OpenAI observed."
                        : "Your photo-free experience.")}
                  </h2>
                </div>
                {session.analysis.vision && (
                  <span className="pill lavender">
                    {session.analysis.vision.image_quality === "usable"
                      ? "Photo assessed"
                      : session.analysis.vision.image_quality === "limited"
                        ? "Photo has limitations"
                        : "Photo could not be assessed"}
                  </span>
                )}
              </div>
              {skinConsultation ? (
                <>
                  <SkinConsultation report={skinConsultation} />
                  {session.analysis.vision &&
                    session.analysis.vision.quality_flags.length > 0 && (
                      <ul
                        className="vision-quality-list"
                        aria-label="Photo limitations"
                      >
                        {session.analysis.vision.quality_flags.map((flag) => (
                          <li key={flag}>{visionQualityLabels[flag]}</li>
                        ))}
                      </ul>
                    )}
                </>
              ) : session.analysis.vision ? (
                <>
                  <p className="vision-summary">
                    {session.analysis.vision.image_quality === "usable"
                      ? "These observations describe appearance in this one photo. Lighting, camera and makeup can affect what is visible."
                      : session.analysis.vision.image_quality === "limited"
                        ? "Some details are unclear in this photo. These observations do not contribute to product matching; your answers and store policy guide the matches below."
                        : "This photo does not provide a clear basis for skin observations. Your answers and store policy guide the matches below. For another photo, finish this session and start again in even light."}
                  </p>
                  {session.analysis.vision.quality_flags.length > 0 && (
                    <ul
                      className="vision-quality-list"
                      aria-label="Photo limitations"
                    >
                      {session.analysis.vision.quality_flags.map((flag) => (
                        <li key={flag}>
                          {visionQualityLabels[flag] ??
                            "The photo limits interpretation."}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="vision-feature-grid">
                    {Object.entries(visionFeatureLabels).map(
                      ([feature, label]) => {
                        const value =
                          session.analysis?.mode === "openai"
                            ? session.analysis.vision?.observed_features[
                                feature as keyof typeof visionFeatureLabels
                              ]
                            : null;
                        return (
                          <article className="vision-feature" key={feature}>
                            <ScanFace size={22} aria-hidden="true" />
                            <h3>{label}</h3>
                            <p
                              className={`vision-value ${value === "visible" ? "is-visible" : ""}`}
                            >
                              {value
                                ? visionValueLabels[value]
                                : "Cannot assess from this photo"}
                            </p>
                          </article>
                        );
                      },
                    )}
                  </div>
                  <p className="fine-print vision-limits">
                    “Not visible in this photo” does not mean absent. These are
                    cosmetic image observations, not a diagnosis, confidence
                    score, hydration measurement or assessment of sensitivity.
                  </p>
                  <p className="fine-print vision-provenance">
                    {session.analysis.vision.image_quality === "usable"
                      ? "Clearly visible pores, spots and fine lines can add a matching goal only through the store's reviewed policy. Redness and flaking are shown for context. Your selected goals, skin type and ingredient exclusions still apply."
                      : "Photo features were omitted from matching because this photo could not be fully assessed. Your selected goals, skin type and ingredient exclusions still apply."}
                  </p>
                </>
              ) : (
                <p className="vision-summary">
                  This result uses your answers and the store's reviewed
                  ingredient policy. No new photo request is made. If you
                  attempted photo analysis earlier, that photo may already have
                  reached OpenAI.
                </p>
              )}
              <details className="vision-disclosure">
                <summary>About this analysis</summary>
                {skinConsultation ? (
                  <>
                    {skinConsultation.limitations.map((limitation) => (
                      <p className="fine-print" key={limitation}>
                        {limitation}
                      </p>
                    ))}
                    {skinConsultation.policyVersion && (
                      <p className="fine-print">
                        Store ingredient policy:{" "}
                        {skinConsultation.policyVersion}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="fine-print">{session.analysis.disclaimer}</p>
                )}
                {session.analysis.vision && (
                  <p className="fine-print">
                    OpenAI API · {session.analysis.model_version}. This
                    application does not save your photo. OpenAI
                    abuse-monitoring logs may be retained for up to 30 days.
                  </p>
                )}
              </details>
            </section>
          )}
          {skinConsultation && (
            <IngredientRecommendations
              report={skinConsultation}
              productIds={
                new Set(
                  session.recommendations?.map((item) => item.product.id) ?? [],
                )
              }
            />
          )}
          <div className="section-heading">
            <div>
              <span className="eyebrow">INGREDIENTS, MEET YOUR SHELF</span>
              <h2>A thoughtful starting routine.</h2>
            </div>
            <span className="subtle">Available in this store</span>
          </div>
          {!openai && explanationBusy && (
            <p className="fine-print explanation-loading" role="status">
              <Sparkles size={18} />
              Preparing your recommendation notes…
            </p>
          )}
          {!openai && session.explanation && (
            <div
              className="notice explanation-note"
              aria-label="Recommendation explanation"
            >
              <Sparkles size={20} />
              <div>
                <strong>
                  {session.explanation.status === "generated"
                    ? "AI-assisted match explanation"
                    : "Why these matched"}
                </strong>
                <p>{session.explanation.summary}</p>
              </div>
            </div>
          )}
          <div className="recommendation-grid">
            {session.recommendations?.map((rec) => (
              <article
                className="product-card"
                id={`store-product-${rec.product.id}`}
                key={rec.product.id}
              >
                <ProductArt
                  category={rec.product.category}
                  name={rec.product.name}
                />
                <div className="product-copy">
                  <span className="eyebrow">{rec.product.brand}</span>
                  <h3>{rec.product.name}</h3>
                  <p className="price">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: rec.product.currency,
                    }).format(rec.product.priceMinor / 100)}
                  </p>
                  <p className="match-reason">
                    <Check size={15} />
                    {rec.matchedIngredients.join(" · ")}
                  </p>
                  {skinConsultation?.products.find(
                    (item) => item.productId === rec.product.id,
                  ) ? (
                    <div className="consultation-product-reasons">
                      <p className="consultation-product-intro">
                        {
                          skinConsultation.products.find(
                            (item) => item.productId === rec.product.id,
                          )?.explanation
                        }
                      </p>
                      <ul aria-label="Why this store product matched">
                        {skinConsultation.products
                          .find((item) => item.productId === rec.product.id)
                          ?.reasons.map((reason) => (
                            <li key={`${reason.concern}-${reason.ingredient}`}>
                              <strong>{reason.ingredient}</strong>
                              <span>{reason.explanation}</span>
                              <span className="consultation-source">
                                {consultationSourceLabels[reason.source]}
                              </span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="fine-print">
                      Matched to{" "}
                      {Array.from(
                        new Set(
                          rec.reasons.map((r) =>
                            concernLabels[r.concern].toLowerCase(),
                          ),
                        ),
                      ).join(" & ")}{" "}
                      through the store's ingredient policy.
                      {photoInformedRanking &&
                        " Photo codes contributed to ingredient candidate ranking."}
                    </p>
                  )}
                  {!openai &&
                    session.explanation?.products.find(
                      (item) => item.productId === rec.product.id,
                    )?.text && (
                      <p className="fine-print product-explanation">
                        {
                          session.explanation.products.find(
                            (item) => item.productId === rec.product.id,
                          )?.text
                        }
                      </p>
                    )}
                </div>
              </article>
            ))}
          </div>
          {!session.recommendations?.length && (
            <p className="notice">
              No available products meet all your preferences. Store staff can
              help you explore alternatives.
            </p>
          )}
          {session.analysis.mode === "experimental" && (
            <>
              <p className="notice">{session.analysis.disclaimer}</p>
              {session.analysis.visual ? (
                <>
                  <details className="analysis-details">
                    <summary>
                      <ScanFace size={20} />
                      <span>About your experimental results</span>
                      <ChevronDown size={20} />
                    </summary>
                    <div className="analysis-details-content">
                      <div className="section-heading">
                        <div>
                          <span className="eyebrow">YOUR PHOTO ANALYSIS</span>
                          <h2>Experimental model outputs.</h2>
                        </div>
                      </div>
                      <p className="fine-print">
                        These are dataset codes, not clinical grades or health
                        scores. Source code meanings and the accuracy of the
                        combined photo-to-recommendation pipeline remain
                        unverified.
                      </p>
                      <div className="observation-grid model-output-grid">
                        {session.analysis.visual.heads.map((head) => (
                          <article key={head.key}>
                            <ScanFace size={20} />
                            <h3>{visualLabels[head.key] ?? head.key}</h3>
                            <span className="model-code">
                              {head.predicted_code}
                            </span>
                            <details>
                              <summary>Relative model outputs</summary>
                              <p>
                                Uncalibrated values; not confidence in a
                                diagnosis.
                              </p>
                              <dl>
                                {head.probabilities.map((value) => (
                                  <div key={value.code}>
                                    <dt>{value.code}</dt>
                                    <dd>
                                      {(value.probability * 100).toFixed(1)}%
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            </details>
                          </article>
                        ))}
                      </div>
                    </div>
                  </details>
                </>
              ) : (
                <p className="notice">
                  You continued without a photo. Ingredient matching uses your
                  questionnaire only.
                </p>
              )}
              <div className="ingredient-candidates">
                <h2>Ingredient candidates.</h2>
                {photoInformedRanking && (
                  <span className="pill lavender">
                    Photo-informed ingredient ranking
                  </span>
                )}
                <p className="fine-print">
                  {photoInformedRanking
                    ? "Your photo's source codes are included in ingredient candidate ranking."
                    : unseenPhotoCondition
                      ? "This photo's code combination was not present in recommendation training, so photo codes were omitted. Ingredient matching uses supported questionnaire fields."
                      : "Ingredient candidates use supported questionnaire fields. Photo codes were not used in this ranking."}{" "}
                  Your selected goals, the store's policy and excluded
                  ingredients still determine product matches.
                </p>
                <div
                  className="chip-options"
                  aria-label="Experimental ingredient candidates"
                >
                  {session.analysis.ingredients.candidates
                    .filter(
                      (candidate) =>
                        !answers.excludedIngredients.some(
                          (ingredient) =>
                            canonicalizeIngredient(ingredient) ===
                            canonicalizeIngredient(candidate.ingredient),
                        ),
                    )
                    .slice(0, 5)
                    .map((candidate) => (
                      <span
                        className="pill lavender"
                        key={candidate.ingredient}
                      >
                        {candidate.ingredient}
                      </span>
                    ))}
                </div>
                <details>
                  <summary>About this recommendation model</summary>
                  <p className="fine-print">
                    It learned ingredient mentions from unreviewed example
                    answers. Missing age, gender and environment details can
                    affect ranking. Ingredient presence does not establish
                    effectiveness or safety.
                  </p>
                  <p className="fine-print">
                    Source code meanings and the accuracy of the combined
                    photo-to-recommendation pipeline remain unverified. Your
                    selected skin type takes precedence. Photo codes do not
                    change your goals, sensitivity preference or exclusions.
                  </p>
                  <p className="fine-print">
                    {session.analysis.ingredients.input_coverage.includes(
                      "no_supported_features_bias_only_baseline",
                    )
                      ? "Your selections do not match this model's supported fields. These candidates reflect its general learned baseline."
                      : "Supported questionnaire inputs: your selected skin type, even-looking tone and fine-line goals where provided. Hydration, texture and sensitivity selections are not inputs to this model."}
                  </p>
                  <p className="fine-print">
                    {session.analysis.ingredients.model_version}
                  </p>
                </details>
              </div>
            </>
          )}
          <div className="observation-grid">
            {session.analysis.observations.map((observation) => (
              <article key={observation.concern_id}>
                <Leaf size={20} />
                <h3>{concernLabels[observation.concern_id]}</h3>
                <span className="mock-level">
                  {observation.level} · illustrative
                </span>
                <p>A simulated observation, not a measured skin score.</p>
              </article>
            ))}
          </div>
          <p className="results-caution">
            {answers.sensitive &&
              "Introduce new products gently and ask staff about your sensitivities. "}
            Check the full product label before use. These cosmetic suggestions
            are based on ingredient presence; concentration and suitability are
            not verified.
          </p>
          <PersonalColor key={session.id} sessionId={session.id} />
          <div className="finish-panel">
            <div>
              <h3>Your moment stays yours.</h3>
              <p>
                Finish to clear this session and prepare the tablet for the next
                guest.
              </p>
            </div>
            <button className="button primary" onClick={() => void reset()}>
              Finish & clear session <Check size={18} />
            </button>
          </div>
        </section>
      )}
      <footer className="kiosk-footer">
        <span>
          <LockKeyhole size={14} />
          Private by design
        </span>
        <span>Cosmetic discovery · Not medical advice</span>
      </footer>
      {idleWarning && (
        <Modal
          title="Still enjoying your moment?"
          close={() => {
            lastActivity.current = Date.now();
            setIdleWarning(false);
          }}
        >
          <p>This session will clear after two minutes of inactivity.</p>
          <button
            autoFocus
            className="button primary wide"
            onClick={() => {
              lastActivity.current = Date.now();
              setIdleWarning(false);
            }}
          >
            I'm still here
          </button>
          <button className="text-button centered" onClick={() => void reset()}>
            Finish and clear now
          </button>
        </Modal>
      )}
    </main>
  );
}
