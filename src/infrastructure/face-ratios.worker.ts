import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import {
  calculateFaceRatios,
  type FaceRatioPoint,
  type FaceRatios,
} from "@/domain/face-ratios";

const worker = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ bitmap: ImageBitmap; origin: string }>) => void)
    | null;
  postMessage(value: FaceRatios): void;
  close(): void;
};
worker.onmessage = async ({ data }) => {
  let task: FaceLandmarker | null = null;
  const bitmap = data.bitmap;
  try {
    const origin = new URL(data.origin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== data.origin ||
      bitmap.width > 2048 ||
      bitmap.height > 2048
    )
      throw new Error("Invalid local frame");
    const vision = await FilesetResolver.forVisionTasks(
      `${origin.origin}/face/mediapipe-1.1.0/wasm`,
    );
    task = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${origin.origin}/face/face-landmarker-v1.task`,
        delegate: "CPU",
      },
      runningMode: "IMAGE",
      numFaces: 2,
      minFaceDetectionConfidence: 0.8,
      minFacePresenceConfidence: 0.8,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    const size = Math.min(384, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("No local canvas");
    ctx.drawImage(bitmap, 0, 0, size, size);
    const pixels = ctx.getImageData(0, 0, size, size).data;
    const luma = new Float32Array(size * size);
    let sum = 0,
      left = 0,
      right = 0,
      lap = 0,
      lapSquared = 0,
      count = 0;
    for (let i = 0; i < luma.length; i++) {
      const p = i * 4;
      luma[i] =
        0.2126 * pixels[p] + 0.7152 * pixels[p + 1] + 0.0722 * pixels[p + 2];
      sum += luma[i];
      if (i % size < size / 2) left += luma[i];
      else right += luma[i];
    }
    for (let y = 1; y < size - 1; y++)
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        const value =
          luma[i - 1] +
          luma[i + 1] +
          luma[i - size] +
          luma[i + size] -
          4 * luma[i];
        lap += value;
        lapSquared += value * value;
        count++;
      }
    const faces = task.detect(bitmap).faceLandmarks as FaceRatioPoint[][];
    const result = calculateFaceRatios(faces, bitmap.width, bitmap.height, {
      meanLuma: sum / luma.length,
      sideDifference: Math.abs(left - right) / (luma.length / 2),
      laplacianVariance: lapSquared / count - (lap / count) ** 2,
    });
    pixels.fill(0);
    luma.fill(0);
    ctx.clearRect(0, 0, size, size);
    canvas.width = 0;
    canvas.height = 0;
    worker.postMessage(result);
  } catch {
    worker.postMessage({ status: "unavailable", reason: "unavailable" });
  } finally {
    bitmap.close();
    task?.close();
    worker.close();
  }
};
