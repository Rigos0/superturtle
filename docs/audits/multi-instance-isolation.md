# Multi-Instance Isolation Audit (Super Turtle)

Date: 2026-03-03  
Scope: Running multiple Super Turtle bot instances on the same machine (e.g., dev + prod, or two bots with different `TELEGRAM_BOT_TOKEN`s).

This audit catalogs all currently-shared resources (mostly under `/tmp`) that can collide across instances, describes collision scenarios, and proposes a token-prefix namespacing design to make multi-instance operation safe by default.

---

## 1) Collision Point Catalog

Every row includes: resource name, exact file path + line number(s), whether an env override exists today, and the collision type:

- **data corruption** — different instances overwrite shared state/files
- **wrong-routing** — instance A reads instance B’s IPC/state and responds in the wrong chat/process
- **startup failure** — port/tmux/name collisions prevent a second instance from starting
- **log interleaving** — logs for multiple instances mix, breaking debuggability and any tooling that tails/parses logs

### Category A — `/tmp` data files (6 items)

| Resource | File:Line | Env override? | Collision type | Notes |
|---|---|---:|---|---|
| `/tmp/claude-telegram-session.json` | `super_turtle/claude-telegram-bot/src/config.ts:379` | No | wrong-routing, data corruption | `/resume` can load another bot’s session; last-write-wins session persistence. |
| `/tmp/claude-telegram-prefs.json` | `super_turtle/claude-telegram-bot/src/session.ts:133`, `super_turtle/setup:29` | No | wrong-routing | Model/effort/driver prefs shared across bots; setup writes this path too. |
| `/tmp/superturtle-mcp-config.json` | `super_turtle/claude-telegram-bot/src/session.ts:61` | No | wrong-routing | Last-write-wins; a bot can load the wrong MCP server list/config. |
| `/tmp/claude-telegram-restart.json` | `super_turtle/claude-telegram-bot/src/config.ts:380` | No | wrong-routing, startup failure | Restart state can bleed between instances (unexpected restart/cleanup behavior). |
| `/tmp/telegram-bot` (directory) | `super_turtle/claude-telegram-bot/src/config.ts:381` | No | data corruption | Media downloads can collide (same filenames; mixed content). |
| `/tmp/codex-telegram-prefs.json` + `/tmp/codex-telegram-session.json` | `super_turtle/claude-telegram-bot/src/codex-session.ts:24-25` | No | wrong-routing, data corruption | Same preference/session bleed as Claude driver, but for Codex. |

### Category B — Log files (3 items)

| Resource | File:Line | Env override? | Collision type | Notes |
|---|---|---:|---|---|
| `/tmp/claude-telegram-bot.log.jsonl` | `super_turtle/claude-telegram-bot/src/logger.ts:3` | No | log interleaving | Pino JSONL file mixes across instances; also used for `/pinologs` tooling. |
| `/tmp/claude-telegram-bot-ts.log` | `super_turtle/claude-telegram-bot/src/handlers/commands.ts:35`, `super_turtle/claude-telegram-bot/live.sh:8` | Partial (`SUPERTURTLE_LOOP_LOG_PATH`) | log interleaving | `live.sh` honors `SUPERTURTLE_LOOP_LOG_PATH`, but code paths still assume the canonical default for `/looplogs`. |
| `/tmp/claude-telegram-audit.log` | `super_turtle/claude-telegram-bot/src/config.ts:360` | Yes (`AUDIT_LOG_PATH`) | log interleaving | Already isolatable via env var; defaults still collide. |

### Category C — MCP IPC files (4 glob-scanned patterns)

These use bare `/tmp/` globs with no ownership filtering. Instance A can pick up instance B’s MCP requests and send stickers/buttons or execute bot-control actions in the wrong chat.

| Resource pattern | File:Line | Env override? | Collision type | Notes |
|---|---|---:|---|---|
| `/tmp/ask-user-*.json` | Scan: `super_turtle/claude-telegram-bot/src/handlers/streaming.ts:87,90-91`; Write: `super_turtle/claude-telegram-bot/bot_control_mcp/server.ts:222` | No | wrong-routing | The bot scans `/tmp` for `ask-user-*.json` and sends inline keyboards when `status === "pending"`. |
| `/tmp/send-turtle-*.json` | Scan: `super_turtle/claude-telegram-bot/src/handlers/streaming.ts:131,134-135`; Write: `super_turtle/claude-telegram-bot/send_turtle_mcp/server.ts:185` | No | wrong-routing | Stickers/photos can be sent by the wrong instance. |
| `/tmp/bot-control-*.json` | Scan: `super_turtle/claude-telegram-bot/src/handlers/streaming.ts:189,192-193`; Write: `super_turtle/claude-telegram-bot/bot_control_mcp/server.ts:310` | No | wrong-routing | Bot-control actions can be executed by the wrong instance. |
| `/tmp/pino-logs-*.json` | Scan: `super_turtle/claude-telegram-bot/src/handlers/streaming.ts:316,319-320`; Write: `super_turtle/claude-telegram-bot/bot_control_mcp/server.ts:272`; Callback-side write: `super_turtle/claude-telegram-bot/src/handlers/callback.ts:743` | No | wrong-routing | One instance may fulfill another instance’s log request, leaking logs across bots/chats. |

