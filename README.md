# Super Turtle

Code from anywhere with your voice.

<p align="center">
  <img src="assets/readme-stickers/hero-double-turtle.png" width="160" alt="Super Turtle" />
</p>


## What It Is

Super Turtle is an autonomous coding system controlled from Telegram:

- You talk to one Meta Agent.
- It decomposes work, spawns SubTurtles, supervises progress, and reports milestones.
- You focus on outcomes, not orchestration.

Core UX: **say what -> get results**.

## Why Use It

1. Uses your Claude Code subscription (no extra API-token workflow).
2. Mobile + voice first via Telegram.
3. Designed for long-running, multi-step coding work.
4. Parallel SubTurtle execution with milestone-focused updates.
5. Natural voice and text interaction from anywhere.

\* Uses official Claude Code CLI auth flows.

<p align="center">
  <img src="assets/readme-stickers/setup-save-turtle.png" width="108" alt="Setup turtle sticker" />
</p>

## Quick Start

### 1) Clone

```bash
git clone https://github.com/Rigos0/superturtle.git
cd superturtle
```

### 2) Open Claude Code and run setup

```bash
claude
```

When prompted, ask:

```text
Set up Super Turtle for me.
```

## What the onboarding agent does

The onboarding agent is expected to fully handhold setup:

1. Guides you through BotFather token creation (`@BotFather`, `/newbot`).
2. Guides you to get your Telegram user ID (`@userinfobot`).
3. Optionally collects `OPENAI_API_KEY` for voice transcription.
4. Runs setup for you:
   - `./super_turtle/setup --driver claude --telegram-token "<token>" --telegram-user "<id>"`
   - Adds `--openai-api-key "<key>"` if provided.
5. Explains what was configured.
6. Starts the bot and verifies Telegram response.

You should not need manual `.env` editing during normal onboarding.

## Platform Status

- macOS: fully supported.
- Linux: untested alpha.
- Windows: not an officially supported setup target right now.

Mac laptop reliability notes:

- Enable `System Settings -> Battery -> Options -> Prevent automatic sleeping when the display is off` (on power adapter).
- Keep the lid open while the bot is running.

<p align="center">
  <img src="assets/readme-stickers/run-fire-turtle.png" width="108" alt="Run turtle sticker" />
</p>

## Run manually (if needed)

```bash
cd super_turtle/claude-telegram-bot
bun run start
```

> **Note:** `bun run start` uses `live.sh`, which requires `tmux` and an interactive terminal.
> Run it in your own terminal session — it cannot be launched by an agent or as a background process.
> If tmux is not installed: `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

Then message your bot in Telegram and ask it to build something.

## Architecture

- **Human** -> Telegram/CLI
- **Meta Agent** -> plans, delegates, supervises
- **SubTurtles** -> autonomous worker agents (parallel, looped execution)
- **State + logs** -> `CLAUDE.md`, `.subturtles/<name>/`, git history

## Documentation

- Docs site: [superturtle.dev/docs](https://www.superturtle.dev/docs)
- Start with: [Quickstart](https://www.superturtle.dev/docs/quickstart)

Full documentation: https://www.superturtle.dev/docs
Platform support details: https://www.superturtle.dev/docs/config/platform-support

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Rigos0/superturtle&type=Date)](https://star-history.com/#Rigos0/superturtle&Date)
