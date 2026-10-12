# Design principles

Primary AELUNE integrated kiosk and phone guide follow `design-system/aelune/BEAUTY-KIOSK.md`: cool white/ice blue/lilac/sans, skin-first report, large touch areas, en/ko/es, neutral measured proportions, optional playful appearance vibe and nine honest own-photo preview states. The public full-screen film retains the AELUNE master. Existing Senmiva management/legacy skin layouts retain the foundation principles below where they do not conflict with that explicit page override. Reference screenshots guide structure, never copied asset identity.

## Source and intent

Reference reviewed: user's `Lovi ios Jan 2026` screenshots (overview contact sheet, selected onboarding/product patterns) and the approved smart-mirror imagery/hero film. Borrow clear step progression, generous whitespace, calm rounded selection cards and consistent actions. Do not copy Lovi branding, artwork, pricing patterns or assets. Senmiva should feel like a calm premium retail consultation, not a medical instrument or a dense futuristic control panel.

## Principles

1. **One decision at a time.** A kiosk page has one obvious primary action. Keep questions short and options tangible. Back/end actions stay predictable. Use plain English and avoid technical model names in customer decisions.
2. **Touch first, desktop efficient.** Kiosk actions are at least 56px high, management actions at least 44px. Content fits a 768px tablet without horizontal scrolling; results may scroll naturally. Management uses tables and labeled dialogs, not kiosk-sized cards everywhere.
3. **Quiet confidence.** Warm ivory surfaces, lavender accents, charcoal text/buttons, restrained rose and sage. Serif display headlines add warmth; UI copy remains a readable sans serif. Use a small consistent spacing/radius system instead of arbitrary ornament.
4. **Truth is part of the interface.** Mock results are labeled; no invented confidence percentages, diagnosis, purchase metrics or testimonials. Ingredient matches explain their basis. The hero film is identified as a promotional concept.
5. **Privacy is visible and functional.** Consent precedes capture. Show where photos live and when they disappear. Finishing is prominent and clears all temporary state. Management has no customer portraits or session drill-down.
6. **Availability matters.** Products show the store's price. Only eligible inventory appears. Empty recommendations explain that no product matches the constraints and invite staff assistance; do not weaken exclusions silently.
7. **Access without friction.** Semantic headings, labels, visible focus, keyboard-operable choices, focus-trapped dialogs, non-color state cues, clear errors and reduced-motion support. Meet WCAG AA contrast for normal text and interactive states; decorative pastels are not text colors.
8. **Motion has a purpose.** Subtle transitions and one progress animation. Avoid distracting scanning effects or mock precision overlays. The landing film has controls; reduced-motion users see the poster. Questions advance through a guest action. The consented live-photo step is the explicit exception: stable centering starts a visible three-second countdown, then captures and analyzes automatically. A pause/skip option stays available; lost alignment cancels the countdown. Scan visuals describe positioning/capture, never invented skin measurements.

## Tokens and component contract

`src/app/globals.css` is the implementation source for semantic tokens; `design-system/senmiva/MASTER.md` records the system. Reuse Brand, ProductArt, Modal and shared button/option/status styles. Product illustrations are generated CSS packaging, not genuine merchant packshots. Use real approved packshots later with alt text and provenance.

Kiosk progression uses one labeled six-step count. Question choices stay in rounded cards; main consent and optional external AI consent remain distinct and unticked. Photo controls explain automatic opening/countdown, optionality and pause/skip choices. A mirrored preview uses transient face position and plain status guidance, without identity or skin-score claims.

Active OpenAI results lead with a professional, plain-language skin appearance summary and source-labelled care priorities. Five detailed interpretations are expandable so the main path stays calm. Ingredient cards explain cosmetic purpose, the applicable store-guide rationale and whether an eligible store product contains the ingredient; links scroll to actual matched product cards. Each product states its registered price and listed-ingredient reasons. Empty catalogs still offer the analysis and ingredient guide, clearly noting unavailable matches. Limited, unassessable and photo-free states do not imply a successful usable photo analysis. Source badges identify direct OpenAI photo observations; there is no second explanation request or dataset-code display in active mode. Only the separate optional experimental provider places products before expandable dataset codes.

New steps focus their heading for assistive technology; buttons, choices and disclosure summaries retain visible keyboard focus. One/two-product results remain balanced without placeholder products. Initial store-guide examples must never be presented as a validated professional policy. Keep provider retention and technical details in the labelled disclosure after the required photo consent; explain observations and matching purpose in the main flow without piling legal language into every card.

Before changing a page, identify the guest/staff task and its primary action. Before accepting it, check tablet landscape/portrait, desktop, empty/loading/error/disabled states, keyboard focus, and privacy cleanup. Screenshot changes should be reviewed alongside functionality, not substituted for tests.
