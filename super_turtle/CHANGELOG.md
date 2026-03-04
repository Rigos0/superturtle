# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
