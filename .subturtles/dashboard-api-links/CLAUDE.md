## Current Task
Run dashboard tests and fix any failures, then commit all changes.

## End Goal with Specs
Dashboard backend exposes stable, documented JSON endpoints so any frontend (plain HTML now, future UI later) can deep-link into entity detail pages.

Required API behavior:
- Existing endpoints keep working (no breaking changes).
- Add process endpoints:
  - `GET /api/processes` returns all process rows with stable `id`, `label`, `kind`, `status`, and `detailLink`.
  - `GET /api/processes/:id` returns one process with expanded detail.
- Add current-job endpoints:
  - `GET /api/jobs/current` returns active/current jobs (from SubTurtle lanes + driver activity) with stable `id`, `name`, `ownerType`, `ownerId`, and `detailLink`.
  - `GET /api/jobs/:id` returns expanded job detail, including related links to owner entity and logs if available.
- For SubTurtle-linked details, include backlog summary and log link where available.
- For driver-linked details, include driver/session fields meaningful for debugging (running, active tool/last tool, elapsed).

Implementation scope:
- File: `super_turtle/claude-telegram-bot/src/dashboard.ts`
- File: `super_turtle/claude-telegram-bot/src/dashboard-types.ts`
- Tests: `super_turtle/claude-telegram-bot/src/dashboard.test.ts`

## Backlog
- [x] Read existing route table and helper builders in `src/dashboard.ts`; identify reusable builders for process + lane-derived job models
- [x] Add/extend API response types in `src/dashboard-types.ts` for process detail + current jobs + job detail
- [x] Implement `GET /api/processes` and `GET /api/processes/:id` in `src/dashboard.ts` with stable IDs and detail links
- [x] Implement `GET /api/jobs/current` and `GET /api/jobs/:id` in `src/dashboard.ts` mapping SubTurtle current items + driver activity into job models
- [x] Add route-level tests in `src/dashboard.test.ts` for happy path + not found + invalid IDs
- [x] Run dashboard tests and fix failures
- [x] Commit with message: `feat(dashboard): add process and job detail APIs for deep links`

## Notes
- Keep responses JSON-only and frontend-agnostic.
- Preserve existing endpoint payloads to avoid regressions.
- Prefer explicit helper functions over inline route logic to keep route table readable.
- Keep IDs deterministic:
  - Process IDs: existing values (`driver-claude`, `driver-codex`, `background-check`, `subturtle-<name>`)
  - Job IDs: `subturtle:<name>:current` and `driver:<name>:active`

## Loop Control
STOP
