<p align="center">
  <img src="https://raw.githubusercontent.com/Rigos0/superturtle/main/assets/readme-stickers/hero-double-turtle.png" width="160" alt="superturtle" />
</p>

<h3 align="center">superturtle</h3>
<p align="center">Code from anywhere with your voice.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/superturtle"><img src="https://img.shields.io/npm/v/superturtle?style=flat-square&label=npm" alt="npm" /></a>
  <a href="https://github.com/Rigos0/superturtle/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" /></a>
  <a href="https://www.superturtle.dev/docs"><img src="https://img.shields.io/badge/docs-superturtle.dev-blue?style=flat-square" alt="Docs" /></a>
</p>

---

An autonomous coding system controlled from Telegram. You talk to one Meta Agent — it decomposes work, spawns SubTurtles, supervises progress, and reports milestones.

You focus on outcomes, not orchestration. **Say what → get results.**

## Install

```bash
npm install -g superturtle
superturtle init
```

Then start:

```bash
superturtle start
```

Operations:

```bash
superturtle status
superturtle doctor
superturtle logs loop
superturtle logs pino --pretty
```

For agents and CI, init runs non-interactively with flags:

```bash
superturtle init --token <BOT_TOKEN> --user <TELEGRAM_USER_ID> --openai-key <KEY>
```

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- [Claude Code](https://claude.ai/code) CLI — uses your existing subscription, no extra API keys

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

## Platform support

| Platform | Status |
|----------|--------|
| macOS    | Fully supported |
| Linux    | Alpha |
| Windows  | Not yet (WSL2 may work) |

## Documentation

- **Docs site:** [superturtle.dev/docs](https://www.superturtle.dev/docs)
- **Quickstart:** [superturtle.dev/docs/quickstart](https://www.superturtle.dev/docs/quickstart)
- **GitHub:** [github.com/Rigos0/superturtle](https://github.com/Rigos0/superturtle)
