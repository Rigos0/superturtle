## Current Task
All backlog items complete.

## End Goal with Specs
Phase 3: Cron + Session + Context endpoints for the dashboard API.

**New endpoints to add in src/dashboard.ts route table:**

1. `GET /api/cron` → returns CronListResponse:
   - jobs array with: id, type, prompt (full), promptPreview (100 chars), fireAt, fireInMs, intervalMs, intervalHuman (e.g. "every 10m"), chatId, silent, createdAt
   - Use getJobs() from cron.ts

2. `GET /api/cron/:id` → returns single CronJobView
   - Find job by id in getJobs()
   - Return 404 via notFoundResponse() if not found

3. `GET /api/session` → returns SessionResponse:
   - Read from session singleton (imported in dashboard.ts): sessionId, model, effort, activeDriver, isRunning, isActive, currentTool, lastTool, lastError, lastErrorTime, lastUsage, conversationTitle, recentMessages, queryStarted, lastActivity
   - Use getAvailableModels() to get modelDisplayName
   - Dates as ISO strings

4. `GET /api/context` → returns ContextResponse:
   - claudeMd: read ${WORKING_DIR}/CLAUDE.md
   - metaPrompt: use META_PROMPT from config.ts (already imported)
   - metaPromptSource: path to META_SHARED.md
   - agentsMdExists: check if ${WORKING_DIR}/AGENTS.md exists

**Existing infrastructure to use:**
- `getJobs()` — from cron.ts (already imported in dashboard.ts)
- `session` singleton — from session.ts (already imported in dashboard.ts)
- `getAvailableModels()` — from session.ts
- `META_PROMPT` — from config.ts (needs import if not already there)
- `WORKING_DIR` — from config.ts (already imported)
- `readFileOr()` — in dashboard.ts
- `jsonResponse()`, `notFoundResponse()` — in dashboard.ts
- `safeSubstring()` — in dashboard.ts
- Types: CronListResponse, CronJobView, SessionResponse, ContextResponse — in dashboard-types.ts

**Acceptance criteria:**
- bun test passes
- curl /api/cron returns jobs list
- curl /api/cron/:id returns single job or 404
- curl /api/session returns session state
- curl /api/context returns CLAUDE.md + META_PROMPT content

## Backlog
- [x] Read dashboard.ts, dashboard-types.ts, cron.ts, session.ts, and config.ts to understand imports
- [x] Add /api/cron and /api/cron/:id route handlers
- [x] Add /api/session route handler
- [x] Add /api/context route handler
- [x] Add tests for all 4 endpoints
- [x] Run tests: cd super_turtle/claude-telegram-bot && bun test
- [x] Fix any failures
- [x] Commit

## Loop Control
STOP
