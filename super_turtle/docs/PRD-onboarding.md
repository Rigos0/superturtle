# Product Requirements Document: Super Turtle Onboarding Experience

**Version:** 1.0
**Date:** February 25, 2026
**Author:** Super Turtle Orchestration System
**Status:** Draft

---

## Executive Summary

This PRD defines how new users onboard onto **Super Turtle**, an autonomous coding agent system built on Claude Code. The onboarding experience guides users from repository clone through a working Telegram bot + first SubTurtle spawn, entirely within Claude Code itself.

**Core design principle:** The onboarding is conversational, driven by Claude Code, requiring no manual file editing or outside-the-IDE configuration.

---

## 1. User Journey

### 1.1 Discovery & First Steps

**Scenario:** User discovers Super Turtle via GitHub README or word of mouth.

1. **GitHub discovery** — README explains what Super Turtle is (autonomous coding agents, Telegram bot control, cost-effective)
2. **Clone repository** — `git clone https://github.com/...agentic.git && cd agentic`
3. **Open in Claude Code** — `claude` (or open folder in Claude Code)
4. **Automatic detection** — Root CLAUDE.md detects first-time setup

### 1.2 First Run: Guided Setup Wizard

When user opens Claude Code for the first time, they see:

```
👋 Welcome to Super Turtle!

You're running Claude Code for the first time in this repository.
I'll walk you through everything — just follow along.

Let me check what we need to set up:
- ✓ Repository cloned
- ✗ Telegram bot token
- ✗ OpenAI API key (optional, for voice)
- ✗ .env configuration

Let's get started! First question:

**Do you want to use Super Turtle as:**
1. A personal Telegram bot (for yourself only)
2. A team bot (for multiple users)
3. Later — I'll skip setup for now
```

### 1.3 Setup Flow (Option 1: Personal Bot)

User selects option 1. Claude Code guides them through:

1. **BotFather Setup**
   ```
   I'll help you create a Telegram bot. Here's what to do:

   1. Open Telegram and message @BotFather
   2. Type: /newbot
   3. Follow the prompts to name your bot
   4. Copy the token (looks like: 1234567890:ABC-DEF...)
   5. Paste it back here →
   ```
   User provides token.

2. **User ID Discovery**
   ```
   Now I need your Telegram user ID so the bot only responds to you.

   1. Open Telegram and message @userinfobot
   2. It will reply with your User ID (a number)
   3. Paste it here →
   ```
   User provides their ID.

3. **OpenAI API Key (Optional)**
   ```
   Want voice message transcription? (Optional)

   You can skip this now and add it later.

   If yes:
   - Go to https://platform.openai.com/api/keys
   - Create a new API key
   - Paste it here →

   [Skip] or [Paste key]
   ```

4. **Configuration Summary**
   ```
   Perfect! Here's what I'm setting up:

   • Telegram bot token: ••••••••••••••••••••••• (20 chars)
   • Your user ID: 123456789
   • Voice transcription: ✓ Enabled

   I'm creating your .env file now...
   ✓ Created .env with secure secrets
   ✓ Added to .gitignore

   Ready to start the bot?
   ```

5. **First Bot Run**
   ```
   Starting your Telegram bot now...

   Your bot is running! To test it:

   1. Open Telegram
   2. Find your bot (@your_bot_name)
   3. Send: /start

   You should see: "Bot initialized. Ready to help."

   ✅ Press Enter to verify the bot is working...
   ```

   Claude Code polls Telegram API or watches logs to confirm the bot received the `/start` command.

### 1.4 First SubTurtle Spawn

```
🐢 Now let's create your first SubTurtle!

SubTurtles are autonomous coding agents that work on one task at a time.

Let me ask a few questions:

What's your first project?
1. Personal project (website, script, tool)
2. Work project
3. Skip for now

[If user selects an option]

Great! What's the project about?
→ [User describes their first task]

I'll create a SubTurtle workspace and spawn it to start working.
This will:
- Create a workspace at .subturtles/my-first-project/
- Seed it with your task description
- Start the autonomous loop
- Set up cron supervision (check every 5 minutes)

Ready?
```

### 1.5 Progress Reporting

