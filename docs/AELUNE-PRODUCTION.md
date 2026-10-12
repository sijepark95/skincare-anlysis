# AELUNE — Inside the Drop

## Direction and scope

AELUNE is a working brand concept created for this project. Its tagline is **Skin, seen differently.** The identity connects luminous water imagery with a clear, restrained skincare discovery interface. This is a naming and visual direction, not a trademark, domain or company-registration clearance.

The public website introduces the actual in-store experience and links to the existing kiosk and store workspace. It does not replace authentication, photo consent, analysis protocols, recommendation policy or tenant isolation. The CGI story is promotional imagery, never evidence of analysis accuracy or a medical measurement.

The original request describes a 30-second, 9:16 film and ends at “The liquid swirls”. The website treats the supplied story as its starting brief; the ending resolves toward ingredient guidance and products registered in the store. The web scroll duration is independent of the source-film duration.

## Identity and editable files

| Item                     | Location                                            | Notes                                                               |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------- |
| Editable style tile      | `/brand` · `src/app/brand/page.tsx` and `brand.css` | Live HTML/CSS samples, not a finished-product screenshot            |
| Selected vector wordmark | `public/brand/aelune-wordmark.svg`                  | Editable source master; its production provenance is recorded below |
| Ice / ink                | `#EAF5FB` / `#11262F`                               | Atmospheric surface / readable text and actions                     |
| Typography               | Georgia + Arial system stacks                       | Editorial display and practical interface; no font-service request  |
| Opening poster           | `public/media/aelune/drop-poster.webp`              | Immediate still while motion is loading or unavailable              |

Keep generated originals and prompts alongside their production record. A generated raster concept remains a raster source; the editable SVG is identified separately. The wordmark is a new project identity, not a claim that the name is commercially available.

## Visual Story

| Scene                    | Visual story                                                                                                                                              | Website copy                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 01 — The drop            | A single crystal-clear droplet floats in a luminous pastel-blue space. Quiet framing reserves room for the opening headline.                              | Skin, seen differently. A clearer way to discover skincare in your store. Meet your skin. |
| 02 — The crossing        | The drop meets the water. A circular ripple opens; the camera enters its center. The source surface leaves the frame before the next world arrives.       | No copy — let the motion lead.                                                            |
| 03 — Beneath the surface | Translucent layers, water-like forms and particles create an abstract microscopic journey. The imagery is scientifically inspired, not medically literal. | A little closer. Visible appearance is one part of your skincare story.                   |
| 04 — The human moment    | Particles resolve into a natural-looking adult face. A delicate visual overlay suggests observation without diagnostic numbers or clinical claims.        | Understand what you see. Photo observations meet your goals and preferences.              |
| 05 — The connection      | The overlay dissolves into luminous serum-like streams. The visual journey resolves toward a calm, usable interface and the real offering.                | Ingredients with a purpose. Thoughtfully matched to eligible products in your store.      |

The story uses one visual thread: water becomes an abstract layer, then a human moment, then a path to ingredient guidance. Website headings, buttons and supporting copy remain real HTML; generated media contains no navigation, result values or baked-in website text.

## Scroll pacing and fallbacks

The hero and pinned film now fill the browser viewport edge to edge, as requested in the full-screen revision. Navigation overlays the hero. The original9:16film is preserved; browser playback uses a cover crop, with the poster and canvas sharing the centered44%vertical focal position. Desktop therefore shows a closer macro framing; phones retain more of the vertical scene. HTML chapters use directional translucent backing, and the ripple removes chapter copy/backing. The normal reading fallback retains the uncropped poster and full flowing content.

The implemented story stage uses native forward and reverse scrolling. Its travel is independent of film duration: 7.4 viewport heights of active travel plus the one-viewport pinned stage. Text-bearing scenes receive deliberate reading holds rather than inheriting timing directly from the source video. The crossing remains a dedicated visual beat.

