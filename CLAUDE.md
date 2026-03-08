# Super Turtle — Dev Branch

You are Super Turtle 🐢 — an autonomous coding agent controlled from Telegram. You spawn SubTurtles to do work, supervise them, and report back. This repo is the agent itself.

## Architecture

- **`super_turtle/claude-telegram-bot/`** — Telegram bot (TypeScript/Bun). The meta agent's runtime. Handles messages, voice, streaming, driver routing (Claude/Codex), MCP tools, session management.
- **`super_turtle/subturtle/`** — SubTurtle orchestration (Python). Loop types: `slow`, `yolo`, `yolo-codex`, `yolo-codex-spark`. Includes `ctl` CLI, watchdog, loop runner, browser screenshot helper, tunnel helper.
- **`super_turtle/meta/`** — Meta agent prompts: `META_SHARED.md` (system prompt), `ORCHESTRATOR_PROMPT.md`, `DECOMPOSITION_PROMPT.md`.
- **`super_turtle/setup`** — Onboarding setup script for fresh clones.
- **`super_turtle/bin/`** — CLI entry point (`superturtle` npm package).
- **`super_turtle/templates/`** — Templates for CLAUDE.md, etc.
- **`super_turtle/docs/`** — Documentation site source.

## Tech Stack

- **Bot runtime:** Bun + TypeScript
- **AI drivers:** Claude CLI (primary), Codex CLI (optional)
- **SubTurtle loops:** Python 3.13
- **MCP servers:** send-turtle (stickers), bot-control (session/model/usage), ask-user (inline buttons)
- **Telegram:** Grammy framework
- **Package:** npm (`superturtle`)

## Key Files

- `super_turtle/claude-telegram-bot/src/handlers/text.ts` — text message handler
- `super_turtle/claude-telegram-bot/src/handlers/voice.ts` — voice message handler + transcription
- `super_turtle/claude-telegram-bot/src/handlers/stop.ts` — stop logic (`stopAllRunningWork()`)
- `super_turtle/claude-telegram-bot/src/handlers/driver-routing.ts` — Claude/Codex driver selection
- `super_turtle/claude-telegram-bot/src/session.ts` — session state, process management, query execution
- `super_turtle/claude-telegram-bot/src/deferred-queue.ts` — voice message queue (max 10 per chat)
- `super_turtle/claude-telegram-bot/src/utils.ts` — `isStopIntent()` detection (line ~302)
- `super_turtle/claude-telegram-bot/src/config.ts` — bot configuration, system prompt injection
- `super_turtle/subturtle/ctl` — SubTurtle CLI (spawn, stop, status, logs, list)

## Branch Merge Instructions (dev <-> main)

Use standard merges. No special merge drivers or merge policy is required.

**Merging:**
```bash
# dev -> main
git checkout main && git merge dev && git push origin main

# main -> dev
git checkout dev && git merge main
```

---

## Current task
Redesign SubTurtle orchestration so durable state, not chat/session memory, is the control plane. Current focus: keep hardening restart recovery so boot-time conductor maintenance replays stranded in-flight wakeups and keeps operator state aligned after crashes.

## SubTurtle orchestration redesign scope

We are keeping the good parts:
- SubTurtle execution loops are good
- Self-stopping via `## Loop Control` + `STOP` is good
- Workspace isolation, watchdogs, logs, and token-prefixed runtime isolation are good

We are redesigning the weak parts:
- handoff state and long-run memory
- silent check-ins and wake-up semantics
- completion/stuck/error reporting back to the meta agent
- supervisor ownership of orchestration decisions
- restart/recovery behavior when the bot or meta session dies mid-run

## Current system baseline

### Shipped
- Telegram bot runtime, Claude/Codex drivers, MCP tools, queueing, and session management
- SubTurtle spawn/stop/status/logs/list, yolo + slow loops, watchdog timeout handling, and self-stop support
- Cron-based silent supervision and orchestrator-mode supervision
- Token-prefixed runtime isolation for logs, temp dirs, IPC dirs, and tmux sessions
- `/status`, `/debug`, `/looplogs`, `/pinologs`, `superturtle doctor`, and `superturtle logs`

### Known gaps
- `handoff.md` and `runs.jsonl` still exist for compatibility, so they must stay strictly derived from canonical conductor state
- `subturtle.meta` still carries some spawn/runtime metadata; worker lifecycle truth now lives in the conductor store and those paths need continued convergence
- Restart/recovery behavior is now repairing missing pending wakeups and persisting stale recurring-cron cleanup, but broader end-to-end coverage is still thin around true bot reboot flows and multi-worker orchestration
- Silent milestone/stuck policy is now deterministic, but the remaining confidence gap is proving the full conductor flow under restart and recovery conditions

## End goal with specs
- Every SubTurtle has explicit durable lifecycle state that can be reconstructed after any bot restart
- Every important worker transition is persisted exactly once in a machine-readable event log
- The supervisor can reconcile all workers from disk without depending on chat history, silent cron text, or model memory
- The meta agent can be busy, restarted, or switched between Claude/Codex while worker events continue to land safely
- Notifications to the human are derived from persisted state transitions, not inferred ad hoc from silent-check prompts
- Self-stop remains first-class: workers still decide when they are done, but completion is consumed by a deterministic conductor flow
- Multi-instance isolation remains intact: token/project-scoped runtime resources must not interfere across dev/prod or separate projects

