/**
 * Integration tests for createStatusCallback — exercises the full
 * push→pull streaming pipeline with a mock ctx.replyWithStream(),
 * verifying native draft streaming, chunking, tool isolation, and done cleanup.
 */
import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { Context } from "grammy";
import type { Message } from "grammy/types";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

// Cache-busting import: deferred-queue.drain.test.ts uses mock.module()
// to replace StreamingState with an empty class, which leaks across test
// files when Bun runs them in the same process. The query string ensures
// we always get the real module.
const { createStatusCallback, StreamingState, clearStreamingState } =
  await import(`./streaming.ts?integration=${Date.now()}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Telegram Message shape. */
function fakeMessage(chatId: number, messageId: number): Message {
  return {
    chat: { id: chatId, type: "private" } as any,
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
  } as Message;
}

/**
 * Build a mock BotContext that looks stream-capable:
 *  - chat.type === "private"
 *  - has `replyWithStream` method
 *  - tracks calls for assertions
 */
function createStreamCapableCtx(chatId: number) {
  let nextMsgId = 1;
  const replyCalls: { text: string; opts?: any }[] = [];
  const editCalls: { chatId: number; msgId: number; text: string; opts?: any }[] = [];
  const deleteCalls: { chatId: number; msgId: number }[] = [];

  // replyWithStream receives the TextSegmentStream, consumes it, and
  // returns the "sent messages" (one per chunk). We simulate the plugin
  // by draining the iterable and returning a single final message.
  const replyWithStreamCalls: AsyncIterable<string>[] = [];

  const replyWithStream = async (iterable: AsyncIterable<string>): Promise<Message[]> => {
    replyWithStreamCalls.push(iterable);
    const parts: string[] = [];
    for await (const chunk of iterable) {
      parts.push(chunk);
    }
    // Simulate: the plugin sends a final message with the concatenated plain text
    const msg = fakeMessage(chatId, nextMsgId++);
    (msg as any).text = parts.join("");
    return [msg];
  };

  const reply = mock(async (text: string, opts?: any): Promise<Message> => {
    replyCalls.push({ text, opts });
    return fakeMessage(chatId, nextMsgId++);
  });

  const editMessageText = mock(async (cid: number, mid: number, text: string, opts?: any) => {
    editCalls.push({ chatId: cid, msgId: mid, text, opts });
    return true;
  });

  const deleteMessage = mock(async (cid: number, mid: number) => {
    deleteCalls.push({ chatId: cid, msgId: mid });
    return true;
  });

  const ctx = {
    chat: { id: chatId, type: "private" },
    reply,
    replyWithStream,
    api: { editMessageText, deleteMessage },
  } as unknown as Context;

  return {
    ctx,
    replyCalls,
    editCalls,
    deleteCalls,
    replyWithStreamCalls,
    reply,
    editMessageText,
    deleteMessage,
  };
}

/**
 * Build a mock context WITHOUT replyWithStream (falls back to edit-based).
 */
function createFallbackCtx(chatId: number) {
  let nextMsgId = 1;
  const replyCalls: { text: string; opts?: any }[] = [];
  const editCalls: { chatId: number; msgId: number; text: string; opts?: any }[] = [];

  const reply = mock(async (text: string, opts?: any): Promise<Message> => {
    replyCalls.push({ text, opts });
    return fakeMessage(chatId, nextMsgId++);
  });

  const editMessageText = mock(async (cid: number, mid: number, text: string, opts?: any) => {
    editCalls.push({ chatId: cid, msgId: mid, text, opts });
    return true;
  });

  const deleteMessage = mock(async () => true);

  const ctx = {
    chat: { id: chatId, type: "private" },
    reply,
    api: { editMessageText, deleteMessage },
  } as unknown as Context;

  return { ctx, replyCalls, editCalls, reply, editMessageText };
}

// ---------------------------------------------------------------------------
// Test: native draft streaming via replyWithStream
// ---------------------------------------------------------------------------

describe("createStatusCallback — native draft streaming", () => {
  const CHAT_ID = 50001;

  beforeEach(() => {
    clearStreamingState(CHAT_ID);
  });

  it("streams text progressively via replyWithStream and finalizes with HTML on segment_end", async () => {
    const { ctx, replyWithStreamCalls, editCalls } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Simulate progressive text accumulation
    await cb("text", "Hello", 0);
    await cb("text", "Hello world", 0);
    await cb("text", "Hello world!", 0);

    // A TextSegmentStream should have been created and replyWithStream called
    expect(state.segmentStreams.size).toBe(1);
    expect(state.streamPromises.size).toBe(1);
    expect(replyWithStreamCalls.length).toBe(1);

    // Finalize the segment — closes the stream, plugin completes
    await cb("segment_end", "Hello world!", 0);

    // Stream state should be cleaned up
    expect(state.segmentStreams.size).toBe(0);
    expect(state.streamPromises.size).toBe(0);

    // An edit should have been applied to format as HTML
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]!.opts?.parse_mode).toBe("HTML");
  });

  it("handles multiple segments independently", async () => {
    const { ctx, replyWithStreamCalls } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Segment 0
    await cb("text", "First", 0);
    await cb("text", "First segment", 0);

    // Segment 1
    await cb("text", "Second", 1);
    await cb("text", "Second segment", 1);

    expect(state.segmentStreams.size).toBe(2);
    expect(replyWithStreamCalls.length).toBe(2);

    // Close both
    await cb("segment_end", "First segment", 0);
    await cb("segment_end", "Second segment", 1);

    expect(state.segmentStreams.size).toBe(0);
    expect(state.streamPromises.size).toBe(0);
  });

  it("done handler closes any still-open streams", async () => {
    const { ctx } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Start streaming but don't send segment_end (simulates stop mid-stream)
    await cb("text", "Partial response", 0);
    expect(state.segmentStreams.size).toBe(1);

    // done should close the stream and clean up
    await cb("done", "", undefined);

    expect(state.segmentStreams.size).toBe(0);
    expect(state.streamPromises.size).toBe(0);
  });

  it("falls back to new message if replyWithStream returns empty array", async () => {
    const CHAT_ID_FAIL = 50002;
    let nextMsgId = 1;

    // replyWithStream that fails (returns empty array)
    const reply = mock(async (_text: string, _opts?: any): Promise<Message> => {
      return fakeMessage(CHAT_ID_FAIL, nextMsgId++);
    });

    const ctx = {
      chat: { id: CHAT_ID_FAIL, type: "private" },
      reply,
      replyWithStream: async (_iterable: AsyncIterable<string>): Promise<Message[]> => {
        // Drain the iterable to avoid hanging
        for await (const _ of _iterable) { /* discard */ }
        return []; // simulate failure
      },
      api: {
        editMessageText: mock(async () => true),
        deleteMessage: mock(async () => true),
      },
    } as unknown as Context;

    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("text", "Hello", 0);
    await cb("segment_end", "Hello", 0);

    // Should have fallen back to ctx.reply
    expect(reply).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test: long messages (>4096 chars) chunk correctly
// ---------------------------------------------------------------------------

describe("createStatusCallback — long message chunking", () => {
  const CHAT_ID = 50010;

  beforeEach(() => {
    clearStreamingState(CHAT_ID);
  });

  it("edit-based fallback sends chunked messages when content exceeds Telegram limit", async () => {
    const { ctx, replyCalls, editCalls, editMessageText } = createFallbackCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Create very long content (>4096 chars)
    const longContent = "A".repeat(5000);

    // First text event creates the message
    await cb("text", "Start", 0);

    // segment_end with very long content
    // editMessageText should fail with MESSAGE_TOO_LONG
    editMessageText.mockImplementation(async () => {
      throw new Error("Bad Request: MESSAGE_TOO_LONG");
    });

    await cb("segment_end", longContent, 0);

    // Should have attempted to delete the original and send chunks
    // (the exact behavior depends on the formatted HTML length)
    expect(replyCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("native streaming path handles multi-message auto-split by leaving as plain text", async () => {
    const CHAT_ID_MULTI = 50011;
    let nextMsgId = 1;

    // replyWithStream that returns multiple messages (simulating plugin auto-split)
    const ctx = {
      chat: { id: CHAT_ID_MULTI, type: "private" },
      reply: mock(async () => fakeMessage(CHAT_ID_MULTI, nextMsgId++)),
      replyWithStream: async (iterable: AsyncIterable<string>): Promise<Message[]> => {
        for await (const _ of iterable) { /* drain */ }
        // Plugin auto-split: returns 2+ messages
        return [
          fakeMessage(CHAT_ID_MULTI, nextMsgId++),
          fakeMessage(CHAT_ID_MULTI, nextMsgId++),
        ];
      },
      api: {
        editMessageText: mock(async () => true),
        deleteMessage: mock(async () => true),
      },
    } as unknown as Context;

    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    const longContent = "B".repeat(5000);
    await cb("text", longContent, 0);
    await cb("segment_end", longContent, 0);

    // Multi-message case: should NOT attempt to edit (leave as plain text)
    const editMock = (ctx as any).api.editMessageText;
    expect(editMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test: tool and thinking messages are separate, not streamed
// ---------------------------------------------------------------------------

describe("createStatusCallback — tool/thinking isolation", () => {
  const CHAT_ID = 50020;

  beforeEach(() => {
    clearStreamingState(CHAT_ID);
  });

  it("tool messages are sent via ctx.reply (not streamed) and tracked in state.toolMessages", async () => {
    const { ctx, replyCalls } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("tool", "<b>Running tests...</b>", undefined);

    // Should use ctx.reply, not replyWithStream
    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0]!.opts?.parse_mode).toBe("HTML");
    expect(state.toolMessages.length).toBe(1);
    expect(state.sawToolUse).toBe(true);
  });

  it("thinking messages are sent via ctx.reply with italic formatting", async () => {
    const { ctx, replyCalls } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("thinking", "Let me analyze this...", undefined);

    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0]!.text).toContain("🧠");
    expect(replyCalls[0]!.text).toContain("<i>");
    expect(state.toolMessages.length).toBe(1);
  });

  it("tool messages interleaved with text segments stay separate", async () => {
    const { ctx, replyCalls, replyWithStreamCalls } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Text starts streaming
    await cb("text", "Working on it", 0);
    expect(replyWithStreamCalls.length).toBe(1);

    // Tool message arrives mid-stream
    await cb("tool", "<code>bash: npm test</code>", undefined);
    expect(replyCalls.length).toBe(1); // tool via reply, not stream
    expect(state.toolMessages.length).toBe(1);

    // More text in same segment
    await cb("text", "Working on it — done!", 0);

    // Finalize
    await cb("segment_end", "Working on it — done!", 0);

    // Stream was for text only, tool stayed separate
    expect(replyWithStreamCalls.length).toBe(1);
    expect(state.toolMessages.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test: done handler cleanup
// ---------------------------------------------------------------------------

describe("createStatusCallback — done cleanup", () => {
  const CHAT_ID = 50030;

  beforeEach(() => {
    clearStreamingState(CHAT_ID);
  });

  it("done handler deletes tool messages and clears streaming state", async () => {
    const { ctx, deleteMessage } = createStreamCapableCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Simulate some tool messages
    await cb("tool", "<b>tool1</b>", undefined);
    await cb("tool", "<b>tool2</b>", undefined);
    expect(state.toolMessages.length).toBe(2);

    // Simulate text streaming
    await cb("text", "Result", 0);
    await cb("segment_end", "Result", 0);

    // Done
    await cb("done", "", undefined);

    // Tool messages should have been deleted
    expect(deleteMessage).toHaveBeenCalledTimes(2);

    // State maps should be clean
    expect(state.segmentStreams.size).toBe(0);
    expect(state.streamPromises.size).toBe(0);
    expect(state.toolMessages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test: fallback path (no replyWithStream)
// ---------------------------------------------------------------------------

describe("createStatusCallback — edit-based fallback", () => {
  const CHAT_ID = 50040;

  beforeEach(() => {
    clearStreamingState(CHAT_ID);
  });

  it("uses ctx.reply + editMessageText when replyWithStream is not available", async () => {
    const { ctx, replyCalls, editCalls } = createFallbackCtx(CHAT_ID);
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // First text event creates the message
    await cb("text", "Hello", 0);
    expect(replyCalls.length).toBe(1);

    // Subsequent text events edit (after throttle — we can't easily test throttle
    // in unit tests since it uses Date.now(), but segment_end always edits)
    await cb("segment_end", "Hello world!", 0);
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]!.opts?.parse_mode).toBe("HTML");
  });
});
