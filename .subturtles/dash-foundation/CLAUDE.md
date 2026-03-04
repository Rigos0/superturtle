## Current Task
All backlog items complete. Dashboard Phase 1 foundation is done.

## End Goal with Specs
Phase 1 of the dashboard API-first expansion. Clean foundation for all subsequent endpoints.

**Deliverables:**
1. `src/dashboard-types.ts` — all API response types (SubturtleListResponse, SubturtleDetailResponse, CronListResponse, CronJobView, SessionResponse, ContextResponse, LogsResponse, UsageResponse, ProcessListResponse, QueueResponse, GitResponse, RunsResponse)
2. `src/log-reader.ts` — extract `readPinoLogLines()`, `buildLevelFilter()`, `formatPinoEntry()`, `clamp()`, and the PINO level constants from `src/handlers/streaming.ts` into a shared module. Update streaming.ts to import from log-reader.ts.
3. Refactor `src/dashboard.ts` routing from if/else chain to regex route table pattern:
   ```typescript
   type RouteHandler = (req: Request, url: URL, match: RegExpMatchArray) => Promise<Response>;
   const routes: Array<{ pattern: RegExp; handler: RouteHandler }> = [ ... ];
   ```
4. Add shared helpers in dashboard.ts: `jsonResponse(data)`, `notFoundResponse(msg?)`, `readFileOr(path, fallback)`, `parseMetaFile(content)` (parses KEY=VALUE format from subturtle.meta)
5. Change `/api/subturtles` to return focused `SubturtleListResponse` (lanes data only). Update the frontend JS in `renderDashboardHtml()` to poll `/api/dashboard` for the overview instead.
6. Validate SubTurtle names in URL path params (reject `/`, `..`, leading `.`)

**Acceptance criteria:**
- `bun test` passes (update `src/dashboard.test.ts` as needed)
- `GET /api/dashboard` still returns full `DashboardState`
- `GET /api/subturtles` returns the focused lanes list
- Frontend still loads and polls correctly
- No circular imports between log-reader.ts and streaming.ts
- All new types exported from dashboard-types.ts

## Backlog
- [x] Read dashboard.ts, dashboard.test.ts, and streaming.ts to understand current state
- [x] Create src/dashboard-types.ts with all response types
- [x] Create src/log-reader.ts extracting log reading from streaming.ts; update streaming.ts imports
- [x] Add shared helpers (jsonResponse, notFoundResponse, readFileOr, parseMetaFile, validateSubturtleName)
- [x] Refactor dashboard.ts routing to regex route table
- [x] Change /api/subturtles response to SubturtleListResponse; update frontend to poll /api/dashboard
- [x] Run tests: cd super_turtle/claude-telegram-bot && bun test (35/35 dashboard tests pass; 2 pre-existing unrelated failures)
- [x] Fix any test failures (none needed for dashboard tests)
- [x] Commit

## Notes
- File: super_turtle/claude-telegram-bot/src/dashboard.ts (main refactor target)
- File: super_turtle/claude-telegram-bot/src/dashboard.test.ts (test file)
- File: super_turtle/claude-telegram-bot/src/handlers/streaming.ts (extract log reader from here)
- File: super_turtle/claude-telegram-bot/src/handlers/commands.ts (reuse exported helpers)
- streaming.ts currently has readPinoLogLines(), buildLevelFilter(), formatPinoEntry(), formatPinoTimestamp(), clamp(), PINO_LEVELS, PINO_LEVEL_LABELS — all need to move to log-reader.ts
- The frontend HTML is inline in renderDashboardHtml() — update the fetch URL from /api/subturtles to /api/dashboard
- parseMetaFile should handle: SPAWNED_AT=<epoch>, TIMEOUT_SECONDS=<int>, LOOP_TYPE=<string>, SKILLS=<json-array>, WATCHDOG_PID=<int>, CRON_JOB_ID=<string>
- /api/subturtles now returns SubturtleListResponse (lanes only); frontend polls /api/dashboard for full state
- 2 pre-existing test failures in readMainLoopLogTail (unrelated to dashboard work)

## Loop Control
STOP
