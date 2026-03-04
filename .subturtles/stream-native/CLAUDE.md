## Current Task
Implement TextSegmentStream adapter (push→pull bridge for StatusCallback→AsyncIterable) as the core building block for streaming refactor.

## End Goal with Specs
When the bot streams a response, the user sees a **live draft bubble** (native Telegram typing UX) that progressively grows with text — NOT a message that gets edited every 500ms. The final message is sent via `sendMessage` when the segment is complete.

**Acceptance criteria:**
- `@grammyjs/stream` plugin installed and registered as middleware
- Grammy bumped to `^1.39.0` (stream plugin peer dep)
- `@grammyjs/auto-retry` installed (recommended by plugin docs)
- Text streaming in `createStatusCallback` uses `sendMessageDraft` instead of `editMessageText`
- `segment_end` finalizes with `sendMessage` (the plugin does this)
- Tool messages (`tool`, `thinking`) stay as-is — they're separate ephemeral messages, not streamed
- Silent mode (`createSilentStatusCallback`) unchanged — no Telegram calls
- `done` cleanup unchanged
- Bot types updated with `StreamFlavor`
- Both Claude and Codex drivers work with the new streaming (they both use the same StatusCallback)
- No regressions in chunking (messages >4096 chars still split correctly)

## Architecture Notes

**Current flow (legacy):**
1. StatusCallback receives `"text"` events → `ctx.reply()` to create message → `ctx.api.editMessageText()` to update (throttled 500ms)
2. `"segment_end"` → final `editMessageText` with full formatted content
3. Problem: edits are janky, rate-limited, messages "pop" instead of streaming

**New flow (native drafts):**
1. StatusCallback receives `"text"` events → push text into a per-segment async iterable
2. `@grammyjs/stream` plugin consumes the iterable via `ctx.replyWithStream()`, calling `sendMessageDraft` internally
3. `"segment_end"` → close the iterable, plugin finalizes with `sendMessage`
4. Result: smooth native draft bubble UX

**Bridge pattern (push → pull):**
Each text segment needs an adapter that converts push-based StatusCallback calls into a pull-based AsyncIterable:
```typescript
class TextSegmentStream {
  private chunks: string[] = [];
  private resolve: (() => void) | null = null;
  private done = false;
  
  push(text: string) { ... }
  close() { ... }
  [Symbol.asyncIterator]() { ... }
}
```
When a new segment starts (first `"text"` call with a new segmentId), create a `TextSegmentStream`, start `ctx.replyWithStream(stream)` in the background, and push subsequent text chunks into it. On `"segment_end"`, close the stream → plugin sends final message.

**Key files:**
- `super_turtle/claude-telegram-bot/src/handlers/streaming.ts` — main refactor target (944 lines)
- `super_turtle/claude-telegram-bot/src/bot.ts` — register `stream()` middleware, add `StreamFlavor` to context type
- `super_turtle/claude-telegram-bot/src/types.ts` — may need StreamFlavor in context type
- `super_turtle/claude-telegram-bot/package.json` — deps

**Plugin setup (from docs):**
```typescript
import { autoRetry } from "@grammyjs/auto-retry";
import { stream, type StreamFlavor } from "@grammyjs/stream";

type MyContext = StreamFlavor<Context>;
bot.api.config.use(autoRetry());
bot.use(stream());
```

**Important: Markdown→HTML conversion**
The current code converts markdown to HTML before sending to Telegram. The `@grammyjs/stream` plugin sends plain text via drafts and formats on finalization. We need to understand how the plugin handles formatting — it may accept `MessageDraftPiece` objects with entities. If not, we may need to:
- Stream raw markdown text in drafts (visible as plain text during streaming)
- Convert to HTML only on the final `sendMessage`
This is actually fine UX — ChatGPT does the same (plain text while streaming, formatted on completion).

## Backlog
- [x] Read and understand current streaming.ts architecture fully
- [x] Install deps: bump grammy to ^1.39.0, add @grammyjs/stream, add @grammyjs/auto-retry
- [x] Register stream() middleware in bot.ts + update context types with StreamFlavor
- [ ] Implement TextSegmentStream adapter (push→pull bridge for StatusCallback→AsyncIterable) <- current
- [ ] Refactor createStatusCallback: text/segment_end handling to use replyWithStream via the adapter
- [ ] Keep tool/thinking/done/silent handlers unchanged
- [ ] Test: send a message, verify draft bubble appears and streams progressively
- [ ] Test: verify long messages (>4096) still chunk correctly
- [ ] Test: verify tool status messages still appear as separate ephemeral messages
- [ ] Commit with clear message

## Reference
- Plugin source: https://github.com/grammyjs/stream
- Plugin README: install with `npm i @grammyjs/stream @grammyjs/auto-retry`
- Telegram Bot API 9.5 (March 1, 2026): sendMessageDraft available to all bots
- OpenClaw reference: https://docs.openclaw.ai/channels/telegram
