# Prioritized next work

## Pilot gates

- Collect separate externally consented independent adult evaluation photos for the prepared [ConvNeXt/OpenAI research comparison](VISION-COMPARISON.md). Confirm source-code definitions and a reviewed common appearance rubric, lock independent photo-only human reference before viewing outputs, then plan participant-aware testing. No photos, empirical winner or production provider switch yet; any future external kiosk photo flow needs its own consent/retention/provider contract.

- Create the user's cloud Supabase project and enter its private configuration. Local real Supabase/Auth/owner/paired-device/RLS/concurrency checks pass; verify hosted pooler/TLS and acceptance flows against the chosen staging project.
- Gmail activation and external verification email receipt are verified locally. Review production sender capacity and configure hosted SMTP, the code-bearing confirmation template and email verification against the staging project.
- Deploy minute cleanup and alerts in the cloud; the local scheduler ran successfully. Verify deletion in primary database/backups against the approved retention policy. Configure HTTPS, trusted proxy headers, shared quotas and private service access.
- Test kiosk camera, screen heights, accessibility and reset on target tablet/smart-mirror browser. Browser app is ready for a camera adapter, not native device lockdown.
- Register genuine products, full formulas, aliases and approved ingredient policies. Review cosmetic wording and consent for deployment region. Confirm the working brand's trademark/domain availability before launch.
- Add account invitation, recovery, MFA/SSO, support access and auditable membership administration before wider tenant onboarding.
- Integrate Auth CAPTCHA before deploying to an environment that requires it; the current pairing UI does not submit CAPTCHA tokens.

## After pilot feedback

- Evaluate optional photo-assisted palettes under controlled lighting/color references; confirm cross-camera and repeated-capture consistency before expanding color claims. Guest confirmation remains required. Register actual shade-specific complete formulas and merchant metadata first; see PERSONAL-COLOR.md.
- Extend confirmed-palette discovery to coordinated blush/lip looks, occasion and finish preferences, and staff-assisted palette comparison. Foundation shade matching, virtual draping/try-on and seasonal diagnosis need independent calibration/reference data, consent and evaluation.

- Per-store branding/locale/currency, proper timezone aggregate reporting, policy administration with approval workflow, catalog validation tooling and unresolved-INCI resolution UI.
- Merchant packshots, catalog/stock integration, stock freshness rules and purchase attribution only with reliable source data. No inferred conversion charts.
- Operational audit trail with actor/action identifiers and no customer data; deployment rollback, backup restore drills, alerting and SLOs.
- Quality-gated licensed ConvNeXt baseline; multi-task label evaluation and independent skin-tone/device validation. See ML-PLAN.md. Image uploads require a separate privacy/security design.
- Extend the implemented optional hosted explanation with reviewed ingredient-efficacy evidence and an independently evaluated grounded narrative. Current API selects matching facts and approved wording only. Add shared cost quotas and provider/consent governance before public deployment. Optional LambdaRank only when there is enough consented reliable ranking feedback.

## Request format

For each new feature: user problem, accepted behavior, affected boundary, data/permissions/retention impact, small acceptance test. Prioritize a coherent slice; avoid reopening all settled architecture for every feature.
