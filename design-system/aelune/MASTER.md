# AELUNE public design system

AELUNE is the working brand for a skincare discovery experience and retailer workspace. The public website uses cinematic water imagery, natural skin texture and editorial restraint: **Skin, seen differently.** The name is a creative proposal, not a trademark-clearance claim.

## Scope and implementation

Use this document for the public home page and `/brand` style tile. Keep the existing kiosk and management layouts governed by [the Senmiva system](../senmiva/MASTER.md); the public redesign does not change their workflows, consent or analysis protocol. Shared brand identity may appear across both surfaces.

- Shared tokens: `src/ui/aelune-tokens.css`, scoped to `.aelune` and `.brand-tile`.
- Public composition: `src/ui/aelune-landing.tsx` and its scoped stylesheet.
- Editable identity, copy, links and media: `src/content/aelune.ts`.
- Scroll renderer and timeline: `src/ui/scroll-story.tsx`, `scroll-story.css` and `scroll-story-timeline.ts`.

## Palette and typography

| Token            | Value     | Role                                         |
| ---------------- | --------- | -------------------------------------------- |
| `--aelune-ice`   | `#EAF5FB` | Luminous blue public surface                 |
| `--aelune-ink`   | `#11262F` | Essential text, actions and retailer section |
| `--aelune-muted` | `#546873` | Supporting readable copy                     |
| `--aelune-line`  | `#CDDDE4` | Decorative dividers; never essential text    |
| `--aelune-paper` | `#F7F8F5` | Resting editorial and privacy sections       |

Georgia supplies expressive, generously sized headlines with restrained italic emphasis. Arial/Helvetica supplies precise navigation, body copy and controls. Both use local fallbacks; do not introduce a font network request. Preserve dark ink contrast on pale surfaces and readable light text on ink. Keep inherited lavender styles out of public headings.

Use one clear heading hierarchy: one page `h1`, meaningful section `h2`s and descriptive `h3`s. Oversized serif type and generous space create emphasis; decorative eyebrows do not carry essential instructions. Body, privacy and functional link text must remain readable on small screens. Primary actions have at least 48px height; other interactive targets maintain at least 44px with adequate spacing and visible keyboard focus.

## Identity and imagery

The crescent droplet symbol follows the selected Higgsfield-generated concept. `public/brand/aelune-wordmark.svg` and `aelune-mark.svg` are editable vector interpretations; preserve the selected raster concept and production provenance separately. Do not describe a generated raster as a vector master or claim a registered trademark.

Use a full-viewport crystal droplet hero and edge-to-edge cinematic story, followed by a realistic editorial skin portrait. Use ice, water, translucency and cool metallic reflections consistently. The film is conceptual CGI, labelled as creative interpretation, not a recording or demonstration of implemented skin analysis. Keep labels, navigation, chapters and calls to action as selectable semantic HTML rather than baked into imagery.

## Composition and motion

The journey moves from a floating drop through a ripple and abstract hydration world toward skin and a serum resolution. Text and motion have separate responsibilities: HTML explains the offering; footage expresses the mood. Leave the ripple transition without chapter copy so the motion can breathe. Follow with ordinary flowing sections explaining skin observations, ingredients, actual store products and the staff workspace.

Use native scrolling, a reversible piecewise timeline and explicit still holds; never intercept wheel or touch input. Count active scroll travel independently from the visible sticky stage. Do not apply `overflow: hidden` or an unintended scrolling container to its ancestors. Keep the portrait subject visible on mobile rather than cropping important action off screen.

The hero begins at the top of the viewport with navigation overlaid; its background fills every edge. The cinematic stage also fills the viewport, using matching poster/canvas cover crops at a centered44%vertical focal position. Wide screens intentionally show a closer macro crop of the vertical source. Use translucent directional backing for readable HTML chapters; remove the chapter backing during the copy-free ripple. Mobile copy sits lower with stable caption contrast. Ordinary reading fallbacks preserve flowing text and the uncropped poster.

Load a useful poster first. Bound concurrent frame requests and decoded memory, prioritize the requested frame and nearby frames, cancel stale work, release evicted bitmaps and retain a poster if loading fails. Reduced motion, Save-Data/slow connections, short viewports, unavailable media and the explicit “Read without motion” choice preserve all chapter copy and actions in normal document flow. A skip-film link remains available.

## Content and honesty

Visitors can open the kiosk, sign in or create a real workspace; navigation must resolve to functioning routes. Do not add fake statistics, endorsements, testimonials, customer logos, scan confidence or medical claims. Label illustrative workspace previews and generated editorial imagery clearly.

Photo analysis is optional and requires separate explicit permission before sending a photo to OpenAI. The application processes photos in memory without saving them or using them for training; provider retention may apply. Preserve the photo-free path. Cosmetic observations are not validated clinical measurements. Ingredient presence does not establish concentration, efficacy or allergy safety. Recommend only eligible products registered in the paired store; never populate an empty catalog with invented products.

## Review and handoff

Verify desktop 1440px, tablet 1024px and narrow 390px layouts, keyboard navigation, contrast, overflow and essential text. Check ordinary forward/reverse scrolling and fast jumps with the actual sequence; compilation alone does not establish smooth pacing. Inspect representative frames and seams, validate every manifest path and report measured transfer size. Keep the style tile tied to shared tokens, and document asset prompts, provenance, editing paths and any observed limitations without exposing secrets.