Related consumer (callback handler): the ask-user callback reads from a fixed `/tmp` path:

- `/tmp/ask-user-{requestId}.json` — `super_turtle/claude-telegram-bot/src/handlers/callback.ts:355`

### Category D — Ports (1 item)

| Resource | File:Line | Env override? | Collision type | Notes |
|---|---|---:|---|---|
| Dashboard port `4173` | `super_turtle/claude-telegram-bot/src/config.ts:346` | Yes (`DASHBOARD_PORT`) | startup failure | Two instances default to the same port and one fails to bind. |

### Category E — Tmux session names (2 items)

| Resource | File:Line | Env override? | Collision type | Notes |
|---|---|---:|---|---|
| `tmux` session `superturtle` | `super_turtle/bin/superturtle.js:21` | No | startup failure, wrong-routing | Two `superturtle start` invocations collide; the second can attach/control the first. |
| `tmux` session `superturtle-bot` | `super_turtle/claude-telegram-bot/live.sh:6` | Yes (`SUPERTURTLE_TMUX_SESSION`) | startup failure, wrong-routing | Already isolatable via env var. |

### Category F — LaunchAgent plist (2 items)

| Resource | File:Line | Env override? | Collision type | Notes |
|---|---|---:|---|---|
| `/tmp/claude-telegram-bot.log` | `super_turtle/claude-telegram-bot/launchagent/com.claude-telegram-ts.plist.template:72` | No | log interleaving | Two LaunchAgents (or two tokens) would share stdout log path. |
| `/tmp/claude-telegram-bot.err` | `super_turtle/claude-telegram-bot/launchagent/com.claude-telegram-ts.plist.template:74` | No | log interleaving | Same for stderr. |

---

## 2) Current Workarounds (Partial Isolation Only)

Env vars that already provide some isolation:

- `SUPERTURTLE_TMUX_SESSION` — isolates `live.sh` tmux session name (`super_turtle/claude-telegram-bot/live.sh:6`)
- `SUPERTURTLE_LOOP_LOG_PATH` — isolates main loop log path used by `live.sh` (`super_turtle/claude-telegram-bot/live.sh:8`)
- `DASHBOARD_PORT` — isolates dashboard port (`super_turtle/claude-telegram-bot/src/config.ts:346`)
- `AUDIT_LOG_PATH` — isolates audit log file (`super_turtle/claude-telegram-bot/src/config.ts:360`)
- `CLAUDE_WORKING_DIR` — isolates working-directory-scoped state for SubTurtles and agent workspace; already used broadly (`super_turtle/claude-telegram-bot/src/config.ts:61`, `super_turtle/bin/superturtle.js:170`)

Important notes:

- Coverage is incomplete: most `/tmp` paths above have **no env override**, and **all MCP IPC globs** are currently un-namespaced.
- The instance lock file is the **only** current `/tmp` path that already uses the token-prefix pattern:
  - `/tmp/claude-telegram-bot.{tokenPrefix}.instance.lock` — `super_turtle/claude-telegram-bot/src/index.ts:81-82`

---

## 3) Proposed Fix: Token-Prefix Namespacing

### Scheme

Derive a stable per-bot namespace from the Telegram bot token:

- `TOKEN_PREFIX = TELEGRAM_BOT_TOKEN.split(":")[0]`

This is already computed in `super_turtle/claude-telegram-bot/src/index.ts:81`. The proposal is to extract it into a shared export in `super_turtle/claude-telegram-bot/src/config.ts` so every module can reference the same value without re-deriving it.

### Apply the namespace to every shared `/tmp` resource

Examples (illustrative, not yet implemented):

- Data files:
  - `/tmp/claude-telegram-{tokenPrefix}-session.json`
  - `/tmp/claude-telegram-{tokenPrefix}-prefs.json`
  - `/tmp/superturtle-{tokenPrefix}-mcp-config.json`
  - `/tmp/claude-telegram-{tokenPrefix}-restart.json`
  - `/tmp/codex-telegram-{tokenPrefix}-prefs.json`
  - `/tmp/codex-telegram-{tokenPrefix}-session.json`
- Log files:
  - `/tmp/claude-telegram-bot.{tokenPrefix}.log.jsonl`
  - `/tmp/claude-telegram-bot-ts.{tokenPrefix}.log`
  - `/tmp/claude-telegram-audit.{tokenPrefix}.log` (or keep env override + apply default namespacing)
- Media dir:
  - `/tmp/telegram-bot-{tokenPrefix}/`

### MCP IPC fix (highest impact)

Problem today:

