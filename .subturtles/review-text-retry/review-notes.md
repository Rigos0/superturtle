# Retry Cleanup Review Notes

## Ranked Findings (2026-03-05)

1. **High: retry cleanup leaves orphaned heartbeat timers from failed attempts**
 - `handleText()` retry catch only calls `cleanupToolMessages(ctx, state)` before creating a fresh `StreamingState` and callback (`text.ts:211`, `text.ts:227`), but this cleanup helper does not stop timers (`streaming.ts:696`, `streaming.ts:712`).
 - Heartbeats are started per callback (`streaming.ts:846`, `streaming.ts:854`) and only stopped in `done` handling (`streaming.ts:1031`, `streaming.ts:1032`) or private `stopHeartbeat()` (`streaming.ts:766`), neither of which runs on stall-error retry paths that throw before `done` (`session.ts:865`).
 - Because `activeStreamingStates` is replaced with the new retry state (`streaming.ts:852`), `/stop` cleanup only reaches the latest state (`stop.ts:99`) and cannot reliably stop an orphaned timer from an older state.

2. **Medium: stale-session empty-response check can read prior-turn usage state**
 - Both drivers detect stale sessions with `!response && this.lastUsage && in=0/out=0` (`session.ts:887`, `codex-session.ts:1183`) and set `lastUsage` when usage events arrive (`session.ts:807`, `codex-session.ts:1137`).
 - Neither send path resets `lastUsage` at entry (`session.ts:400`, `codex-session.ts:868`), so empty responses can be classified using previous-turn usage metadata.

3. **Low: ask-user prompt preservation in cleanup is working as intended**
 - Ask-user prompt detection is inline-keyboard based (`streaming.ts:74`), and cleanup skips those messages (`streaming.ts:698`).
 - Regression coverage confirms skip behavior (`streaming.test.ts:285`), and callback flow edits the same prompt message on selection (`callback.ts:381`), which matches persistence expectations.

4. **Low: retry loop is bounded and cleanup is largely idempotent**
 - Retry budget is fixed at one retry (`text.ts:193`, `text.ts:195`), and stale-session retry reinitializes streaming state/callback (`text.ts:227`).
 - Cleanup is called from both retry catch and `done` paths (`text.ts:211`, `streaming.ts:1036`), and helper-side list reset (`streaming.ts:712`) prevents repeated delete loops on the same state object.

## 2026-03-05 - Item 1: handleText() flow vs old inline cleanup

### Summary
- `handleText()` now calls `cleanupToolMessages(ctx, state)` at the top of the retry catch path before retry classification in [text.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/text.ts:208).
- Previous behavior (pre-`282273c`) performed an inline loop in `text.ts` with the same delete intent (delete tool messages, skip ask-user prompt messages, ignore cleanup failures).

### Old vs New Behavior Delta
1. Deletion intent is preserved:
 - Old inline logic skipped ask-user prompt messages via `isAskUserPromptMessage` and deleted all other `state.toolMessages`.
 - New helper does the same skip/delete in [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:696).
2. Error handling changed:
 - Old inline logic swallowed all delete errors.
 - New helper suppresses known benign delete failures but logs unexpected ones in debug.
3. State mutation changed:
 - New helper explicitly clears `state.toolMessages` and `state.heartbeatMessage` after cleanup in [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:712).
 - Old inline logic did not clear these fields.

### Initial Risk Readout
- No retry-control-flow regression found in this slice: retry gating branches still run after cleanup with the same decision order.
- Behavior is stricter about in-memory cleanup state and observability, with equivalent user-facing delete/skip semantics for this path.

## 2026-03-05 - Item 2: Does cleanup delete persistent ask-user prompts?

### Verification
1. Ask-user prompts are identified by inline keyboard presence in `isAskUserPromptMessage()` at [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:74).
2. `cleanupToolMessages()` explicitly skips those messages before delete calls at [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:696).
3. Regression test coverage exists and passes for the skip behavior at [streaming.test.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.test.ts:285).
4. Ask-user lifecycle confirms persistence-until-selection semantics: callback path edits the same prompt message on selection rather than assuming pre-deletion at [callback.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/callback.ts:381).

### Conclusion
- No evidence that `cleanupToolMessages()` deletes ask-user prompt messages that should persist.
- Confirmed by direct code path inspection and targeted test execution (`bun test ... -t "cleanupToolMessages"`: 3/3 pass).

### Residual Note
- The preservation heuristic is broader than ask-user specifically (it preserves any inline-keyboard tool message). This is likely intentional but should be kept in mind when auditing non-ask-user inline controls.

## 2026-03-05 - Item 3: Idempotency across repeated retries and stale sessions

### Verification
1. Retry budget is bounded and deterministic: `handleText()` allows one retry (`MAX_RETRIES = 1`) and uses the same request payload unless it intentionally switches to a recovery prompt for stall cases at [text.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/text.ts:193) and [text.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/text.ts:195).
2. Stale-session retries are explicit and state-resetting: on `Empty response from stale session`, the handler recreates `StreamingState` + callback before retrying, preventing attempt-local state leakage at [text.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/text.ts:215) and [text.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/text.ts:227).
3. Driver-side stale detection clears resumable session identifiers before bubbling the retryable error:
 - Claude clears `sessionId` on empty `in=0 out=0` responses at [session.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/session.ts:887) and [session.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/session.ts:894).
 - Codex clears `threadId` and `thread` for the same condition at [codex-session.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/codex-session.ts:1183) and [codex-session.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/codex-session.ts:1189).
4. Cleanup is idempotent when retries repeat:
 - `handleText()` does catch-path cleanup per failed attempt at [text.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/text.ts:211).
 - status-callback `done` also triggers cleanup at [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:1031).
 - `cleanupToolMessages()` clears `state.toolMessages` after delete attempts, so repeated calls are safe/no-op after first pass at [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:696) and [streaming.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/handlers/streaming.ts:712).
5. Manual probe (`bun --no-env-file -e ...`) confirmed stale behavior is bounded:
 - stale-then-success path ran exactly 2 attempts with same user message and final success.
 - stale-twice path ran exactly 2 attempts and emitted one terminal error reply (`❌ Error: Empty response from stale session`).

### Conclusion
- No duplicate-side-effect regression identified in stale-session retry handling: retries are bounded, stale handles are cleared before retry, and cleanup functions are re-entrant.
- No stale-session-specific automated test currently exists in `text.retry.test.ts` to lock this behavior, so coverage remains indirect via code-path inspection and manual probe.

### Residual Risk
- `lastUsage` is read during stale detection but not reset at the start of each new send for either driver (`session.ts` usage capture at [session.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/session.ts:807), `codex-session.ts` at [codex-session.ts](/Users/Richard.Mladek/Documents/projects/agentic/super_turtle/claude-telegram-bot/src/codex-session.ts:1137)). This can misclassify a later empty response using prior-turn usage state, which is a correctness risk in edge cases.
