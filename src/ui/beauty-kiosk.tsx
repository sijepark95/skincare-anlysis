"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Download,
  LockKeyhole,
  QrCode,
  ShieldCheck,
  Upload,
  X,
  Sparkles,
  ScanFace,
  WandSparkles,
  SlidersHorizontal,
} from "lucide-react";
import type { Consultation, DeviceContext } from "@/application/contracts";
import { faceShapes, type BeautyPreferences } from "@/domain/beauty";
import { BEAUTY_PHOTO_NOTICE_VERSION } from "@/domain/beauty-analysis";
import type { BeautyState } from "@/application/beauty-consultations";
import {
  lipFinishes,
  personalColorPalettes,
  suggestedPalette,
  type PaletteId,
} from "@/domain/personal-color";
import { api, json } from "./api";
import { Brand } from "./brand";
import { Modal } from "./modal";
import {
  BeautyBook,
  FaceFeatures,
  HairPhoto,
  downloadBeautyGuide,
} from "./beauty-book";
import { useBeautyMakeup } from "./use-beauty-makeup";
import { useFaceCamera } from "./use-face-camera";
import "./beauty-kiosk.css";
import { BeautyCompleteKiosk } from "./complete-beauty-kiosk";

type Step = "welcome" | "privacy" | "photo" | "confirm" | "book";
type Share = { url: string; expiresAt: string; qrDataUrl: string };
const initialBasics = {
  hairLength: "any",
  mood: "soft",
  finish: "any",
} as const;

export function BeautyKiosk() {
  return <BeautyCompleteKiosk />;
}

