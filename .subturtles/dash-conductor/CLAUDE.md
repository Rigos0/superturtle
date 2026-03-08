# Current task
Fetch `/api/conductor` in the dashboard `loadData()` flow so the UI can consume worker, wakeup, and inbox state.

# End goal with specs
1. Race lane cards show a lifecycle state badge (running/completed/failed/archived/timed_out) sourced from conductor worker state, not just ctl status. Badge colors: running=green (#eaf4e4), completed=sage (#8aa67c), failed=red (#fdecec), archived=muted (#f5f1eb), timed_out=terracotta (#faebdf).
2. New "Conductor" panel in the dashboard grid showing pending wakeups (summary, category, delivery_state) and unacknowledged inbox items (title, priority, category). Panel is compact — a summary table or stacked list.
3. Header badge row includes a "Conductor: N pending" badge showing combined count of pending wakeups + unacknowledged inbox items.
4. Queue panel auto-hides when empty — collapse to a single muted line "No queued messages" instead of showing the full empty table.

# Roadmap (Completed)
- Favicon, title, layout reorder done
- /api/conductor endpoint shipping worker states, wakeups, inbox

# Roadmap (Upcoming)
- Conductor panel and badges on main dashboard
- Race lane lifecycle integration

# Backlog
- [x] Add conductor types to `dashboard-types.ts`: `ConductorWorkerView`, `ConductorWakeupView`, `ConductorInboxView`, `ConductorResponse`
- [ ] Fetch `/api/conductor` in the dashboard JS `loadData()` alongside the other 3 fetches <- current
- [ ] Enhance race lane cards: add a lifecycle state badge span next to the existing status text in `.lane-meta`, sourced from conductor worker data matched by name
- [ ] Add Conductor panel to the dashboard grid: show wakeups table (summary, category, state) + inbox table (title, priority, category). Place it in a new row or merge into an existing row that makes visual sense
- [ ] Add `conductorBadge` to the header badge row showing pending count
- [ ] Auto-hide Queue panel when empty: if `data.deferredQueue.totalMessages === 0`, render a collapsed single-line muted message instead of the full table
- [ ] Run typecheck (`bun run typecheck`) and fix all errors
- [ ] Commit

## Notes
File: `super_turtle/claude-telegram-bot/src/dashboard.ts` (~2600 lines). Types: `dashboard-types.ts` (~345 lines).
The `/api/conductor` endpoint already exists (just added). It returns `{ generatedAt, workers, wakeups, inbox }`.
`workers` are `WorkerStateRecord[]` from `conductor-supervisor.ts`. Key fields: `worker_name`, `lifecycle_state`, `loop_type`, `current_task`, `checkpoint`, `created_at`, `updated_at`.
`wakeups` are `WakeupRecord[]`. Key fields: `id`, `worker_name`, `category`, `delivery_state`, `summary`.
`inbox` items are `MetaAgentInboxItemRecord[]`. Key fields: `id`, `worker_name`, `priority`, `category`, `title`, `delivery_state`.
Dashboard HTML is in `renderDashboardHtml()`. CSS inline in `<style>`, JS inline in `<script>`. Frontend fetches happen in `loadData()` function.
Color scheme: olive/sage/terracotta on cream. Preserve existing visual identity.
