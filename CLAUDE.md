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

`CLAUDE.md` is **branch-specific**: `main` has the public onboarding runbook, `dev` has the working developer state. `.gitattributes` uses `merge=ours` driver to prevent merges from overwriting the target branch's `CLAUDE.md`.

**One-time setup (per clone):**
```bash
git config merge.ours.driver true
```

**Merging (always use `--no-ff`):**
```bash
# dev -> main
git checkout main && git merge --no-ff dev && git push origin main

# main -> dev
git checkout dev && git merge --no-ff main
```

Fast-forward merges skip merge drivers entirely, so `--no-ff` is required. If CLAUDE.md gets overwritten: `git checkout HEAD~1 -- CLAUDE.md && git commit -m "restore branch-specific CLAUDE.md"`.

---

## Current task
Primary focus: full observability of all running processes (bot runtime, SubTurtles, cron supervision, MCP sidecars), robust error visibility, and faster debugging/evaluation loops.

## Observability Baseline (Current State)

### Shipped
- `/status` and `/debug` expose active driver/session state, queue state, and recent loop-log errors
- `/looplogs` and `/pinologs` provide in-chat log access
- `superturtle doctor` provides a one-command local process inventory (bot tmux state + SubTurtles + cron + log health + recent loop failure hints)
- `superturtle logs` provides namespaced loop/pino/audit log tailing (`--pretty` for pino)
- Token-prefixed runtime files are in place:
  - loop log: `/tmp/claude-telegram-{tokenPrefix}-bot-ts.log`
  - pino jsonl log: `/tmp/claude-telegram-{tokenPrefix}-bot.log.jsonl`
  - audit log: `/tmp/claude-telegram-{tokenPrefix}-audit.log`
  - temp dir: `/tmp/telegram-bot-{tokenPrefix}`
  - IPC dir: `/tmp/superturtle-{tokenPrefix}`
- `subturtle/ctl` provides worker process status/logs/list/stop, watchdog timeout handling, and run-state ledger updates (`.superturtle/state/runs.jsonl`, `handoff.md`)
- tmux session names are token/project scoped (`superturtle-{tokenPrefix}-{projectSlug}`) to prevent cross-project interference
- Process-level fatal handlers (`uncaughtException`, `unhandledRejection`) now emit pino/event logs and force supervised restart

### In Progress (local only, not baseline yet)
- Branch `wip/logging-split` commit `0a5d546` adds request/event correlation IDs and expanded event logging across handlers/streaming paths

### Known Gaps
- No single documented, one-pass process inventory flow (bot + SubTurtles + cron + logs)
- No explicit incident triage playbook in this root file
- Robustness expectations are not yet captured as concrete acceptance checks

## Process Observability Matrix
- Super Turtle bot process
  - Liveness: `superturtle status`, `tmux ls`
  - Logs: `/looplogs`, `/pinologs`, `/tmp/claude-telegram-{tokenPrefix}-bot-ts.log`, `/tmp/claude-telegram-{tokenPrefix}-bot.log.jsonl`
  - Primary failure signals: tmux session missing, `/status` shows stopped, repeated restart/crash lines in loop log
- SubTurtle worker processes
  - Liveness: `super_turtle/subturtle/ctl list`, `super_turtle/subturtle/ctl status <name>`
  - Logs: `super_turtle/subturtle/ctl logs <name>`, `.subturtles/<name>/subturtle.log`
  - Primary failure signals: pid missing/stale, overdue timeout, repeated watchdog/kill lines
- Cron supervision jobs
  - Liveness: `/cron`, `.superturtle/cron-jobs.json`, `/debug` background section
  - Logs/signals: missing expected check-ins, stale job timestamps, no new run-state events
- MCP sidecars (bot-control / ask-user / send-turtle)
  - Liveness: requests complete via callbacks/tools, pino log entries with `module: "mcp"` or tool events
  - Failure signals: callback stalls, MCP transport errors, missing IPC file activity in `/tmp/superturtle-{tokenPrefix}/`

## End goal with specs
Multiple Super Turtle instances (dev + prod, different projects) run on the same Mac with zero cross-instance interference. All shared `/tmp/` resources namespaced by bot token prefix.

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
- ✅ Multi-instance isolation: TOKEN_PREFIX namespacing for all /tmp files, MCP IPC directory, logs, tmux sessions
- ✅ npm release safety gates: CI runs on PR + main push with Bun typecheck/tests, Python tests, npm tarball smoke check, and non-destructive `superturtle init` test (preserves existing `.claude`, `CLAUDE.md`, `AGENTS.md`)

## Backlog
- [x] Build a single-command process inventory flow (bot + SubTurtles + cron + key logs)
- [ ] Harden error-path observability: every crash/failure mode must have one durable, queryable log surface
- [ ] Add clear triage workflow for stalled queue, dead bot session, and cron drift scenarios
- [ ] Validate/merge local request-correlation work (`wip/logging-split` / `0a5d546`) or replace with equivalent
- [ ] Reuse Telegram bot output streaming primitives in the runtime flow (with research notes)
- [ ] Audit STOP behavior and polish queued-message visibility while a response is running
- [ ] Redesign `/context` to report Super Turtle-level loaded prompts (CLAUDE.md + META prompt)
- [ ] Review overnight commits and publish a concise dev-branch checkpoint (no push)

## Debug/Triage Playbook
1. Confirm process liveness
   - `superturtle status`
   - `tmux ls`
   - `super_turtle/subturtle/ctl list`
2. Snapshot internal state
   - Telegram `/debug`
   - Telegram `/status`
3. Inspect logs in this order
   - Telegram `/looplogs`
   - Telegram `/pinologs`
   - `tail -F /tmp/claude-telegram-{tokenPrefix}-bot-ts.log`
   - `tail -F /tmp/claude-telegram-{tokenPrefix}-bot.log.jsonl`
   - `tail -F /tmp/claude-telegram-{tokenPrefix}-audit.log`
4. If worker-specific issue
   - `super_turtle/subturtle/ctl status <name>`
   - `super_turtle/subturtle/ctl logs <name>`
5. Decide restart scope
   - Prefer smallest scope first (single worker/session) before global stop/restart

## Robustness Acceptance Criteria
- No silent bot/process death without a visible signal path (`status`/tmux/log)
- Every long-running process has a documented liveness check and log source
- Error paths emit to at least one durable log sink (loop/pino/audit/worker log)
- Queue/streaming stalls are diagnosable from logs + `/debug` without code changes
- Isolation guarantees hold: stopping one token/project instance does not impact others

## Notes
- Multi-instance audit: `docs/audits/multi-instance-isolation.md`
- TOKEN_PREFIX lives in `src/token-prefix.ts` (standalone leaf module, no circular deps)
- MCP IPC files isolated in `/tmp/superturtle-{tokenPrefix}/`, passed to MCP servers via `SUPERTURTLE_IPC_DIR` env var
- The bot is the meta agent — system prompt is `super_turtle/meta/META_SHARED.md`, injected via `config.ts`
- Observability instrumentation branch pending review: `wip/logging-split` (commit `0a5d546`)
- LinkedIn demo (Turtle In) lives in separate repo: `https://github.com/turtleagent/TurtleIn`
- npm/CI hardening shipped in commit `8f6b29e`:
  - `.github/workflows/ci.yml` (PR + push + workflow_dispatch; Python + package smoke + init safety jobs)
  - `super_turtle/tests/npm-package-smoke.sh`
  - `super_turtle/tests/init-non-destructive.sh`
  - `super_turtle/package.json` scripts: `test:pack`, `test:init-safe`
