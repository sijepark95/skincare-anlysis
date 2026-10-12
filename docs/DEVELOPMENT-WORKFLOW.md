# Keeping long-term development efficient

## Compact context

The repository is the durable memory. Start with `npm run context` (AGENTS + current STATUS). Add one area with `npm run context -- skin` (active hosted analysis), `ui`, `database`, `ml`, `vision` (independent research), `llm` (optional legacy explanation) or `architecture`. Read only the feature's source files and relevant SPEC subsection. Do not paste the complete conversation, database, screenshots or build logs into every task.

STATUS is a current-state summary, not a chronological log. SPEC records accepted behavior. ARCHITECTURE holds stable decisions and boundaries. BACKLOG stores new ideas instead of expanding the active feature. The design master stores visual decisions so each screen does not need a new design exploration.

## Small complete tasks

Use this request pattern:

> Implement [one outcome]. Follow AGENTS.md and the relevant specification. Acceptance: [2–4 observable checks]. Keep accepted architecture unchanged unless a real blocker appears. Run relevant tests; update STATUS. Return changed behavior, test results and remaining issue in a few sentences.

Ask for discovery/review separately only when requirements are uncertain. Once implementation is authorized, finish the slice, including failure states and its tests. Delegate independent boundaries with explicit file ownership, then integrate once. Reuse the same agent/task context for related changes rather than re-reading every file.

## Checks proportional to the change

- Domain/catalog rules: focused Vitest files, then typecheck.
- HTTP/auth/retention: boundary/application tests plus relevant SQL harness; add a true regression case.
- Kiosk/workspace behavior: relevant Playwright flow and screenshot at affected viewport.
- Schema: migration + role/RLS test; inspect permissions and cross-tenant FKs, not only happy-path SQL.
- Python inference: service tests and pinned dependency check.
- Before merging a complete slice: lint, typecheck, unit suite, production build and affected end-to-end checks.

Read failures at their source and summarize the useful lines. Do not repeat successful broad test runs without a new change or unresolved concern. Token efficiency comes from stable decisions, bounded context and reusable tests; do not remove privacy or permission tests to shorten a task.

## Handoff discipline

Update STATUS with the outcome and actual remaining blockers. Keep credentials in ignored environment files. Commit each completed slice when ready for versioned review, with a concrete title. Never rely on uncommitted chat-only decisions as the next developer's memory.
