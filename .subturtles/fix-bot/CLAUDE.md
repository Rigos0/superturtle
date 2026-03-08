# Current task
Fix Codex#3 in `super_turtle/claude-telegram-bot/src/session.ts` and `super_turtle/claude-telegram-bot/src/codex-session.ts`: await the non-awaited `Bun.write(...)` session/preference persistence calls so write failures are caught.

# End goal with specs
Fix 5 straightforward issues in `super_turtle/claude-telegram-bot/src/`. Each fix = one commit.

# Roadmap (Completed)
- Nothing yet

# Roadmap (Upcoming)
- Quick-win bot bug fixes from code review

# Backlog
- [x] Fix #1: voice.ts line 88 — add `session.typingController = typing;` after typing starts, and `session.typingController = null;` in the finally block after `typing.stop()`. This lets stop commands kill the typing indicator during voice processing.
- [x] Fix #2: formatting.ts line 112 — change `replace(/#/g, "")` to `replace(/^#+\s*/, "")` so only leading markdown headers are stripped from blockquotes, not ALL hash characters (which breaks URLs with fragments).
- [x] Fix #6: streaming.ts line 27 — remove unused `PINO_LOG_PATH` from the import. Keep `streamLog`.
- [x] Fix #5+#8: text.ts — remove the duplicate `buildStallRecoveryPrompt` and `buildSpawnOrchestrationRecoveryPrompt` functions (lines ~58-79) AND remove the redundant retry loop in the text handler (lines ~209-388 retry wrapper). The driver-routing.ts already handles retries. The text handler should just call `runMessageWithActiveDriver()` once without its own retry wrapper.
- [ ] Fix Codex#3: session.ts and codex-session.ts — find all `Bun.write(...)` calls for session/preference persistence that are NOT awaited inside try/catch blocks. Add `await` to each one so write failures are caught instead of becoming unhandled rejections. <- current
