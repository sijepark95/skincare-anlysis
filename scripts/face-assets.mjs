import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public", "face");
const packageRoot = path.join(
  root,
  "node_modules",
  "@mediapipe",
  "tasks-vision",
);
const modelUrl =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const modelHash =
  "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f";
const assets = {
  "vision_wasm_internal.js":
    "7c652617b5bef832f42878ce8c5f752b0724bca6054e4bc1013a37d4b1949723",
  "vision_wasm_internal.wasm":
    "782eda3ec1f414fdb4f1d66a8b59093eb4d5ab437e06117796abf05962d68eef",
  "vision_wasm_nosimd_internal.js":
    "510fc70a170eb8b46767a7abab2af89a7a8341fa5b3ebfb8a5de41a79b7fa9df",
  "vision_wasm_nosimd_internal.wasm":
    "b802041d105876865d6a0806f2ff7c4419a7f1b80bc01340fe36e759c2030011",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verify = (bytes, expected, name) => {
  if (hash(bytes) !== expected)
    throw new Error(`Pinned face asset failed integrity verification: ${name}`);
};
const check = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check"))
  throw new Error(
    "Use face:prepare or face:check without additional arguments.",
  );
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json")));
if (pkg.version !== "1.1.0" || pkg.license !== "Apache-2.0")
  throw new Error(
    "Expected the reviewed @mediapipe/tasks-vision@1.1.0 package.",
  );
const wasmRoot = path.join(publicRoot, "mediapipe-1.1.0", "wasm");
if (!check) await mkdir(wasmRoot, { recursive: true });
for (const [name, expected] of Object.entries(assets)) {
  const destination = path.join(wasmRoot, name);
  const bytes = await readFile(
    check ? destination : path.join(packageRoot, "wasm", name),
  );
  verify(bytes, expected, name);
  if (!check) await writeFile(destination, bytes);
}
const modelPath = path.join(publicRoot, "blaze-face-short-range-v1.tflite");
let model;
try {
  model = await readFile(modelPath);
} catch (error) {
  if (check || error.code !== "ENOENT") throw error;
  const response = await fetch(modelUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || Number(response.headers.get("content-length")) > 300_000)
    throw new Error("Pinned face model download failed.");
  model = Buffer.from(await response.arrayBuffer());
  if (model.length > 300_000)
    throw new Error("Pinned face model download exceeded its size limit.");
  verify(model, modelHash, "blaze-face-short-range-v1.tflite");
  await writeFile(modelPath, model);
}
verify(model, modelHash, "blaze-face-short-range-v1.tflite");
const landmarkPath = path.join(publicRoot, "face-landmarker-v1.task");
const landmarkHash =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
let landmark;
try {
  landmark = await readFile(landmarkPath);
} catch (error) {
  if (check || error.code !== "ENOENT") throw error;
  const response = await fetch(
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    { redirect: "error", signal: AbortSignal.timeout(30_000) },
  );
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > 4_000_000
  )
    throw new Error("Pinned landmark model download failed.");
  landmark = Buffer.from(await response.arrayBuffer());
  if (landmark.length > 4_000_000)
    throw new Error("Pinned landmark model exceeded its size limit.");
  verify(landmark, landmarkHash, "face-landmarker-v1.task");
  await writeFile(landmarkPath, landmark);
}
verify(landmark, landmarkHash, "face-landmarker-v1.task");
console.log(
  `Face assets ${check ? "checked" : "prepared"}: pinned local model and SIMD/non-SIMD CPU runtime.`,
);