| Beat              | Active travel        | Framing and copy                                                        |
| ----------------- | -------------------- | ----------------------------------------------------------------------- |
| Opening hold      | 0.8 viewport heights | Opening still; first HTML chapter has reading time                      |
| The drop          | 1.0 viewport heights | Slow travel toward the water, first chapter retained                    |
| Inside the ripple | 1.4 viewport heights | Source leaves, camera travels inward; all chapter copy hidden and inert |
| A closer look     | 1.7 viewport heights | Film 10–24s; abstract layers resolve into the face; second chapter      |
| Your next step    | 1.5 viewport heights | Film 24–30s; face becomes serum then a drop; final chapter and link     |
| Resolution hold   | 1.0 viewport heights | Last frame rests while the final copy remains readable                  |

The mapping in `src/ui/scroll-story-timeline.ts` was adjusted after inspecting the actual film: the drop uses 0–5s, the copy-free ripple uses 5–10s, discovery uses 10–24s and resolution uses 24–30s. The source surface leaves before the hydration world arrives. The generated face appears around 19s and resolves through serum around 25–28s; the opening droplet returns at the end. These are observed aesthetic transitions, not a demonstration of the analysis service.

Visitors can skip the film to the ordinary experience section. Reduced-motion and constrained-device modes preserve every content chapter and primary action in flowing HTML and do not request the frame sequence. A still remains useful if motion media is missing or fails. Mobile copy reflows around the portrait subject rather than simply shrinking the desktop layout.

## Asset provenance and prompts

Provider: **Higgsfield MCP**, as specified in the supplied cinematic instructions. Exact prompts, submitted parameters, job IDs, dimensions, source hashes and measurements are preserved in `public/media/aelune/production.json`, without credentials or temporary URLs. The portrait is a generated adult campaign subject. No customer or AI-Hub photo was used.

The user's original scene direction is preserved in the attached brief and current conversation: an extreme macro clear droplet, slow fall and circular impact ripple, an immersive hydration-inspired abstract world, particles resolving into a photorealistic face, a subtle AI appearance overlay, and luminous liquid serum. Production additions must preserve that identity and distinguish aesthetic metaphor from implemented functionality.

### Production record

| Asset           | Job / original                                                              | Actual output                                                                                                 |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Logo concepts   | `e840a4db-1ec3-4ada-b916-1c27990f1cb8` / `public/brand/aelune-concepts.png` | Three directions; selected top crescent-cut droplet for its clear small silhouette and connection to the film |
| Opening still   | `19eb5816-0b91-4959-9eb8-df4be14c42e7` / `drop-source.png`                  | 1520×2688 original; 1018×1800 WebP poster, 44,906bytes                                                        |
| Editorial still | `1306bf6c-7980-45b8-a085-e9063ed34a47` / `skin-source.png`                  | 1792×2240 original; 1440×1800 WebP poster, 199,610bytes                                                       |
| Continuous film | `bfcaa3ad-bd5a-417f-9ab4-663ed6df89d7` / `inside-the-drop.mp4`              | Seedance2.5, 1080×1920, 24fps, 30.042s, HEVC, no audio; 13,729,959bytes                                       |
| Browser preview | `inside-the-drop-web.mp4`                                                   | H.264/yuv420p, 720×1280, 24fps, fast-start, no audio; 5,561,133bytes                                          |
| Scroll sequence | `story/manifest.json` and `frame-0000.webp`–`frame-0540.webp`               | 541frames, 720×1280, 18fps; 15,787,410bytes total, largest55,400bytes                                         |

The SVG mark and wordmark are editable vector interpretations of the selected generated raster concept. The concept PNG is preserved separately; it is not represented as a model-generated SVG. The wordmark retains editable text with the shared Georgia stack. Convert text to outlines only for a delivery that specifically needs fixed glyph geometry.

One continuous generation carries all transitions, using the selected drop as starting/ending reference and the adult portrait as identity reference. There are no independently assembled clip seams. Representative source frames, the ripple/face/return boundaries and actual forward/reverse browser scrubbing were inspected. The film contains no website text or diagnostic numbers. The face/liquid transformation is intentionally CGI; it does not imply physical skin penetration, measurement or product efficacy.

