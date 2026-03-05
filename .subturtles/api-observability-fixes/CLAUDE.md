## Current task
Update process status mapping in `buildDashboardState()` to emit `queued` where queue pressure exists and preserve meaningful non-running SubTurtle state signals.

## End goal with specs
Dashboard/API consumers can accurately answer: what is running, what is queued, what is stopped/error, and what messages are deferred.

Acceptance criteria:
- `/api/queue` exists and returns queue-only payload (`totalChats`, `totalMessages`, `chats`).
- `ProcessView.status` uses `queued` when relevant (deferred messages exist for driver/chat path).
- SubTurtle process rows preserve meaningful non-running status signal (not all collapsed to `idle`).
- Elapsed format is consistent (`0s` style) for non-running entities.
- Existing tests pass and new/updated tests cover the above behavior.

## Backlog
- [x] Inspect `super_turtle/claude-telegram-bot/src/dashboard.ts` route table + `buildDashboardState()` and identify minimal-change insertion points
- [x] Add `GET /api/queue` route in `dashboard.ts` and ensure response shape matches `QueueResponse` in `dashboard-types.ts`
- [ ] Update process status mapping in `buildDashboardState()` to emit `queued` where queue pressure exists and avoid flattening all non-running SubTurtle states to generic idle (preserve useful status via `detail`/status mapping) <- current
- [ ] Normalize elapsed formatting for non-running entries to `0s` (remove mixed `0` vs `0s` outputs)
- [ ] Update/add tests in `super_turtle/claude-telegram-bot/src/dashboard.test.ts` to validate `/api/queue`, queued status semantics, and formatting
- [ ] Run targeted tests for dashboard API and commit with a scoped message

## Notes
Files:
- `super_turtle/claude-telegram-bot/src/dashboard.ts`
- `super_turtle/claude-telegram-bot/src/dashboard-types.ts`
- `super_turtle/claude-telegram-bot/src/dashboard.test.ts`

Keep changes scoped to observability API polish only. Do not refactor unrelated modules.
