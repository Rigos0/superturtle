# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**Turn [Claude Code](https://claude.com/product/claude-code) into your personal assistant, accessible from anywhere via Telegram.**

For the full Super Turtle project, use the root setup flow first (AI-guided via `CLAUDE.md`/`AGENTS.md`).

Send text, voice, photos, documents, audio, and video. See responses and tools usage in real-time.

![Demo](assets/demo.gif)

## Claude Code as a Personal Assistant

I've started using Claude Code as a personal assistant, and I've built this bot so I can access it from anywhere.

In fact, while Claude Code is described as a powerful AI **coding agent**, it's actually a very capable **general-purpose agent** too when given the right instructions, context, and tools.

To achieve this, I set up a folder with a CLAUDE.md that teaches Claude about me (my preferences, where my notes live, my workflows), has a set of tools and scripts based on my needs, and pointed this bot at that folder.

→ **[📄 See the Personal Assistant Guide](docs/personal-assistant-guide.md)** for detailed setup and examples.

## Bot Features

- 💬 **Text**: Ask questions, give instructions, have conversations
- 🎤 **Voice**: Speak naturally - transcribed via OpenAI and processed by Claude
- 📸 **Photos**: Send screenshots, documents, or anything visual for analysis
- 📄 **Documents**: PDFs, text files, and archives (ZIP, TAR) are extracted and analyzed
- 🎵 **Audio**: Audio files (mp3, m4a, ogg, wav, etc.) are transcribed via OpenAI and processed
- 🎬 **Video**: Video messages and video notes are processed by Claude
- 🔄 **Session persistence**: Conversations continue across messages
- 📨 **Message queuing**: Send multiple messages while Claude works - they queue up automatically. Prefix with `!` or use `/stop` to interrupt and send immediately
- 🛑 **Global stop intents**: `stop`, `pause`, `abort`, `!`, and `!stop` (including voice transcript variants) immediately stop active work and running SubTurtles
- 🔘 **Interactive buttons**: Claude can present options as tappable inline buttons via the built-in `ask_user` MCP tool

## Quick Start (Super Turtle repo)

```bash
git clone <your-fork-or-repo-url>
cd <repo-directory>
# Open Claude Code here and ask:
# "Set up Super Turtle on this machine."
```

The setup wizard runs `./super_turtle/setup`, installs dependencies, and configures `super_turtle/claude-telegram-bot/.env` for you.

## Quick Start (standalone bot folder, manual)

If you are only working on this bot module directly:

```bash
cd super_turtle/claude-telegram-bot
cp .env.example .env
# Edit .env with your credentials
bun install
bun run start
```

### Prerequisites

