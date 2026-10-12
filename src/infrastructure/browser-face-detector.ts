import type { Detection } from "@mediapipe/tasks-vision";
import type { FaceSnapshot } from "@/domain/face-capture";

export interface BrowserFaceDetector {
  /** Call at most 5 times/second, only while a consented live preview is active. */
  detect(video: HTMLVideoElement): FaceSnapshot;
  close(): void;
}

const WASM_ROOT = "/face/mediapipe-1.1.0/wasm";
const MODEL_PATH = "/face/blaze-face-short-range-v1.tflite";
const MAX_EDGE = 640;
const MAX_SOURCE_EDGE = 8192;

const finite = (value: number) => Number.isFinite(value);
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Package-specific geometry never crosses the browser/application boundary. */
export function normalizeFaceDetections(
  detections: Detection[],
  width: number,
  height: number,
): FaceSnapshot {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_EDGE ||
    height > MAX_EDGE ||
    !Array.isArray(detections) ||
    detections.length > 20
  )
    throw new Error("Face detection is unavailable.");
  return {
    faces: Array.from(detections).map((detection) => {
      if (typeof detection !== "object" || detection === null)
        throw new Error("Face detection is unavailable.");
      const box = detection.boundingBox;
      const confidence = detection.categories?.[0]?.score;
      if (
        !box ||
        ![box.originX, box.originY, box.width, box.height].every(finite) ||
        box.width <= 0 ||
        box.height <= 0 ||
        !finite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        !Array.isArray(detection.keypoints) ||
        detection.keypoints.length > 6 ||
        Array.from(detection.keypoints).some(
          (point) =>
            typeof point !== "object" ||
            point === null ||
            !finite(point.x) ||
            !finite(point.y),
        )
      )
        throw new Error("Face detection is unavailable.");
      const x = clamp(box.originX / width);
      const y = clamp(box.originY / height);
      const right = clamp((box.originX + box.width) / width);
      const bottom = clamp((box.originY + box.height) / height);
      if (right <= x || bottom <= y)
        throw new Error("Face detection is unavailable.");
      return {
        box: { x, y, width: right - x, height: bottom - y },
        // Out-of-frame landmarks stay bounded; edge faces fail alignment checks.
        keypoints: detection.keypoints.map((point) => ({
          x: clamp(point.x),
          y: clamp(point.y),
        })),
        confidence,
      };
    }),
  };
}

async function initializeBrowserFaceDetector(): Promise<BrowserFaceDetector> {
  if (typeof document === "undefined" || typeof WebAssembly === "undefined")
    throw new Error("Face detection is unavailable on this browser.");
  // All model/runtime paths are fixed same-origin assets. The kiosk CSP also
  // blocks upstream metrics destinations; there is no CDN or telemetry opt-out.
  const { FaceDetector, FilesetResolver } =
    await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
    runningMode: "VIDEO",
    minDetectionConfidence: 0.7,
    minSuppressionThreshold: 0.3,
  });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    detector.close();
    throw new Error("Face detection is unavailable on this browser.");
  }
  let closed = false;
  let lastTimestamp = -1;
  return {
    detect(video) {
      if (closed) throw new Error("Face detection is unavailable.");
      const { videoWidth: width, videoHeight: height } = video;
      if (
        !Number.isInteger(video.readyState) ||
        video.readyState < 2 ||
        video.readyState > 4 ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > MAX_SOURCE_EDGE ||
        height > MAX_SOURCE_EDGE
      )
        throw new Error("The camera frame is not ready.");
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        // MediaPipe requires strictly increasing timestamps even if a camera
        // stalls or callers accidentally run twice within a millisecond.
        const now = Math.max(performance.now(), lastTimestamp + 1);
        lastTimestamp = now;
        const result = detector.detectForVideo(canvas, now);
        return normalizeFaceDetections(
          result.detections,
          canvas.width,
          canvas.height,
        );
      } finally {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      detector.close();
    },
  };
}

export async function createBrowserFaceDetector(): Promise<BrowserFaceDetector> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialization = initializeBrowserFaceDetector().then((detector) => {
    if (expired) {
      detector.close();
      throw new Error("Face detection is unavailable.");
    }
    return detector;
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("Face detection is unavailable. Please try again."));
    }, 15_000);
  });
  try {
    return await Promise.race([initialization, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
