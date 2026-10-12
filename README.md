# AELUNE

A working integrated AI beauty kiosk: one fresh photo connects skin observations, reviewed ingredient/store-product recommendations, personal palettes, local geometric face ratios and optional own-photo makeup3/hair3/hair-color3 previews. English, Korean and Spanish preserve state without repeated AI calls. Required age range, optional adult Gender, separate photo/image/save consent, tablet touch controls, desktop management, normalized Supabase/RLS and an independent FastAPI service. Skin preferences remain optional/unknown; bases are confirmed approximate store comparison candidates. Photos, generated images, ratios, animal vibe and individual Gender never enter DB/QR. Manual styling and legacy QR remain compatible. No AI-Hub images or locally trained skin/recommendation checkpoints ship in the app. Bundled MediaPipe face-framing and geometry dependencies have separate provenance and model-artifact review notes in [BEAUTY-ASSETS](docs/BEAUTY-ASSETS.md). See the [Korean setup, privacy and deployment guide](docs/BEAUTY-KIOSK.md), or `npm run context -- beauty`.

The public AELUNE identity and “Inside the Drop” website use a generated 30-second film, native reversible scroll playback and accessible reading fallbacks. Open `/brand` for the editable style tile, original film and logo masters. Copy/media live in `src/content/aelune.ts`; see [production and editing guide](docs/AELUNE-PRODUCTION.md). For a small task-specific context bundle, run `npm run context -- brand`. The existing internal Senmiva package, service and database identifiers are preserved.

The preserved legacy skin path offers **Explore lip colors** with its own separate photo purpose; [personal-color guide](docs/PERSONAL-COLOR.md) describes that compatibility flow. The primary kiosk uses the new combined contract and independent skincare/cosmetic matchers. Owners review common shade versions plus color/base details alongside complete formulas and store listings. Suggestions require confirmation and are not calibrated seasonal measurements or exact virtual try-on.

Explicit offline ConvNeXt-Tiny research has its own setup and commands in [ml/README.md](ml/README.md). Dataset manifests, pretrained downloads and experiment checkpoints stay outside the application and OneDrive. Local experimental serving remains an optional inactive provider; see [Korean kiosk model setup](docs/KIOSK-MODEL-SETUP.md). Mock remains the default for a fresh demonstration configuration.

Optional product-only API explanations are available solely in mock/experimental modes, with separate customer opt-in and bounded requests; they are disabled in OpenAI photo mode. The [Korean LLM setup guide](docs/LLM-SETUP.md) describes that preserved text feature. No key or source data is included.

## Run the local demo

Use Node 24 (Node 22+ supported), then run from this directory:

```powershell
npm.cmd ci
npm.cmd run face:prepare
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev
```

