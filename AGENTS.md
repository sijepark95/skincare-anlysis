# AELUNE working rules

- Read `docs/STATUS.md` first, then only the relevant section of `docs/SPEC.md` and subsystem documentation. Do not reload the entire repository or conversation.
- Keep the agreed MVP stable. Record new ideas in `docs/BACKLOG.md`; change an accepted decision only with a concrete reason and impact.
- Architecture: UI / HTTP -> application use cases -> domain; infrastructure implements ports. Domain must not import Next.js, Supabase or filesystem code.
- Tenant identity comes from verified staff membership or a paired device. Never trust a client-supplied organization ID. All tenant relationships need tenant-safe database foreign keys and RLS.
- No raw customer photo persistence, request-body logging, customer accounts, source AI-Hub images in the application, or automatic model training. Explicitly configured local experimental inference is authorized; show unvalidated dataset codes and ingredient candidates honestly. Keep mock results visibly identified and never claim clinical accuracy, efficacy or safety.
- Active kiosk serving uses explicit OpenAI photo analysis, authorized on 2026-10-11. Require the separate current unticked external-photo consent, strict appearance protocol and durable one-attempt claim; do not revert to ConvNeXt or product-only explanation without a new requirement. Photo-free continuation makes no new provider call. See docs/OPENAI-SKIN-SETUP.md.
- Kiosk: one primary action, large touch targets, anonymous transient sessions, camera cleanup and inactivity reset. Management: clear labels, draft/review/publish, accessible dense layouts.
- Primary `/kiosk` is the approved integrated beauty flow: age range → consent → fresh capture → combined palette/face/base confirmation → skin-first report. One separately consented OpenAI request supplies independently quality-gated skin/style observations. Use the explicit photo-only recommendation context; never fabricate completed answers. Only usable pores/spots/fine-lines add texture/uneven-tone/fine-line goals. Keep skincare and cosmetic shade matching separate.
- English/Korean/Spanish language changes must preserve state without AI calls. Under13 has no personal-photo flow; teen photos are off until both release gates are deliberately enabled. Optional adult Gender stays in browser memory; the explicit selection supplies a transient styling default (Man→masculine, Woman→feminine, absent/other→balanced). Send only the allowlisted styling direction to preview requests, never raw Gender to photo/image providers, and persist neither direction nor individual Gender. Raw Gender may be submitted on Finish solely for consented, suppressed aggregate statistics. Never infer demographics from images.
- Local landmark ratios are geometric percentages, not confidence/beauty scores. Hide unmeasurable values. The optional animal vibe is a neutral appearance association, never personality. Nine original-photo edits (makeup3→hair3→color3) require separate unchecked consent and individual durable attempts; display partial results/failures, no retries, bounded12min/session15min, discard late work after cancellation/changes/exit. No photos, generated pixels, ratios, animal vibe or individual Gender in DB/QR.
- QR saves confirmed style choices and original eligible formula/shade versions for seven days, opt-in, hash-only and public HTTPS. Preserve legacy APIs/QR without weakening their guards. `/kiosk/skin` and optional legacy color remain compatible routes, not required steps. See `npm run context -- beauty`; old feature documents describe only those legacy paths.
- Use semantic design tokens: `design-system/aelune/MASTER.md` for the public website/style tile and `design-system/senmiva/MASTER.md` for the existing kiosk/management layouts. Lovi is a design reference, not an asset library. Hero video is approved promotional content, not evidence of implemented analysis.
- Complete a coherent feature with relevant checks. Report changes, validation and remaining issues briefly. Update STATUS to current state; do not append long transcripts.
- Do not commit secrets or generated artifacts. Use lockfiles and explicit environment configuration; production must fail closed.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
