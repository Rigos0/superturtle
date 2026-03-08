# Review Findings

## High

### 1. `resumeThread()` never persists the resumed Codex thread ID
- Evidence: `super_turtle/claude-telegram-bot/src/codex-session.ts:939-945`, `super_turtle/claude-telegram-bot/src/codex-session.ts:1065-1070`, `super_turtle/claude-telegram-bot/src/codex-session.ts:1083-1109`
- Impact: `CodexSession` reloads `prefs.threadId` on startup and persists new-thread IDs, but the resume path never updates that file. After `/resume`, a supervised restart can reopen the previously saved thread instead of the thread the operator just resumed.
- Fix: call `saveCodexPrefs()` from `resumeThread()` with the resumed `threadId`, `model`, and `reasoningEffort`.
- Missing coverage: extend `super_turtle/claude-telegram-bot/src/codex-session.test.ts` to assert that `CODEX_PREFS_FILE.threadId` changes when `resumeThread()` succeeds.

## Medium

### 2. Telegram can resume Codex sessions that never received the Telegram bootstrap prompt
- Evidence: `super_turtle/claude-telegram-bot/src/config.ts:261-279`, `super_turtle/claude-telegram-bot/src/codex-session.ts:1105-1106`, `super_turtle/claude-telegram-bot/src/codex-session.ts:1191-1199`, `super_turtle/claude-telegram-bot/src/codex-session.ts:1707-1731`, `super_turtle/claude-telegram-bot/src/handlers/commands.ts:517-520`
- Impact: the bootstrap prompt is now Telegram-only, but `resumeSession()` can source same-directory live sessions from the app-server list and `resumeThread()` always marks the bootstrap as already present. A Codex CLI session created outside Telegram can therefore bypass the Telegram runtime contract on its first resumed turn.
- Fix: track whether the resumed session was previously bootstrapped by Telegram and only skip injection when that provenance exists. Otherwise prepend `CODEX_TELEGRAM_BOOTSTRAP.md` on the first Telegram-owned turn after resume.
- Missing coverage: add a `resumeSession()` test that resumes an app-server session without bootstrap evidence and asserts the first `sendMessage()` still includes the `<system-instructions>` wrapper.

### 3. `/api/context` omits Codex bootstrap prompt health
- Evidence: `super_turtle/claude-telegram-bot/src/config.ts:261-279`, `super_turtle/claude-telegram-bot/src/dashboard-types.ts:224-232`, `super_turtle/claude-telegram-bot/src/dashboard.ts:2365-2382`, `super_turtle/claude-telegram-bot/src/dashboard.test.ts:1455-1476`
- Impact: `config.ts` now loads `CODEX_TELEGRAM_BOOTSTRAP.md`, but the dashboard context response only exposes `META_SHARED.md`. If the Codex bootstrap file is missing or unreadable, operators only get a startup warning log and the main context snapshot still looks healthy.
- Fix: add Codex bootstrap metadata to `ContextResponse` and `/api/context` so dashboard or `/debug` consumers can detect the missing prompt immediately.
- Missing coverage: extend the `/api/context` route test to assert the Codex bootstrap fields are present.

### 4. Failed `ctl spawn --state-file` attempts leave phantom workers in `.subturtles/`
- Evidence: `super_turtle/subturtle/ctl:838-866`, `super_turtle/subturtle/ctl:1145-1203`, `super_turtle/subturtle/tests/test_ctl_integration.sh:578-615`
- Impact: `do_spawn()` writes `.subturtles/<name>/CLAUDE.md` before validation and exits on validation failure without cleanup. `ctl list` treats that leftover directory as a stopped worker, so one invalid spawn pollutes the shared inventory with a worker that never existed.
- Fix: validate before persisting into the worker workspace, or remove the workspace on any pre-start failure path.
- Missing coverage: replace the current assertion on `${ws}/CLAUDE.md` with coverage that a failed spawn leaves no workspace behind and does not appear in `ctl list`.

## Low

### 5. The dashboard visual refresh added untested rendering branches
- Evidence: `super_turtle/claude-telegram-bot/src/dashboard.ts:1215-1252`, `super_turtle/claude-telegram-bot/src/dashboard.ts:1284-1315`, `super_turtle/claude-telegram-bot/src/dashboard.test.ts:654-680`
- Impact: the new session-row truncation, lane-card rendering, milestone state, and turtle-position logic are all driven by client-side JavaScript, but the dashboard suite only checks for static shell markup and script parseability. Regressions in the main observability UI can land without a failing test.
- Fix: add a `/dashboard` route test that injects representative payloads and asserts the emitted HTML or extracted rendering helpers for long titles, partially complete backlogs, zero-backlog lanes, and the toggle text.
- Missing coverage: assert truncated long titles, `lane-card` markup, `lane-milestone done/current` classes, and bounded `lane-turtle` `left:` values.

## Verification

- `bun test super_turtle/claude-telegram-bot/src/codex-session.test.ts` -> `9 pass, 0 fail`
- `bun test super_turtle/claude-telegram-bot/src/dashboard.test.ts` -> `83 pass, 0 fail`
- `bash super_turtle/subturtle/tests/test_ctl_integration.sh` -> `23 pass, 0 fail`