The original is preserved unchanged. An H.264 preview avoids relying on HEVC browser support. The site does not load the original film during normal browsing; `/brand` uses explicit native playback with `preload=none`. The pinned story fetches only a nearby frame window: at most3requests concurrently,15priority frames and16decoded entries, with cancellation, bitmap release and2attempts per missing frame. Full sequence transfer is about15.8MB only if the visitor traverses it; it is not preloaded in one batch.

## Editing and publication

The style tile is edited in `src/app/brand/page.tsx` and `src/app/brand/brand.css`. Shared colors and fonts live in `src/ui/aelune-tokens.css`; the tile imports the same tokens used by the website. Website copy, story chapters, links and media paths are in `src/content/aelune.ts`. Chapter/frame timing lives in `src/ui/scroll-story-timeline.ts`. Changes become shared only when the application source is rebuilt and deployed. No browser-local draft is presented as a published edit.

Use `npm run context -- brand` to load only the current status, public design principles and this editing guide for future work. The kiosk/management design remains in `design-system/senmiva/MASTER.md`; public identity rules are in `design-system/aelune/MASTER.md`. This keeps task context small and prevents the campaign layout from changing kiosk workflows.

`scripts/prepare-aelune-media.py --check` verifies numbering, every local frame path, nonempty sizes, poster presence and first/middle/last decoded dimensions. Preparing a new sequence requires Python/Pillow and FFmpeg (or the ignored local imageio-ffmpeg installation); run the script without `--check` only when its output directory does not exist. It uses fresh staging and refuses to overwrite the accepted sequence. Preserve an existing version before replacing media and update the centralized paths deliberately. The H.264 preview was derived with FFmpeg using `scale=720:-2`, `libx264`, `-crf 23`, `-pix_fmt yuv420p`, `-movflags +faststart` and `-an`.

The project runs locally. This work does not authorize public deployment, a new subscription, or changing any external account settings. No invented testimonials, partner logos, clinical efficacy claims, customer counts or store availability are included.

## Acceptance and observed limitations

The full-screen revision passes the12affected Chromium cases again, including exact hero/poster/canvas edge alignment at1440×900,1024×768 and390×844, active cinematic axe, visible overlay copy/controls and native forward/reverse painting. Desktop macro crops and mobile hero/story screenshots were reviewed. Lint, strict TypeScript, all806unit tests and production build pass. The preceding full76browser run is recorded below; unrelated browser cases were not repeated for this scoped layout change.

Static/fallback acceptance has passed in Chromium against the real generated posters and selected SVG: the public site and style tile load at 1440×900, 1024×768 and 390×844 with no horizontal overflow or axe WCAG 2 A, 2 AA or 2.1 AA violations. The first keyboard action reaches the content skip link; source images decode successfully. Reduced-motion, data-saving and short-landscape modes make zero story-sequence requests. Missing-manifest recovery preserves all chapters and the poster. The seven focused static/fallback tests passed; desktop/tablet/mobile screenshots were reviewed. These checks used an isolated local demo server and made no customer-photo, authentication-email or external-AI requests.

Final acceptance also passes against the actual541-frame sequence: native wheel forward/reverse, accurate chapter mapping, hidden/inert inactive links, copy-free ripple, final hold, skip, frame-failure recovery with at most2attempts, manual reading-mode restoration and a resting request window of at most15frames. `/brand` requests no movie before explicit playback, then the H.264 preview decodes and plays. Native story screenshots at1440×900 and390×844 were inspected; the phone caption now has an opaque backing to keep contrast stable over changing frames.

Final local checks: ESLint/strict TypeScript,806Vitest tests across41files, production build and all76Chromium tests pass. This includes the full existing kiosk/management suite and12new cinematic/brand cases. All541frame paths, sequential filenames, nonempty sizes and first/middle/last decoded dimensions pass the asset check. Production and development outputs remain separate; the connected kiosk was not reset. No email endpoint, customer photo or external analysis request was used for these frontend checks.

Observed limits: Chromium was exercised locally; Safari/Firefox and physical retail tablets still need a device pass. The generated morphing is stylized CGI, with no claim of measured analysis quality. No public hosting or domain setup was performed. The new name is a working identity. Source movie, stills and full frame sequence remain local project assets; a future deployment should preserve their paths and cache static media appropriately.
