"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowLeft,
  Camera,
  Check,
  Download,
  LockKeyhole,
  QrCode,
  ScanFace,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import type { Consultation, DeviceContext } from "@/application/contracts";
import type { CompleteBeautyView } from "@/application/beauty-complete";
import {
  guestAgeBands,
  COMPLETE_SAVE_NOTICE_VERSION,
  type BeautyLocale,
  type GuestAgeBand,
  type GuestGender,
  type CompleteSavedGuide,
  type CompleteSkinProfile,
} from "@/application/beauty-complete-contracts";
import {
  BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION,
  type BeautyCompleteAnalysis,
} from "@/domain/beauty-complete";
import { faceShapes, type BeautyPreferences } from "@/domain/beauty";
import type { BaseChoice } from "@/domain/cosmetic-shades";
import { concerns, skinTypes } from "@/domain/types";
import {
  personalColorPalettes,
  suggestedPalette,
  type PaletteId,
} from "@/domain/personal-color";
import { api, json } from "./api";
import { Brand } from "./brand";
import { Modal } from "./modal";
import { HairPhoto } from "./beauty-book";
import {
  CompleteBeautyBook,
  downloadCompleteGuide,
} from "./complete-beauty-book";
import { bt, beautyLabel, beautyLocales } from "./beauty-i18n";
import { useBeautyPreviews } from "./use-beauty-previews";
import { useFaceCamera } from "./use-face-camera";
import { useFaceRatios } from "./use-face-ratios";
import { stylingDirectionForGender } from "@/domain/beauty-styling";
import "./beauty-kiosk.css";

