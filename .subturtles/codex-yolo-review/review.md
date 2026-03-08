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

### 4. Invalid spawn attempts now leak phantom SubTurtles into the shared worker inventory
- File paths: `super_turtle/subturtle/ctl`, `super_turtle/subturtle/tests/test_ctl_integration.sh`
- Approximate lines: `838-865`, `1145-1203`, `578-615`
- Issue: `do_spawn()` now copies the proposed state file into `.subturtles/<name>/CLAUDE.md` before validation, then exits immediately on `validate_spawn_state_file()` failure. That leaves a workspace directory behind even though no process, metadata, or cron job was created. `ctl list` enumerates every directory under `.subturtles/`, so the failed spawn immediately shows up as a stopped SubTurtle with a task summary. The new integration test locks that behavior in by asserting the failed workspace still exists.
- Why it matters: this is an isolation leak across the whole SubTurtle control plane. A bad spawn for one worker name pollutes the global inventory that operators use to inspect all workers, making a non-existent worker indistinguishable from a legitimately stopped one. That undermines process observability and creates false positives in the shared `.subturtles/` namespace.
- Concrete fix: validate the incoming state before persisting it into the target workspace, or remove the workspace on any pre-start failure path (`state` validation, start failure, cron registration failure). `ctl list` should only surface workers that actually reached a managed state.
- Missing test: replace the current assertion on `${ws}/CLAUDE.md` with coverage that `ctl spawn` failure leaves no workspace behind and that `ctl list` does not include the failed worker name.

## Low

### 5. The dashboard visual refresh shipped without assertions for the new session-row and lane rendering branches
- File paths: `super_turtle/claude-telegram-bot/src/dashboard.ts`, `super_turtle/claude-telegram-bot/src/dashboard.test.ts`
- Approximate lines: `805-836`, `1215-1315`, `654-680`
- Issue: the refresh added new client-side behavior for truncating long session titles, constraining the session table layout, and rendering SubTurtle lane cards with milestone state and turtle position. The dashboard suite still stops at checking for a few static container classes and that the inline script parses, so none of the new rendering logic is exercised by automated assertions.
- Why it matters: regressions in the main observability surface can now land silently. A broken `session-link` label, incorrect milestone state, or a lane card that drops the current backlog item would not fail the test suite even though the UI is the primary operator view for these changes.
- Concrete fix: extract the session-row and lane-card formatting into testable helpers or add a `/dashboard` route test that loads mocked API payloads and asserts the emitted HTML for long titles, partially completed backlogs, zero-backlog lanes, and the "Show more sessions" toggle text.
- Missing test: add coverage that asserts the rendered page contains truncated long titles, `lane-card` markup, the expected `lane-milestone done/current` classes, and a bounded `lane-turtle` `left:` style for representative backlog ratios.

## Verification

- `bun test src/codex-session.test.ts src/session-observability.test.ts src/dashboard.test.ts`
- Result when previously run for the runtime findings: `98 pass, 0 fail`
- `bun test super_turtle/claude-telegram-bot/src/dashboard.test.ts super_turtle/claude-telegram-bot/src/codex-session.test.ts`
- Result: `91 pass, 1 fail`; `GET /dashboard/sessions/:driver/:sessionId > renders transcript-backed Codex history and meta prompt evidence without turn logs` timed out after 5s in both suite and isolated reruns, so that coverage is currently not reliable.
- `bash super_turtle/subturtle/claude-md-guard/tests/run.sh`
- Result: `47 pass, 0 fail`
- `bash super_turtle/subturtle/tests/test_ctl_integration.sh`
- Result: `23 pass, 0 fail`
- `bash super_turtle/subturtle/tests/smoke_spawn_status.sh`
- Result: `pass`
- Manual reproduction: `super_turtle/subturtle/ctl spawn review-invalid-<pid> --state-file <invalid.md>` exited non-zero, left `.subturtles/review-invalid-<pid>/CLAUDE.md` on disk, and `super_turtle/subturtle/ctl list` reported that name as a stopped worker.
