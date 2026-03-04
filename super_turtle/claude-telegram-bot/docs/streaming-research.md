# Telegram Streaming Research Notes (Existing Implementation)

This repo already contains a fairly complete Telegram streaming implementation in
`super_turtle/claude-telegram-bot/src/handlers/streaming.ts`, with the Claude CLI
stream reader in `super_turtle/claude-telegram-bot/src/session.ts`.

These notes summarize what exists today, plus an audit of STOP + queued-message
behavior while streaming is active.

## Telegram constraints & handling

- **Message length**: Telegram message text is limited to **4096** characters.
  - `TELEGRAM_MESSAGE_LIMIT=4096`, `TELEGRAM_SAFE_LIMIT=4000`.
  - The safe limit leaves headroom for markup expansion and small suffixes.
- **Formatting**: Primary output uses `parse_mode: "HTML"`, with fallbacks.
  - If HTML parsing fails on `reply`/`editMessageText`, the bot retries in plain text.
- **Edit rate**: Telegram has edit rate constraints; this bot throttles updates to avoid spamming edits.
  - `STREAMING_THROTTLE_MS=500` (≈ 2 edits/sec maximum per segment message).

## Existing streaming pipeline (Claude)

1. Claude CLI is spawned with `--output-format stream-json` in `src/session.ts`.
2. `session.sendMessageStreaming(...)` reads stream-json events and builds response segments.
3. The session emits `statusCallback("text", ...)` updates (throttled), and emits:
   - `statusCallback("thinking", ...)` for thinking blocks,
   - `statusCallback("tool", ...)` for tool-use status,
   - `statusCallback("segment_end", ...)` when a segment closes,
   - `statusCallback("done", "")` on completion / early return.
4. Handlers create a `StreamingState` and pass `createStatusCallback(ctx, state)` from `src/handlers/streaming.ts`.
5. `createStatusCallback(...)`:
   - Sends the **first** message for a segment via `ctx.reply(...)`,
   - Updates the same Telegram message via `ctx.api.editMessageText(...)` on later updates,
   - Deletes the segment message and switches to chunked sends when content exceeds Telegram limits.

## Segment model

- Responses are split into **segments** at tool boundaries:
  - In `session.sendMessageStreaming`, a segment ends when a `tool_use` block is encountered.
  - Each segment gets its own Telegram message (`StreamingState.textMessages` is a `Map<segmentId, Message>`).
- This keeps a single “assistant response” readable even when tools interleave with text.

## Reusable primitives

The streaming stack already exposes reusable building blocks:

- `StreamingState` (tracks segment messages, tool messages, last edit times/content)
- `createStatusCallback()` and `createSilentStatusCallback()`
- `sendChunkedMessages()` (handles long content)
- `formatToolStatus()` (tool status formatting, used upstream in the session)
- `isAskUserPromptMessage()` (prevents deletion of inline-button prompts)

## Timeouts & stall handling

`src/session.ts` enforces stream stall timeouts:

- `CLAUDE_EVENT_STREAM_STALL_TIMEOUT_MS` default: **120s** (120_000ms)
- `CLAUDE_TOOL_ACTIVE_STALL_TIMEOUT_MS` default: **180s** (180_000ms)

When a stall triggers, the process is killed and the partial response is flushed; the caller can choose to retry.

## STOP + deferred queue audit (during active streaming)

### Mid-stream stop (message coherence)

- `handleStop()` calls `stopAllRunningWork(chatId)`, which:
  - stops typing,
  - stops the active driver query,
  - clears queued messages for that chat,
  - stops running SubTurtles.
- The in-flight handler still runs its own `finally` and the session still emits `segment_end`/`done`
  on shutdown, so the last-edited segment message generally ends in a coherent “final partial state”.
- The user receives an explicit `🛑 Stopped.` reply from `handleStop()`.

### Drain suppression timing

- STOP suppresses deferred-queue draining *before* killing the driver to prevent “stop” immediately
  followed by queued messages being processed by handler `finally` blocks.
- **Fix applied**: drain suppression is now **per-chat** (not global), so stopping in one chat doesn’t
  prevent queued work in other chats from draining.

### Tool-status cleanup on stop

- Tool status messages (`StreamingState.toolMessages`) are deleted on `statusCallback("done")`.
- `session.sendMessageStreaming(...)` emits `done` even when a running query is aborted (process kill),
  so tool-status messages should not persist indefinitely.
- For handler-level errors, `handleText()` also attempts tool-message cleanup in its retry/error path.
- Inline-button ask-user prompts are intentionally preserved (they must remain visible until tapped).

### Queue visibility (user feedback while streaming)

- When a driver is already running, incoming messages are enqueued and the user gets an explicit ack:
  `📝 Queued (#N). I will run this once the current answer finishes.`
- The queue is capped at **10** items per chat, with 5s dedupe for identical consecutive messages.
- The “queued” acknowledgment is sent by handlers (not by a `QUEUE_NOTIFICATION` constant).

## Codex driver parity audit

### Streaming callback parity

- Codex uses the same `StatusCallback` signature and event types (`text`, `thinking`, `tool`, `segment_end`, `done`); no intentional divergence.

### Stop behavior gaps fixed

- Clear `stopRequested` after a stop completes (`clearStopRequested()` parity with Claude).
- Add `isRunning` guard to driver `stop()` so STOP is a no-op when nothing is running.
- Add `_isProcessing` lifecycle tracking to cover Codex’s pre-stream initialization window.
- Return `"pending"` from `CodexSession.stop()` when processing but not yet streaming, matching the Claude three-state stop semantics.

### `clearStopRequested()` timing race (pending stops)

- **Race:** if the driver clears `stopRequested` after a `"pending"` stop, it can silently discard STOP during the pre-spawn window (thread creation / MCP init / etc). When the upcoming `sendMessageStreaming()` / `sendMessage()` finally checks `stopRequested`, it may see `false` and proceed to run the query anyway.
- **Fix:** only call `clearStopRequested()` when `stop()` returns `"stopped"` (i.e., we actually killed an active process/stream). For `"pending"`, preserve the flag so the pre-spawn `stopRequested` checks can reliably bail.
- **Why safe:** once the send path reaches the actual spawn/run phase, it already clears `stopRequested = false` (Claude before spawning the CLI subprocess; Codex after creating the abort controller and marking the query as running), so there’s no long-lived stale flag risk.

### Deferred queue

- Deferred queue logic is driver-agnostic (`isAnyDriverRunning()` checks both drivers).
- With `_isProcessing`, Codex now reports `isRunning=true` during initialization, preventing premature drain while a turn is still being set up.

### Codex-unique patterns (intentional)

- Codex uses an MCP completion callback to detect `ask_user` and break out of the event loop when inline buttons are ready.
- Codex keeps a pending “pump loop” during the run, plus a final flush after turn completion, to catch late MCP writes (Codex SDK thread streaming vs Claude CLI subprocess model).

### Typing controller

- Codex has no typing controller; `stopTyping()` in the stop handler is effectively a no-op for Codex today. This is acceptable given Codex’s different runtime path, but could be polished later.