```
🐢 my-first-project is running!

Status:
• Type: slow (Plan → Groom → Execute → Review)
• Started: 2 minutes ago
• Current: Planning phase
• Timeout: 1 hour
• Commits: 0 (planning...)

I'll check back with progress every 5 minutes via cron.
You can:
- /stop [name] — Stop the worker
- /logs [name] — See detailed logs
- /status — Check all SubTurtles

In the meantime, your bot is ready to use! Send it a message anytime.
```

---

## 2. Setup Requirements

### 2.1 System Requirements

| Requirement | Details | Notes |
|---|---|---|
| **OS** | macOS or Linux | Windows support planned (WSL works) |
| **Claude Code** | Latest version | `claude` command in PATH |
| **Bun** | 1.0+ | For Telegram bot Node runtime |
| **Python** | 3.11+ | For SubTurtle autonomous loops |
| **Git** | 2.0+ | For commits and version control |

### 2.2 API Keys & Tokens Required

| Key | Source | Cost | Required? | Use |
|---|---|---|---|---|
| **Telegram Bot Token** | @BotFather on Telegram | Free | ✅ Yes | Telegram bot authentication |
| **OpenAI API Key** | platform.openai.com | ~$5-20/month | ❌ No | Voice message transcription |
| **Anthropic API Key** | console.anthropic.com | ~$20+/month | ❌ Optional | API-based Claude (if not using CLI auth) |
| **Claude Code Subscription** | claude.com | $20/month | ✅ Yes | AI reasoning and coding |

**Note:** Claude Code subscriptions are significantly more cost-effective than API-only usage for heavy bot interaction.

### 2.3 External Dependencies

#### Telegram Bot

```bash
# Install Bun (if not already installed)
curl https://bun.sh/install | bash

# Then: bun install (runs automatically during first setup)
```

**npm dependencies** (managed by bun):
- `@anthropic-ai/claude-agent-sdk` — Claude integration
- `grammy` — Telegram bot framework
- `openai` — Voice transcription
- `zod` — Configuration validation

#### SubTurtle Loop

```bash
# Python 3.11+ (pre-requisite, checked during setup)
python3 --version

# Virtual environment created at:
# super_turtle/subturtle/.venv/
# (auto-created on first SubTurtle spawn)
```

**No external Python packages required** for the basic loop. Enhanced features (testing, linting, etc.) can be added per SubTurtle via `--skill` flag.

#### Optional System Tools

| Tool | Purpose | Install |
|---|---|---|
| `pdftotext` (poppler) | PDF extraction for bot documents | `brew install poppler` |
| `cloudflared` | Tunnel support for preview links | Pre-installed at `/opt/homebrew/bin/cloudflared` |

### 2.4 Permissions & File Access

By default, Claude Code can access:

- Repository root (full codebase)
- `~/.claude` (for Claude Code plans)
- `~/Documents`, `~/Downloads`, `~/Desktop`

The `.env` file is **never committed** to git. It lives in:
- `super_turtle/claude-telegram-bot/.env` (secrets)

Example `.env`:
```bash
# Required
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789

# Optional
CLAUDE_WORKING_DIR=/path/to/workspace
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-api03-...
```

---

## 3. Two Key Scenarios: New Repo vs Existing Repo

### 3.1 Scenario A: Greenfield (New Repository)

**User profile:** Starting fresh with Super Turtle.

**Experience:**
1. Clone this repository: `git clone https://github.com/...agentic.git`
2. Run `claude`
3. Guided setup: Telegram bot → first SubTurtle spawn
4. Everything "just works" — no manual setup

**Key advantage:** Out-of-the-box working system.

**What's already in the repo:**
- Root CLAUDE.md (orchestration guide)
- Bot code (super_turtle/claude-telegram-bot/)
- SubTurtle infrastructure (super_turtle/subturtle/)
- Skills library (super_turtle/skills/)
- Example projects (.subturtles/snake-game/, etc.)

**Conflicts:** None — repository is designed for this.

---

### 3.2 Scenario B: Brownfield (Existing Repository)

**User profile:** Has an existing codebase; wants to add Super Turtle.

**Challenge:** Existing CLAUDE.md, .env patterns, git structure.

**Installation Steps:**

1. **Check for conflicts**
   ```
   Checking your repo for conflicts:
   ✓ CLAUDE.md exists (will preserve)
   ✓ AGENTS.md exists (will preserve)
   ✗ .env conflicts (need to merge)
   ```

