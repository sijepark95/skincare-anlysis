# Current state — 2026-10-12

## Product

**AELUNE is an integrated beauty kiosk with desktop store management.** Primary `/kiosk`: required age range → distinct unticked purposes → fresh automatic stable-face/cancellable3s capture → combined palette/face/base confirmation → skin-first complete report. English/Korean/Spanish preserve state without AI calls. Optional skin/style choices follow results; skin type defaults unknown. Under13 photo excluded; teen photo release defaults OFF in both app and DB. Adult optional Gender/decline stays browser memory only; explicit Man/Woman supplies masculine/feminine styling and other/declined stays balanced. The result page has decorative cute emoji/emoticon stickers and pastel accents.

Report: five skin observations + reviewed ingredient/store skincare → portrait-led eye/nose/lip raw geometry tracks with optional animal/confirmed face hashtags → confirmed palette/base color cards → own-photo makeup3 + registered lip/blush/eye shades → own-photo hair3/color3 stylebook → download/QR/Finish. Cool white/ice blue/lilac/sans touch design, original reference hair photography labelled inspiration. Completed generation counts return to normal flow; only active generation keeps a sticky cancellable status. Public full-screen AELUNE film/brand retained. Legacy skin/color/beauty APIs, `/kiosk/skin` and old QR supported.

## Contracts and privacy

New `beauty-complete-v1` uses one OpenAI Responses photo request, pinned `gpt-4.1-mini-2025-04-14`, independently quality-gated skin/style facts, store:false/no tools/history/retries. Complete photo notice `2026-10-beauty-complete-photo-v1`. Only usable pores/spots/fine-lines route to texture/uneven-tone/fine-line goals; redness/flaking infer neither hydration nor sensitivity. Explicit photo-only context never fabricates questionnaire answers. Separate cosmetic matcher requires guest-confirmed palette/base; concealer match default, brighten explicit. Reasons use reviewed policy/catalog facts, no invented products/efficacy.

`2026-10-beauty-preview-v1` opts into nine individually claimed sequential original-photo edits: makeup3→hair_style3→hair_color3. Partial success/failure displays immediately, no retries, honest task/count strip.60s provider/75s transport/80s browser;12min total or15min absolute session first. A bounded transient X-Beauty-Styling-Direction header selects natural/groomed/definition makeup and crop/curtain/quiff for Man; raw Gender never reaches photo/image providers and direction is not persisted. Identity-preserving prompts are not a fidelity guarantee. Image API provider retention may apply. Hidden/back/change/withdraw/Finish/expiry clears source/generated URLs and rejects late results. Landmarks/ratios stay on device. No pixels/generated images/ratios/animal/individual Gender in DB/QR.

Complete QR `beauty-complete-guide-v1` retains confirmed style/locale and original eligible formula/shade versions for7days under `2026-10-complete-save-v1`.256bit fragment-only capability/hash-only DB; anonymous publishable-key read/revoke, no staff/service role/table SELECT. Stock/version changes mark original item unavailable. Finish preserves explicitly saved guide. Local localized offline HTML/print can reflect the transient styling direction; QR retains general confirmed choices without Gender/direction. Local export works; public issuance remains gated because `BEAUTY_PUBLIC_ORIGIN` is unset. No deploy/tunnel performed.

## Database and management

Local Supabase Auth, staff login/onboarding, pairing/revocation, normalized formulas/listings and owner cosmetic color/base review work. Common immutable shade version + disjoint color/base details separate from products/formulas/stock; drafts/foreign-store/unknown ingredients/exclusions/unreviewed/hidden/out-of-stock products excluded. Tenant-safe composite FKs/RLS remain. Exactly9restricted writer signatures.27migrations through202610110021 applied, no reset. Absolute session expiry and slot deadlines enforced in DB and UI; minute cleanup includes complete transient rows/expired QR.

Opted-in adult completed sessions count once, Gender aggregate only, no individual Gender row. Last4closed UTCweeks, separate age/Gender, suppress whole dimension if any nonzero cell<10. Staff cannot read individual results. Current user catalog and Gmail settings preserved.

## Runtime and verification

Connected development app3000/private8000/localSupabase15431/15432/mail15434, loopback. New preview flag enabled locally; teen flags OFF. Secrets remain ignored. **Never execute account/mail-creating supabase-smoke while Gmail is active.** Safe acceptance: `node scripts/beauty-complete-acceptance.mjs --local-synthetic`.

Latest reference-result UI: full lint/strictTS, 1,362 Vitest tests/66 files and production build pass. After final ARIA/portrait/status-strip fixes, affected 24 tests/3 files, scoped lint/strictTS and build pass again. 38 distinct complete/legacy browser cases verified across behavior and focused final runs. Final 1024×768, 1080×1920 and 390×844 screenshots reviewed: axe 0, no overflow/portrait overlap/page errors. Evidence: `test-results/run-60876`. No DB/backend contract change or external AI/photo/email call; previous Python 226 and styling/browser evidence remain prior checks.

Prior integrated foundation evidence remains: actual PostgreSQL 635 pgTAP assertions/12 suites; synthetic two-tenant BFF/DB/restricted-writer/QR acceptance with fixtures removed; 28 integrated/legacyQR browser cases. Real bundled FaceLandmarker task/WASM loaded locally on a synthetic blank image, without a face-quality accuracy claim. All 115 distinct browser cases validated across full run 113 pass and focused 2 pass recheck; see the exact test-harness/fake-camera note in VERIFICATION.

Before public pilot: publicHTTPS + hosted Supabase/Auth/SMTP/private service/cleanup monitoring; reviewed merchant policy/catalog; controlled-light consenting-adult observation/base/fidelity/latency tests; physical tablet/camera/reset tests; distributed quotas, backup/recovery. No empirical accuracy/model-winner/publicdeployment claim; no retraining or AI-Hub source photo use this release.

## Efficient continuation

Read AGENTS and this status, then only `npm run context -- beauty|skin|color|brand|database|architecture`. New primary work uses BEAUTY-CONTEXT/BEAUTY-KIOSK and design override. Legacy docs apply only to their named endpoints. Update current decisions briefly, put evidence in VERIFICATION/new ideas in BACKLOG. Do not reload datasets/media/chat or make AI calls for translation/manual choices/reads. Repository-local Git author uses the verified GitHub account and its private noreply address. Commit application code/assets and safe example settings; keep actual secrets, datasets/checkpoints, build outputs, temporary tools and test artifacts ignored.
