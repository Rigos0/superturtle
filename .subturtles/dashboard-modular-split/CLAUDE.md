# Current task
Do a final pass for naming consistency and module-level comments where needed. <- current

# End goal with specs
- Dashboard server code is organized into cohesive modules under `super_turtle/claude-telegram-bot/src/dashboard/`.
- `src/dashboard.ts` becomes a thin entrypoint (routing bootstrap + exports) instead of a 3k-line mixed file.
- API responses and HTML pages remain backward-compatible for existing tests and clients.
- Existing dashboard tests continue to pass, including route/auth/session/subturtle detail coverage.
- New module boundaries are documented by code structure and clear import surfaces.

# Roadmap (Completed)
- Gathered current dashboard hotspots and function inventory from `dashboard.ts`.
- Confirmed route set includes `/api/dashboard/*`, `/api/conductor`, and detail pages.
- Confirmed conductor state and queue rendering already exist and should remain stable.

# Roadmap (Upcoming)
- Extract pure helpers and formatting utilities into `dashboard/helpers.ts`.
- Extract data assembly and mapping into `dashboard/data.ts`.
- Extract HTML renderers into `dashboard/renderers.ts`.
- Extract route handlers and route table into `dashboard/routes.ts`.
- Reduce `dashboard.ts` to composition/exports and verify tests.

# Backlog
- [x] Create `src/dashboard/` module layout and move low-risk shared helper functions first
- [x] Extract dashboard overview/conductor/current-jobs data builders into dedicated module(s)
- [x] Extract HTML rendering for dashboard + detail pages into renderer module(s)
- [x] Extract route handlers/table wiring into routes module while preserving patterns
- [x] Update imports/exports in `dashboard.ts` to thin entrypoint and remove dead code
- [x] Run dashboard-focused tests and fix regressions introduced by extraction
- [ ] Do a final pass for naming consistency and module-level comments where needed <- current