2. **Preserve existing CLAUDE.md**
   ```
   Your repo already has CLAUDE.md (guidance for your existing work).

   I'll create:
   - super_turtle/CLAUDE.md (Super Turtle orchestration guide)
   - super_turtle/.env (bot secrets, separate from your .env)

   This way both coexist without conflict.
   ```

3. **Copy infrastructure**
   ```bash
   # Minimal copy (just what's needed):
   cp -r github.com/.../agentic/super_turtle \
        ./super_turtle/

   # Avoid copying:
   # - .subturtles/ (empty starter templates only)
   # - .env files (created fresh)
   # - node_modules/, .venv/ (recreated on first run)
   ```

4. **Merge .env files**
   ```
   I found your existing .env. I'll:
   1. Back it up to .env.backup
   2. Create a new .env with Super Turtle defaults
   3. Show you the diff so you can re-add any custom vars
   ```

5. **Test integration**
   ```
   Testing Super Turtle in your repo...
   ✓ Telegram bot starts
   ✓ SubTurtle spawns
   ✓ Your existing code is untouched

   All good! You're ready to use Super Turtle.
   ```

**Key principle:** Super Turtle installs *alongside* existing code, not inside it.

---

## 4. Claude Code as the Onboarding Guide

### 4.1 Root CLAUDE.md: First-Time Setup Detection

The root CLAUDE.md includes a setup phase that:

1. **Detects first-time setup**
   ```
   if .env not found OR TELEGRAM_BOT_TOKEN not set:
      trigger_onboarding_wizard()
   ```

2. **Guides interactively**
   - Multiple choice prompts (1, 2, 3 options)
   - Claude Code handles all editing (no manual file touch required)
   - Verification steps (test bot, confirm token, etc.)

3. **Handles errors gracefully**
   - Invalid token? → "That doesn't look right. Let's try again."
   - Bot won't start? → "Let me check the logs..."
   - Missing Bun? → "I'll help you install it."

### 4.2 Conversation Flow

```
User: [Opens Claude Code for first time]

Claude Code: [Reads root CLAUDE.md, detects first-time setup]
"Hi! Welcome to Super Turtle. Let's get you set up..."

User: [Answers 5-7 guided questions]

Claude Code: [Creates .env, installs deps, tests bot, spawns SubTurtle]
"All set! Your bot is running and your first SubTurtle is working."

User: [Can now use Telegram bot or create more SubTurtles]
```

### 4.3 Error Handling

| Error | Claude Response |
|---|---|
| Invalid Telegram token | "That doesn't match the expected format. Let me help you find it again." |
| Bot won't connect | "Let me check the logs... I see the issue: [error]. Here's the fix:" |
| Missing OpenAI key (non-critical) | "You skipped the OpenAI key. Voice won't work, but text will. You can add it anytime." |
| Bun not installed | "I need Bun to run the bot. Let me install it for you..." |
| Python venv fails | "Let me recreate the Python environment..." |

### 4.4 Safety & Validation

- **Token validation** — Check format before saving
- **Path validation** — Ensure CLAUDE_WORKING_DIR exists
- **Capability check** — Verify Bun, Python, Git are available
- **Intent filtering** — AI guard prevents dangerous commands (destructive patterns blocked)
- **Audit logging** — All setup actions logged to `/tmp/claude-telegram-audit.log`

---

## 5. Configuration Architecture

### 5.1 Where Config Lives

```
agentic/
├── CLAUDE.md                        # Root orchestration guide
├── .env                             # (auto-created, not committed)
├── super_turtle/
│   ├── claude-telegram-bot/
│   │   ├── .env                     # Bot secrets (auto-created)
│   │   ├── .env.example             # Template for reference
│   │   ├── mcp-config.ts            # Optional MCP servers
│   │   └── src/
│   │       └── config.ts            # Runtime config parsing
│   │
│   └── subturtle/
│       ├── ctl                      # Control script
│       └── __main__.py              # Loop runner
│
└── .subturtles/
    └── <project-name>/
        ├── CLAUDE.md                # SubTurtle state (auto-created)
        └── AGENTS.md                # Symlink to CLAUDE.md
```

### 5.2 Minimal vs Complete Configuration

#### Minimal (Get Started Fast)
```bash
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789
```
✅ Bot works. Voice transcription disabled.

#### Recommended (First Productive Day)
```bash
# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=...

# Optional: Voice transcription
OPENAI_API_KEY=sk-proj-...

# Optional: Claude Code working directory
CLAUDE_WORKING_DIR=/path/to/workspace
```
✅ Bot works with voice. Bot can access your files.