- **Bun 1.0+** - [Install Bun](https://bun.sh/)
- **Claude Agent SDK** - `@anthropic-ai/claude-agent-sdk` (installed via bun install)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **OpenAI API Key** (optional, for voice transcription)

### Claude Authentication

The bot uses the `@anthropic-ai/claude-agent-sdk` which supports two authentication methods:

| Method                     | Best For                                | Setup                             |
| -------------------------- | --------------------------------------- | --------------------------------- |
| **CLI Auth** (recommended) | High usage, cost-effective              | Run `claude` once to authenticate |
| **API Key**                | CI/CD, environments without Claude Code | Set `ANTHROPIC_API_KEY` in `.env` |

**CLI Auth** (recommended): The SDK automatically uses your Claude Code login. Just ensure you've run `claude` at least once and authenticated. This uses your Claude Code subscription which is much more cost-effective for heavy usage.

**API Key**: For environments where Claude Code isn't installed. Get a key from [console.anthropic.com](https://console.anthropic.com/) and add to `.env`:

```bash
ANTHROPIC_API_KEY=<optional_anthropic_api_key>
```

Note: API usage is billed per token and can get expensive quickly for heavy use.

### Codex Subscription Requirement (CLOTH)

Codex features in this project require an active **CLOTH** subscription on the OpenAI account you use for Codex.

If CLOTH is not active, Codex-specific workflows will not be available. Claude-only bot usage is unaffected.

## Configuration

### 1. Create Your Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the token and keep it private

Then send `/setcommands` to BotFather and paste this:

```
start - Show status and user ID
new - Start a fresh session
resume - Resume Claude/Codex session
context - Show context usage
stop - Interrupt current query
status - Check what Claude is doing
looplogs - Raw run-loop logs
pinologs - Filtered app logs
sub - SubTurtles
```

### 2. Configure Environment

Create `.env` with your settings:

```bash
# Required
TELEGRAM_BOT_TOKEN=<telegram_bot_token_from_botfather>  # From @BotFather
TELEGRAM_ALLOWED_USERS=<telegram_user_id>               # Your Telegram user ID

# Recommended
CLAUDE_WORKING_DIR=/path/to/your/folder    # Where Claude runs (loads CLAUDE.md, skills, MCP)
OPENAI_API_KEY=<optional_openai_api_key>   # For voice transcription
```

`.env` is gitignored. Keep real credentials only in local env files.

**Finding your Telegram user ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram.

### Multi-Project & Forum Topics

Run SuperTurtle on multiple projects at the same time. Each project gets its
own topic in a Telegram supergroup — messages stay isolated, and you can see
all your agents in one group.

```
🐢 my-app              ← topic auto-created
🦊 api-server           ← topic auto-created
🐙 landing-page         ← topic auto-created
```

#### Quick start

If you already have one instance running:

```bash
cd ~/projects/another-project
superturtle start
```

That's it. SuperTurtle detects the running instance, creates a forum topic for
the new project, and routes messages to the right place. Each topic gets a
deterministic emoji based on the project directory name.

#### One-time setup: create a forum group

Before multi-project works, you need a Telegram supergroup with topics enabled.
You only do this once.

**Step 1 — Create a group:**
1. In Telegram, tap the compose/new message button (pencil icon)
2. Select **"New Group"**
3. Add your SuperTurtle bot as a member
4. Give the group a name (e.g. "SuperTurtle")
5. Create it

**Step 2 — Enable Topics:**
1. Open the group → tap the group name at the top
2. Tap **"Edit"** (pencil icon)
3. Find **"Topics"** and toggle it **ON**

Telegram automatically converts the group to a supergroup when you enable
Topics.

**Step 3 — Make the bot an admin:**
1. In group settings → **"Administrators"** → **"Add Admin"**
2. Select the SuperTurtle bot
3. Enable these permissions: **Send Messages**, **Manage Topics**, **Pin Messages**

**Step 4 — Connect the group:**
Start SuperTurtle and send any message in the group. SuperTurtle auto-detects
the group chat ID — no manual configuration needed.

#### How it works

A lightweight **router process** runs alongside the bot. It polls Telegram once
and routes each update to the right instance based on which forum topic the
message came from. Instances connect to the router via a local socket.

```
Telegram → Router → Instance A (topic: 🐢 my-app)
                  → Instance B (topic: 🦊 api-server)
                  → Instance C (topic: 🐙 landing-page)
```

- **Single instance** — the router still runs, but transparently. You can use
  SuperTurtle in a direct chat or a forum topic, both work.
- **Multiple projects** — each gets its own topic. Messages in one topic never
  reach another project.
- **Duplicate detection** — starting SuperTurtle twice in the same directory
  shows a friendly message pointing you to the existing topic.
- **Thread registry** — topic assignments persist in `~/.superturtle/projects.json`.
  Restarting an instance reuses its existing topic (conversation history is
  preserved).

#### Manual configuration

You can also set the forum group and thread ID manually in `.env`:

```bash
TELEGRAM_FORUM_CHAT_ID=-100XXXXXXXXXX   # Supergroup ID (starts with -100)
TELEGRAM_THREAD_ID=42                    # Reuse a specific topic
```

#### Troubleshooting

**"Failed to connect to router"** — the router process isn't running. Run
`superturtle start` again; it starts the router automatically.

**Messages going to the wrong topic** — check `~/.superturtle/projects.json` to
see which directory is mapped to which thread. Delete an entry to force a new
topic on next start.

**Bot not responding in the group** — make sure the bot is an admin with
**Manage Topics** permission. Without it, the bot can't create topics or send
messages in them.

### Codex Configuration (Optional)

Enable Codex usage reporting in `/usage` by setting:

```bash
CODEX_ENABLED=true
```

Meta-agent Codex sessions use a runtime policy that is configurable via env vars:

```bash
# Defaults shown below (least privilege)
META_CODEX_SANDBOX_MODE=workspace-write
META_CODEX_APPROVAL_POLICY=never
META_CODEX_NETWORK_ACCESS=false
```

Notes:

- `CODEX_ENABLED` defaults to `false`, so Claude usage remains the only section shown in `/usage` unless you explicitly enable Codex.
- `META_CODEX_SANDBOX_MODE`, `META_CODEX_APPROVAL_POLICY`, and `META_CODEX_NETWORK_ACCESS` default to least-privilege values (`workspace-write`, `never`, network disabled).
- Codex usage stats are fetched from a local Codex CLI instance (`codex` must be installed and available in PATH).
- The bot parses local Codex history to extract usage data (requests and estimated token counts over the last 7 days).
- No API keys required for Codex usage reporting — only the local `codex` CLI tool.
- `OPENAI_API_KEY` is still used for voice transcription and is separate from Codex usage reporting.
- If `CODEX_ENABLED=true` but Codex is not installed/available, the bot keeps working and shows Codex usage as unavailable.
- Codex workflows still require an active CLOTH subscription (see section above).

If you are using SubTurtles, the recommended Codex worker type is `yolo-codex` (see [SubTurtle docs](../meta/META_SHARED.md)).

**File access paths:** By default, Claude can access:

- `CLAUDE_WORKING_DIR` (or home directory if not set)
- `~/Documents`, `~/Downloads`, `~/Desktop`
- `~/.claude` (for Claude Code plans and settings)

To customize, set `ALLOWED_PATHS` in `.env` (comma-separated). Note: this **overrides** all defaults, so include `~/.claude` if you want plan mode to work:

```bash
ALLOWED_PATHS=/your/project,/other/path,~/.claude
```

### 3. Configure MCP Servers (Optional)

Copy and edit the MCP config:

```bash
cp mcp-config.ts mcp-config.local.ts
# Edit mcp-config.local.ts with your MCP servers
```

The bot includes a built-in `ask_user` MCP server that lets Claude present options as tappable inline keyboard buttons. Add your own MCP servers (Things, Notion, Typefully, etc.) to give Claude access to your tools.

## Bot Commands

| Command    | Description                       |
| ---------- | --------------------------------- |
| `/start`   | Show status and your user ID      |
| `/new`     | Start a fresh session             |
| `/resume`  | Unified Claude+Codex session picker (+ continue current) |
| `/context` | Show Claude context usage         |
| `/stop`    | Interrupt current query (plain `stop`/`pause`/`abort` also work) |
| `/status`  | Check what Claude is doing        |
| `/looplogs`| Show last 50 lines of raw main run-loop log |
| `/pinologs`| Show filtered Pino app logs (Info/Warning/Errors) |
| `/restart` | Restart the bot                   |

## Running as a Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit the plist with your paths and env vars
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

The bot will start automatically on login and restart if it crashes.

**Prevent sleep:** To keep the bot running when your Mac is idle, go to **System Settings → Battery → Options** and enable **"Prevent automatic sleeping when the display is off"** (when on power adapter).

**Logs:**

```bash
tail -f /tmp/claude-telegram-bot-ts.log   # stdout
tail -f /tmp/claude-telegram-bot-ts.err   # stderr
```

## Monitor Background Bot

Use the live launcher so the bot always runs in one visible terminal (`tmux`) and multiple starts just re-attach.
`bun run start` appends the caffeinated run-loop output to `/tmp/claude-telegram-bot-ts.log`; Telegram `/looplogs` tails this same file.

```bash
# Start or re-attach the same terminal session
bun run start
# /restart keeps using this same tmux terminal session

# Attach later from another terminal
tmux attach -t superturtle-bot

# Session status
tmux has-session -t superturtle-bot && echo "running" || echo "stopped"

# Stop bot completely
tmux kill-session -t superturtle-bot
```

**Shell aliases:** If running as a service, these aliases make it easy to manage the bot (add to `~/.zshrc` or `~/.bashrc`):

```bash
alias cbot='launchctl list | grep com.claude-telegram-ts'
alias cbot-stop='launchctl bootout gui/$(id -u)/com.claude-telegram-ts 2>/dev/null && echo "Stopped"'
alias cbot-start='launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-telegram-ts.plist 2>/dev/null && echo "Started"'
alias cbot-restart='launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts && echo "Restarted"'
alias cbot-logs='tail -f /tmp/claude-telegram-bot-ts.log'
```

## Development

```bash
# Run with auto-reload
bun --watch run src/index.ts

# Type check
bun run typecheck

# Or directly
bun run --bun tsc --noEmit
```

## Security

> **⚠️ Important:** This bot runs Claude Code with **all permission prompts bypassed**. Claude can read, write, and execute commands without confirmation within the allowed paths. This is intentional for a seamless mobile experience, but you should understand the implications before deploying.

**→ [Read the full Security Model](https://www.superturtle.dev/docs/config/security)** for details on how permissions work and what protections are in place.

Multiple layers protect against misuse:

1. **User allowlist** - Only your Telegram IDs can use the bot
2. **Intent classification** - AI filter blocks dangerous requests
3. **Path validation** - File access restricted to `ALLOWED_PATHS`
4. **Command safety** - Destructive patterns like `rm -rf /` are blocked
5. **Rate limiting** - Prevents runaway usage
6. **Audit logging** - All interactions logged to `/tmp/claude-telegram-audit.log`

## Troubleshooting

**Bot doesn't respond**

- Verify your user ID is in `TELEGRAM_ALLOWED_USERS`
- Check the bot token is correct
- Look at logs: `tail -f /tmp/claude-telegram-bot-ts.err`
- Ensure the bot process is running

**Claude authentication issues**

- For CLI auth: run `claude` in terminal and verify you're logged in
- For API key: check `ANTHROPIC_API_KEY` is set and uses the expected Anthropic key prefix
- Verify the API key has credits at [console.anthropic.com](https://console.anthropic.com/)

**Voice messages fail**

- Ensure `OPENAI_API_KEY` is set in `.env`
- Verify the key is valid and has credits

**Claude can't access files**

- Check `CLAUDE_WORKING_DIR` points to an existing directory
- Verify `ALLOWED_PATHS` includes directories you want Claude to access
- Ensure the bot process has read/write permissions

**MCP tools not working**

- Verify `mcp-config.ts` exists and exports properly
- Check that MCP server dependencies are installed
- Look for MCP errors in the logs

## License

MIT
