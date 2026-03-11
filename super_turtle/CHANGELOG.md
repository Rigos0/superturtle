# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Multi-project support**: run SuperTurtle on multiple projects simultaneously — each project gets its own forum topic in a Telegram supergroup, with messages routed automatically
- Dedicated router process: single Telegram poller that routes updates to project instances via Unix domain sockets, replacing per-instance polling
- Auto-topic creation: starting `superturtle start` in a new directory auto-creates a forum topic with a deterministic emoji name (e.g. `🐢 my-app`)
- Duplicate detection: starting a second instance in the same directory shows a friendly message pointing to the existing topic instead of creating a conflict
- Thread registry: topic assignments persist in `~/.superturtle/projects.json` so instances reuse their topic across restarts
- Global env: bot token, allowed users, and API keys stored in `~/.superturtle/.env` (shared across all projects)

### Changed
- `superturtle start` now starts a router process alongside the bot (transparent to single-instance users)
- Configuration moved from per-project `.superturtle/.env` to global `~/.superturtle/.env` (existing configs are migrated automatically)

## [0.2.3] - 2026-03-09

### Added
- driver-specific default model and effort settings for fresh sessions: `DEFAULT_CLAUDE_MODEL`, `DEFAULT_CLAUDE_EFFORT`, `DEFAULT_CODEX_MODEL`, and `DEFAULT_CODEX_EFFORT`
- `SHOW_TOOL_STATUS=false` as the default packaged install setting so routine tool-call progress no longer clutters Telegram chats

### Changed
- `superturtle start` now forwards `DEFAULT_*` environment variables into the tmux bot process, so configured model defaults work the same way as direct bot launches
- dashboard runtime config is simplified: packaged installs now use the built-in localhost bind and stable per-instance port instead of exposing `DASHBOARD_PORT`, `DASHBOARD_BIND_ADDR`, and `DASHBOARD_HOST`

## [0.2.2] - 2026-03-08

### Fixed
- npm package Python entrypoints: include missing Python package marker files so packaged `python -m subturtle` and `state/run_state_writer.py` imports work outside the monorepo
- npm package smoke test: verify packaged Python entrypoints and import fallbacks from the packed tarball

## [0.2.1] - 2026-03-08

### Changed
- removed message keyword-based reasoning escalation for both Claude and Codex turns
- removed the related thinking-keyword environment variables from packaged templates and operator docs

### Added
- regression coverage to ensure message content no longer changes Claude thinking tokens or Codex reasoning effort

## [0.2.0] - 2026-03-08

### Added
- `superturtle doctor`: one-command observability snapshot (bot tmux state, SubTurtles, cron summary, log health, recent loop failures)
- `superturtle logs`: tail namespaced loop/pino/audit logs with optional pino pretty-printing
- dashboard session observability:
  - new APIs: `/api/sessions` and `/api/sessions/:driver/:sessionId`
  - new UI section on `/dashboard` for active + recent sessions
  - new detail page: `/dashboard/sessions/:driver/:sessionId` with recent message timeline + runtime metadata

### Changed
- `superturtle start` now launches via `run-loop.sh` with loop-log tee output (`/tmp/claude-telegram-<tokenPrefix>-bot-ts.log`) and fails fast with last-log context when the tmux session exits immediately
- bot runtime now treats `uncaughtException` and `unhandledRejection` as fatal, logs them to pino/events, and exits for supervised restart
- `bun run start` (`live.sh`) now loads `${CLAUDE_WORKING_DIR}/.superturtle/.env` before deriving tmux/log names, avoiding accidental fallback to `default` token prefix
- fixed dashboard frontend script link rendering so polling runs (removes JavaScript syntax break that caused "Loading… / waiting for first sync…" to stick)

## [0.1.4] - 2026-03-04

### Fixed
- tmux session isolation: `superturtle start/stop/status` now default to `superturtle-<tokenPrefix>-<projectSlug>` instead of a shared static session name
- `claude-telegram-bot/live.sh` now uses the same token/project namespaced tmux session default for manual `bun run start`

## [0.1.3] - 2026-03-04

### Fixed
- npm global install: include bot runtime dependencies in root package so `superturtle start` does not crash with missing modules
- npm package smoke test: verify root `dependencies` include `claude-telegram-bot` runtime dependencies with matching versions

## [0.1.1] - 2026-03-04

### Fixed
- `superturtle init`: polished output with ANSI colors and step indicators
- `superturtle init`: added `--token`, `--user`, `--openai-key` flags for non-interactive use
- `superturtle init`: detect non-TTY and fail fast with usage message
- `live.sh`: pass `CLAUDE_WORKING_DIR` into tmux session (was not sourcing `.env`)
- npm README: use absolute image URLs so images render on npmjs.com

## [0.1.0] - 2026-03-03

Initial public release.

### Added
- `superturtle` CLI with `init`, `start`, `stop`, `status` commands
- Telegram bot runtime (Bun + grammY) with text, voice, photo, document, video handlers
- Claude Code driver with streaming responses
- Optional Codex driver with quota-aware routing
- SubTurtle orchestration system (spawn, stop, status, logs, watchdog)
- Meta agent prompts (META_SHARED.md, orchestrator, decomposition)
- MCP servers: send-turtle (stickers), bot-control (session/model/usage), ask-user (inline buttons)
- Voice transcription via OpenAI API
- User allowlist, rate limiting, audit logging
- Deferred voice message queue (max 10 per chat)
- Multi-instance isolation via TOKEN_PREFIX namespacing
- Tunnel support (cloudflared) for frontend preview links
- Browser screenshot support (Playwright)
- Orchestrator cron mode for full-auto operation
- CLAUDE.md and .claude config templates for target projects
- systemd service template for Linux deployment
