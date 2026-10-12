# Senmiva design system

Premium, calm, simple retail discovery. Based on the user's Lovi onboarding references and pastel smart-mirror campaign, adapted for kiosk readability. This curated specification replaces the generic design-search output. Behavioral principles: docs/DESIGN-PRINCIPLES.md.

| Semantic token  | Value   | Purpose                       |
| --------------- | ------- | ----------------------------- |
| paper           | #FAF8F5 | Warm ivory page surface       |
| white           | #FFFFFF | Cards, options and forms      |
| ink             | #29282B | Text and primary actions      |
| muted           | #67616C | Readable secondary copy       |
| line            | #E7E2E7 | Decorative boundaries         |
| lavender        | #EEE8F5 | Selected options and emphasis |
| lavender-strong | #746284 | Display emphasis and focus    |
| rose            | #F6E9E6 | Occasional product surface    |
| sage            | #E9EEEA | Published status surface      |
| danger          | #9B3434 | Error text                    |

Implementation source: src/app/globals.css. Local system sans serif (Arial fallback) for UI; Georgia for editorial headlines. No font-network request. Display 38–86px responsive; kiosk headline 37–57px/body 16px/actions 16px. Management heading 35–39px/table 12–14px/captions 10–12px. Tiny decorative eyebrows are never essential instructions.

Spacing: 4/8/12/16/20/24/32/40/48/64px. Card radius 16–24px; lavender selected card with strong border/checkmark. Pill buttons: charcoal primary, white secondary with border. Kiosk targets >=56px; management >=44px. Focus outline 3px with offset. Status always has text, not color alone.

Kiosk: white rounded question cards, one main action, stable brand/privacy shell and labeled six-step progression with predictable back/end. In active OpenAI photo mode, main consent and separate optional adult/single-subject external-photo consent are visually distinct and initially unticked. Declining photos keeps the camera off and proceeds with questionnaire/store-policy matches. Landscape welcome/photo capture use image/content splits; portrait stacks. The photo-consented step opens the camera automatically; a mirrored preview shows local face framing and a visible cancellable three-second countdown before automatic capture/analysis. Keep pause and photo-free alternatives accessible; no invented skin scan percentages. OpenAI results lead with a professional appearance summary and source-labelled care priorities, followed by expandable five-feature interpretations, ingredient-purpose/rationale cards and eligible registered-store product cards. Ingredient links scroll only to actual matching product cards; empty catalogs retain the summary and ingredient guide without placeholders. The derived report interprets saved direct OpenAI observations and matching facts without a second LLM request, new transfer or stored prose. Initial onboarding ingredient-guide examples remain labelled as examples. Do not show dataset codes, confidence bars or a second product-only LLM explanation in this mode. Failed external attempts offer photo-free continuation or finish/new session; repeated Analyze/retake is disabled within that session. The optional legacy experimental mode retains products before expandable code cards. Finish/reset stays prominent; one/two-product layouts stay balanced. New steps focus the noninteractive heading without a decorative focus rectangle; interactive focus rings stay visible. Guest controls and disclosure summaries >=56px. Kiosk refinements are scoped under .kiosk. Management: desktop sidebar/store selector, restrained tables/cards, clear active-provider/consent labels; small screens use horizontal navigation and scrollable tables.

Lucide icons consistently 16–24px; larger only in focused empty states. ProductArt is local CSS illustration. Avoid emoji, unrelated icon libraries, fake merchant packshots and glass panels behind essential text. Hero video is approved promotional content, separate from analysis claims.

Motion: 180ms hover and slow nonessential analysis pulse; respect reduced motion. No auto-advancing kiosk steps, clinical precision effects, decorative charts or bouncing. Design loading, empty, validation and network-error states.

Review desktop 1440px, tablet 1024x768/768x1024 and narrow390px. Run axe and keyboard checks; inspect screenshots because automated accessibility cannot detect every layout failure.