export function LegacyBeautyKiosk({ onSkin }: { onSkin?: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [context, setContext] = useState<{
    device: DeviceContext | null;
    analysisMode: string;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<BeautyState | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [photoAccepted, setPhotoAccepted] = useState(false);
  const [portrait, setPortrait] = useState("");
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [ingredient, setIngredient] = useState("");
  const [basics, setBasics] =
    useState<Pick<BeautyPreferences, "hairLength" | "mood" | "finish">>(
      initialBasics,
    );
  const [palette, setPalette] = useState<PaletteId | "">("");
  const [faceShape, setFaceShape] = useState<
    BeautyPreferences["faceShape"] | ""
  >("");
  const [preview, setPreview] = useState("");
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [idle, setIdle] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [shareAccepted, setShareAccepted] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const session = useRef<string | null>(null);
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const photo = useRef<File | null>(null);
  const photoUrl = useRef("");
  const portraitUrl = useRef("");
  const photoConsent = useRef(false);
  const attempt = useRef(false);
  const main = useRef<HTMLElement>(null);
  const lastActivity = useRef(0);
  const makeup = useBeautyMakeup(session);
  const {
    clear: clearMakeup,
    reset: resetMakeup,
    active: makeupActive,
  } = makeup;
  const faceCamera = useFaceCamera({
    active:
      camera &&
      step === "photo" &&
      photoAccepted &&
      !state?.attempted &&
      !idle &&
      !busy,
    onCapture(blob) {
      if (!photoConsent.current || attempt.current || document.hidden) return;
      void analyze(
        new File([blob], "beauty-photo.jpg", { type: "image/jpeg" }),
      );
    },
  });
  const { video, stopCamera } = faceCamera;

  const clearMedia = useCallback(() => {
    stopCamera();
    photo.current = null;
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = "";
    if (portraitUrl.current) URL.revokeObjectURL(portraitUrl.current);
    portraitUrl.current = "";
    clearMakeup();
  }, [stopCamera, clearMakeup]);
  const cancel = useCallback(() => {
    epoch.current++;
    request.current?.abort();
    request.current = null;
    clearMedia();
  }, [clearMedia]);
  const reset = useCallback(
    async (beacon = false) => {
      cancel();
      const id = session.current;
      session.current = null;
      photoConsent.current = false;
      attempt.current = false;
      setStep("welcome");
      setState(null);
      setAccepted(false);
      setPhotoAccepted(false);
      setPortrait("");
      resetMakeup();
      setExclusions([]);
      setIngredient("");
      setBasics(initialBasics);
      setPalette("");
      setFaceShape("");
      setPreview("");
      setCamera(false);
      setBusy("");
      setError("");
      setNotice("");
      setIdle(false);
      setSaveOpen(false);
      setShareAccepted(false);
      setShare(null);
      if (!id) return;
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
        /* Server expiry clears abandoned sessions. */
      }
    },
    [cancel, resetMakeup],
  );

  useEffect(() => {
    const controller = new AbortController();
    api<NonNullable<typeof context>>("context", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setContext(value);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const activity = () => {
      lastActivity.current = Date.now();
    };
    const hidden = () => {
      if (!document.hidden) return;
      cancel();
      setCamera(false);
      setPreview("");
      setPortrait("");
      setBusy("");
      setNotice(
        "The camera and unsent photo were cleared while this screen was away.",
      );
    };
    const leave = () => {
      void reset(true);
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) leave();
    };
    const timer = window.setInterval(() => {
      if (!session.current || makeupActive.current) return;
      const elapsed = Date.now() - lastActivity.current;
      if (elapsed >= 120000) void reset();
      else if (elapsed >= 90000) setIdle(true);
    }, 1000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", restored);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", restored);
      leave();
    };
  }, [cancel, reset, makeupActive]);
  useEffect(() => {
    main.current
      ?.querySelector<HTMLElement>("h1")
      ?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step]);

  function begin(label: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++epoch.current;
    setBusy(label);
    setError("");
    setNotice("");
    return {
      controller,
      current: () => current === epoch.current && !controller.signal.aborted,
    };
  }
  async function run(
    label: string,
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    const { controller, current } = begin(label);
    try {
      await work(controller.signal, current);
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    } finally {
      if (current()) setBusy("");
    }
  }
  async function start() {
    await run("Starting your consultation…", async (signal, current) => {
      const value = await api<Consultation>("kiosk/sessions", {
        method: "POST",
        body: "{}",
        signal,
      });
      if (!current()) {
        void api(`kiosk/sessions/${value.id}/finish`, {
          method: "POST",
          body: "{}",
        }).catch(() => {});
        return;
      }
      session.current = value.id;
      lastActivity.current = Date.now();
      setStep("privacy");
    });
  }
  async function privacy() {
    await run("Saving your permission…", async (signal, current) => {
      await api(`kiosk/sessions/${session.current}/consent`, {
        method: "POST",
        body: json({ accepted: true, visionAccepted: false }),
        signal,
      });
      const value = await api<BeautyState>(
        `kiosk/sessions/${session.current}/beauty`,
        { signal },
      );
      if (!current()) return;
      setState(value);
      setExclusions(value.excludedIngredients);
      photoConsent.current = value.consent;
      setPhotoAccepted(value.consent);
      attempt.current = value.attempted;
      setStep("photo");
    });
  }
  async function changePhotoConsent(value: boolean) {
    photoConsent.current = value;
    setPhotoAccepted(value);
    if (!value) {
      cancel();
      makeup.declineLocally();
      setCamera(false);
      setPreview("");
      setPortrait("");
      setPalette("");
      setFaceShape("");
      setState((existing) =>
        existing
          ? {
              ...existing,
              analysis: null,
              preferences: null,
              guide: null,
              recommendations: [],
              consent: false,
            }
          : null,
      );
    }
    await run("Saving photo permission…", async (signal, current) => {
      try {
        await api(`kiosk/sessions/${session.current}/beauty-consent`, {
          method: "POST",
          body: json({
            accepted: value,
            noticeVersion: BEAUTY_PHOTO_NOTICE_VERSION,
          }),
          signal,
        });
        if (current() && value && makeup.accepted)
          await makeup.changeConsent(true, signal);
        if (current() && value && !attempt.current) setCamera(true);
      } catch (cause) {
        if (current()) {
          photoConsent.current = false;
          setPhotoAccepted(false);
          clearMedia();
          setPreview("");
          setCamera(false);
        }
        throw cause;
      }
    });
  }
  function choosePhoto(file?: File) {
    if (
      !file ||
      !photoConsent.current ||
      attempt.current ||
      !state?.photoAvailable
    )
      return;
    clearMedia();
    setCamera(false);
    setPreview("");
    setError("");
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    ) {
      setError("Choose a static JPG, PNG or WebP photo up to 10 MB.");
      return;
    }
    photo.current = file;
    photoUrl.current = URL.createObjectURL(file);
    setPreview(photoUrl.current);
  }
  function openCamera() {
    if (
      !photoConsent.current ||
      attempt.current ||
      busy ||
      !state?.photoAvailable
    )
      return;
    clearMedia();
    setPreview("");
    setError("");
    setCamera(true);
    if (camera) void faceCamera.openCamera();
  }
  async function analyze(capturedImage?: File) {
    const image = capturedImage ?? photo.current;
    if (!image || attempt.current || !photoConsent.current || busy) return;
    attempt.current = true;
    setState((value) => (value ? { ...value, attempted: true } : value));
    clearMedia();
    setPreview("");
    setCamera(false);
    portraitUrl.current = URL.createObjectURL(image);
    setPortrait(portraitUrl.current);
    makeup.keepSource(image);
    await run("Looking at your photo. One moment…", async (signal, current) => {
      const response = await fetch(
        `/api/v1/kiosk/sessions/${session.current}/beauty-analysis`,
        {
          method: "POST",
          body: image,
          headers: { "Content-Type": image.type },
          credentials: "same-origin",
          cache: "no-store",
          signal,
        },
      );
      const value = await response.json();
      if (!response.ok) {
        makeup.releaseSource();
        throw new Error(
          value.error?.message ??
            "The photo suggestion is unavailable. You can still build your guide yourself.",
        );
      }
      if (current()) {
        setState(value);
        setPalette(suggestedPalette(value.analysis) ?? "neutral_soft");
        setFaceShape(
          value.analysis?.image_quality === "usable" &&
            value.analysis.face_shape !== "uncertain"
            ? value.analysis.face_shape
            : "unsure",
        );
        setStep("confirm");
      }
    });
  }
  function skipPhoto() {
    clearMedia();
    setCamera(false);
    setPreview("");
    setPortrait("");
    setError("");
    setPalette(palette || "neutral_soft");
    setFaceShape(faceShape || "unsure");
    setStep("confirm");
  }
  async function confirm(
    change?: Partial<Pick<BeautyPreferences, "mood" | "hairLength">>,
  ) {
    if (!palette || !faceShape || busy || makeup.active.current) return;
    const preferences: BeautyPreferences = {
      ...basics,
      paletteId: palette,
      faceShape,
      ...change,
    };
    await run("Creating your beauty book…", async (signal, current) => {
      await api(`kiosk/sessions/${session.current}/beauty-exclusions`, {
        method: "POST",
        body: json({ excludedIngredients: exclusions }),
        signal,
      });
      const value = await api<BeautyState>(
        `kiosk/sessions/${session.current}/beauty-preferences`,
        { method: "POST", body: json(preferences), signal },
      );
      if (current()) {
        setState(value);
        setBasics({
          hairLength: preferences.hairLength,
          mood: preferences.mood,
          finish: preferences.finish,
        });
        setStep("book");
        if (
          value.analysis?.image_quality === "usable" &&
          value.makeup?.available !== false &&
          !value.makeup?.attempted
        ) {
          await makeup.generate(signal, current);
          lastActivity.current = Date.now();
        } else makeup.releaseSource();
      }
    });
  }
  const closeSave = useCallback(() => {
    setSaveOpen(false);
  }, []);
  const suggested = suggestedPalette(state?.analysis ?? null);
  const suggestedShape =
    state?.analysis?.image_quality === "usable" &&
    state.analysis.face_shape !== "uncertain"
      ? state.analysis.face_shape
      : null;
  const label = (value: string) => value[0].toUpperCase() + value.slice(1);
  const back = () => {
    cancel();
    setCamera(false);
    setPreview("");
    setPortrait("");
    setError("");
    setStep(step === "confirm" ? "photo" : "privacy");
  };

  const selectedPalette =
    personalColorPalettes.find((value) => value.id === palette) ??
    personalColorPalettes[4];
  const makeupConsentControl = state?.makeup?.available ? (
    <label className="beauty-check beauty-makeup-optin">
      <input
        type="checkbox"
        checked={makeup.accepted}
        disabled={
          (!!busy && !makeup.accepted) ||
          (!!state.attempted && !makeup.accepted)
        }
        onChange={(event) => {
          const value = event.target.checked;
          if (!photoAccepted) makeup.stageConsent(value);
          else
            void run("Saving image permission…", (signal) =>
              makeup.changeConsent(value, signal),
            );
        }}
      />
      <span>
        <WandSparkles size={18} />
        Create 3 makeup looks on my photo
        <small>
          Optional separate image generation with OpenAI. Choose this before
          starting the camera. My photo is sent again after I confirm the
          direction. AI makeup edits can change appearance. Previews stay in
          this session and are excluded from QR saves. Provider retention may
          apply.
        </small>
      </span>
    </label>
  ) : null;
  return (
    <main className={`beauty-shell beauty-step-${step}`} ref={main}>
      <header className="beauty-header">
        <Brand />
        <span>
          <Sparkles size={15} /> AI BEAUTY STUDIO
        </span>
        {step !== "welcome" && (
          <button className="beauty-text-button" onClick={() => void reset()}>
            <X size={18} />
            End session
          </button>
        )}
      </header>
      {step !== "welcome" && step !== "book" && (
        <nav className="beauty-progress" aria-label="Consultation progress">
          <button
            className="beauty-text-button"
            disabled={!!busy || step === "privacy"}
            onClick={back}
          >
            <ArrowLeft size={18} />
            Back
          </button>
          <ol>
            {["Permission", "Your photo", "Your report"].map((name, index) => (
              <li
                key={name}
                className={
                  index === (step === "privacy" ? 0 : step === "photo" ? 1 : 2)
                    ? "current"
                    : ""
                }
              >
                <span>{index + 1}</span>
                {name}
              </li>
            ))}
          </ol>
          <span className="beauty-progress-time">ABOUT 2 MIN</span>
        </nav>
      )}
      {step === "welcome" ? (
        <section className="beauty-welcome">
          <div className="beauty-welcome-copy">
            <span className="beauty-eyebrow">
              <Sparkles size={16} /> AELUNE / BEAUTY STUDIO
            </span>
            <h1 tabIndex={-1}>
              Your face.
              <br />
              Your colors.
              <br />
              <span>Your possibilities.</span>
            </h1>
            <p>
              Meet your features. Find your palette. Discover three makeup looks
              and a hairstyle that feels like you.
            </p>
            <div className="beauty-welcome-facts">
              <span>
                <LockKeyhole size={16} />
                No account
              </span>
              <span>
                <Camera size={16} />
                Photo optional
              </span>
            </div>
            {ready && !context?.device ? (
              <Link className="button primary" href="/kiosk/pair">
                Pair this tablet
                <ArrowRight size={19} />
              </Link>
            ) : (
              <button
                className="button primary"
                disabled={!ready || !context || !!busy}
                onClick={() => void start()}
              >
                Discover my beauty edit
                <ArrowRight size={19} />
              </button>
            )}
            {onSkin ? (
              <button
                className="beauty-text-button beauty-skin-entry"
                onClick={onSkin}
              >
                Explore skincare instead
                <ArrowRight size={16} />
              </button>
            ) : (
              <Link
                className="beauty-text-button beauty-skin-entry"
                href="/kiosk/skin"
              >
                Explore skincare instead
                <ArrowRight size={16} />
              </Link>
            )}
            <p className="beauty-small">
              AI style suggestions. Your choices always come first.
            </p>
          </div>
          <div className="beauty-welcome-visual">
            <HairPhoto
              index={5}
              label="Original illustrative beauty inspiration, not a customer result"
              className="beauty-hero-photo"
            />
            <span className="beauty-welcome-photo-label">
              STYLE INSPIRATION · NOT YOUR RESULT
            </span>
            <div className="beauty-floating-card beauty-floating-palette">
              <span>YOUR COLOR DIRECTION</span>
              <strong>Find your kind of color.</strong>
              <div>
                {personalColorPalettes[2].swatches.map((swatch) => (
                  <i key={swatch} style={{ background: swatch }} />
                ))}
              </div>
            </div>
            <div className="beauty-floating-card beauty-floating-feature">
              <ScanFace size={21} />
              <div>
                <strong>Made around you</strong>
                <span>Features · Color · Styling</span>
              </div>
              <Sparkles size={16} />
            </div>
          </div>
        </section>
      ) : step === "book" && state?.guide ? (
        <>
          <BeautyBook
            guide={state.guide}
            recommendations={state.recommendations}
            analysis={state.analysis}
            portraitUrl={portrait}
            makeupImages={makeup.images}
            makeupBusy={makeup.busy}
            makeupStatus={
              makeup.status ||
              (!makeup.accepted
                ? "Makeup image generation was not selected. These three cards are styling directions, not generated photos."
                : !state.makeup?.available
                  ? "Own-photo makeup previews are unavailable on this device. No substitute portrait is shown."
                  : "")
            }
            busy={!!busy}
            hairLength={basics.hairLength}
            onMoodChange={(mood) => void confirm({ mood })}
            onHairLengthChange={(hairLength) => void confirm({ hairLength })}
          />
          <section className="beauty-book-actions">
            <div>
              <strong>Your beauty book is ready.</strong>
              <span>Photos and generated images stay out of QR saves.</span>
            </div>
            <button
              className="beauty-text-button"
              disabled={!!busy}
              onClick={() => setStep("confirm")}
            >
              <SlidersHorizontal size={17} />
              Edit direction
            </button>
            <button
              className="button secondary"
              disabled={makeup.busy}
              onClick={() => {
                if (!state.guide || !state.preferences) return;
                downloadBeautyGuide({
                  guide: state.guide,
                  preferences: state.preferences,
                  products: state.recommendations.map(({ product, shade }) => ({
                    name: product.name,
                    brand: product.brand,
                    shadeName: shade.shadeName,
                    finish: shade.finish,
                    swatchHex: shade.swatchHex,
                    priceMinor: product.priceMinor,
                    currency: product.currency,
                  })),
                });
              }}
            >
              <Download size={18} />
              Download guide
            </button>
            <button
              className="button secondary"
              disabled={!state.sharingAvailable || makeup.busy}
              onClick={() => setSaveOpen(true)}
            >
              <QrCode size={18} />
              Save to my phone
            </button>
            <button className="button primary" onClick={() => void reset()}>
              Finish & clear session
              <Check size={18} />
            </button>
            {!state.sharingAvailable && (
              <p className="beauty-small beauty-share-unavailable">
                {state.shareUnavailableReason ??
                  "Phone QR needs a public HTTPS address. Downloads work here."}
              </p>
            )}
          </section>
        </>
      ) : (
        <section
          className={`beauty-step-card ${step === "photo" ? "beauty-photo-step" : ""}`}
        >
          <div className="beauty-step-heading">
            <span className="beauty-eyebrow">
              {step === "privacy"
                ? "01 / YOUR PERMISSION"
                : step === "photo"
                  ? "02 / YOUR PHOTO"
                  : "03 / YOUR DIRECTION"}
            </span>
            <h1 tabIndex={-1}>
              {step === "privacy" ? (
                <>
                  Your beauty.
                  <br />
                  <span>Your choice.</span>
                </>
              ) : step === "photo" ? (
                <>
                  Step into <span>the frame.</span>
                </>
              ) : (
                <>
                  A first look.
                  <br />
                  <span>Make it yours.</span>
                </>
              )}
            </h1>
            <p>
              {step === "privacy"
                ? "A private, anonymous moment to explore your style."
                : step === "photo"
                  ? "One photo for your visible features and color direction. No long questionnaire."
                  : "Review this starting direction, then create your beauty book with one tap."}
            </p>
          </div>
          {step === "privacy" && (
            <>
              <div className="beauty-privacy">
                <div>
                  <ShieldCheck size={22} />
                  <strong>Private by design</strong>
                  <p>
                    No account. Your temporary kiosk session clears when you
                    finish or leave it idle.
                  </p>
                </div>
                <div>
                  <Camera size={22} />
                  <strong>You choose the photo</strong>
                  <p>
                    Separate permission before any photo leaves this device. No
                    app photo storage or training.
                  </p>
                </div>
                <div>
                  <QrCode size={22} />
                  <strong>Keep just the guide</strong>
                  <p>
                    Optional QR saving includes confirmed style choices and
                    store shades, never your photos.
                  </p>
                </div>
              </div>
              <label className="beauty-check">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  I agree to this temporary beauty consultation and its privacy
                  notice.
                </span>
              </label>
              <div className="beauty-step-actions">
                <span>
                  <LockKeyhole size={15} />
                  No guest account needed
                </span>
                <button
                  className="button primary"
                  disabled={!accepted || !!busy}
                  onClick={() => void privacy()}
                >
                  Continue to my photo
                  <ArrowRight size={19} />
                </button>
              </div>
            </>
          )}
          {step === "photo" && (
            <>
              <div className="beauty-photo-layout">
                <div className="beauty-camera-stage">
                  {camera ? (
                    <>
                      <video
                        ref={video}
                        muted
                        autoPlay
                        playsInline
                        aria-label="Beauty camera preview"
                      />
                      <div className="beauty-face-frame" aria-hidden="true" />
                      <div className="beauty-camera-status" role="status">
                        {faceCamera.countdown !== null ? (
                          <>
                            <strong>{faceCamera.countdown}</strong>
                            <span>Hold still · capturing automatically</span>
                          </>
                        ) : (
                          <>
                            <ScanFace size={24} />
                            <span>
                              {faceCamera.detectorState === "loading"
                                ? "Starting local face positioning…"
                                : faceCamera.detectorState === "unavailable"
                                  ? "Positioning is unavailable. Upload a photo or continue without one."
                                  : "Center one face. Hold still for a 3-second countdown."}
                            </span>
                          </>
                        )}
                      </div>
                      <button
                        className="beauty-pause-camera"
                        onClick={() => {
                          clearMedia();
                          setCamera(false);
                        }}
                      >
                        Pause camera
                      </button>
                    </>
                  ) : preview ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview} alt="New beauty photo, not yet sent" />
                      <span className="beauty-photo-tag">READY TO ANALYZE</span>
                    </>
                  ) : (
                    <div className="beauty-camera-empty">
                      <div>
                        <ScanFace size={52} />
                      </div>
                      <strong>
                        {state?.attempted
                          ? "Your photo attempt is complete"
                          : "Your look starts with you"}
                      </strong>
                      <p>
                        {state?.attempted
                          ? "Continue with your direction. No second analysis will be sent."
                          : "Even light. No beauty filters. One person in the frame."}
                      </p>
                      <span
                        className="beauty-camera-corners"
                        aria-hidden="true"
                      />
                    </div>
                  )}
                </div>
                <div className="beauty-photo-permissions">
                  {state?.photoAvailable ? (
                    <>
                      {makeupConsentControl}
                      <label className="beauty-check">
                        <input
                          type="checkbox"
                          checked={photoAccepted}
                          disabled={!!busy && !photoAccepted}
                          onChange={(event) =>
                            void changePhotoConsent(event.target.checked)
                          }
                        />
                        <span>
                          Analyze my photo with OpenAI
                          <small>
                            I am an adult and the only person in this photo. My
                            new photo is processed in memory for approximate
                            features and color suggestions. OpenAI may retain
                            abuse-monitoring logs for up to 30 days. Earlier
                            skin photos are never reused.
                          </small>
                        </span>
                      </label>
                    </>
                  ) : (
                    <p className="beauty-callout">
                      Photo analysis is unavailable on this device. Explore a
                      complete guide without a photo.
                    </p>
                  )}
                  {!state?.attempted && (
                    <div className="beauty-camera-actions">
                      <button
                        className="button primary"
                        disabled={
                          !photoAccepted ||
                          !state?.photoAvailable ||
                          !!busy ||
                          faceCamera.opening
                        }
                        onClick={openCamera}
                      >
                        <Camera size={19} />
                        {faceCamera.opening ? "Opening camera…" : "Open camera"}
                      </button>
                      <label
                        className={`button secondary beauty-upload ${!photoAccepted || !!busy ? "disabled" : ""}`}
                      >
                        <Upload size={18} />
                        Upload a new photo
                        <input
                          type="file"
                          aria-label="New beauty photo"
                          accept="image/jpeg,image/png,image/webp"
                          disabled={
                            !photoAccepted || !state?.photoAvailable || !!busy
                          }
                          onChange={(event) => {
                            choosePhoto(event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  )}
                  <p className="beauty-small">
                    Camera positioning runs locally. Once stable, a cancellable
                    3-second countdown captures and analyzes one photo. Uploaded
                    photos wait for your tap.
                  </p>
                  {faceCamera.error && (
                    <p className="notice error" role="alert">
                      {faceCamera.error}
                    </p>
                  )}
                </div>
              </div>
              <div className="beauty-step-actions">
                <button
                  className="beauty-text-button"
                  disabled={!!busy}
                  onClick={skipPhoto}
                >
                  {state?.attempted
                    ? "Continue with my direction"
                    : "Continue without a photo"}
                  <ArrowRight size={17} />
                </button>
                {preview && (
                  <button
                    className="button primary"
                    disabled={!!busy}
                    onClick={() => void analyze()}
                  >
                    Analyze new photo
                    <ArrowRight size={19} />
                  </button>
                )}
              </div>
            </>
          )}
          {step === "confirm" && (
            <>
              <div className="beauty-confirm-summary">
                <div className="beauty-confirm-photo">
                  {portrait ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={portrait}
                        alt="Your photo for this temporary consultation"
                      />
                    </>
                  ) : (
                    <ScanFace size={54} />
                  )}
                </div>
                <div>
                  <span className="beauty-eyebrow">
                    {suggested
                      ? "PHOTO-SUGGESTED DIRECTION"
                      : "AN OPEN STARTING DIRECTION"}
                  </span>
                  <h2>{selectedPalette.name}</h2>
                  <div
                    className="beauty-choice-swatches"
                    aria-label="Suggested palette swatches"
                  >
                    {selectedPalette.swatches.map((swatch) => (
                      <i key={swatch} style={{ background: swatch }} />
                    ))}
                  </div>
                  <p>
                    {faceShape && faceShape !== "unsure"
                      ? `${label(faceShape)} face direction`
                      : "Face shape open to exploring"}{" "}
                    · All hair lengths ·{" "}
                    {makeup.accepted
                      ? "3 own-photo makeup previews"
                      : "3 makeup styling directions"}
                  </p>
                  <span className="beauty-confirm-note">
                    Your next tap confirms this palette and outline for the
                    styling guide. You can adjust either below.
                  </span>
                </div>
              </div>
              <FaceFeatures analysis={state?.analysis} />
              {state?.analysis?.quality_flags.length ? (
                <p className="beauty-small">
                  Photo limitations:{" "}
                  {state.analysis.quality_flags
                    .map((flag) => flag.replaceAll("_", " "))
                    .join(", ")}
                  . Unclear features remain undetermined.
                </p>
              ) : null}
              <details className="beauty-adjust">
                <summary>
                  <SlidersHorizontal size={18} />
                  Adjust my direction (optional)
                </summary>
                <fieldset className="beauty-palette-options">
                  <legend>Palette to explore</legend>
                  <div>
                    {personalColorPalettes.map((option) => (
                      <label
                        key={option.id}
                        className={palette === option.id ? "selected" : ""}
                      >
                        <input
                          type="radio"
                          name="beauty-palette"
                          checked={palette === option.id}
                          onChange={() => setPalette(option.id)}
                        />
                        <span>
                          <strong>{option.name}</strong>
                          <span
                            className="beauty-choice-swatches"
                            aria-hidden="true"
                          >
                            {option.swatches.map((swatch) => (
                              <i key={swatch} style={{ background: swatch }} />
                            ))}
                          </span>
                          <small>{option.description}</small>
                          {option.id === suggested && (
                            <small>Photo suggestion</small>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="beauty-form-row">
                  <label>
                    Face outline to explore
                    <select
                      value={faceShape}
                      onChange={(event) =>
                        setFaceShape(
                          event.target.value as BeautyPreferences["faceShape"],
                        )
                      }
                    >
                      {faceShapes.map((shape) => (
                        <option key={shape} value={shape}>
                          {shape === "unsure"
                            ? "Open / not sure"
                            : `${label(shape)}${shape === suggestedShape ? " · photo suggestion" : ""}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Preferred lip finish
                    <select
                      value={basics.finish}
                      onChange={(event) =>
                        setBasics((value) => ({
                          ...value,
                          finish: event.target
                            .value as BeautyPreferences["finish"],
                        }))
                      }
                    >
                      <option value="any">Any finish</option>
                      {lipFinishes.map((finish) => (
                        <option key={finish} value={finish}>
                          {label(finish)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
              <details className="beauty-exclusions">
                <summary>Ingredients I want to avoid (optional)</summary>
                <p className="beauty-small">
                  Filters store lip products. Check the full label; this does
                  not establish allergy safety.
                </p>
                <label>
                  Add an ingredient to avoid
                  <select
                    value={ingredient}
                    onChange={(event) => {
                      const name = event.target.value;
                      setIngredient("");
                      if (name && !exclusions.includes(name))
                        setExclusions((value) => [...value, name]);
                    }}
                  >
                    <option value="">Choose a registered ingredient</option>
                    {state?.ingredients
                      .filter((name) => !exclusions.includes(name))
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="beauty-exclusion-tags">
                  {exclusions.map((name) => (
                    <button
                      type="button"
                      key={name}
                      aria-label={`Remove exclusion ${name}`}
                      onClick={() =>
                        setExclusions((value) =>
                          value.filter((item) => item !== name),
                        )
                      }
                    >
                      {name}
                      <X size={14} />
                    </button>
                  ))}
                </div>
              </details>
              <div className="beauty-step-actions">
                <span>
                  AI suggestions are approximate. No face needs correcting.
                </span>
                <button
                  className="button primary"
                  disabled={!palette || !faceShape || !!busy}
                  onClick={() => void confirm()}
                >
                  Confirm & see my beauty book
                  <ArrowRight size={19} />
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {error && (
        <div className="beauty-feedback notice error" role="alert">
          {error}
        </div>
      )}
      {(busy || notice) && (
        <p
          className={`beauty-feedback ${makeup.busy ? "beauty-generating-status" : ""}`}
          role="status"
        >
          {makeup.busy && <WandSparkles size={20} />}
          {makeup.busy ? makeup.status : busy || notice}
        </p>
      )}
      <footer className="beauty-footer">
        <span>
          <LockKeyhole size={14} />
          Private by design
        </span>
        <span>AI beauty inspiration · Always your choice</span>
      </footer>
      {idle && (
        <Modal
          title="Still exploring?"
          close={() => {
            lastActivity.current = Date.now();
            setIdle(false);
          }}
        >
          <p>This kiosk will clear your temporary consultation soon.</p>
          <button
            className="button primary wide"
            onClick={() => {
              lastActivity.current = Date.now();
              setIdle(false);
            }}
          >
            Keep exploring
          </button>
          <button
            className="button secondary wide"
            onClick={() => void reset()}
          >
            Finish & clear session
          </button>
        </Modal>
      )}
      {saveOpen && (
        <Modal title="Save your beauty guide" close={closeSave}>
          <div className="beauty-share-panel">
            <p>
              Save confirmed style choices and registered lip matches. Your
              original photo, generated makeup previews and AI feature
              observations are excluded.
            </p>
            {share ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={share.qrDataUrl}
                  alt="QR code to open your saved beauty guide on your phone"
                />
                <p>
                  Scan with your phone. Available until{" "}
                  {new Date(share.expiresAt).toLocaleString()}.
                </p>
                <p className="beauty-small">
                  Anyone with this link can view it until expiry. Delete it from
                  the phone page at any time.
                </p>
              </>
            ) : (
              <>
                <label className="beauty-check">
                  <input
                    type="checkbox"
                    checked={shareAccepted}
                    onChange={(event) => setShareAccepted(event.target.checked)}
                  />
                  <span>
                    Save this guide for seven days for anyone holding its
                    private link. This is separate from clearing my kiosk
                    session.
                  </span>
                </label>
                <button
                  className="button primary wide"
                  disabled={
                    !shareAccepted || !!busy || !state?.sharingAvailable
                  }
                  onClick={() =>
                    void run(
                      "Preparing your private link…",
                      async (signal, current) => {
                        const value = await api<Share>(
                          `kiosk/sessions/${session.current}/beauty-share`,
                          {
                            method: "POST",
                            body: json({
                              accepted: true,
                              noticeVersion: "2026-10-beauty-save-v1",
                            }),
                            signal,
                          },
                        );
                        if (current()) setShare(value);
                      },
                    )
                  }
                >
                  Create my phone QR code
                  <QrCode size={18} />
                </button>
              </>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {busy && <p role="status">{busy}</p>}
          </div>
        </Modal>
      )}
    </main>
  );
}
