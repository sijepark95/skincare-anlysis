"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Palette, Upload } from "lucide-react";
import {
  lipFinishes,
  personalColorPalettes,
  suggestedPalette,
  type ColorMatch,
  type ColorPreferences,
  type PaletteId,
} from "@/domain/personal-color";
import {
  COLOR_PHOTO_NOTICE_VERSION,
  isColorAnalysis,
  type ColorAnalysis,
} from "@/domain/color-analysis";
import { ApiError, api, json } from "./api";
import { Modal } from "./modal";
import "./personal-color.css";

type ColorResult = {
  analysis: ColorAnalysis | null;
  preferences: ColorPreferences | null;
  recommendations: ColorMatch[];
  attempted: boolean;
  consent: boolean;
  photoAvailable: boolean;
};

/** Independent, optional purpose: never reads or reuses the skin-analysis photo. */
export function PersonalColor({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ColorResult | null>(null);
  const [paletteId, setPaletteId] = useState<PaletteId | "">("");
  const [finish, setFinish] = useState<ColorPreferences["finish"]>("any");
  const [consent, setConsent] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState("");
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState<
    "loading" | "consent" | "photo" | "confirm" | "camera" | ""
  >("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const photo = useRef<File | null>(null);
  const photoUrl = useRef("");
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const attemptLock = useRef(false);
  const cameraEpoch = useRef(0);
  const consentCurrent = useRef(false);

  const clearMedia = useCallback(() => {
    cameraEpoch.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    photo.current = null;
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = "";
  }, []);

  const cancel = useCallback(() => {
    epoch.current++;
    request.current?.abort();
    request.current = null;
    clearMedia();
  }, [clearMedia]);

  const close = useCallback(() => {
    cancel();
    setCamera(false);
    setPreview("");
    setBusy("");
    setOpen(false);
  }, [cancel]);

  useEffect(() => {
    const hidden = (event: Event) => {
      if (event.type !== "pagehide" && !document.hidden) return;
      cancel();
      setCamera(false);
      setPreview("");
      setBusy("");
      setStatus(
        "The camera and unsent photo were cleared. Choose a palette or select a new photo when you return.",
      );
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", hidden);
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++epoch.current;
    api<ColorResult>(`kiosk/sessions/${sessionId}/color`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted || current !== epoch.current) return;
        setResult(value);
        consentCurrent.current = value.consent === true;
        setConsent(value.consent === true);
        if (value.preferences) {
          setPaletteId(value.preferences.paletteId);
          setFinish(value.preferences.finish);
        }
        if (value.attempted || value.analysis) {
          attemptLock.current = true;
          setAttempted(true);
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted && current === epoch.current)
          setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted && current === epoch.current)
          setBusy("");
      });
    return () => controller.abort();
  }, [open, sessionId]);

  function beginRequest() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++epoch.current;
    return {
      controller,
      isCurrent: () => !controller.signal.aborted && current === epoch.current,
    };
  }

  async function setPhoto(file: File | null) {
    clearMedia();
    setCamera(false);
    setPreview("");
    setError("");
    if (!file) return;
    if (
      !consentCurrent.current ||
      attemptLock.current ||
      !result?.photoAvailable
    )
      return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024 ||
      !file.size
    ) {
      setError("Choose a static JPG, PNG or WebP photo up to 10 MB.");
      return;
    }
    photo.current = file;
    photoUrl.current = URL.createObjectURL(file);
    setPreview(photoUrl.current);
    setStatus(
      "New photo ready. It is sent only when you choose Analyze new photo.",
    );
  }

  async function startCamera() {
    if (
      !consentCurrent.current ||
      attemptLock.current ||
      !result?.photoAvailable ||
      busy
    )
      return;
    clearMedia();
    setPreview("");
    setError("");
    setBusy("camera");
    const current = ++cameraEpoch.current;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
      });
      if (
        current !== cameraEpoch.current ||
        document.hidden ||
        !consentCurrent.current
      ) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      setCamera(true);
    } catch {
      if (current === cameraEpoch.current)
        setError(
          "The camera could not open. You can upload a new photo or choose a palette yourself.",
        );
    } finally {
      if (current === cameraEpoch.current) setBusy("");
    }
  }

  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current.play().catch(() => {});
    }
  }, [camera]);

  function capture() {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight || !consentCurrent.current)
      return;
    const current = cameraEpoch.current;
    const canvas = document.createElement("canvas");
    const scale = Math.min(
      1,
      1536 / Math.max(source.videoWidth, source.videoHeight),
    );
    canvas.width = Math.round(source.videoWidth * scale);
    canvas.height = Math.round(source.videoHeight * scale);
    canvas
      .getContext("2d")
      ?.drawImage(source, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        canvas.width = canvas.height = 0;
        if (
          blob &&
          current === cameraEpoch.current &&
          !document.hidden &&
          consentCurrent.current
        )
          void setPhoto(
            new File([blob], "color-photo.jpg", { type: "image/jpeg" }),
          );
      },
      "image/jpeg",
      0.9,
    );
  }

  async function changeConsent(accepted: boolean) {
    consentCurrent.current = accepted;
    setConsent(accepted);
    setError("");
    if (!accepted) {
      cancel();
      setPreview("");
      setCamera(false);
      setBusy("");
      setResult((value) =>
        value
          ? { ...value, analysis: null, preferences: null, recommendations: [] }
          : null,
      );
    }
    setBusy("consent");
    const { controller, isCurrent } = beginRequest();
    try {
      await api(`kiosk/sessions/${sessionId}/color-consent`, {
        method: "POST",
        signal: controller.signal,
        body: json({ accepted, noticeVersion: COLOR_PHOTO_NOTICE_VERSION }),
      });
    } catch (cause) {
      if (isCurrent()) {
        consentCurrent.current = false;
        setConsent(false);
        clearMedia();
        setPreview("");
        setCamera(false);
        setError((cause as Error).message);
      }
    } finally {
      if (isCurrent()) setBusy("");
    }
  }

  async function analyze() {
    if (
      !photo.current ||
      !consentCurrent.current ||
      attemptLock.current ||
      busy
    )
      return;
    const freshPhoto = photo.current;
    // Lock before the request: a timeout/abort must never cause an automatic second image attempt.
    attemptLock.current = true;
    setAttempted(true);
    setBusy("photo");
    setError("");
    setStatus("Requesting one optional color suggestion…");
    const { controller, isCurrent } = beginRequest();
    clearMedia();
    setPreview("");
    setCamera(false);
    try {
      const response = await fetch(
        `/api/v1/kiosk/sessions/${sessionId}/color-analysis`,
        {
          method: "POST",
          body: freshPhoto,
          headers: { "Content-Type": freshPhoto.type },
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new ApiError(
          value.error?.message ??
            "The photo suggestion could not be completed. Choose a palette yourself.",
          response.status,
          value.error?.code ?? "color_analysis_failed",
        );
      const analysis = value.mode === "openai_color" ? value : value.analysis;
      if (!isColorAnalysis(analysis))
        throw new Error(
          "The service did not return a usable color suggestion. You can choose a palette yourself.",
        );
      if (!isCurrent()) return;
      setResult((existing) => ({
        analysis,
        preferences: existing?.preferences ?? null,
        recommendations: existing?.recommendations ?? [],
        consent: true,
        photoAvailable: existing?.photoAvailable ?? true,
        attempted: true,
      }));
      setStatus(
        "Photo suggestion ready. Compare the palettes and confirm your own choice below.",
      );
    } catch (cause) {
      if (isCurrent()) {
        setError((cause as Error).message);
        setStatus(
          "This session's photo attempt has been used. You can still choose and confirm a palette yourself.",
        );
      }
    } finally {
      if (isCurrent()) setBusy("");
    }
  }

  async function confirm() {
    if (!paletteId || busy) return;
    clearMedia();
    setPreview("");
    setCamera(false);
    setBusy("confirm");
    setError("");
    const { controller, isCurrent } = beginRequest();
    try {
      const value = await api<ColorResult>(
        `kiosk/sessions/${sessionId}/color-preferences`,
        {
          method: "POST",
          body: json({ paletteId, finish }),
          signal: controller.signal,
        },
      );
      if (!isCurrent()) return;
      setResult(value);
      setStatus(
        "Your palette is confirmed. Matches use this store's reviewed shade descriptions.",
      );
    } catch (cause) {
      if (isCurrent()) setError((cause as Error).message);
    } finally {
      if (isCurrent()) setBusy("");
    }
  }

  const suggested = suggestedPalette(result?.analysis ?? null);
  const confirmed =
    result?.preferences?.paletteId === paletteId &&
    result?.preferences?.finish === finish;
  const chosen = personalColorPalettes.find(
    (palette) => palette.id === paletteId,
  );
  const matches = confirmed ? (result?.recommendations ?? []) : [];

  return (
    <section
      className="personal-color-entry"
      aria-label="Optional lip color discovery"
    >
      <div>
        <span className="eyebrow">
          <Palette size={15} /> A LITTLE COLOR, YOUR WAY
        </span>
        <h2>Your color, your choice.</h2>
        <p>
          Compare six palette directions, then explore registered lip shades in
          this store. A new photo suggestion is optional.
        </p>
      </div>
      <button
        className="button secondary"
        onClick={() => {
          setError("");
          setStatus("");
          setBusy("loading");
          setOpen(true);
        }}
      >
        Explore lip colors
      </button>
      {open && (
        <Modal title="Find your lip colors" close={close}>
          <div className="personal-color">
            <p>
              Choose the colors you enjoy. Photo and screen lighting can shift
              color; these are approximate style directions, not a calibrated or
              seasonal color assessment.
            </p>
            <details className="color-photo-option">
              <summary>Optional photo suggestion</summary>
              <p>
                Use a new, unfiltered photo in even daylight with minimal lip
                color. Your earlier skin photo is never reused for this separate
                purpose.
              </p>
              {!result?.photoAvailable && (
                <p className="color-note">
                  Photo suggestions are unavailable on this device. You can
                  compare and confirm a palette below.
                </p>
              )}
              <label className="check-row color-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={
                    !result?.photoAvailable ||
                    busy === "loading" ||
                    busy === "consent" ||
                    busy === "confirm"
                  }
                  onChange={(event) => void changeConsent(event.target.checked)}
                />
                <span>
                  Send a new photo to OpenAI for a color suggestion (optional)
                  <small>
                    I am an adult and the only person in the photo. The app
                    processes it in memory and does not save or train on it.
                    OpenAI normally retains abuse-monitoring logs for up to 30
                    days, with legal or safety exceptions. This permission is
                    separate from skin analysis.
                  </small>
                </span>
              </label>
              {attempted ? (
                <p className="color-note">
                  This session&apos;s photo attempt has been used. Confirm or
                  change a palette below without sending another photo.
                </p>
              ) : (
                <>
                  <div className="color-photo-actions">
                    <button
                      className="button secondary"
                      disabled={!consent || !result?.photoAvailable || !!busy}
                      onClick={() => void startCamera()}
                    >
                      <Camera size={17} />
                      Open camera
                    </button>
                    <label
                      className={`button secondary color-upload ${!consent || !result?.photoAvailable || !!busy ? "disabled" : ""}`}
                    >
                      <Upload size={17} />
                      Upload a new photo
                      <input
                        aria-label="New photo for color suggestion"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={!consent || !result?.photoAvailable || !!busy}
                        onChange={(event) => {
                          void setPhoto(event.target.files?.[0] ?? null);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {camera && (
                    <div className="color-capture">
                      <video
                        ref={video}
                        autoPlay
                        muted
                        playsInline
                        aria-label="Color photo camera preview"
                      />
                      <button className="button secondary" onClick={capture}>
                        Capture new photo
                      </button>
                    </div>
                  )}
                  {preview && (
                    <div className="color-capture">
                      {/* A transient object URL never passes through image optimization or persistence. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={preview}
                        alt="New color photo preview, not yet sent"
                      />
                      <button
                        className="button primary"
                        disabled={!!busy}
                        onClick={() => void analyze()}
                      >
                        Analyze new photo
                      </button>
                    </div>
                  )}
                </>
              )}
            </details>
            {result?.analysis && (
              <div
                className="color-observation"
                aria-label="Photo color suggestion"
              >
                <span className="eyebrow">APPROXIMATE PHOTO SUGGESTION</span>
                {suggested ? (
                  <p>
                    In this lighting, the photo suggests{" "}
                    <strong>
                      {personalColorPalettes
                        .find((palette) => palette.id === suggested)
                        ?.name.toLowerCase()}
                    </strong>
                    . This has not selected a palette for you.
                  </p>
                ) : (
                  <p>
                    This photo does not support a clear palette suggestion.
                    Compare the palettes yourself; no color category has been
                    assumed.
                  </p>
                )}
                {result.analysis.quality_flags.length > 0 && (
                  <p className="color-note">
                    Photo limitations:{" "}
                    {result.analysis.quality_flags
                      .map((flag) => flag.replaceAll("_", " "))
                      .join(", ")}
                    .
                  </p>
                )}
              </div>
            )}
            <fieldset className="color-palettes" disabled={!!busy}>
              <legend>1. Choose your palette</legend>
              <div className="color-palette-grid">
                {personalColorPalettes.map((palette) => (
                  <label
                    className={`color-palette ${paletteId === palette.id ? "selected" : ""}`}
                    key={palette.id}
                  >
                    <input
                      type="radio"
                      name="personal-color-palette"
                      value={palette.id}
                      checked={paletteId === palette.id}
                      onChange={() => {
                        setPaletteId(palette.id);
                        setStatus("");
                      }}
                    />
                    <span>
                      <strong>{palette.name}</strong>
                      <span className="color-swatches" aria-hidden="true">
                        {palette.swatches.map((swatch) => (
                          <i key={swatch} style={{ backgroundColor: swatch }} />
                        ))}
                      </span>
                      <small>{palette.description}</small>
                      {suggested === palette.id && (
                        <small className="color-suggested">
                          Photo suggestion · please confirm
                        </small>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="color-finish">
              2. Preferred finish
              <select
                value={finish}
                disabled={!!busy}
                onChange={(event) => {
                  setFinish(event.target.value as ColorPreferences["finish"]);
                  setStatus("");
                }}
              >
                <option value="any">Any finish</option>
                {lipFinishes.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <p className="color-status" role="status">
              {busy === "loading"
                ? "Loading saved choices…"
                : busy === "photo"
                  ? "Requesting one optional color suggestion…"
                  : busy === "confirm"
                    ? "Finding this store's shades…"
                    : status}
            </p>
            <button
              className={`button ${preview ? "secondary" : "primary"} wide`}
              disabled={!paletteId || !!busy}
              onClick={() => void confirm()}
            >
              {confirmed
                ? "Refresh store shade matches"
                : "Confirm palette & find lip shades"}
            </button>
            {confirmed && (
              <section
                className="color-matches"
                aria-label="Confirmed store lip shades"
              >
                <h3>{chosen?.name}, your way.</h3>
                <p>
                  Based on your confirmed palette and the store&apos;s reviewed
                  shade metadata. Swatches are screen previews; compare a tester
                  in person.
                </p>
                {matches.length ? (
                  matches.map(({ product, shade, reasons }) => (
                    <article className="color-match" key={product.id}>
                      <span
                        className="color-match-swatch"
                        style={{ backgroundColor: shade.swatchHex }}
                        aria-hidden="true"
                      />
                      <div>
                        <span className="eyebrow">{product.brand}</span>
                        <h4>{product.name}</h4>
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
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="color-empty">
                    No available registered lip shades match your choices in
                    this store. Try another finish or ask staff to compare
                    alternatives.
                  </p>
                )}
              </section>
            )}
            <p className="color-note">
              Changing or confirming a palette sends no new photo and makes no
              new AI call. Ingredient exclusions and current store availability
              still apply; a color match does not establish allergy safety.
            </p>
          </div>
        </Modal>
      )}
    </section>
  );
}