#### Complete (Production)
```bash
# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=... # comma-separated for multiple users

# Voice & reasoning
OPENAI_API_KEY=...

# Claude authentication (if not using CLI auth)
ANTHROPIC_API_KEY=...

# Path access
CLAUDE_WORKING_DIR=...
ALLOWED_PATHS=/your/project,/other/path,~/.claude

# Advanced: Codex integration
CODEX_ENABLED=true

# Rate limiting (requests per hour)
RATE_LIMIT=100
```

### 5.3 Environment File Security

**Never commit `.env`:**
```bash
# In .gitignore:
super_turtle/claude-telegram-bot/.env
super_turtle/claude-telegram-bot/.env.local
.env
```

**Why:** Secrets must stay off version control.

**How we verify:** Git pre-commit hook checks for accidental commits.

### 5.4 Configuration Validation

At startup, Claude Code validates:

1. **Required keys present** — TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS
2. **Key format valid** — Token matches expected pattern
3. **Paths exist** — CLAUDE_WORKING_DIR, ALLOWED_PATHS accessible
4. **API keys working** — Test connectivity to Telegram, OpenAI (optional)

If validation fails, Claude Code prompts to fix immediately.

---

## 6. Success Criteria

### 6.1 User Journey Timeline

| Phase | Duration | Outcome |
|---|---|---|
| **Discovery** | 1 min | User has repo cloned |
| **Setup** | 5-10 min | Bot token + user ID collected |
| **Bot verification** | 1-2 min | Bot responds to /start |
| **SubTurtle spawn** | 1 min | First project workspace created |
| **First commit** | 5-15 min | SubTurtle makes first code change |
| **Complete** | ~25 min | **Goal achieved** |

**Target:** User can go from zero to working Telegram bot + first SubTurtle in **< 30 minutes**.

### 6.2 Success Metrics

✅ **Bot is responsive**
- Bot responds to messages within 5 seconds
- Voice transcription works (if enabled)
- Session persistence works (can resume conversations)

✅ **SubTurtle is autonomous**
- Spawned SubTurtle runs its first planning phase
- First commit happens within 10 minutes
- Cron supervision detects progress

✅ **Integration is seamless**
- No manual file editing required
- Claude Code handles all setup
- Errors are recoverable

✅ **System is accessible**
- Works on macOS and Linux
- Works in greenfield and brownfield scenarios
- Documentation is clear and discoverable

### 6.3 Acceptance Criteria

- [ ] Root CLAUDE.md detects first-time setup
- [ ] Claude Code guides through 5-7 interactive prompts
- [ ] .env is created with validated secrets
- [ ] `bun install` runs automatically
- [ ] Telegram bot starts and responds
- [ ] First SubTurtle spawns with provided task
- [ ] Cron supervision is registered
- [ ] User receives progress updates
- [ ] All steps complete in < 30 minutes
- [ ] Brownfield scenario (existing repo) doesn't conflict

---

## 7. Open Questions & Future Work

### 7.1 Questions for Stakeholders

