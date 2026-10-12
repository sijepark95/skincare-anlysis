# Local face-presence assets

Copyright The MediaPipe Authors / Google. Apache License 2.0; see APACHE-2.0.txt.
These unmodified redistributable runtime/model dependencies assist camera framing.
They do not recognize identity, evaluate skin, diagnose, or establish image quality.
No source AI-Hub assets or customer pictures are included.

- npm package: @mediapipe/tasks-vision **1.1.0**, Apache-2.0, pinned in package-lock.json.
- Runtime: the package's unmodified SIMD and non-SIMD JavaScript/WASM assets.
- Model: Google BlazeFace short-range float16 version **1**, 229,746 bytes.
- Model SHA-256: `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`.
- [Versioned model source](https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite).
- [Google model card, including Apache-2.0 license and limitations](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf).
- [Official web guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js).

Run `npm run face:prepare` after `npm ci` to restore the pinned local assets.
Run `npm run face:check` to verify both pinned model artifacts and all four runtime hashes. The preparation
script downloads only the pinned public models if missing; runtime never uses a CDN.
Package upgrades require hash, compatibility and privacy review rather than changing
these paths to `latest`.

The upstream June 2026 [privacy notice](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/web/vision/README.md)
says input is processed on device and performance/utilization metrics can be sent
to Google. The installed 1.1.0 bundle contains an `odml.pa.googleapis.com/v1/log`
endpoint. There is no documented telemetry opt-out in the face detector options.
Senmiva therefore enforces a same-origin kiosk Content Security Policy to block
external runtime connections and serves every executable/model asset locally.
Do not weaken that boundary or claim the package inherently has no telemetry.
Face geometry and resized pixels are transient browser memory and never sent to
the LLM, application database, analytics, or training. After consent, stable live
framing starts a visible cancellable three-second countdown, then captures and
submits the photo to the private analysis service. Pause and photo-free choices
remain available. The live position check does not certify an uploaded photo.

The integrated kiosk additionally uses `face-landmarker-v1.task` in a local CPU
worker for quality-gated geometric ratios. Exact provenance, checksum and the
artifact-specific licensing review note are in `docs/BEAUTY-ASSETS.md`. The package
license does not independently establish model artifact licensing terms.