Open [http://localhost:3000](http://localhost:3000). Use the same origin as `NEXT_PUBLIC_APP_URL` in `.env.local`; mutation requests check it. If using `http://127.0.0.1:3000`, set that exact origin instead.

- `/` — AELUNE cinematic story and product introduction.
- `/brand` — live style tile, identity masters and original campaign media.
- `/kiosk` — integrated skin/ingredient/store recommendations, portrait-led facial ratios, confirmed palette/base cards and nine optional own-photo previews (three makeup, three hairstyles, three hair colors); local downloads and deployment-gated QR saving.
- `/kiosk/skin` — preserved skincare questionnaire, separately consented photo observations, ingredient-to-product matches and finish/reset.
- `/result` — phone guide from a private QR capability, download/print and delete; public HTTPS required for kiosk issuance.
- `/management` — local owner workspace, store selector, catalog drafts/import/publication, listings and devices.
- `/management/settings` — privacy and operating configuration.

The standalone demo needs no cloud account, Python service or credentials. Six fictional products seed automatically. Catalog edits persist to ignored `.local/catalog.json`; sessions, pairing codes and counters reset with the process. This is a single-process local adapter, not the production tenancy system. A fresh demo browser uses Soho. To use the other store, create a code from Devices in that store, then pair at `/kiosk/pair`.

Download the CSV template from the catalog. Ingredient cells use **semicolon-separated INCI names**. Fields containing commas must be quoted. Preview validates every row; import creates drafts atomically. Publish after review, then explicitly enable the store listing and stock. Manual drafts may hold unknown names, which block publication; CSV rejects unknown names before import. The 40-name reference dictionary is intentionally small and must be curated for real catalogs.

## Separate analysis service

Follow [services/analysis/README.md](services/analysis/README.md) to start FastAPI on `127.0.0.1:8000` with a newly generated secret of at least 32 characters. Set the identical secret in web `.env.local`:

```dotenv
ANALYSIS_SERVICE_URL=http://127.0.0.1:8000
ANALYSIS_API_KEY=<your-generated-secret>
```

Restart Next after environment changes. Without these values demo uses the local mock provider. When a service is configured, failure is surfaced; it never silently substitutes local results. Supabase mode requires the private service. Both mock providers return deterministic illustrative fixtures, not validated skin measurements. The original mock endpoint accepts an opaque request UUID and questionnaire only. Explicit experimental mode uses a separate bounded in-memory photo/profile endpoint and honest experimental outputs; source files and checkpoint weights are not shipped with the repository.

## Supabase mode

Start with the [Korean setup guide](docs/SUPABASE-SETUP.md). It covers a new cloud project, initial owner account, anonymous device Auth and the exact files to configure. [docs/DATABASE.md](docs/DATABASE.md) describes the normalized model, roles and RPCs.

The repository includes the pinned official Supabase CLI. Local ports are API `15431`, PostgreSQL `15432` and captured development mail `15434`; Studio `15433` is excluded from the minimal starter. Local preparation creates a confirmed development owner and saves its generated password in an ignored file; it never prints the password. Cloud infrastructure initialization requires your own confirmed Auth account and never seeds fictional products.

```powershell
npm.cmd run supabase:start
npm.cmd run supabase:local:prepare
npm.cmd run dev:connected
```

Development uses `.next-development`, production build/start use `.next`, and browser tests use `.next-e2e`. Keep these generated directories separate: running a production build must not replace a live kiosk's development cache. Persistent Turbopack development caching is disabled to prevent stale HMR hashes after restarts; in-memory Fast Refresh remains enabled. `NEXT_DIST_DIR` remains available for explicitly isolated test or build output.

For a **new cloud project**, fill the runtime and operator files described in the guide, then:

```powershell
npm.cmd run supabase:migrate
npm.cmd run supabase:init
npm.cmd run supabase:check
npm.cmd run dev:connected
```

Migration and initialization are repeatable and preserve existing data. They reject unexpected schema history or permissions. Do not use `supabase db reset` to connect a project: it deletes local data. The local SQL seed contains no passwords or staff memberships.

Provision staff accounts and memberships through administration, enable anonymous device Auth, create a restricted login inheriting `analysis_writer`, and schedule cleanup every minute. Configure `.env.local` and restart:

```dotenv
APP_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=<project-url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
ANALYSIS_DATABASE_URL=<restricted-writer-postgresql-url>
ANALYSIS_SERVICE_URL=<private-analysis-url>
ANALYSIS_API_KEY=<shared-secret>
```

Business owners can register at `/management/signup`, confirm their email with a six-digit code, then create a company and first store at `/management/setup`. Each signup creates only its own new workspace; client metadata never grants existing-tenant membership. By default, local signup email is captured at `http://127.0.0.1:15434` and is not delivered externally. To send real email from the local stack, use the private SMTP profile and commands in [email setup](docs/EMAIL-SETUP.md). The signup screen identifies capture versus configured SMTP. Cloud signup requires a configured SMTP sender, email confirmation enabled and the provided `{{ .Token }}` confirmation template; see the setup guide. Additional staff invitations remain a separate feature. Customers never create accounts.

Staff signs in at `/management/login`; kiosks pair with one-time codes. Staff/device Auth cookies are separate and HTTP-only. Scope comes from verified identity. Never place database passwords or service-role keys in `NEXT_PUBLIC_*`. Remote writer connections verify TLS certificates.

Production requires explicit `APP_MODE`; missing configuration fails closed. `APP_MODE=demo` in production is an unauthenticated preview environment, never suitable for real tenant data.

## Containers and CI

Web/Python Dockerfiles and `compose.yaml` provide nonroot containers. Compose exposes web only on `127.0.0.1:3000`; inference has no host port. Put `APP_MODE` and a generated `ANALYSIS_API_KEY` in an ignored `.env`, then `docker compose up --build`. Local Supabase from containers uses `host.docker.internal` instead of `127.0.0.1` for project/writer addresses.

For hosted photo mode add the private `OPENAI_API_KEY` to the ignored Compose environment and use `docker compose -f compose.yaml -f compose.openai.yaml up --build`. Only this explicit override enables analysis-service egress and passes it the provider key. The image contains the service and strict appearance protocol, without Torch, weights or source records.

Compose keeps the application filesystem read-only and mounts a named volume only at `.local` for demo catalog persistence. Supabase remains the scalable persistence adapter. CI defines web checks/build/Playwright, Python tests, real Supabase pgTAP and container builds; remote CI has not been executed by this task.

## Verification

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd exec -- playwright install chromium
npm.cmd run test:e2e
# With the Python service environment installed (ports 8000/3200 must be free):
npm.cmd run test:integration
# With the local Supabase stack prepared:
npm.cmd run test:db
npm.cmd run test:supabase
```

Python instructions are in its README. SQL role tests run on actual PostgreSQL via PGlite:

```powershell
npm.cmd install --prefix "$env:TEMP/senmiva-pglite-rls" --no-save --package-lock=false @electric-sql/pglite@0.5.8
node supabase/tests/runtime-rls.mjs
```

The harness executes unchanged migrations/seed with real roles/RLS/constraints/triggers/pgcrypto. Only Supabase-managed Auth accessors are stubbed. This complements actual Supabase Auth, PostgreSQL 17, concurrency and pgTAP checks. Playwright uses an isolated catalog on port 3100. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for actual results and limitations.

## Privacy and honest results

Camera capture occurs after consent. In mock mode photos remain in browser memory. Explicit experimental mode processes an optional photo privately in memory after versioned consent and a deliberate analyze action, without photo persistence or request-body logging. Tracks stop and object URLs/file inputs are cleared on retake, finish, reset and exit. Kiosk warning/reset occur after 90/120 seconds of inactivity. Late responses cannot restore a finished UI. Server expiry is 15 minutes, with minute cleanup required in Supabase.

Finish/decline/revocation removes questionnaires, observations, experimental model outputs and recommendation details. Minimal consent/closed-session metadata retains for 30 days; operational audit metadata for 90 days; staff sees aggregate counters only. No customer analytics or external font requests load. Ingredient matching cannot establish concentration, efficacy, diagnosis or allergy safety. Model outputs are unvalidated dataset codes and silver-label ingredient candidates, not clinical assessments. See [model setup and limitations](docs/KIOSK-MODEL-SETUP.md).

Supabase preserves the current published formulation while a replacement draft is reviewed. The simpler demo temporarily removes an edited product from recommendations until republished. Product identity fields are immutable for existing SKUs in this MVP; register a new SKU for a different product.

## Continue efficiently

Start with `npm run context`, optionally `npm run context -- ui`, `database`, `ml`, `llm`, `vision` or `architecture`. Follow [AGENTS.md](AGENTS.md). The `vision` context contains only the isolated, consented photo-comparison guide; it never reads photos or credentials. Durable project memory:

- [Current state](docs/STATUS.md), [accepted scope](docs/SPEC.md), [architecture](docs/ARCHITECTURE.md).
- [Design principles](docs/DESIGN-PRINCIPLES.md), [design master](design-system/senmiva/MASTER.md).
- [Token-efficient workflow](docs/DEVELOPMENT-WORKFLOW.md), [prioritized backlog](docs/BACKLOG.md).

Production dependency audit is clean at implementation time. An unpatched **development-only** `braces <=3.0.3` advisory remains through Next's ESLint plugin, documented in VERIFICATION rather than hidden with an unsafe forced downgrade.
