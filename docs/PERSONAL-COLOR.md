# Personal palette and store lip shades

This optional kiosk consultation is separate from skincare. OpenAI suggests an approximate warm/cool/neutral and soft/clear color direction from a **new separately consented photo**. The guest must choose and confirm a palette and preferred finish before any product match appears. Choosing a different palette or finish, refreshing matches and opening a saved result make no AI request. Manual discovery works without sending a photo.

## Try it

Complete a kiosk skin consultation, then choose **Explore lip colors** above Finish. Compare the six style palettes, optionally open **Optional photo suggestion**, accept its initially unchecked purpose-specific notice and capture or upload a fresh image. Analyze explicitly. A suggestion never checks a palette automatically; confirm your own choice. An unclear photo has no inferred color direction and manual selection remains available.

The active connected runner already supplies the private OpenAI configuration used by skin analysis; no additional API key or service is needed. Restart `npm run dev:connected` after updating the private Python service. Mock/experimental modes offer manual palette discovery only. No external color calls happen on startup or without a photo.

## Register store shades

1. As an organization owner, add a catalog item with category **Lip color**. Each purchasable shade must have its own SKU/variant, complete actual formula and reviewed publication. Do not use one generic formula when shade pigments differ.
2. Publish the formulation, then use **Review lip shade** on that catalog row. Enter its actual shade name, hue family, warm/cool/neutral description, soft/clear intensity, gloss/satin/matte finish and screen swatch. Confirm the review checkbox to publish an immutable metadata version. Publication does not alter the formula or listing.
3. Set the relevant store listing visible and stock above zero. Managers can manage listings; only owners publish formulas/shade metadata. A missing, incomplete, unpublished, hidden, unavailable or foreign-store item never appears as a match.

Matches come from the confirmed palette and current store shade versions, not invented AI products. Preferred finish is a hard filter. Opposing warm/cool metadata is excluded for those directions; neutral registered shades may accompany either. Matching undertone and intensity rank first, with at most three results. Alternative intensity is labelled. Guest ingredient exclusions remain hard filters; unresolved exclusions withhold results. Skin type associations and skincare ingredient-rule scores do not rank lip shades. Lip items are excluded from the skincare matcher.

An empty store result is honest. Register reviewed shades or ask staff about testers; the app does not populate the merchant's catalog automatically. Swatches and palette previews are approximate screen colors, not virtual try-on, foundation matching or a promise of suitability.

## Boundaries and privacy

`POST /v1/analyze/color` is a separate authenticated private FastAPI endpoint. The only provider inputs are a random request ID and a metadata-stripped, bounded photo; no session identity, questionnaire, store catalog or skin analysis is transferred. The pinned model is `gpt-4.1-mini-2025-04-14`, prompt `personal-color-suggestion-v1`. The strict eight-field result stores only image quality, categorical undertone/chroma and enumerated limitations with protocol identifiers. Unsupported/free-text output is rejected. Limited/unassessable images require both color directions to be uncertain. No seasonal class, race, age, health inference or confidence percentage is generated.

The separate notice is `2026-10-personal-color-photo-v1`. A durable database claim allows at most one image attempt per session, including failures and concurrent requests. Withdrawal deletes saved color observations/preferences and permanently invalidates an in-flight attempt. Reaccepting cannot revive or repeat that attempt. Manual palette confirmation remains possible. Finish, expiry and device revocation purge transient records; a late response cannot restore them.

The app does not persist, log or train on guest photos. Camera tracks/object URLs and unsent captures are cleared on hidden tabs, closing, confirmation, reset and unmount. Existing OpenAI image sanitizer limits and `store:false`, no-tools/no-history/no-retry transport apply. Provider retention may still apply; `store:false` does not mean zero retention. [OpenAI's current data controls](https://developers.openai.com/api/docs/guides/your-data) describe normally up to30-day abuse monitoring retention with legal/safety exceptions, checked2026-10-11. Metadata stripping removes ICC/EXIF and JPEG re-encoding can further shift color. Lighting, white balance, makeup, camera and display variation make this an **exploratory styling suggestion**, requiring guest confirmation and in-person comparison. Independent controlled-light evaluation has not been performed.

## Architecture and persistence

UI/HTTP → `application/personal-color.ts` ports/use cases → pure `domain/personal-color.ts` matcher and `domain/color-analysis.ts` strict protocol. Private HTTP and Supabase/demo adapters implement the ports. The existing skin protocol and its five feature outputs are unchanged.

Normalized tables: `variant_shade_versions` (immutable metadata) and `variant_shades` (current pointer) reuse existing variants/formulations/listings. Transient tables separately hold purpose consent, one attempt, color observation, quality flags and guest preferences. Composite tenant foreign keys, RLS, owned-device RPCs and an exact sixth restricted writer signature protect writes. Recommendations are derived live from confirmed preferences and the current eligible catalog; no duplicate customer product arrays, prose, photo or color profile is stored. Demo mode persists merchant shade metadata beside the catalog and keeps consultation state in process memory only.

Migrations `202610110008_personal_color.sql` and `202610110009_lip_shade_visibility.sql` extend the existing database. Apply pending migrations with `npm run supabase:migrate`, then `npm run supabase:check`. Never run the account-creating Supabase smoke while Gmail delivery is active. The explicit synthetic color acceptance script uses temporary local fixtures and no email/photo/external provider call.

## Ingredient identity review

The vocabulary remains deliberately bounded. Lip ingredient identities were added from primary published [Dior Lip Glow ingredient lists](https://www.dior.com/en_gb/beauty/products/dior-addict-lip-glow-C045700001.html), including [additional pigment declarations](https://www.dior.com/fr_fr/beauty/products/dior-addict-lip-glow-E000000008.html) and [other shade variants](https://www.dior.com/fr_fr/beauty/products/dior-addict-lip-glow-E000002177.html), checked2026-10-11. This is identity normalization only: no efficacy, regulatory approval, allergen safety, product endorsement or merchant inventory was inferred. CI77891 resolves to existing Titanium Dioxide; different iron-oxide CI numbers remain distinct. Do not collapse Red6/Red7/other colorants through an ambiguous alias. Use actual shade-specific labels, not an undifferentiated “may contain” pigment range. Unknown ingredients block publication until reviewed in both domain vocabulary and database registry; never omit them to pass validation.

## Future work

Evaluate suggestions with consenting adults under controlled light and a color reference, checking consistency across cameras/skin appearances and repeated captures before expanding claims. Next useful product directions: coordinated lip/blush looks; guest-selected occasion and finish; staff-assisted palette comparison. Foundation shade accuracy, automatic seasonal diagnosis and virtual try-on need their own reference data, calibration, consent and evaluation.

For focused future context run `npm run context -- color`; read this file and the ports before loading other subsystems.
