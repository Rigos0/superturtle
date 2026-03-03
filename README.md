<p align="center">
  <img src="assets/readme-stickers/hero-double-turtle.png" width="160" alt="superturtle" />
</p>

<h3 align="center">superturtle</h3>
<p align="center">Code from anywhere with your voice.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/superturtle"><img src="https://img.shields.io/npm/v/superturtle?style=flat-square&label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" /></a>
  <a href="https://www.superturtle.dev/docs"><img src="https://img.shields.io/badge/docs-superturtle.dev-blue?style=flat-square" alt="Docs" /></a>
</p>

---

Send a voice message or text on Telegram. superturtle runs [Claude Code](https://claude.ai/code) (or [Codex](https://openai.com/index/introducing-codex/), beta) on your machine, writes code, runs tests, and reports back — while you're on the couch, on a walk, or on a different machine entirely.

For bigger tasks it spins up parallel workers (SubTurtles), each in their own git worktree, and supervises them to completion.

## Install

```bash
npm install -g superturtle
superturtle init
```

Then start:

```bash
superturtle start
```

For agents and CI, init runs non-interactively with flags:

```bash
superturtle init --token <BOT_TOKEN> --user <TELEGRAM_USER_ID> --openai-key <KEY>
```

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- [Claude Code](https://claude.ai/code) CLI — uses your existing subscription, no extra API keys

<p align="center">
  <img src="assets/readme-stickers/setup-save-turtle.png" width="108" alt="Setup" />
</p>

## Why superturtle

1. **Uses your Claude Code subscription** — no extra API-token workflow.
2. **Mobile + voice first** via Telegram.
3. **Long-running, multi-step work** — spawns parallel SubTurtles.
4. **Milestone updates** — you get progress, not noise.
5. **Works from anywhere** — phone, tablet, another machine.

## Architecture

```
You (Telegram) → Meta Agent → SubTurtles (parallel workers)
                     ↓
              plans, delegates, supervises
                     ↓
              CLAUDE.md · .subturtles/ · git history
```

- **Meta Agent** — plans, delegates, supervises (the bot itself)
- **SubTurtles** — autonomous worker agents with looped execution
- **MCP servers** — stickers, bot control, inline buttons
- **Drivers** — Claude Code (primary), Codex (optional)

<p align="center">
  <img src="assets/readme-stickers/architecture-gear-turtle.png" width="108" alt="Architecture" />
</p>

## Platform support

| Platform | Status |
|----------|--------|
| macOS    | Fully supported |
| Linux    | Alpha |
| Windows  | Not yet (WSL2 may work) |

**macOS note:** Enable `System Settings → Battery → Options → Prevent automatic sleeping when the display is off` when on power adapter.

## Documentation

- **Docs site:** [superturtle.dev/docs](https://www.superturtle.dev/docs)
- **Quickstart:** [superturtle.dev/docs/quickstart](https://www.superturtle.dev/docs/quickstart)

## Development

```bash
git clone https://github.com/Rigos0/superturtle.git
cd superturtle/super_turtle/claude-telegram-bot
bun install
cp .env.example .env  # fill in your tokens
bun run start
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Rigos0/superturtle&type=Date)](https://star-history.com/#Rigos0/superturtle&Date)