## Roadmap (Completed)
- ✅ Core bot: Telegram integration, Claude driver, streaming responses, voice transcription
- ✅ SubTurtle system: spawn/stop/status/logs, yolo + slow loops, watchdog, cron supervision
- ✅ Meta agent: META_SHARED.md prompt, orchestrator cron, decomposition, silent-first supervision
- ✅ MCP tools: send-turtle stickers, bot-control (usage/model/sessions), ask-user buttons
- ✅ Codex driver: optional Codex CLI integration, driver switching, quota-aware routing
- ✅ Package refactor: decoupled paths, CLI subprocess (replaced Agent SDK), npm package structure
- ✅ Auth & security: user allowlist, rate limiting, audit logging
- ✅ Deferred queue: voice message queuing when driver is busy, dedup, drain-on-complete
- ✅ Tunnel support: cloudflared helper for frontend preview links
- ✅ Screenshot support: Playwright-based browser screenshots for visual QA
- ✅ Stop behavior: unified stop across text/voice/button, deferred queue clearing, `/stop` command
- ✅ Multi-instance isolation: TOKEN_PREFIX namespacing for all `/tmp` files, MCP IPC directory, logs, tmux sessions
- ✅ Current worker execution model: isolated workspaces, `CLAUDE.md` state files, commit-per-iteration yolo/slow loops, and self-stop directives

## Roadmap (Upcoming)
- Add restart, recovery, stale-cleanup, and multi-worker tests for conductor behavior

## Backlog
- [x] Define orchestration v2 ownership boundaries, lifecycle states, event types, and invariants
- [x] Design the minimal durable data model: worker state file, global event log, and derived/rendered views
- [x] Implement structured worker lifecycle persistence in `subturtle/ctl` and the Python loop
- [x] Emit deterministic worker-side facts for checkpoints, completion requests, timeouts, stops, archives, and fatal-error handoff
- [x] Emit reconciled `worker.completed`, `worker.failed`, cleanup, and delivery transitions from supervisor logic
- [x] Expand the supervisor reconciliation path so silent cron milestone/stuck checks consume structured state instead of prompt inference
- [x] Design and implement meta-agent wake-up/inbox semantics for background worker events during active user conversations
- [x] Rework silent cron jobs to become reconciliation/notification triggers instead of the primary source of orchestration truth
- [x] Re-render `handoff.md`, dashboard state, and operator summaries from structured state
- [x] Replace prompt-mediated silent milestone/stuck judgment with deterministic supervisor policy
- [ ] Add end-to-end tests for restart recovery, stale cron cleanup, mid-chat completion delivery, and multi-worker orchestration <- current

## Notes
- Multi-instance audit: `docs/audits/multi-instance-isolation.md`
- Conductor v2 design reference: `super_turtle/docs/long-run-state-tracking.md`
- Structured conductor state is now live under `.superturtle/state/events.jsonl`, `.superturtle/state/workers/`, `.superturtle/state/wakeups/`, and `.superturtle/state/inbox/`
- Current runtime producers: `subturtle/ctl` emits start/stop/archive/timeout lifecycle facts, and the Python loop emits checkpoint facts plus `completion_pending` / `failure_pending` handoff facts
- Current runtime consumer: the bot timer now drains pending conductor wakeups directly, emits reconciliation events, removes stale cron jobs, and sends Telegram notifications without routing those lifecycle updates through the meta-agent conversation thread
- Legacy completion cron handoff has been removed from the SubTurtle self-stop path; completion delivery now rides the canonical wakeup queue
- Silent SubTurtle supervision now runs deterministic supervisor policy over canonical worker state, backlog completion, and checkpoint signatures; milestone/stuck wakeups flow through the same inbox and Telegram delivery path as lifecycle wakeups without terminal cleanup side effects
- The bot timer now recreates missing `completion_requested` / `fatal_error` / `timeout` wakeups from canonical worker state before delivery, and stale recurring SubTurtle cron cleanup is persisted as a conductor event instead of existing only as an inline warning
- The bot now runs the same conductor maintenance pass on startup and on each timer tick, so recovered wakeups and stale recurring-cron cleanup no longer wait for the first scheduled interval after a reboot
- Startup conductor maintenance now also requeues wakeups stranded in `processing`, so an interrupted completion/failure/milestone notification is replayable after a bot restart instead of being lost indefinitely
- `ctl spawn` now registers structured supervision cron jobs with `job_kind=subturtle_supervision`, `worker_name`, and `supervision_mode`, and the bot prefers those fields over prompt regex parsing
- `handoff.md` is now refreshed from canonical worker state plus pending wakeups, and dashboard lanes prefer conductor worker fields for live SubTurtles
- Reconciled lifecycle wakeups now also create durable meta-agent inbox items; the next successful interactive Claude/Codex turn injects them as non-chat background context and acknowledges them after the turn completes
- `handoff.md` now surfaces both `pending` and `processing` wakeups so in-flight recovery state stays visible to the operator instead of disappearing from the rendered summary
- Current conductor coverage now includes recreated pending-wakeup recovery, `processing` wakeup replay on startup, stale recurring-cron cleanup, startup maintenance idempotency, multi-worker inbox recovery, and driver-level interactive acknowledgment tests for both Claude and Codex session paths
- TOKEN_PREFIX lives in `src/token-prefix.ts` (standalone leaf module, no circular deps)
- MCP IPC files are isolated in `/tmp/superturtle-{tokenPrefix}/`, passed to MCP servers via `SUPERTURTLE_IPC_DIR`
- The bot is the meta agent; system prompt injection still lives in `super_turtle/claude-telegram-bot/src/config.ts`
- The redesign should preserve the existing good operator ergonomics: `ctl list`, `ctl status`, worker logs, `/debug`, `/status`, dashboard views, and preview URLs
