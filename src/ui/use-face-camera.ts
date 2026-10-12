"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { BrowserFaceDetector } from "@/infrastructure/browser-face-detector";
import {
  assessFaceCapture,
  type FaceCaptureAssessment,
  type FaceObservation,
} from "@/domain/face-capture";
import { advanceFaceScan, initialFaceScanState } from "@/domain/face-scan";

function faceMoved(
  previous: FaceObservation | null,
  next: FaceObservation | null,
) {
  if (!previous || !next) return false;
  const a = previous.box;
  const b = next.box;
  return (
    Math.abs(a.x + a.width / 2 - b.x - b.width / 2) > 0.035 ||
    Math.abs(a.y + a.height / 2 - b.y - b.height / 2) > 0.035 ||
    Math.abs(a.width - b.width) > 0.05 ||
    Math.abs(a.height - b.height) > 0.05
  );
}

/** Transient positioning only: no identity, photo storage, or skin interpretation. */
export function useFaceCamera({
  active,
  onCapture,
}: {
  active: boolean;
  onCapture: (photo: Blob) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const detector = useRef<BrowserFaceDetector | null>(null);
  const attempt = useRef(0);
  const scan = useRef(initialFaceScanState());
  const capturing = useRef(false);
  const [media, setMedia] = useState<MediaStream | null>(null);
  const streaming = media !== null;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [detectorState, setDetectorState] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const [assessment, setAssessment] = useState<FaceCaptureAssessment | null>(
    null,
  );
  const [scanReady, setScanReady] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 1280, height: 960 });
  const captured = useEffectEvent(onCapture);

  const stopCamera = useCallback(() => {
    attempt.current++;
    scan.current = initialFaceScanState();
    capturing.current = false;
    detector.current?.close();
    detector.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setMedia(null);
    setOpening(false);
    setAssessment(null);
    setScanReady(false);
    setCountdown(null);
  }, []);

  const openCamera = useCallback(async () => {
    stopCamera();
    const current = attempt.current;
    setError("");
    setOpening(true);
    setDetectorState("loading");
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      });
      if (current !== attempt.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      setOpening(false);
      setMedia(media);
    } catch {
      if (current === attempt.current) {
        setOpening(false);
        setError(
          "Camera access isn't available. Allow access in your browser and retry, choose a photo, or continue without a photo.",
        );
      }
    }
  }, [stopCamera]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (active && document.visibilityState !== "hidden") void openCamera();
    }, 0);
    const visibility = () => {
      if (document.visibilityState === "hidden") stopCamera();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      stopCamera();
    };
  }, [active, openCamera, stopCamera]);

  useEffect(() => {
    if (!media || !video.current) return;
    const liveMedia = media;
    const current = attempt.current;
    const element = video.current;
    element.srcObject = liveMedia;
    let disposed = false;
    let frame = 0;
    let localDetector: BrowserFaceDetector | null = null;
    let previousFrame = 0;
    let previousVideoTime = -1;
    let previousFace: FaceObservation | null = null;
    let previousCountdown: number | null = null;
    let startupExpired = false;
    const fail = () => {
      stopCamera();
      setDetectorState("unavailable");
      setError(
        "Face positioning couldn't start. Retry the camera, choose a photo, or continue without one.",
      );
    };
    const resize = () => {
      if (disposed || current !== attempt.current) return;
      setFrameSize({
        width: element.videoWidth || 1280,
        height: element.videoHeight || 960,
      });
      scan.current = initialFaceScanState();
      previousFace = null;
      previousCountdown = null;
      setCountdown(null);
      setScanReady(false);
    };
    element.addEventListener("resize", resize);
    const ended = () => {
      if (!disposed && current === attempt.current) fail();
    };
    liveMedia
      .getVideoTracks()
      .forEach((track) => track.addEventListener("ended", ended));
    const startupTimer = window.setTimeout(() => {
      startupExpired = true;
      if (!disposed && current === attempt.current) fail();
    }, 10000);

    function captureCurrentFrame() {
      if (capturing.current || !element.videoWidth || !element.videoHeight)
        return;
      capturing.current = true;
      setScanReady(false);
      setCountdown(0);
      const canvas = document.createElement("canvas");
      // Cameras may ignore the ideal resolution. Bound the transient capture
      // before allocating pixels and keep the full frame's aspect ratio.
      const scale = Math.min(
        1,
        1920 / Math.max(element.videoWidth, element.videoHeight),
      );
      canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        stopCamera();
        setError(
          "This browser couldn't capture a photo. Choose a photo or continue without one.",
        );
        return;
      }
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          canvas.width = canvas.height = 0;
          if (disposed || current !== attempt.current) return;
          if (!blob) {
            stopCamera();
            setError("The photo wasn't captured. Please try scanning again.");
            return;
          }
          stopCamera();
          captured(blob);
        },
        "image/jpeg",
        0.85,
      );
    }

    async function prepare() {
      try {
        await element.play();
        if (disposed || startupExpired || current !== attempt.current) return;
        setFrameSize({
          width: element.videoWidth || 1280,
          height: element.videoHeight || 960,
        });
        const { createBrowserFaceDetector } =
          await import("@/infrastructure/browser-face-detector");
        localDetector = await createBrowserFaceDetector();
        if (disposed || startupExpired || current !== attempt.current) {
          localDetector.close();
          localDetector = null;
          return;
        }
        detector.current = localDetector;
        clearTimeout(startupTimer);
        setDetectorState("ready");
        const inspect = (time: number) => {
          if (disposed || current !== attempt.current || !localDetector) return;
          if (!capturing.current && time - previousFrame >= 200) {
            const gap = previousFrame === 0 ? 0 : time - previousFrame;
            previousFrame = time;
            const fresh =
              element.readyState >= 2 &&
              element.currentTime !== previousVideoTime &&
              liveMedia
                .getVideoTracks()
                .some((track) => track.readyState === "live") &&
              gap <= 500;
            previousVideoTime = element.currentTime;
            if (!fresh) {
              scan.current = initialFaceScanState();
              previousFace = null;
              previousCountdown = null;
              setScanReady(false);
              setCountdown(null);
              setAssessment(null);
              frame = requestAnimationFrame(inspect);
              return;
            }
            try {
              const next = assessFaceCapture(localDetector.detect(element));
              setAssessment(next);
              const progress = advanceFaceScan(scan.current, {
                assessment: next,
                now: time,
                frameFresh: !faceMoved(previousFace, next.face),
              });
              previousFace = next.face;
              scan.current = progress.state;
              setScanReady(progress.phase === "countdown");
              setCountdown(progress.countdown);
              if (progress.phase === "countdown") setError("");
              else if (
                previousCountdown !== null &&
                progress.phase === "guiding"
              )
                setError(
                  "Scan paused. Center one face and hold still to restart.",
                );
              previousCountdown = progress.countdown;
              if (progress.phase === "capture") captureCurrentFrame();
            } catch {
              fail();
              return;
            }
          }
          frame = requestAnimationFrame(inspect);
        };
        frame = requestAnimationFrame(inspect);
      } catch {
        clearTimeout(startupTimer);
        if (!disposed && current === attempt.current) {
          fail();
        }
      }
    }
    void prepare();
    return () => {
      disposed = true;
      element.removeEventListener("resize", resize);
      liveMedia
        .getVideoTracks()
        .forEach((track) => track.removeEventListener("ended", ended));
      clearTimeout(startupTimer);
      cancelAnimationFrame(frame);
      if (localDetector) {
        if (detector.current === localDetector) detector.current = null;
        localDetector.close();
        localDetector = null;
      }
    };
  }, [media, stopCamera]);

  return {
    video,
    streaming,
    opening,
    error,
    detectorState,
    assessment,
    scanReady,
    countdown,
    frameSize,
    openCamera,
    stopCamera,
  };
}
