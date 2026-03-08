# Current task
Replace backlog JSON dump with HTML checklist in `renderSubturtleDetailHtml`: iterate `detail.backlog` array, render each item as a checkbox line (checked if `done`, highlighted if `current`), using styled `<ul>` with CSS classes.

# End goal with specs
1. SubTurtle detail page: backlog rendered as HTML checklist (not raw JSON), logs display with proper newlines, event timeline showing last 15 conductor events.
2. Process detail page: logs display with proper newlines, cleaner layout.
3. Job detail page: job name shown prominently, link to SubTurtle detail page (not just process), backlog progress shown if owner is a SubTurtle, logs with proper newlines.
4. All detail pages get the turtle favicon and "SuperTurtle" branding consistent with the main dashboard.

# Roadmap (Completed)
- Main dashboard layout fixes done
- /api/conductor endpoint available

# Roadmap (Upcoming)
- Detail page rendering fixes
- Event timeline integration

# Backlog
- [x] Fix log newlines on ALL detail pages: change `logs?.lines.join("\\n")` to `logs?.lines.join("\n")` in `renderSubturtleDetailHtml`, `renderProcessDetailHtml`, `renderJobDetailHtml`
- [ ] Replace backlog JSON dump with HTML checklist in `renderSubturtleDetailHtml`: iterate `detail.backlog` array, render each item as a checkbox line (checked if `done`, highlighted if `current`), using styled `<ul>` with CSS classes <- current
- [ ] Add turtle favicon and "SuperTurtle" title prefix to all detail page `<head>` sections (currently only main dashboard has it)
- [ ] Improve job detail page: show `detail.job.name` as a prominent heading, add link to `/dashboard/subturtles/{name}` when `ownerType === "subturtle"`, show backlog progress bar if `extra.backlogSummary` exists
- [ ] Add event timeline to SubTurtle detail page: call `/api/conductor` or add new `/api/subturtles/{name}/events` endpoint, render last 15 events as a styled timeline list showing event_type, timestamp, emitted_by, and key payload fields
- [ ] Run typecheck (`bun run typecheck`) and fix all errors
- [ ] Commit

## Notes
File: `super_turtle/claude-telegram-bot/src/dashboard.ts` (~2600 lines).
Detail pages are rendered by: `renderSubturtleDetailHtml()` (~line 1671), `renderProcessDetailHtml()` (~line 2145), `renderJobDetailHtml()` (~line 2181).
All use `DETAIL_THEME_CSS` constant (~line 1613) for shared styling.
The log bug: `logs?.lines.join("\\n")` in a template literal produces literal `\n` instead of actual newlines. Fix: use `logs?.lines.join("\n")` (single backslash in the template).
The backlog data structure: `detail.backlog` is an array of `{ text: string, done: boolean, current: boolean }`.
`renderJsonPre()` at line ~206 just does `JSON.stringify(value, null, 2)` in a `<pre>` — replace this for backlog only.
For event timeline: `loadWorkerEvents(stateDir, workerName)` from `conductor-supervisor.ts` returns `WorkerEventRecord[]`. State dir is `join(SUPERTURTLE_DATA_DIR, "state")` imported from `./config`. SUPERTURTLE_DATA_DIR and CONDUCTOR_STATE_DIR constant already exist in dashboard.ts.
