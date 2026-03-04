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
None — multi-instance isolation complete. Ready for next priority.

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
- [ ] Run overnight orchestrator spawn drill for cron reliability <- current
- [ ] Validate pre-existing cron jobs remain after orchestrator-triggered SubTurtle spawn
- [ ] Report spawned SubTurtles and first progress checkpoint

## Notes
- Multi-instance audit: `docs/audits/multi-instance-isolation.md`
- TOKEN_PREFIX lives in `src/token-prefix.ts` (standalone leaf module, no circular deps)
- MCP IPC files isolated in `/tmp/superturtle-{tokenPrefix}/`, passed to MCP servers via `SUPERTURTLE_IPC_DIR` env var
- The bot is the meta agent — system prompt is `super_turtle/meta/META_SHARED.md`, injected via `config.ts`
- LinkedIn demo (Turtle In) lives in separate repo: `https://github.com/turtleagent/TurtleIn`
- npm/CI hardening shipped in commit `8f6b29e`:
  - `.github/workflows/ci.yml` (PR + push + workflow_dispatch; Python + package smoke + init safety jobs)
  - `super_turtle/tests/npm-package-smoke.sh`
  - `super_turtle/tests/init-non-destructive.sh`
  - `super_turtle/package.json` scripts: `test:pack`, `test:init-safe`