- MCP servers write request files directly into `/tmp/*.json`.
- The bot scans `/tmp` with globs like `ask-user-*.json` (`super_turtle/claude-telegram-bot/src/handlers/streaming.ts:87+`) and processes any pending file that matches the chat id. There is no instance ownership boundary, so cross-instance pickup is possible.

Proposed design:

1. Create a per-instance IPC directory on startup: `/tmp/superturtle-{tokenPrefix}/`
2. Update **all MCP servers** to write their request files into that directory:
   - `/tmp/superturtle-{tokenPrefix}/ask-user-*.json`
   - `/tmp/superturtle-{tokenPrefix}/send-turtle-*.json`
   - `/tmp/superturtle-{tokenPrefix}/bot-control-*.json`
   - `/tmp/superturtle-{tokenPrefix}/pino-logs-*.json`
3. Update glob scans in `streaming.ts` to scan only that directory (e.g., `cwd: IPC_DIR` instead of `cwd: "/tmp"`).
4. Update reads/writes in `callback.ts` to use the same IPC directory when referencing `ask-user-{requestId}.json` and `pino-logs-{requestId}.json`.

Why this is highest impact:

- It directly prevents cross-instance **wrong-routing** (stickers/buttons/logs/control actions going to the wrong running bot) even if users accidentally run multiple bots in parallel.

### Tmux session isolation

- Make `super_turtle/bin/superturtle.js` honor `SUPERTURTLE_TMUX_SESSION` (same env var that `live.sh` already supports), defaulting to `superturtle` if unset.

### Plist template isolation

- Add a `TOKEN_PREFIX` placeholder to `super_turtle/claude-telegram-bot/launchagent/com.claude-telegram-ts.plist.template` log paths so multi-instance LaunchAgents don’t share `/tmp/claude-telegram-bot.log` and `.err`.

---

## 4) Prioritized Implementation Plan

### P0 — Data corruption / wrong-routing (do first)

1. Extract `TOKEN_PREFIX` into `super_turtle/claude-telegram-bot/src/config.ts` as a shared export
2. Namespace MCP IPC files into `/tmp/superturtle-{tokenPrefix}/` subdirectory (`super_turtle/claude-telegram-bot/src/handlers/streaming.ts`, `super_turtle/claude-telegram-bot/src/handlers/callback.ts`, all 3 MCP servers)
3. Namespace `superturtle-mcp-config.json` (`super_turtle/claude-telegram-bot/src/session.ts`)
4. Namespace `claude-telegram-prefs.json` and `codex-telegram-prefs.json` (`super_turtle/claude-telegram-bot/src/session.ts`, `super_turtle/claude-telegram-bot/src/codex-session.ts`, `super_turtle/setup`)

### P1 — Session/state bleeding

5. Namespace `claude-telegram-session.json` and `codex-telegram-session.json` (`super_turtle/claude-telegram-bot/src/config.ts`, `super_turtle/claude-telegram-bot/src/codex-session.ts`)
6. Namespace `claude-telegram-restart.json` (`super_turtle/claude-telegram-bot/src/config.ts`)
7. Namespace `telegram-bot/` media directory (`super_turtle/claude-telegram-bot/src/config.ts`)

### P2 — Log interleaving / UX

8. Namespace `claude-telegram-bot.log.jsonl` (`super_turtle/claude-telegram-bot/src/logger.ts`)
9. Namespace `claude-telegram-bot-ts.log` (`super_turtle/claude-telegram-bot/src/handlers/commands.ts`, `super_turtle/claude-telegram-bot/live.sh`)
10. Make `super_turtle/bin/superturtle.js` tmux session name configurable via `SUPERTURTLE_TMUX_SESSION`
11. Add token prefix to plist template log paths

---

## 5) Developer Workflow Guide

### Today (before fixes)

- Running `bun run start` (dev) and `superturtle start` (prod) with different bot tokens:
  - `tmux` can be isolated (if you remember to set `SUPERTURTLE_TMUX_SESSION`), but most `/tmp` files still collide by default.
  - Workaround would require manually setting env vars for every `/tmp` path (most don’t exist today) — impractical.
- Running two `superturtle start` from different project directories:
  - `super_turtle/bin/superturtle.js` hardcodes `TMUX_SESSION = "superturtle"` (`super_turtle/bin/superturtle.js:21`), so the second invocation collides and can attach to the first.
- Safe approach today:
  - Only run one instance at a time, or use separate macOS user accounts/containers/VMs to isolate `/tmp`.

### After fixes

- Different bot tokens → full isolation automatically (token prefix namespaces everything under `/tmp` that matters).
- Same bot token → instance lock prevents double-start (already implemented via `/tmp/claude-telegram-bot.{tokenPrefix}.instance.lock`, `super_turtle/claude-telegram-bot/src/index.ts:81-82`).
- Developer workflow:
  - Maintain separate `.env` files with different `TELEGRAM_BOT_TOKEN` values; everything else is automatic.
  - `CLAUDE_WORKING_DIR` already isolates SubTurtle state; this audit covers the remaining bot-level isolation gaps (MCP IPC, prefs/sessions, logs, tmux defaults).

