# Private analysis service

Explicit configuration selects deterministic **demo questionnaire results** (`mock`), the completed local **experimental** checkpoints, or consented **OpenAI photo observation** (`openai`). No mode diagnoses skin, establishes product efficacy, downloads data or trains models. Hosted mode observes five visible cosmetic features without loading ConvNeXt, ingredient checkpoints or Torch. Experimental outputs retain opaque category codes and uncalibrated candidate scores.

## Run locally

Use Python 3.12. From `services/analysis` on Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.lock
# Generate this once and put the same value in the web application's server-only configuration.
$env:ANALYSIS_API_KEY = (.\.venv\Scripts\python -c "import secrets; print(secrets.token_urlsafe(32))")
$env:ANALYSIS_PROVIDER = "mock"
.\.venv\Scripts\python -m uvicorn senmiva_analysis.main:app --app-dir src --host 127.0.0.1 --port 8000 --no-access-log --limit-concurrency 32
```

The example `.env` file documents names; the service does not implicitly read it. Supply environment variables through the shell, container runtime, or a secret manager. Missing, short, or example secrets refuse startup. The server binds to localhost for development. In production the BFF and this service must communicate through a private network with transport encryption; do not publish the service directly to customer browsers.

Linux/macOS: use `python3.12 -m venv .venv`, then substitute `.venv/bin/python` for the Windows Python path. For a runtime-only installation use `requirements.lock`. All dependency versions are exact; update locks deliberately and rerun the tests. No PyTorch dependency is required for mock or OpenAI mode.

## HTTP contract

The integrated kiosk uses separately authenticated `POST /v1/analyze/beauty-complete` with only `{request_id,image_base64}` under the new combined-photo purpose. One stateless Responses call returns exact `{request_id,mode:"openai_beauty_complete",model_version,prompt_version:"beauty-complete-v1",beauty,skin,animalVibe,baseDepth}`. `beauty` is the existing strict v2 result; `skin` is the existing strict `SkinVision` block. Their quality limits are independent: usable style outlines do not establish adequate pore detail. `animalVibe` is a transient, playful appearance association from `cat|dog|rabbit|fox|deer|bear|uncertain`, with no personality claim. `baseDepth` is an approximate cosmetic shade family `fair|light|medium|tan|deep|uncertain`, requiring guest confirmation before base matching. Limited style requires both new directions uncertain. No age, Gender, demographic inference, prose, scores or products enter this protocol. Existing endpoints and validation remain unchanged.

`POST /v1/generate/beauty-preview` generates one independently admitted image at a time. Request: `{request_id,image_base64,palette_id,kind,index,face_shape,styling_direction?}`; `kind` is `makeup|hair_style|hair_color`, `index` is an integer0–2, and `face_shape` is a confirmed guide shape or `unsure`. Optional transient `styling_direction` is strictly `balanced|masculine|feminine`, default `balanced` for old callers. The browser supplies it through the BFF's allowlisted `X-Beauty-Styling-Direction` header; neither Gender nor open text is forwarded. Masculine edits use natural skin/groomed brows/subtle definition and textured crop/curtain part/soft quiff; feminine and balanced retain the existing light cosmetic directions. Every direction preserves facial anatomy, identity, natural skin and existing facial hair. Direction is absent from responses, DB and QR. Response: exact `{request_id,kind,index,mime_type:"image/jpeg",image_base64,model_version,prompt_version:"beauty-preview-v1"}`. Enable `ANALYSIS_BEAUTY_PREVIEW_ENABLED=true` separately in the BFF and private service; default false. Each edit retains the existing pinned Images model, image sanitation and ≤60-second configured per-image timeout. BFF transport is bounded to75seconds/2MiB. The BFF owns the ordered nine-slot queue, durable one-attempt-per-slot claim,12-minute overall limit, partial failure display, cancellation and stale-result rejection. Every request must reference the original consented photo rather than a previous generated image. Only the requested category changes: cosmetics, hair shape/length, or hair colour. Source/output stay memory-only, with provider-retention disclosure and separate generation consent. No automatic retries. Old three-image makeup endpoint remains readable and independent.

Primary beauty styling adds independently authenticated `POST /v1/analyze/beauty` in OpenAI mode. Request: fresh `request_id` UUID and required `image_base64` only. Its exact twelve-field v2 response uses mode `openai_beauty`, pinned model `gpt-4.1-mini-2025-04-14`, prompt `beauty-style-suggestion-v2`, image quality, categorical undertone/chroma/face shape, visible eye shape, apparent front-view nose width, lip fullness and allowlisted quality flags. Limited/unassessable input requires all six directions uncertain. No fabricated percentages, nose bridge/geometry measurements, demographic/personality inferences, clinical claims, confirmed preferences or products. The TypeScript reader still accepts exact nine-field v1 records without inventing missing features. The same sanitizer, bounded authenticated admission, `store:false`, no tools/history/retries/logs and memory-only photo processing apply. Fresh separate purpose consent and one durable attempt belong to the BFF/database; manual styling never calls this endpoint. See [beauty kiosk and deployment](../../docs/BEAUTY-KIOSK.md).

Guest-photo makeup previews use a separate authenticated `POST /v1/generate/beauty-makeup`. Enable explicitly with `ANALYSIS_BEAUTY_MAKEUP_ENABLED=true` in both the BFF and private service; it defaults off and requires OpenAI mode. `ANALYSIS_BEAUTY_MAKEUP_TIMEOUT_SECONDS` defaults to60 and is capped at60 per edit. The request contains only `request_id`, required bounded `image_base64`, and confirmed `palette_id` (`warm_soft|warm_clear|cool_soft|cool_clear|neutral_soft|neutral_clear`). Separate initially unticked generation consent and durable one-attempt admission belong to the BFF/database. This purpose sends the guest's photo for three real cosmetic edits; it does not silently authorize reuse from the prior analysis consent.

The pinned Images API model is `gpt-image-2.5-flare-2026-09-08`, with fixed `beauty-makeup-preview-v1` prompts for `soft`, `fresh`, `defined`. Each of three sequential edits references the same sanitized source with a distinct locally authored makeup prompt and the confirmed palette. No Files API, provider output URL, open-ended client prompt, retry or source/output persistence. Response: exact `{request_id,mode:"openai_beauty_makeup",model_version,prompt_version,images:[{id,image_base64,mime_type:"image/jpeg"},...]}` in that fixed order. Each decoded, metadata-stripped JPEG is at most768×1152 and1MiB; the BFF caps the complete reply at6MiB and210seconds. Any error rejects the whole batch; partial/repeated images never masquerade as three previews. Output remains transient in browser memory and is cleared on withdrawal/reset/exit; QR guides do not persist the portraits.

The Images API does **not** expose Responses' `store:false`; this implementation does not send unsupported parameters or promise zero provider retention. Provider retention may apply. Images are illustrative makeup ideas, not identity verification, exact product try-on, clinical results or guaranteed cosmetic outcomes. Account/model access, real portrait fidelity and kiosk latency require a consenting-person pilot. No actual customer/AI-Hub image or paid provider call is used in tests. The current official [image generation guide](https://developers.openai.com/api/docs/guides/image-generation) and [image-edit API reference](https://developers.openai.com/api/reference/resources/images/methods/edit) establish the pinned snapshot and edit parameters; verified on2026-10-11.

OpenAI mode also exposes the separate authenticated `POST /v1/analyze/color` purpose. Its strict JSON request contains only `request_id` (fresh UUID) and required `image_base64`; there is no questionnaire or skin result. The eight-field `openai_color` response pins model/prompt and returns image quality, categorical undertone/chroma and enumerated limitations. Limited or unassessable photos must return uncertain color directions. It never confirms a palette or recommends inventory. Existing image sanitization, memory/body bounds, request admission, `store:false`, no retries and no logs apply. Mock/experimental modes disable this endpoint; manual palette discovery stays in the BFF. See [personal-color setup and privacy](../../docs/PERSONAL-COLOR.md).

`GET /healthz` is public and returns `{"status":"ok","mode":"mock"}`. It contains no environment or secret information.

`POST /v1/analyze` requires `Content-Type: application/json` and the server-only `X-Analysis-Key` header. Authentication uses constant-time comparison before the body is read. Request bodies are bounded to 4 KiB, including chunked bodies. Duplicate credentials are rejected.

```json
{
  "request_id": "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b",
  "concern_ids": ["dehydration", "texture"],
  "skin_type": "dry",
  "sensitive": true
}
```

- `request_id`: a UUID supplied by the BFF; echoed for correlation without persistence.
- `concern_ids`: one to four unique values from `dehydration`, `texture`, `uneven_tone`, `fine_lines`.
- `skin_type`: `normal`, `dry`, `oily`, `combination`, or `unsure`.
- `sensitive`: a JSON boolean, with no string or number coercion. This field is available for future providers; mock scores do not claim to assess sensitivity.
- All four fields are required. Extra fields, including photos, image URLs, base64 images, and organization identifiers, are forbidden.

```json
{
  "request_id": "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b",
  "mode": "mock",
  "model_version": "mock-1.0",
  "quality_status": "demo",
  "observations": [
    {"concern_id": "dehydration", "level": "high", "score": 0.78},
    {"concern_id": "texture", "level": "moderate", "score": 0.48}
  ],
  "disclaimer": "Demo results generated from your questionnaire, not from a photo or AI skin measurement. For cosmetic guidance only; not a medical diagnosis."
}
```

Scores are illustrative fixtures in `[0, 1]`, not probabilities, confidence values, instrument readings, or clinically calibrated measurements. Levels are low below 0.34, moderate below 0.67, and high otherwise. Identical questionnaire inputs produce identical observations. The service is stateless; replayed requests do not incur writes. Session ownership, tenant authorization, idempotent result persistence, and product recommendations belong to the BFF/database, not to this inference service.

Failures return only generic details: `401` invalid credentials, `413` oversized body, `415` non-JSON, `422` invalid input. Validation errors never echo rejected input. Responses use `Cache-Control: no-store`. Interactive API documentation and browser CORS are disabled.

## Architecture and operations

HTTP contracts and boundary checks live in `api`; application use cases depend on the provider protocol; immutable domain models depend only on Python's standard library. Infrastructure implements explicit mock, local experimental and hosted OpenAI adapters, plus an unavailable legacy PyTorch placeholder. A composition root wires these parts together. Neither domain nor application depends on FastAPI, storage, filesystem access, or Supabase.

Only the independently versioned experimental and OpenAI endpoints accept ephemeral photo bytes after the BFF verifies paired-device ownership, active session and the applicable consent. Hosted mode additionally requires external-photo consent and a durable BFF/database claim before transmission. There is no database, file output, request body logging, analytics exporter, raw input cache, or background training. Keep access logs disabled and do not configure a proxy or tracing tool to record headers, bodies, query strings, or secrets. If telemetry is added, limit it to aggregate request counts, timing, status, and provider version.

The BFF must enforce paired-device/session authorization and per-device/tenant request budgets before calling this service. The deployment ingress must limit connections, headers and request-read time; use a provider-appropriate deadline (mock10s, hosted-photo BFF45s with provider network timeout at most30s, experimental60s). The default server caps concurrency at32; scale replicas using measured latency and resource use. Service authentication alone is not tenant authorization. Rotate the shared secret through server-only configuration, and restrict ingress to the BFF.

Container build, from the repository root:

```text
docker build -f services/analysis/Dockerfile -t senmiva-analysis:dev .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp -p 127.0.0.1:8000:8000 --env-file services/analysis/.env senmiva-analysis:dev
```

The container runs as UID/GID 10001. Create a local `services/analysis/.env` from the example and replace the placeholder before using `--env-file`; secret files are ignored by Git and excluded by the Dockerfile-specific build allowlist. The Docker image and installed libraries should be scanned in deployment CI.

## OpenAI photo observation

The connected kiosk explicitly selects this mode with server-only configuration:

```text
ANALYSIS_PROVIDER=openai
OPENAI_API_KEY=<private key entered locally, never sent in chat>
ANALYSIS_OPENAI_TIMEOUT_SECONDS=30
```

The pinned provider is `gpt-4.1-mini-2025-04-14` through Responses. Runtime uses the strict, dependency-free protocol in `ml/src/senmiva_training/vision_api.py`; local runtime puts both `services/analysis/src` and `ml/src` on `PYTHONPATH`. The connected launcher supplies these paths and can reuse the existing private Python environment, but no workspace, model artifact, GPU, training package installation or checkpoint is required. A plain service virtual environment with the pinned runtime dependencies is also supported. The Docker build copies only that protocol and its empty package initializer to `/app/shared`, with an explicit build-context allowlist. No other training code, data, private artifacts or Torch libraries enter the image.

Base `compose.yaml` deliberately serves mock analysis over its internal-only network and forwards no provider key. For hosted photo analysis, put the private key and existing required settings in the ignored root `.env` and select the explicit override:

```powershell
docker compose -f compose.yaml -f compose.openai.yaml up --build
```

The override selects `openai` in both web and analysis, disables the separate explanation feature, supplies `OPENAI_API_KEY` only to analysis and gives analysis an outbound network for the fixed OpenAI HTTPS endpoint. Analysis still has no host port. The web container has no OpenAI key. This is a container package, not a completed cloud deployment or configured hosted Supabase project.

`POST /v1/analyze/openai` accepts the same authenticated questionnaire envelope plus optional bare `image_base64` as experimental requests. The questionnaire is validated locally but is **never sent to OpenAI**. An absent photo returns `vision: null`, `quality_status: not_provided` and empty `observations` without an external request. Other provider endpoints are disabled in hosted mode; errors do not fall back to mock or local inference.

The boundary authenticates before reading, bounds JSON (including chunked bodies) and admits only one photo request per worker. Decoding accepts static JPEG/PNG/WebP up to 10MiB, 25 million pixels and at least 224px per edge. The service corrects orientation, preserves aspect ratio within 1536px, rejects a resulting edge below 224px and re-encodes fresh RGB JPEG pixels in memory. EXIF, ICC, text, filenames and other metadata are not forwarded. OpenAI receives only this bounded image and fixed instructions: no session/request/tenant identifiers, questionnaire, store products, ingredient lists or source codes. No image, result file or request body is saved by the service.

The response has `mode: openai`, the pinned `model_version`, empty `observations`, fixed disclaimer and optional `vision: {prompt_version, image_quality, quality_flags, observed_features}`. The five exact features are `visible_redness`, `visible_spots`, `visible_pores`, `visible_fine_lines` and `visible_flaking`; each is `visible`, `not_visible`, `uncertain` or `not_assessable`. `not_visible` describes this image rather than absence of a condition. Image quality is `usable`, `limited` or `not_assessable`; no/multiple faces yield a normal `not_assessable` result for retaking. Clinical scores, source-code mappings, ingredient advice and free provider text are forbidden. Strict JSON validation does not establish accuracy.

The external adapter has a 30-second maximum deadline, a 32KiB response bound, fixed HTTPS destination, no redirects/proxies/history/tools and no automatic retries. Refusal returns safe HTTP422; upstream errors/invalid output return safe HTTP503. The BFF owns separate guest photo-transfer consent, a durable one-attempt claim and store eligibility policy. Do not expose this private service directly to browsers.

Responses use `store:false`; this does **not** promise zero provider retention. [OpenAI's data controls](https://developers.openai.com/api/docs/guides/your-data) describe default abuse-monitoring retention up to 30 days and applicable exceptions. API content is not used for training unless the account opts in. Separate consent must disclose external photo processing before the BFF may transmit pixels. Local deletion cannot recall an already-sent provider request.

## Experimental local models

The connected development launcher resolves the private ML workspace and uses its existing Python/Torch environment with the service's pinned requirements. Both `services/analysis/src` and `ml/src` must be on `PYTHONPATH`. Set these server-only variables explicitly:

```text
ANALYSIS_PROVIDER=experimental
SENMIVA_ML_WORKSPACE=<private local ML workspace outside cloud sync>
ANALYSIS_PHOTO_MANIFEST=skin-all-001
ANALYSIS_PHOTO_RUN=skin-all-head-001
ANALYSIS_INGREDIENT_MANIFEST=ingredients-001
ANALYSIS_INGREDIENT_RUN=ingredients-linear-001
ANALYSIS_DEVICE=auto
```

The models load and verify at startup, including original manifest/run hashes, completed metrics, best-checkpoint selection, tensor-only loading, tensor shapes and finite values. Experimental startup also requires the private immutable `contracts/{ANALYSIS_INGREDIENT_MANIFEST}-source-codes-v1.json` support artifact, selected automatically with no additional environment variable. Its contract, original source fingerprint and retained TRAIN-profile witnesses are verified against the original ingredient manifest. Neither checkpoint is modified. A missing or incompatible artifact refuses startup; inference failures return generic errors with no mock fallback. `GET /healthz` returns `mode: experimental` only after model loading. The legacy mock endpoint returns 503 in experimental mode. `ANALYSIS_PROVIDER=pytorch` remains an unavailable legacy placeholder, rather than an alias for these experiments. The default Docker image supports mock and hosted photo observation; experimental deployment still needs the ML package/runtime and read-only private artifact mounts explicitly provisioned.

Prepare the support artifact once from the repository root on a new approved environment, after extraction and ingredient-manifest preparation:

```powershell
.\scripts\ml.ps1 prepare-code-support --extracted expanded-001 --manifest ingredients-001 --name ingredients-001-source-codes-v1
```

The current source audit covers 9,000 JSONL records and the original recommendation source fingerprint, with 4,824 retained TRAIN profiles supporting 145 whole condition categories. Validation profiles cannot supply support. The command creates a separate private file without retraining, changing source/manifest/weights or overwriting an existing artifact. Witnesses never enter responses, application storage or public assets. See [the source-code contract](../../docs/ML-SOURCE-CODE-CONTRACT.md) and [Korean setup guide](../../docs/KIOSK-MODEL-SETUP.md).

`POST /v1/analyze/experimental` uses the same authenticated four-field questionnaire and an optional `image_base64` string containing **bare base64**, without a data-URL prefix. Omit it for questionnaire-only ingredient inference (`visual: null`). The service bounds JSON to 13,985,112 bytes, decoded image to 10 MiB, dimensions to at least 224 pixels per edge and at most 25 million pixels. Only complete static JPEG/PNG/WebP images are accepted. All bytes remain in process memory; no multipart spooling or image/result files are created. Auth is checked before reading bytes; chunked bodies are bounded, body reads have a 10-second deadline and one experimental request is admitted per worker before body buffering. Busy requests return 429. GPU execution also has a nonblocking inference slot. Deploy one worker per provisioned model/GPU allocation until throughput is measured.

The response includes `request_id`, `mode: experimental`, `quality_status: experimental`, model versions, **empty** `observations`, an explanatory disclaimer, optional `visual: {model_version, heads}` and `ingredients: {model_version, candidates, input_coverage}`. The aggregate `model_version` adds `:source-codes-v1`; individual checkpoint identities remain unchanged. Each of eight heads carries its opaque predicted code and per-code softmax values. All ingredient vocabulary candidates are returned in descending sigmoid-score order for the BFF's approved canonical-INCI intersection and store eligibility policy. Scores are not calibrated probabilities of suitability or safety. The service has no tenant catalog access and cannot bypass stock, published formula, exclusions or reviewed policy rules.

The current kiosk supplies partial features. Direct skin-type translations are normal→중성, dry→건성, oily→지성 and combination→복합성. Cosmetic goals translate uneven_tone→미백 and fine_lines→주름; these are input vocabulary translations, not diagnoses. Dehydration and texture lack verified equivalent labels and are omitted. Age, gender and external factors are omitted rather than invented. The sensitivity answer is not a model feature; explicit exclusions remain enforced by the application.

For an optional photo, all eight exact head codes are serialized in verified source order into one `initial_skin_condition` category using the original normalizer/hash. Only exact whole categories witnessed in retained training profiles are added to the ingredient input. Invalid or incomplete codes fail closed. Unseen combinations are omitted, preserving questionnaire-only inference. `input_coverage` records `source_code_contract_aihub71886_v1`, `visual_condition_used_source_contract_v1` for actual use or `visual_condition_unseen_in_training_omitted` for unsupported combinations; no-photo input carries `no_photo_questionnaire_only`. It also discloses missing fields, unresolved code meanings/combined-pipeline accuracy and a bias-only baseline where applicable. This passes structurally compatible opaque categories without a guessed image/annotation row join, severity scale or clinical need mapping. Questionnaire preferences stay authoritative. Changed candidate scores flow through the existing BFF policy-weighted store ranking, while the current normalized coverage tables preserve provenance without a new database migration. Partial-input and combined-pipeline performance remain unvalidated; complete-profile offline metrics must not be presented as kiosk accuracy.

## Verification and limitations

```powershell
.\.venv\Scripts\python -m pytest
.\.venv\Scripts\python -m pip check
```

Tests cover authentication before parsing, deterministic mock markers, strict experimental requests/results, memory-only input, invalid base64/image and private provider errors, concern/type/body bounds, no CORS, privacy headers, immutable domain types and unavailable provider failures. ML inference tests use synthetic tensors and cover unchanged artifacts, tensor-only loading, exact source serialization/hash parity, retained-training support, unsupported-category omissions and finite-output enforcement.

Training remains a separate, explicitly invoked pipeline in [../../ml/README.md](../../ml/README.md), with its own environment and private outputs outside OneDrive. The user confirmed permission and explicitly requested experimental kiosk integration after completing the eight-head ConvNeXt-Tiny experiment and ingredient candidate experiment. The separate loopback personal-photo tester remains available. Code meanings/raters, region compatibility and person IDs remain unverified; exact duplicate exclusion does not establish person separation. Reserve a person-disjoint locked test set, validate actual retail cameras, capture quality, uncertainty and partial recommendation inputs before product performance claims. No face, lighting, blur or skin-region quality detector is implemented. Whole-face kiosk captures differ from region training images; the existing evaluation center crop is preserved, so outputs can be inaccurate. Ingredient/product matching remains a separate application subsystem governed by reviewed rules and verified formulas.