1. **Multi-user bots:** Should the setup flow support multiple authorized users from the start, or add it later?
2. **Docker/containers:** Should we provide Docker setup for cloud deployment?
3. **Hosted bot option:** Should Super Turtle offer a managed bot service (user doesn't run locally)?
4. **Mobile setup:** Can we make setup work from Telegram itself (no laptop)?

### 7.2 Future Enhancements

- **Web dashboard** — Monitor SubTurtles from browser, not just Telegram
- **Skill marketplace** — Browse and install skills from Anthropic registry
- **Template projects** — Quick-start templates (API server, React app, CLI tool)
- **Cost tracking** — Dashboard showing API spend breakdown
- **Team management** — Invite teammates, collaborate on projects
- **GitHub integration** — Auto-create PRs, sync with GitHub Actions

### 7.3 Known Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| **Telegram only** | No web UI for bot control | Will add web dashboard later |
| **macOS/Linux only** | Windows users need WSL | Native Windows support planned |
| **Single bot instance** | One bot per repo | Can run multiple repos independently |
| **Voice: OpenAI only** | Requires OpenAI subscription | Can add other providers (Deepgram, etc.) |

---

## 8. Implementation Roadmap

### Phase 1: MVP (Current)
- [x] Core infrastructure (ctl, loop types, cron)
- [x] Telegram bot foundation
- [ ] **Onboarding wizard (this PRD)**
- [ ] Interactive setup flow in root CLAUDE.md

### Phase 2: Polish (Next)
- [ ] Error recovery improvements
- [ ] Better progress reporting
- [ ] Brownfield installation helper
- [ ] Documentation polish

### Phase 3: Enhancement (Future)
- [ ] Web dashboard
- [ ] Team management
- [ ] Skill marketplace
- [ ] Advanced cost tracking

---

## 9. Appendix: Detailed Technical Spec

### 9.1 Root CLAUDE.md Pseudo-Code

```python
# In super_turtle/claude-telegram-bot/__init__.py or root CLAUDE.md

def on_first_open():
    if not env_file_exists() or not has_telegram_token():
        start_onboarding_wizard()
    else:
        start_bot()

def start_onboarding_wizard():
    # Step 1: Welcome
    show_welcome_message()

    # Step 2: Bot creation choice
    choice = ask_user("Personal or team bot?", options=[
        "Personal (just me)",
        "Team (multiple users)",
        "Skip for now"
    ])

    if choice == "Skip":
        return  # Exit setup, user can re-trigger later

    # Step 3: Telegram bot token
    token = ask_user_for_secret(
        "Create bot with @BotFather, copy token:",
        validate=lambda x: re.match(r'^\d+:[A-Za-z0-9_-]+$', x)
    )

    # Step 4: User ID
    user_id = ask_user_for_input(
        "Find your ID at @userinfobot, paste it:",
        validate=lambda x: x.isdigit()
    )

    # Step 5: OpenAI key (optional)
    openai_key = ask_user_for_secret(
        "OpenAI key for voice (optional, press Enter to skip):",
        required=False
    )

    # Step 6: Create .env
    create_env_file({
        "TELEGRAM_BOT_TOKEN": token,
        "TELEGRAM_ALLOWED_USERS": user_id,
        "OPENAI_API_KEY": openai_key,
    })

    # Step 7: Install dependencies
    run("bun install")

    # Step 8: Start bot
    start_bot()

    # Step 9: Verify bot works
    if test_telegram_connection(token):
        show_success("Bot is running!")
    else:
        show_error("Bot failed to start. Check logs.")
        return

    # Step 10: Offer SubTurtle spawn
    if ask_user("Create your first SubTurtle?", yes_no=True):
        spawn_first_subturtle()

def spawn_first_subturtle():
    project_desc = ask_user("What's your first project?")

    run(f"""
        ./super_turtle/subturtle/ctl spawn my-first-project \
            --type yolo \
            --timeout 1h \
            --cron-interval 5m \
            --state-file - << 'EOF'
# Current Task

Work on: {project_desc}

# End Goal

Deliver a working solution that meets the requirements.

# Backlog

- [ ] Plan the implementation <- current
- [ ] Implement the solution
- [ ] Test and verify
- [ ] Commit and report

EOF
    """)

    show_success("SubTurtle spawned! Check /logs to see progress.")
```

### 9.2 .env Template with Comments

See `super_turtle/claude-telegram-bot/.env.example` for the authoritative template.

### 9.3 Error Messages & Recovery

```python
ERRORS = {
    "TOKEN_INVALID_FORMAT": (
        "That doesn't look like a valid Telegram token. "
        "It should be a number, colon, then a long string. "
        "Let's try again."
    ),
    "BOT_WONT_CONNECT": (
        "I can't connect to Telegram. "
        "This usually means the token is invalid. "
        "Let me guide you through getting a new one."
    ),
    "BUN_NOT_FOUND": (
        "I need Bun to run the bot. "
        "Let me install it for you... (this may take a minute)"
    ),
    "PYTHON_VERSION_OLD": (
        "You have Python 3.9, but I need 3.11+. "
        "See install instructions at python.org"
    ),
}
```

---

## 10. References

- **Repository:** https://github.com/...agentic
- **Root README:** `/README.md`
- **Bot Details:** `super_turtle/claude-telegram-bot/README.md`
- **SubTurtle Docs:** `super_turtle/subturtle/README.md`
- **Project Kickoff Runbook:** `docs/NEXT_PROJECT_KICKOFF_RUNBOOK.md`
- **Telegram Bot API:** https://core.telegram.org/bots
- **Claude Code:** https://claude.com/product/claude-code

---

**End of PRD**
