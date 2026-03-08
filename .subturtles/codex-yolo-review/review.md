# Runtime / Session Review

Ordered by severity.

## High

### 1. Resumed Codex threads are not persisted to prefs, so crash recovery can point back at the wrong session
- File paths: `super_turtle/claude-telegram-bot/src/codex-session.ts`
- Approximate lines: `939-945`, `1065-1070`, `1095-1109`
- Issue: `CodexSession` reloads `prefs.threadId` on startup, and `startNewThread()` overwrites that file, but `resumeThread()` never does. After a `/resume`, a supervised restart can still reload the pre-resume thread id, not the thread that was actually resumed.
- Why it matters: this branch explicitly hardens fatal-restart behavior. In that environment, resuming a Codex session is not durable: after a crash/restart the bot can expose the wrong “current” Codex session and silently continue from stale state instead of the session the operator just resumed.
- Concrete fix: call `saveCodexPrefs()` from `resumeThread()` with the resumed `threadId`, `model`, and `reasoningEffort`, the same way `startNewThread()` persists new threads.
- Missing test: extend `src/codex-session.test.ts` to assert that `CODEX_PREFS_FILE.threadId` is updated when `resumeThread()` succeeds.

## Medium

### 2. Telegram can resume live Codex sessions that never received the new bootstrap prompt
- File paths: `super_turtle/claude-telegram-bot/src/config.ts`, `super_turtle/claude-telegram-bot/src/codex-session.ts`, `super_turtle/claude-telegram-bot/src/handlers/commands.ts`
- Approximate lines: `261-279`, `1095-1106`, `1174-1199`, `1707-1715`, `517-518`
- Issue: the new `CODEX_TELEGRAM_BOOTSTRAP.md` is now a Telegram-only runtime prompt, but `resumeSession()` still allows resuming same-directory live sessions from the app-server list, and `resumeThread()` unconditionally sets `systemPromptPrepended = true`. That suppresses bootstrap injection even when the resumed thread originated outside Telegram and never received those instructions.
- Why it matters: a same-repo Codex CLI session resumed from Telegram can now bypass the Telegram runtime contract entirely on its first post-resume turn. That means SubTurtle spawning/state-file rules can silently disappear exactly in the resume path this change is trying to stabilize.
- Concrete fix: track whether a session was bootstrapped by Telegram (for example via saved-session metadata or transcript artifact detection) and only skip bootstrap on resume when that provenance is present. Otherwise inject the bootstrap prompt on the first Telegram-owned turn after resume.
- Missing test: add a `resumeSession()` case that sources the session from `getSessionListLive()` without transcript bootstrap evidence and assert that the first `sendMessage()` still includes the `<system-instructions>` wrapper.

### 3. Dashboard context snapshots never expose Codex bootstrap prompt health
- File paths: `super_turtle/claude-telegram-bot/src/config.ts`, `super_turtle/claude-telegram-bot/src/dashboard.ts`, `super_turtle/claude-telegram-bot/src/dashboard-types.ts`
- Approximate lines: `261-279`, `2365-2380`, `224-232`
- Issue: `config.ts` now loads `CODEX_TELEGRAM_BOOTSTRAP.md` as a separate runtime dependency, but `/api/context` still reports only `META_SHARED.md`. If the Codex bootstrap file is missing or unreadable, the only signal is the startup warning log; the dashboard/context snapshot has no field that tells an operator whether new Codex threads are actually running with their required bootstrap instructions.
- Why it matters: this branch intentionally moved Telegram-specific Codex behavior out of repo-global instructions. Losing that file is therefore a control-plane failure for every new Codex session, but the main observability surface still looks healthy unless someone digs through startup logs. That is exactly the kind of failure signal the observability work is supposed to surface quickly.
- Concrete fix: extend `ContextResponse` and `/api/context` with Codex bootstrap metadata (`text`, `source`, and/or an explicit loaded boolean), and expose that alongside the existing META prompt state so `/debug` and dashboard consumers can detect the failure immediately.
- Missing test: update the `/api/context` route coverage in `src/dashboard.test.ts` to assert the Codex bootstrap fields are present.

## Verification

- `bun test src/codex-session.test.ts src/session-observability.test.ts src/dashboard.test.ts`
- Result: `98 pass, 0 fail`