type Step = "welcome" | "age" | "privacy" | "photo" | "confirm" | "book";
type Share = { url: string; expiresAt: string; qrDataUrl: string };
const initialPreferences: BeautyPreferences = {
  paletteId: "neutral_soft",
  faceShape: "unsure",
  hairLength: "any",
  mood: "soft",
  finish: "any",
};
const initialBase: BaseChoice = {
  depth: "unknown",
  undertone: "unknown",
  concealerPurpose: "match",
};
export function BeautyCompleteKiosk() {
  const [step, setStep] = useState<Step>("welcome");
  const [locale, setLocale] = useState<BeautyLocale>("en");
  const [device, setDevice] = useState<DeviceContext | null>(null);
  const [ready, setReady] = useState(false);
  const [value, setValue] = useState<CompleteBeautyView | null>(null);
  const [analysis, setAnalysis] = useState<BeautyCompleteAnalysis | null>(null);
  const [ageBand, setAgeBand] = useState<GuestAgeBand | "">("");
  const [gender, setGender] = useState<GuestGender | null>(null);
  const [analytics, setAnalytics] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [photoAccepted, setPhotoAccepted] = useState(false);
  const [preferences, setPreferences] =
    useState<BeautyPreferences>(initialPreferences);
  const [base, setBase] = useState<BaseChoice>(initialBase);
  const [profile, setProfile] = useState<CompleteSkinProfile>({
    skinType: "unsure",
    concerns: [],
    excludedIngredients: [],
  });
  const [skinOpen, setSkinOpen] = useState(false);
  const [camera, setCamera] = useState(false);
  const [upload, setUpload] = useState("");
  const [portrait, setPortrait] = useState("");
  const [busy, setBusy] = useState(false);
  const [usedAttempt, setUsedAttempt] = useState(false);
  const [error, setError] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [idle, setIdle] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [shareAccepted, setShareAccepted] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const session = useRef<string | null>(null);
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const generationRequest = useRef<AbortController | null>(null);
  const source = useRef<File | null>(null);
  const uploadUrl = useRef("");
  const portraitUrl = useRef("");
  const attempt = useRef(false);
  const photoConsent = useRef(false);

  const demographic = useRef({ gender, analytics, ageBand });
  useEffect(() => {
    demographic.current = { gender, analytics, ageBand };
  }, [gender, analytics, ageBand]);
  const lastActivity = useRef(0);
  const expiresAt = useRef(0);
  const main = useRef<HTMLElement>(null);
  const previews = useBeautyPreviews(session);
  const {
    reset: resetPreviews,
    cancel: cancelPreviews,
    active: previewActive,
  } = previews;
  const ratios = useFaceRatios();
  const { clear: clearRatios } = ratios;
  const cameraView = useFaceCamera({
    active:
      camera &&
      step === "photo" &&
      photoAccepted &&
      !usedAttempt &&
      !idle &&
      !busy,
    onCapture(blob) {
      void analyze(
        new File([blob], "beauty-capture.jpg", { type: "image/jpeg" }),
      );
    },
  });
  const {
    video,
    stopCamera,
    countdown,
    error: cameraError,
    assessment,
    detectorState,
  } = cameraView;
  const text = (key: Parameters<typeof bt>[1]) => bt(locale, key);
  const label = (id: string) => beautyLabel(locale, id);
  const adult = !!ageBand && !["under13", "13-15", "16-17"].includes(ageBand);
  const stylingDirection = stylingDirectionForGender(adult ? gender : null);
  const photoEligible = !!value?.beauty.photoAvailable;
  const cameraHint =
    detectorState === "loading" && camera
      ? "cameraLoading"
      : detectorState === "unavailable"
        ? "cameraUnavailable"
        : assessment?.status === "multiple-faces"
          ? "faceMultiple"
          : assessment?.status === "too-far"
            ? "faceFar"
            : assessment?.status === "too-close"
              ? "faceClose"
              : assessment?.status === "ready"
                ? "faceReady"
                : "centerFace";

  const clearMedia = useCallback(() => {
    stopCamera();
    source.current = null;
    if (uploadUrl.current) URL.revokeObjectURL(uploadUrl.current);
    if (portraitUrl.current) URL.revokeObjectURL(portraitUrl.current);
    uploadUrl.current = "";
    portraitUrl.current = "";
    clearRatios();
    cancelPreviews();
    generationRequest.current?.abort();
    generationRequest.current = null;
  }, [stopCamera, clearRatios, cancelPreviews]);
  const cancel = useCallback(() => {
    epoch.current++;
    request.current?.abort();
    request.current = null;
    clearMedia();
  }, [clearMedia]);
  const reset = useCallback(
    async (beacon = false) => {
      const id = session.current;
      const data = demographic.current;
      const aggregateGender =
        data.analytics && !["under13", "13-15", "16-17"].includes(data.ageBand)
          ? data.gender
          : null;
      cancel();
      session.current = null;
      expiresAt.current = 0;
      photoConsent.current = false;
      attempt.current = false;
      setUsedAttempt(false);
      resetPreviews();
      setStep("welcome");
      setValue(null);
      setAnalysis(null);
      setAgeBand("");
      setGender(null);
      setAnalytics(false);
      setAccepted(false);
      setPhotoAccepted(false);
      setPreferences(initialPreferences);
      setBase(initialBase);
      setProfile({ skinType: "unsure", concerns: [], excludedIngredients: [] });
      setSkinOpen(false);
      setCamera(false);
      setUpload("");
      setPortrait("");
      setBusy(false);
      setError(false);
      setCleared(false);
      setIdle(false);
      setSaveOpen(false);
      setShareAccepted(false);
      setShare(null);
      if (!id) return;
      const body = json({ gender: aggregateGender });
      if (beacon) {
        navigator.sendBeacon(
          `/api/v1/kiosk/sessions/${id}/beauty-complete-finish`,
          new Blob([body], { type: "application/json" }),
        );
        return;
      }
      try {
        await api(`kiosk/sessions/${id}/beauty-complete-finish`, {
          method: "POST",
          body,
        });
      } catch {
        /* Server expiry handles abandoned sessions. */
      }
    },
    [cancel, resetPreviews],
  );
  useEffect(() => {
    const controller = new AbortController();
    api<{ device: DeviceContext | null }>("context", {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setDevice(next.device);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
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
      setUpload("");
      setPortrait("");
      setBusy(false);
      setCleared(true);
    };
    const leave = () => {
      void reset(true);
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) leave();
    };
    const timer = window.setInterval(() => {
      if (!session.current) return;
      if (expiresAt.current && Date.now() >= expiresAt.current) {
        void reset();
        return;
      }
      if (previewActive.current) return;
      const elapsed = Date.now() - lastActivity.current;
      if (elapsed >= 120000) void reset();
      else if (elapsed >= 90000) setIdle(true);
    }, 1000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", restore);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", restore);
      leave();
    };
  }, [cancel, reset, previewActive]);
  useEffect(() => {
    main.current
      ?.querySelector<HTMLElement>("h1")
      ?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step]);
  async function run(
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const own = ++epoch.current;
    const current = () => own === epoch.current && !controller.signal.aborted;
    setBusy(true);
    setError(false);
    setCleared(false);
    try {
      await work(controller.signal, current);
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function start() {
    await run(async (signal, current) => {
      const next = await api<Consultation>("kiosk/sessions", {
        method: "POST",
        body: "{}",
        signal,
      });
      if (!current()) {
        void api(`kiosk/sessions/${next.id}/finish`, {
          method: "POST",
          body: "{}",
        }).catch(() => {});
        return;
      }
      session.current = next.id;
      expiresAt.current = Date.now() + 15 * 60 * 1000;
      lastActivity.current = Date.now();
      setStep("age");
    });
  }
  async function saveContext() {
    if (!ageBand) return;
    await run(async (signal, current) => {
      const next = await api<CompleteBeautyView>(
        `kiosk/sessions/${session.current}/beauty-context`,
        {
          method: "POST",
          body: json({ ageBand, locale, analyticsConsent: adult && analytics }),
          signal,
        },
      );
      if (current()) {
        setValue(next);
        setStep("privacy");
      }
    });
  }
  async function privacy() {
    if (!accepted) return;
    await run(async (signal, current) => {
      await api(`kiosk/sessions/${session.current}/consent`, {
        method: "POST",
        body: json({ accepted: true, visionAccepted: false }),
        signal,
      });
      let next = await api<CompleteBeautyView>(
        `kiosk/sessions/${session.current}/beauty-complete`,
        { signal },
      );
      if (photoAccepted && next.beauty.photoAvailable) {
        next = await api<CompleteBeautyView>(
          `kiosk/sessions/${session.current}/beauty-complete-consent`,
          {
            method: "POST",
            signal,
            body: json({
              accepted: true,
              noticeVersion: BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION,
            }),
          },
        );
        if (previews.accepted) await previews.changeConsent(true, signal);
      } else if (next.completeConsent) {
        next = await api<CompleteBeautyView>(
          `kiosk/sessions/${session.current}/beauty-complete-consent`,
          {
            method: "POST",
            signal,
            body: json({
              accepted: false,
              noticeVersion: BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION,
            }),
          },
        );
        previews.stageConsent(false);
      }
      if (!current()) return;
      setValue(next);
      photoConsent.current = photoAccepted && next.completeConsent;
      setProfile(next.skinProfile);
      if (photoConsent.current) {
        setStep("photo");
        setCamera(true);
      } else setStep("confirm");
    });
  }
  async function withdrawPhoto() {
    photoConsent.current = false;
    setPhotoAccepted(false);
    cancel();
    setCamera(false);
    setUpload("");
    setPortrait("");
    setAnalysis(null);
    setPreferences(initialPreferences);
    setBase(initialBase);
    previews.stageConsent(false);
    await run(async (signal, current) => {
      const next = await api<CompleteBeautyView>(
        `kiosk/sessions/${session.current}/beauty-complete-consent`,
        {
          method: "POST",
          body: json({
            accepted: false,
            noticeVersion: BEAUTY_COMPLETE_PHOTO_NOTICE_VERSION,
          }),
          signal,
        },
      );
      if (current()) setValue(next);
    });
  }
  function choosePhoto(file?: File) {
    if (!file || !photoConsent.current || attempt.current || !photoEligible)
      return;
    stopCamera();
    setCamera(false);
    if (uploadUrl.current) URL.revokeObjectURL(uploadUrl.current);
    source.current = null;
    setUpload("");
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    ) {
      setError(true);
      return;
    }
    source.current = file;
    uploadUrl.current = URL.createObjectURL(file);
    setUpload(uploadUrl.current);
    setError(false);
  }
  async function analyze(captured?: File) {
    const image = captured ?? source.current;
    if (!image || attempt.current || !photoConsent.current || busy) return;
    attempt.current = true;
    setUsedAttempt(true);
    source.current = null;
    stopCamera();
    setCamera(false);
    if (uploadUrl.current) URL.revokeObjectURL(uploadUrl.current);
    uploadUrl.current = "";
    setUpload("");
    portraitUrl.current = URL.createObjectURL(image);
    setPortrait(portraitUrl.current);
    previews.keepSource(image);
    void ratios.measure(image);
    await run(async (signal, current) => {
      const response = await fetch(
        `/api/v1/kiosk/sessions/${session.current}/beauty-complete-analysis`,
        {
          method: "POST",
          body: image,
          headers: { "Content-Type": image.type },
          credentials: "same-origin",
          cache: "no-store",
          signal,
        },
      );
      const next = (await response.json()) as CompleteBeautyView;
      if (!response.ok) {
        previews.releaseSource();
        throw new Error("analysis_unavailable");
      }
      if (current()) {
        setValue(next);
        setAnalysis(next.analysis);
        if (next.analysis?.beauty.image_quality !== "usable")
          previews.releaseSource();
        setPreferences({
          ...initialPreferences,
          paletteId:
            suggestedPalette(next.analysis?.beauty ?? null) ?? "neutral_soft",
          faceShape:
            next.analysis?.beauty.image_quality === "usable" &&
            next.analysis.beauty.face_shape !== "uncertain"
              ? next.analysis.beauty.face_shape
              : "unsure",
        });
        setBase({
          depth:
            next.analysis?.baseDepth && next.analysis.baseDepth !== "uncertain"
              ? next.analysis.baseDepth
              : "unknown",
          undertone:
            next.analysis?.beauty.undertone &&
            next.analysis.beauty.undertone !== "uncertain"
              ? next.analysis.beauty.undertone
              : "unknown",
          concealerPurpose: "match",
        });
        setStep("confirm");
      }
    });
  }
  function skipPhoto() {
    stopCamera();
    source.current = null;
    if (uploadUrl.current) URL.revokeObjectURL(uploadUrl.current);
    uploadUrl.current = "";
    setCamera(false);
    setUpload("");
    previews.releaseSource();
    setError(false);
    setStep("confirm");
  }
  async function confirm(nextPreferences = preferences) {
    if (step === "book") cancelPreviews();
    generationRequest.current?.abort();
    await run(async (signal, current) => {
      const next = await api<CompleteBeautyView>(
        `kiosk/sessions/${session.current}/beauty-complete-preferences`,
        {
          method: "POST",
          signal,
          body: json({
            preferences: nextPreferences,
            baseDepth: base.depth,
            baseUndertone: base.undertone,
            concealerPurpose: base.concealerPurpose,
          }),
        },
      );
      if (!current()) return;
      setValue(next);
      setPreferences(nextPreferences);
      setStep("book");
      if (
        next.preview.available &&
        previews.accepted &&
        analysis?.beauty.image_quality === "usable"
      ) {
        const controller = new AbortController();
        generationRequest.current = controller;
        void previews
          .generate(
            controller.signal,
            () => session.current !== null && !controller.signal.aborted,
            stylingDirection,
          )
          .finally(() => {
            lastActivity.current = Date.now();
          });
      }
    });
  }
  async function localeChange(next: BeautyLocale) {
    setLocale(next);
    if (!session.current || !ageBand) return;
    try {
      await api(`kiosk/sessions/${session.current}/beauty-context`, {
        method: "POST",
        body: json({
          ageBand,
          locale: next,
          analyticsConsent: adult && analytics,
        }),
      });
    } catch {
      setError(true);
    }
  }
  function currentSaved(): CompleteSavedGuide | null {
    if (!value?.beauty.preferences) return null;
    return {
      version: "beauty-complete-guide-v1",
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      locale,
      preferences: value.beauty.preferences,
      products: [
        ...value.skinRecommendations.map(({ product }) => ({
          variantId: product.id,
          category: product.category,
          formulationVersionId: "",
          shadeVersionId: null,
          name: product.name,
          brand: product.brand,
          shadeName: null,
          swatchHex: null,
          priceMinor: product.priceMinor,
          currency: product.currency,
          available: true,
        })),
        ...value.cosmetics.map(({ product, shade }) => ({
          variantId: product.id,
          category: shade.category,
          formulationVersionId: "",
          shadeVersionId: shade.versionId,
          name: product.name,
          brand: product.brand,
          shadeName: shade.shadeName,
          swatchHex: shade.swatchHex,
          priceMinor: product.priceMinor,
          currency: product.currency,
          available: true,
        })),
      ],
    };
  }
  const primaryLabel =
    step === "welcome"
      ? text("start")
      : step === "age"
        ? text("next")
        : step === "privacy"
          ? text("next")
          : step === "photo"
            ? upload
              ? text("analyze")
              : text("withoutPhoto")
            : step === "confirm"
              ? text("confirm")
              : "";
  const primaryDisabled =
    step === "welcome"
      ? !ready || !device
      : step === "age"
        ? !ageBand
        : step === "privacy"
          ? !accepted
          : step === "confirm"
            ? !value
            : false;
  async function primaryAction() {
    if (step === "welcome") await start();
    else if (step === "age") await saveContext();
    else if (step === "privacy") await privacy();
    else if (step === "photo") {
      if (upload) await analyze();
      else skipPhoto();
    } else if (step === "confirm") await confirm();
  }
  return (
    <div className="beauty-shell beauty-complete-shell" lang={locale}>
      <header className="beauty-header">
        <Brand />
        <div className="complete-top-controls">
          <label className="complete-language">
            <span className="sr-only">Language / 언어 / Idioma</span>
            <select
              value={locale}
              onChange={(event) =>
                void localeChange(event.target.value as BeautyLocale)
              }
            >
              {beautyLocales.map((item) => (
                <option key={item} value={item}>
                  {item === "en"
                    ? "English"
                    : item === "ko"
                      ? "한국어"
                      : "Español"}
                </option>
              ))}
            </select>
          </label>
          {step !== "welcome" && (
            <button className="text-button" onClick={() => void reset()}>
              <X size={18} />
              {text("end")}
            </button>
          )}
        </div>
      </header>
      <main ref={main} className={`complete-main complete-step-${step}`}>
        {error && (
          <div role="alert" className="complete-alert">
            {text("networkError")}
          </div>
        )}
        {cleared && (
          <div role="status" className="complete-alert">
            {text("cleared")}
          </div>
        )}
        {step === "welcome" && (
          <section className="complete-welcome">
            <div className="complete-welcome-copy">
              <span className="beauty-eyebrow">{text("studio")}</span>
              <h1 tabIndex={-1}>{text("welcomeTitle")}</h1>
              <p>{text("welcomeBody")}</p>
              <div className="complete-welcome-tags">
                <span>
                  <LockKeyhole size={18} />
                  {text("noAccount")}
                </span>
                <span>
                  <ScanFace size={18} />
                  {text("optionalPhoto")}
                </span>
              </div>
              {ready && !device && (
                <Link className="button" href="/pair">
                  {text("pair")}
                </Link>
              )}
            </div>
            <div className="complete-welcome-visual">
              <HairPhoto index={4} label={text("reference")} />
              <div className="complete-welcome-visual-label">
                <Sparkles size={20} />
                {text("skinTitle")} · {text("palette")}
                <span>{text("reference")}</span>
              </div>
              <div className="complete-floating-chip">
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </section>
        )}
        {step === "age" && (
          <section className="complete-form-page">
            <span className="beauty-eyebrow">01 · {text("age")}</span>
            <h1 tabIndex={-1}>{text("ageTitle")}</h1>
            <p>{text("ageBody")}</p>
            <fieldset className="complete-age-grid">
              <legend>{text("age")}</legend>
              {guestAgeBands.map((item) => (
                <button
                  type="button"
                  className={`complete-choice ${ageBand === item ? "selected" : ""}`}
                  aria-pressed={ageBand === item}
                  key={item}
                  onClick={() => {
                    setAgeBand(item);
                    if (["under13", "13-15", "16-17"].includes(item)) {
                      setGender(null);
                      setAnalytics(false);
                    }
                  }}
                >
                  {item === "under13" ? text("under13") : item}
                  {ageBand === item && <Check size={20} />}
                </button>
              ))}
            </fieldset>
            {adult && (
              <details className="complete-details">
                <summary>{text("gender")}</summary>
                <p>{text("genderNotice")}</p>
                <label>
                  {text("gender")}
                  <select
                    value={gender ?? ""}
                    onChange={(event) =>
                      setGender(
                        event.target.value
                          ? (event.target.value as GuestGender)
                          : null,
                      )
                    }
                  >
                    <option value="">{text("unknown")}</option>
                    {[
                      "woman",
                      "man",
                      "nonbinary",
                      "self_described",
                      "prefer_not_to_say",
                    ].map((item) => (
                      <option key={item} value={item}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="complete-checkbox">
                  <input
                    type="checkbox"
                    checked={analytics}
                    onChange={(event) => setAnalytics(event.target.checked)}
                  />
                  <span>{text("analytics")}</span>
                </label>
              </details>
            )}
          </section>
        )}
        {step === "privacy" && (
          <section className="complete-form-page">
            <span className="beauty-eyebrow">02 · {text("private")}</span>
            <h1 tabIndex={-1}>{text("privacyTitle")}</h1>
            <p>{text("privacyBody")}</p>
            <label className="complete-consent complete-checkbox">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
                disabled={busy}
              />
              <span>
                <strong>{text("consultationConsent")}</strong>
                <span>
                  {text("noAccount")} · {text("optionalPhoto")}
                </span>
              </span>
            </label>
            {photoEligible ? (
              <>
                <label className="complete-consent complete-checkbox">
                  <input
                    type="checkbox"
                    checked={previews.accepted}
                    onChange={(event) =>
                      previews.stageConsent(event.target.checked)
                    }
                    disabled={busy || !value?.preview.available}
                  />
                  <span>
                    <strong>{text("previewConsent")}</strong>
                    <span>{text("previewPrivacy")}</span>
                    {!value?.preview.available && (
                      <span>{text("unavailable")}</span>
                    )}
                  </span>
                </label>
                <label className="complete-consent complete-checkbox">
                  <input
                    type="checkbox"
                    checked={photoAccepted}
                    onChange={(event) => setPhotoAccepted(event.target.checked)}
                    disabled={busy}
                  />
                  <span>
                    <strong>{text("photoConsent")}</strong>
                    <span>{text("photoPrivacy")}</span>
                  </span>
                </label>
              </>
            ) : (
              <div className="complete-empty">
                <ShieldCheck size={28} />
                <p>
                  {text(
                    ageBand === "under13" ? "childNoPhoto" : "teenDisabled",
                  )}
                </p>
              </div>
            )}
          </section>
        )}
        {step === "photo" && (
          <section className="complete-photo-page">
            <div>
              <span className="beauty-eyebrow">03 · {text("ownPhoto")}</span>
              <h1 tabIndex={-1}>{text("photoTitle")}</h1>
              <p>{text("photoBody")}</p>
              <label className="complete-checkbox">
                <input
                  type="checkbox"
                  checked={photoAccepted}
                  disabled={busy && !photoAccepted}
                  onChange={() => void withdrawPhoto()}
                />
                <span>{text("photoConsent")}</span>
              </label>
              {usedAttempt && <p>{text("once")}</p>}
            </div>
            <div className="complete-camera">
              <div className="complete-camera-frame">
                {camera ? (
                  <>
                    <video
                      ref={video}
                      autoPlay
                      playsInline
                      muted
                      aria-label={text("ownPhoto")}
                    />
                    <div className="complete-camera-oval" aria-hidden="true" />
                    {countdown !== null && (
                      <strong className="complete-countdown">
                        {countdown}
                      </strong>
                    )}
                  </>
                ) : upload ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={upload} alt={text("ownPhoto")} />
                  </>
                ) : (
                  <ScanFace size={90} aria-hidden="true" />
                )}
                <span className="complete-camera-status" role="status">
                  {busy
                    ? text("analyzing")
                    : countdown !== null
                      ? bt(locale, "captureIn", { count: countdown })
                      : text(cameraHint)}
                </span>
              </div>
              {cameraError && <p role="alert">{text("cameraUnavailable")}</p>}
              <div className="complete-photo-actions">
                <button
                  className="button secondary"
                  disabled={busy || usedAttempt || !photoAccepted}
                  onClick={() => {
                    if (camera) {
                      stopCamera();
                      setCamera(false);
                    } else {
                      setCamera(true);
                    }
                  }}
                >
                  <Camera size={20} />
                  {text(camera ? "pauseCamera" : "openCamera")}
                </button>
                <label
                  className={`button secondary ${busy || usedAttempt || !photoAccepted ? "disabled" : ""}`}
                >
                  <Upload size={20} />
                  {text("upload")}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy || usedAttempt || !photoAccepted}
                    onChange={(event) => {
                      choosePhoto(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
          </section>
        )}
        {step === "confirm" && (
          <section className="complete-confirm">
            <div className="complete-confirm-heading">
              <span className="beauty-eyebrow">{text("basicLook")}</span>
              <h1 tabIndex={-1}>{text("confirmTitle")}</h1>
              <p>{text("confirmBody")}</p>
            </div>
            <div className="complete-confirm-summary">
              <div className="complete-confirm-portrait">
                {portrait ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={portrait} alt={text("ownPhoto")} />
                  </>
                ) : (
                  <ScanFace size={70} />
                )}
              </div>
              <div>
                <span>{text("palette")}</span>
                <h2>{label(preferences.paletteId)}</h2>
                <div className="complete-palette-swatches">
                  {personalColorPalettes
                    .find((item) => item.id === preferences.paletteId)
                    ?.swatches.map((hex) => (
                      <span
                        key={hex}
                        style={{ backgroundColor: hex }}
                        aria-hidden="true"
                      />
                    ))}
                </div>
                <p>
                  {text("faceShape")}:{" "}
                  <strong>{label(preferences.faceShape)}</strong>
                </p>
              </div>
            </div>
            <details className="complete-details">
              <summary>{text("adjust")}</summary>
              <div className="complete-select-grid">
                <label>
                  {text("palette")}
                  <select
                    value={preferences.paletteId}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        paletteId: event.target.value as PaletteId,
                      })
                    }
                  >
                    {personalColorPalettes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {label(item.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {text("faceShape")}
                  <select
                    value={preferences.faceShape}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        faceShape: event.target
                          .value as BeautyPreferences["faceShape"],
                      })
                    }
                  >
                    {faceShapes.map((item) => (
                      <option key={item} value={item}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
            <section className="complete-base-confirm">
              <h3>{text("baseTitle")}</h3>
              <p>{text("baseNotice")}</p>
              <div className="complete-select-grid">
                <label>
                  {text("depth")}
                  <select
                    value={base.depth}
                    onChange={(event) =>
                      setBase({
                        ...base,
                        depth: event.target.value as BaseChoice["depth"],
                      })
                    }
                  >
                    {["unknown", "fair", "light", "medium", "tan", "deep"].map(
                      (item) => (
                        <option key={item} value={item}>
                          {label(item === "medium" ? "mediumDepth" : item)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  {text("undertone")}
                  <select
                    value={base.undertone}
                    onChange={(event) =>
                      setBase({
                        ...base,
                        undertone: event.target
                          .value as BaseChoice["undertone"],
                      })
                    }
                  >
                    {["unknown", "warm", "cool", "neutral"].map((item) => (
                      <option key={item} value={item}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {text("concealer")}
                  <select
                    value={base.concealerPurpose}
                    onChange={(event) =>
                      setBase({
                        ...base,
                        concealerPurpose: event.target
                          .value as BaseChoice["concealerPurpose"],
                      })
                    }
                  >
                    <option value="match">{text("match")}</option>
                    <option value="brighten">{text("brighten")}</option>
                  </select>
                </label>
              </div>
              <div className="complete-products">
                {value?.baseCandidates.slice(0, 3).map((item) => (
                  <article className="complete-product" key={item.product.id}>
                    <span
                      className="complete-swatch"
                      style={{ backgroundColor: item.shade.swatchHex }}
                      aria-hidden="true"
                    />
                    <div>
                      <h3>{item.product.name}</h3>
                      <p>{item.shade.shadeName}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </section>
        )}
        {step === "book" && value && (
          <>
            <CompleteBeautyBook
              value={value}
              analysis={analysis}
              portrait={portrait}
              ratios={ratios.result}
              locale={locale}
              stylingDirection={stylingDirection}
              slots={previews.slots}
              previewAccepted={
                previews.accepted &&
                value.completeConsent &&
                !!analysis &&
                analysis.beauty.image_quality === "usable" &&
                value.preview.available
              }
              generating={previews.busy}
              onCancel={cancelPreviews}
              onEditSkin={() => setSkinOpen(true)}
            />
            <section className="complete-section complete-style-controls">
              <h2>{text("adjust")}</h2>
              <p>{text("generationNotice")}</p>
              <div className="complete-three">
                {["short", "medium", "long"].map((length, index) => (
                  <button
                    className={`complete-hair-choice ${preferences.hairLength === length ? "selected" : ""}`}
                    key={length}
                    disabled={busy}
                    onClick={() => {
                      const next = {
                        ...preferences,
                        hairLength: length as BeautyPreferences["hairLength"],
                      };
                      setPreferences(next);
                      void confirm(next);
                    }}
                  >
                    <HairPhoto
                      index={[0, 3, 4][index]}
                      label={text("reference")}
                    />
                    <strong>{label(length)}</strong>
                  </button>
                ))}
              </div>
            </section>
            <section className="complete-section complete-save-section">
              <div>
                <h2>{text("saveTitle")}</h2>
                <p>{text("downloadNotice")}</p>
              </div>
              <button
                className="button secondary"
                onClick={() => {
                  const saved = currentSaved();
                  if (saved)
                    downloadCompleteGuide(saved, locale, stylingDirection);
                }}
              >
                <Download size={20} />
                {text("download")}
              </button>
              <button
                className="button secondary"
                onClick={() => setSaveOpen(true)}
              >
                <QrCode size={20} />
                {text("save")}
              </button>
            </section>
          </>
        )}
      </main>
      <footer className="complete-bottom">
        <div>
          <ShieldCheck size={18} />
          <span>{text("private")}</span>
        </div>
        {step === "book" ? (
          <button className="button primary" onClick={() => void reset()}>
            {text("finish")}
            <Check size={20} />
          </button>
        ) : (
          true && (
            <>
              <button
                className="text-button"
                disabled={busy || step === "welcome"}
                onClick={() => {
                  if (step === "age") {
                    void reset();
                    return;
                  }
                  if (step === "photo") {
                    stopCamera();
                    setCamera(false);
                  }
                  setStep(
                    step === "privacy"
                      ? "age"
                      : step === "photo"
                        ? "privacy"
                        : "privacy",
                  );
                }}
              >
                <ArrowLeft size={18} />
                {text("back")}
              </button>
              <button
                className="button primary"
                disabled={busy || primaryDisabled}
                onClick={() => void primaryAction()}
              >
                {busy ? text("saving") : primaryLabel}
                <ArrowRight size={20} />
              </button>
            </>
          )
        )}
      </footer>
      {busy && step === "photo" && (
        <div className="complete-processing" role="status">
          <Sparkles size={30} />
          <strong>{text("analyzing")}</strong>
        </div>
      )}
      {idle && (
        <Modal
          title={text("stillHere")}
          closeLabel={text("close")}
          close={() => {
            setIdle(false);
            lastActivity.current = Date.now();
          }}
        >
          <p>{text("idleNotice")}</p>
          <button
            className="button"
            onClick={() => {
              setIdle(false);
              lastActivity.current = Date.now();
            }}
          >
            {text("keep")}
          </button>
          <button className="text-button" onClick={() => void reset()}>
            {text("finish")}
          </button>
        </Modal>
      )}
      {skinOpen && (
        <Modal
          title={text("skinOptions")}
          closeLabel={text("close")}
          close={() => setSkinOpen(false)}
        >
          <div className="complete-modal-fields">
            <label>
              {text("skinType")}
              <select
                value={profile.skinType}
                onChange={(event) =>
                  setProfile({
                    ...profile,
                    skinType: event.target
                      .value as CompleteSkinProfile["skinType"],
                  })
                }
              >
                {skinTypes.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>{text("concerns")}</legend>
              {concerns.map((item) => (
                <label className="complete-checkbox" key={item}>
                  <input
                    type="checkbox"
                    checked={profile.concerns.includes(item)}
                    onChange={(event) =>
                      setProfile({
                        ...profile,
                        concerns: event.target.checked
                          ? [...profile.concerns, item]
                          : profile.concerns.filter((goal) => goal !== item),
                      })
                    }
                  />
                  <span>{label(item)}</span>
                </label>
              ))}
            </fieldset>
            <label>
              {text("exclusions")}
              <select
                value=""
                onChange={(event) => {
                  if (
                    event.target.value &&
                    !profile.excludedIngredients.includes(event.target.value)
                  )
                    setProfile({
                      ...profile,
                      excludedIngredients: [
                        ...profile.excludedIngredients,
                        event.target.value,
                      ],
                    });
                }}
              >
                <option value="">{text("unknown")}</option>
                {value?.beauty.ingredients.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <div className="complete-exclusion-chips">
              {profile.excludedIngredients.map((item) => (
                <button
                  className="text-button"
                  key={item}
                  onClick={() =>
                    setProfile({
                      ...profile,
                      excludedIngredients: profile.excludedIngredients.filter(
                        (name) => name !== item,
                      ),
                    })
                  }
                >
                  {item}
                  <X size={18} />
                </button>
              ))}
            </div>
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                cancelPreviews();
                void run(async (signal, current) => {
                  const next = await api<CompleteBeautyView>(
                    `kiosk/sessions/${session.current}/beauty-complete-skin`,
                    { method: "POST", body: json(profile), signal },
                  );
                  if (current()) {
                    setValue(next);
                    setSkinOpen(false);
                  }
                });
              }}
            >
              {text("update")}
            </button>
          </div>
        </Modal>
      )}
      {saveOpen && (
        <Modal
          title={text("saveTitle")}
          closeLabel={text("close")}
          close={() => setSaveOpen(false)}
        >
          <p>{text("saveNotice")}</p>
          {value?.beauty.sharingAvailable ? (
            <>
              <label className="complete-checkbox">
                <input
                  type="checkbox"
                  checked={shareAccepted}
                  onChange={(event) => setShareAccepted(event.target.checked)}
                />
                <span>{text("saveConsent")}</span>
              </label>
              {share ? (
                <div className="complete-qr">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={share.qrDataUrl}
                    alt={text("save")}
                    width={232}
                    height={232}
                  />
                  <p>
                    {bt(locale, "expires", {
                      date: new Date(share.expiresAt).toLocaleDateString(
                        locale,
                      ),
                    })}
                  </p>
                </div>
              ) : (
                <button
                  className="button"
                  disabled={!shareAccepted || busy}
                  onClick={() =>
                    void run(async (signal, current) => {
                      const next = await api<Share>(
                        `kiosk/sessions/${session.current}/beauty-complete-share`,
                        {
                          method: "POST",
                          body: json({
                            accepted: true,
                            noticeVersion: COMPLETE_SAVE_NOTICE_VERSION,
                          }),
                          signal,
                        },
                      );
                      if (current()) setShare(next);
                    })
                  }
                >
                  {text("createQR")}
                </button>
              )}
            </>
          ) : (
            <p>{text("qrLocal")}</p>
          )}
        </Modal>
      )}
    </div>
  );
}
