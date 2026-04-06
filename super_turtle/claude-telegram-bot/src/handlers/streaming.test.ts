import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import type { Context } from "grammy";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();
process.env.TELEGRAM_PROGRESS_INITIAL_DELAY_MS ||= "0";

const {
  checkPendingAskUserRequests,
  checkPendingBotControlRequests,
  checkPendingPinoLogsRequests,
  checkPendingSendImageRequests,
  checkPendingSendTurtleRequests,
  cleanupToolMessages,
  clearStreamingState,
  createAskUserKeyboard,
  createStatusCallback,
  getStreamingState,
  isAskUserPromptMessage,
  isSpawnOrchestrationToolStatus,
  shouldSendToolStatusMessage,
  StreamingState,
} = await import("./streaming");
const { IPC_DIR } = await import("../config");
mkdirSync(IPC_DIR, { recursive: true });

type StreamingModule = typeof import("./streaming");
type EditMessageTextCall = [number, number, string, Record<string, unknown>?];
type HeartbeatTick = () => void | Promise<void>;

const STREAMING_ASK_USER_PATTERN = "ask-user-streaming-*.json";
const STREAMING_PINO_LOGS_PATTERN = "pino-logs-streaming-*.json";
const STREAMING_BOT_CONTROL_PATTERN = "bot-control-streaming-*.json";

async function cleanupIpcFiles(pattern: string): Promise<void> {
  const glob = new Bun.Glob(pattern);
  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(`${IPC_DIR}/${filename}`);
    } catch {
      // best effort cleanup
    }
  }
}

beforeEach(async () => {
  mock.restore();
  process.env.SUPERTURTLE_IPC_DIR = IPC_DIR;
  process.env.TELEGRAM_PROGRESS_INITIAL_DELAY_MS = "0";
  await cleanupIpcFiles(STREAMING_ASK_USER_PATTERN);
  await cleanupIpcFiles(STREAMING_PINO_LOGS_PATTERN);
  await cleanupIpcFiles(STREAMING_BOT_CONTROL_PATTERN);
});

afterEach(async () => {
  mock.restore();
  await cleanupIpcFiles(STREAMING_ASK_USER_PATTERN);
  await cleanupIpcFiles(STREAMING_PINO_LOGS_PATTERN);
  await cleanupIpcFiles(STREAMING_BOT_CONTROL_PATTERN);
});

async function loadStreamingModuleWithLogLines(lines: string[]): Promise<StreamingModule> {
  const logReader = await import("../log-reader");
  mock.module("../log-reader", () => ({
    ...logReader,
    readPinoLogLines: async () => lines,
  }));

  return import(`./streaming.ts?pino-log-lines=${Date.now()}-${Math.random()}`);
}

async function loadFreshStreamingModule(): Promise<StreamingModule> {
  return import(`./streaming.ts?fresh=${Date.now()}-${Math.random()}`);
}

function getEditMessageTextCalls(mockFn: ReturnType<typeof mock>): EditMessageTextCall[] {
  return mockFn.mock.calls as unknown as EditMessageTextCall[];
}

async function runHeartbeatTick(tick: HeartbeatTick | null): Promise<void> {
  if (tick) {
    await tick();
  }
}

function expectLiveProgressText(
  text: string,
  summary: string
): void {
  expect(text).toBe(summary);
  expect(text).not.toContain("Elapsed ");
}

function expectCompletedProgressText(
  text: string,
  summary: string
): void {
  expect(text).toContain(summary);
  expect(text).toContain("Elapsed ");
}

describe("isAskUserPromptMessage()", () => {
  it("detects messages with inline keyboards", () => {
    const message = {
      reply_markup: {
        inline_keyboard: [[{ text: "Option", callback_data: "askuser:req:0" }]],
      },
    } as any;

    expect(isAskUserPromptMessage(message)).toBe(true);
  });

  it("returns false for regular messages", () => {
    expect(isAskUserPromptMessage({ text: "hello" } as any)).toBe(false);
    expect(
      isAskUserPromptMessage({ reply_markup: { inline_keyboard: [] } } as any)
    ).toBe(false);
  });
});

describe("createAskUserKeyboard()", () => {
  it("builds one row per option for two options", () => {
    const keyboard = createAskUserKeyboard("request-abc", ["Yes", "No"]);
    const inlineKeyboard = (keyboard as any).inline_keyboard;
    const rows = inlineKeyboard.filter((row: unknown[]) => row.length > 0);

    expect(rows).toEqual([
      [{ text: "Yes", callback_data: "askuser:request-abc:0" }],
      [{ text: "No", callback_data: "askuser:request-abc:1" }],
    ]);
  });

  it("builds six callback buttons with askuser:<id>:<index> data", () => {
    const options = ["One", "Two", "Three", "Four", "Five", "Six"];
    const keyboard = createAskUserKeyboard("req-6", options);
    const inlineKeyboard = (keyboard as any).inline_keyboard;
    const rows = inlineKeyboard.filter((row: unknown[]) => row.length > 0);

    expect(rows).toHaveLength(6);
    expect(rows.flat()).toHaveLength(6);

    options.forEach((option, idx) => {
      expect(rows[idx]).toEqual([
        { text: option, callback_data: `askuser:req-6:${idx}` },
      ]);
    });
  });
});

describe("checkPendingAskUserRequests()", () => {
  it("does not deliver pending ask-user request with missing chat_id", async () => {
    const { checkPendingAskUserRequests } = await loadFreshStreamingModule();
    const requestId = `streaming-ask-user-missing-chat-${Date.now()}`;
    const requestFile = `${IPC_DIR}/ask-user-${requestId}.json`;
    await Bun.write(
      requestFile,
      JSON.stringify({
        request_id: requestId,
        question: "Should not send",
        options: ["Yes", "No"],
        status: "pending",
        chat_id: "",
        created_at: new Date().toISOString(),
      })
    );

    const replyMock = mock(async () => ({ message_id: 1 }));
    const ctx = { reply: replyMock } as unknown as Context;
    const handled = await checkPendingAskUserRequests(ctx, 123);

    expect(handled).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
    const updated = JSON.parse(await Bun.file(requestFile).text());
    expect(updated.status).toBe("error");
    expect(String(updated.error)).toContain("Missing chat_id");
  });

  it("expires stale pending ask-user request instead of delivering it", async () => {
    const { checkPendingAskUserRequests } = await loadFreshStreamingModule();
    const requestId = `streaming-ask-user-stale-${Date.now()}`;
    const requestFile = `${IPC_DIR}/ask-user-${requestId}.json`;
    await Bun.write(
      requestFile,
      JSON.stringify({
        request_id: requestId,
        question: "Should be expired",
        options: ["A", "B"],
        status: "pending",
        chat_id: "123",
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })
    );

    const replyMock = mock(async () => ({ message_id: 1 }));
    const ctx = { reply: replyMock } as unknown as Context;
    const handled = await checkPendingAskUserRequests(ctx, 123);

    expect(handled).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
    const updated = JSON.parse(await Bun.file(requestFile).text());
    expect(updated.status).toBe("expired");
    expect(String(updated.error)).toContain("expired");
  });
});

describe("checkPendingSendImageRequests()", () => {
  it("respects a custom SUPERTURTLE_IPC_DIR override for pending image requests", async () => {
    const customIpcDir = `/tmp/streaming-send-image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousIpcDir = process.env.SUPERTURTLE_IPC_DIR;
    mkdirSync(customIpcDir, { recursive: true });
    process.env.SUPERTURTLE_IPC_DIR = customIpcDir;

    try {
      const { checkPendingSendImageRequests } = await loadFreshStreamingModule();
      const requestId = `streaming-send-image-${Date.now()}`;
      const requestFile = `${customIpcDir}/send-image-${requestId}.json`;
      const imagePath = `${customIpcDir}/send-image-${requestId}.png`;

      await Bun.write(imagePath, new Uint8Array([1, 2, 3, 4]));
      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          source: imagePath,
          caption: "Test image",
          status: "pending",
          chat_id: "123",
          created_at: new Date().toISOString(),
        })
      );

      const replyWithPhotoMock = mock(async () => ({ message_id: 1 }));
      const replyMock = mock(async () => ({ message_id: 2 }));
      const ctx = {
        replyWithPhoto: replyWithPhotoMock,
        reply: replyMock,
      } as unknown as Context;

      const handled = await checkPendingSendImageRequests(ctx, 123);

      expect(handled).toBe(true);
      expect(replyWithPhotoMock).toHaveBeenCalledTimes(1);
      expect(replyMock).not.toHaveBeenCalled();

      const updated = JSON.parse(await Bun.file(requestFile).text());
      expect(updated.status).toBe("sent");
      expect(typeof updated.sent_at).toBe("string");
    } finally {
      process.env.SUPERTURTLE_IPC_DIR = previousIpcDir || IPC_DIR;
      rmSync(customIpcDir, { recursive: true, force: true });
    }
  });
});

describe("pending media request locking", () => {
  it("prevents duplicate send_turtle delivery when pollers race on the same request", async () => {
    const { checkPendingSendTurtleRequests } = await loadFreshStreamingModule();
    const customIpcDir = `/tmp/streaming-send-turtle-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousIpcDir = process.env.SUPERTURTLE_IPC_DIR;
    mkdirSync(customIpcDir, { recursive: true });
    process.env.SUPERTURTLE_IPC_DIR = customIpcDir;

    const originalFetch = globalThis.fetch;
    let releaseStickerSend!: () => void;
    const stickerSendStarted = new Promise<void>((resolve) => {
      releaseStickerSend = resolve;
    });

    globalThis.fetch = mock(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    ) as unknown as typeof fetch;

    try {
      const requestId = `streaming-send-turtle-lock-${Date.now()}`;
      const requestFile = `${customIpcDir}/send-turtle-${requestId}.json`;
      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          url: "https://example.com/turtle.webp",
          status: "pending",
          chat_id: "777",
          created_at: new Date().toISOString(),
        })
      );

      let stickerCalls = 0;
      const replyWithStickerMock = mock(async () => {
        stickerCalls += 1;
        if (stickerCalls === 1) {
          await stickerSendStarted;
        }
        return {
          chat: { id: 777 },
          message_id: stickerCalls,
          sticker: { file_id: "sticker-file-id" },
        };
      });

      const ctx = {
        chat: { id: 777 },
        replyWithSticker: replyWithStickerMock,
        reply: mock(async () => ({ chat: { id: 777 }, message_id: 99 })),
      } as unknown as Context;

      const first = checkPendingSendTurtleRequests(ctx, 777);
      await Promise.resolve();
      const second = checkPendingSendTurtleRequests(ctx, 777);
      releaseStickerSend();

      const [firstHandled, secondHandled] = await Promise.all([first, second]);

      expect(stickerCalls).toBe(1);
      expect([firstHandled, secondHandled].filter(Boolean)).toHaveLength(1);

      const updated = JSON.parse(await Bun.file(requestFile).text());
      expect(updated.status).toBe("sent");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SUPERTURTLE_IPC_DIR = previousIpcDir || IPC_DIR;
      rmSync(customIpcDir, { recursive: true, force: true });
    }
  });
});

describe("checkPendingPinoLogsRequests()", () => {
  it("filters by minimum level and returns formatted entries", async () => {
    const logLines = [
      JSON.stringify({ level: 30, time: 1710000000000, module: "bot", msg: "hello" }),
      JSON.stringify({
        level: 50,
        time: 1710000005000,
        module: "claude",
        msg: "processing failed",
        err: { message: "boom" },
      }),
      JSON.stringify({ level: 40, time: 1710000010000, module: "streaming", msg: "warned" }),
    ];

    const { checkPendingPinoLogsRequests } = await loadStreamingModuleWithLogLines(logLines);
    const requestId = "streaming-pino-logs-test-error";
    const requestFile = `${IPC_DIR}/pino-logs-${requestId}.json`;
    const request = {
      request_id: requestId,
      level: "error",
      limit: 50,
      status: "pending",
      chat_id: "123",
      created_at: new Date().toISOString(),
    };
    await Bun.write(requestFile, JSON.stringify(request, null, 2));

    await checkPendingPinoLogsRequests(123);

    const result = JSON.parse(await Bun.file(requestFile).text());
    expect(result.status).toBe("completed");
    expect(result.result).toContain("ERROR");
    expect(result.result).toContain("[claude]");
    expect(result.result).toContain("processing failed");
    expect(result.result).toContain("(boom)");
    expect(result.result).not.toContain("WARN");
  });

  it("filters by exact levels and module", async () => {
    const logLines = [
      JSON.stringify({ level: 30, time: 1710000100000, module: "bot", msg: "hello" }),
      JSON.stringify({ level: 40, time: 1710000105000, module: "streaming", msg: "warned" }),
      JSON.stringify({ level: 50, time: 1710000110000, module: "streaming", msg: "error" }),
    ];

    const { checkPendingPinoLogsRequests } = await loadStreamingModuleWithLogLines(logLines);
    const requestId = "streaming-pino-logs-test-warn";
    const requestFile = `${IPC_DIR}/pino-logs-${requestId}.json`;
    const request = {
      request_id: requestId,
      levels: ["warn"],
      module: "streaming",
      limit: 10,
      status: "pending",
      chat_id: "123",
      created_at: new Date().toISOString(),
    };
    await Bun.write(requestFile, JSON.stringify(request, null, 2));

    await checkPendingPinoLogsRequests(123);

    const result = JSON.parse(await Bun.file(requestFile).text());
    expect(result.status).toBe("completed");
    expect(result.result).toContain("WARN");
    expect(result.result).toContain("[streaming]");
    expect(result.result).toContain("warned");
    expect(result.result).not.toContain("ERROR");
  });
});

describe("StreamingState lifecycle", () => {
  it("getStreamingState returns undefined before registration and after clear", async () => {
    const streaming = await import(
      `./streaming.ts?lifecycle=${Date.now()}-${Math.random()}`
    );
    const chatId = 999;
    streaming.clearStreamingState(chatId);
    expect(streaming.getStreamingState(chatId)).toBeUndefined();

    const state = new streaming.StreamingState();
    const ctx = { chat: { id: chatId } } as unknown as Context;
    streaming.createStatusCallback(ctx, state);

    expect(streaming.getStreamingState(chatId)).toBe(state);
    streaming.clearStreamingState(chatId);
    expect(streaming.getStreamingState(chatId)).toBeUndefined();
  });
});

describe("cleanupToolMessages()", () => {
  it("deletes tool messages from Telegram via ctx.api.deleteMessage", async () => {
    const state = new StreamingState();
    const deleteMessageMock = mock(async () => {});
    const chatId = 77;

    state.toolMessages = [
      { chat: { id: chatId }, message_id: 1001 } as any,
      { chat: { id: chatId }, message_id: 1002 } as any,
    ];

    const ctx = { api: { deleteMessage: deleteMessageMock } } as unknown as Context;

    await cleanupToolMessages(ctx, state);

    expect(deleteMessageMock).toHaveBeenCalledTimes(2);
    expect(deleteMessageMock).toHaveBeenCalledWith(chatId, 1001);
    expect(deleteMessageMock).toHaveBeenCalledWith(chatId, 1002);
  });

  it("skips deletion for ask-user prompt messages with inline keyboards", async () => {
    const state = new StreamingState();
    const deleteMessageMock = mock(async () => {});
    const chatId = 77;

    state.toolMessages = [
      { chat: { id: chatId }, message_id: 2001 } as any,
      {
        chat: { id: chatId },
        message_id: 2002,
        reply_markup: {
          inline_keyboard: [[{ text: "Option", callback_data: "askuser:req:0" }]],
        },
      } as any,
      { chat: { id: chatId }, message_id: 2003 } as any,
    ];

    const ctx = { api: { deleteMessage: deleteMessageMock } } as unknown as Context;

    await cleanupToolMessages(ctx, state);

    expect(deleteMessageMock).toHaveBeenCalledTimes(2);
    expect(deleteMessageMock).toHaveBeenCalledWith(chatId, 2001);
    expect(deleteMessageMock).toHaveBeenCalledWith(chatId, 2003);
    expect(deleteMessageMock).not.toHaveBeenCalledWith(chatId, 2002);
  });

  it("suppresses benign deleteMessage errors and still clears tool messages", async () => {
    const state = new StreamingState();
    const chatId = 77;
    state.toolMessages = [
      { chat: { id: chatId }, message_id: 3001 } as any,
    ];

    const deleteMessageMock = mock(async () => {
      throw new Error("400: Bad Request: message to delete not found");
    });
    const ctx = { api: { deleteMessage: deleteMessageMock } } as unknown as Context;

    await cleanupToolMessages(ctx, state);

    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
    expect(state.toolMessages.length).toBe(0);
  });
});

describe("tool status visibility", () => {
  it("hides routine tool statuses in quiet mode", () => {
    expect(shouldSendToolStatusMessage("<code>git status</code>", false)).toBe(false);
    expect(shouldSendToolStatusMessage("▶️ <code>npm test</code>", false)).toBe(false);
  });

  it("still shows failure-like tool statuses in quiet mode", () => {
    expect(shouldSendToolStatusMessage("Error: command failed", false)).toBe(true);
    expect(shouldSendToolStatusMessage("BLOCKED: rm target outside allowed paths", false)).toBe(true);
    expect(shouldSendToolStatusMessage("Access denied: /etc/passwd", false)).toBe(true);
    expect(shouldSendToolStatusMessage("🔧 mcp: tool (failed: boom)", false)).toBe(true);
  });

  it("still detects spawn orchestration from hidden tool statuses", () => {
    expect(isSpawnOrchestrationToolStatus("▶️ <code>subturtle/ctl spawn worker-a</code>")).toBe(true);
    expect(isSpawnOrchestrationToolStatus("Spawn SubTurtle worker-a")).toBe(true);
    expect(isSpawnOrchestrationToolStatus("<code>git status</code>")).toBe(false);
  });

  it("can explicitly allow routine tool statuses for debug mode", () => {
    expect(shouldSendToolStatusMessage("<code>git status</code>", true)).toBe(true);
    expect(shouldSendToolStatusMessage("<code>git status</code>", false)).toBe(false);
  });
});

describe("bot-control dynamic import", () => {
  it("imports commands.ts via executeBotControlAction without throwing", async () => {
    const { checkPendingBotControlRequests } = await loadFreshStreamingModule();
    const originalSpawnSync = Bun.spawnSync;
    Bun.spawnSync = ((_cmd: unknown, _opts?: unknown) => {
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const chatId = 12345;
    const requestId = `streaming-bot-control-test-${Date.now()}-${Math.random()}`;
    const requestFile = `${IPC_DIR}/bot-control-${requestId}.json`;
    const request = {
      request_id: requestId,
      action: "usage",
      params: {},
      status: "pending",
      chat_id: String(chatId),
      created_at: new Date().toISOString(),
    };

    try {
      await Bun.write(requestFile, JSON.stringify(request, null, 2));
      const handled = await checkPendingBotControlRequests({} as any, chatId);
      expect(handled).toBe(true);

      const result = JSON.parse(await Bun.file(requestFile).text());
      expect(result.status).toBe("completed");
      expect(result.result).toContain("Failed to fetch usage data");
    } finally {
      Bun.spawnSync = originalSpawnSync;
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(requestFile);
      } catch {
        /* best-effort cleanup */
      }
    }
  }, 20_000);
});

describe("streaming notifications", () => {
  it("skips creating a progress message when a fast single-reply run finishes before the initial delay", async () => {
    process.env.TELEGRAM_PROGRESS_INITIAL_DELAY_MS = "350";
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const replyCalls: Array<{ text: string; extra?: Record<string, unknown> }> = [];
    const deleteMessageMock = mock(async () => {});
    const editMessageTextMock = mock(async () => {});
    let nextMessageId = 1;

    const ctx = {
      chat: { id: 123 },
      reply: mock(async (text: string, extra?: Record<string, unknown>) => {
        replyCalls.push({ text, extra });
        return {
          chat: { id: 123 },
          message_id: nextMessageId++,
        };
      }),
      api: {
        editMessageText: editMessageTextMock,
        deleteMessage: deleteMessageMock,
      },
    } as unknown as Context;

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);
    await state.progressUpdateChain;

    await statusCallback("text", "Hello from Super Turtle", 0);
    await statusCallback("segment_end", "Hello from Super Turtle", 0);
    await statusCallback("done", "");

    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]).toMatchObject({
      text: "Hello from Super Turtle",
      extra: { parse_mode: "HTML" },
    });
    expect(replyCalls[0]?.extra?.disable_notification).toBeUndefined();
    expect(editMessageTextMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it("updates thinking and tool progress in the retained silent message", async () => {
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const replyCalls: Array<{ text: string; extra?: Record<string, unknown> }> = [];
    const deleteMessageMock = mock(async () => {});
    const editMessageTextMock = mock(async () => {});

    const ctx = {
      chat: { id: 456 },
      reply: mock(async (text: string, extra?: Record<string, unknown>) => {
        replyCalls.push({ text, extra });
        return {
          chat: { id: 456 },
          message_id: replyCalls.length,
        };
      }),
      api: {
        deleteMessage: deleteMessageMock,
        editMessageText: editMessageTextMock,
      },
    } as unknown as Context;

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
    await state.progressUpdateChain;

    await statusCallback("thinking", "Planning the answer");
    await statusCallback("tool", "Error: command failed");
    await statusCallback("done", "");

    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]).toMatchObject({
      text: "Planning the answer",
      extra: { disable_notification: true, parse_mode: "HTML" },
    });
    expect(editMessageTextMock).toHaveBeenCalledTimes(2);
    const editCalls = getEditMessageTextCalls(editMessageTextMock);
    expectLiveProgressText(String(editCalls[0]?.[2]), "Error: command failed");
    expectCompletedProgressText(String(editCalls[1]?.[2]), "Reply ready.");
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it("keeps the retained progress message when visible thinking precedes the final reply", async () => {
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const replyCalls: Array<{ text: string; extra?: Record<string, unknown> }> = [];
    const editMessageTextMock = mock(async () => {});

    const ctx = {
      chat: { id: 457 },
      reply: mock(async (text: string, extra?: Record<string, unknown>) => {
        replyCalls.push({ text, extra });
        return {
          chat: { id: 457 },
          message_id: replyCalls.length,
        };
      }),
      api: {
        deleteMessage: mock(async () => {}),
        editMessageText: editMessageTextMock,
      },
    } as unknown as Context;

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
    await state.progressUpdateChain;

    await statusCallback("thinking", "Working through it");
    await statusCallback("segment_end", "Final answer", 0);
    await statusCallback("done", "");

    expect(replyCalls).toHaveLength(2);
    expect(replyCalls[0]).toMatchObject({
      text: "Working through it",
      extra: { disable_notification: true, parse_mode: "HTML" },
    });
    expect(replyCalls[1]).toMatchObject({
      text: "Final answer",
      extra: { parse_mode: "HTML" },
    });
    expect(editMessageTextMock).toHaveBeenCalledTimes(2);
    const editCalls = getEditMessageTextCalls(editMessageTextMock);
    expectLiveProgressText(String(editCalls[0]?.[2]), "Final answer");
    expectCompletedProgressText(String(editCalls[1]?.[2]), "Final answer");
  });

  it("omits pagination controls when retained progress history has only one snapshot", async () => {
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const editMessageTextMock = mock(async () => {});

    const ctx = {
      chat: { id: 458 },
      reply: mock(async () => ({
        chat: { id: 458 },
        message_id: 1,
      })),
      api: {
        deleteMessage: mock(async () => {}),
        editMessageText: editMessageTextMock,
      },
    } as unknown as Context;

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
    await state.progressUpdateChain;

    await statusCallback("thinking", "Working through it");
    await statusCallback("segment_end", "Final answer", 0);
    await statusCallback("done", "");

    expect(state.progressSnapshots).toHaveLength(1);
    expect(state.progressSnapshots[0]?.progressState).toBe("Writing answer");
    expect(state.progressSnapshots[0]?.terminal).toBe(true);
    expect(state.selectedProgressSnapshotIndex).toBe(0);

    const finalEdit = getEditMessageTextCalls(editMessageTextMock).at(-1);
    expect(String(finalEdit?.[2])).toContain("Final answer");
    expect(String(finalEdit?.[2])).toContain("Elapsed ");
    expect(String(finalEdit?.[2])).not.toContain("1 / 1");
    expect((finalEdit?.[3] as any)?.reply_markup).toBeUndefined();
  });

  it("does not send a new silent progress message after teardown completes", async () => {
    const {
      StreamingState,
      createStatusCallback,
      teardownStreamingState,
    } = await loadFreshStreamingModule();
    const replyCalls: Array<{ text: string; extra?: Record<string, unknown> }> = [];

    const ctx = {
      chat: { id: 654 },
      reply: mock(async (text: string, extra?: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        replyCalls.push({ text, extra });
        return {
          chat: { id: 654 },
          message_id: 1,
        };
      }),
      api: {
        editMessageText: mock(async () => {}),
        deleteMessage: mock(async () => {}),
      },
    } as unknown as Context;

    const state = new StreamingState();
    createStatusCallback(ctx, state);
    await teardownStreamingState(ctx, state, {
      chatId: 654,
      clearRegisteredState: true,
    });
    await state.progressUpdateChain;

    expect(replyCalls).toEqual([]);
    expect(state.progressMessage).toBeNull();
  });

  it("enters Still working after 20s of quiet and refreshes at most every 30s", async () => {
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const replyCalls: Array<{ text: string; extra?: Record<string, unknown> }> = [];
    const editMessageTextMock = mock(async () => {});

    const originalDateNow = Date.now;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let fakeNow = 1_700_000_000_000;
    let heartbeatTick: HeartbeatTick | null = null;

    Date.now = () => fakeNow;
    globalThis.setInterval = (((callback: (...args: unknown[]) => unknown) => {
      heartbeatTick = callback as HeartbeatTick;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    globalThis.clearInterval = ((
      _timer: ReturnType<typeof setInterval>
    ) => undefined) as typeof clearInterval;

    try {
      const ctx = {
        chat: { id: 789 },
        reply: mock(async (text: string, extra?: Record<string, unknown>) => {
          replyCalls.push({ text, extra });
          return {
            chat: { id: 789 },
            message_id: replyCalls.length,
          };
        }),
        api: {
          editMessageText: editMessageTextMock,
          deleteMessage: mock(async () => {}),
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);
      await state.progressUpdateChain;

      expect(replyCalls).toHaveLength(0);
      expect(heartbeatTick).not.toBeNull();

      fakeNow += 19_000;
      await runHeartbeatTick(heartbeatTick);
      expect(editMessageTextMock).not.toHaveBeenCalled();

      fakeNow += 1_000;
      await runHeartbeatTick(heartbeatTick);
      expect(editMessageTextMock).not.toHaveBeenCalled();
      expect(replyCalls).toHaveLength(1);
      expect(replyCalls[0]).toMatchObject({
        text: "\u200b",
        extra: { disable_notification: true, parse_mode: "HTML" },
      });

      fakeNow += 29_000;
      await runHeartbeatTick(heartbeatTick);
      expect(editMessageTextMock).not.toHaveBeenCalled();

      fakeNow += 1_000;
      await runHeartbeatTick(heartbeatTick);
      expect(editMessageTextMock).not.toHaveBeenCalled();

      await statusCallback("thinking", "Back on it");
      expect(replyCalls).toHaveLength(1);
      expect(editMessageTextMock).toHaveBeenCalledTimes(1);
      const editCalls = getEditMessageTextCalls(editMessageTextMock);
      expectLiveProgressText(String(editCalls[0]?.[2]), "Back on it");

      fakeNow += 19_000;
      await runHeartbeatTick(heartbeatTick);
      expect(editMessageTextMock).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = originalDateNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("stores a retained snapshot when heartbeat enters Still working", async () => {
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const editMessageTextMock = mock(async () => {});

    const originalDateNow = Date.now;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let fakeNow = 1_700_000_000_000;
    let heartbeatTick: HeartbeatTick | null = null;

    Date.now = () => fakeNow;
    globalThis.setInterval = (((callback: (...args: unknown[]) => unknown) => {
      heartbeatTick = callback as HeartbeatTick;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    globalThis.clearInterval = ((
      _timer: ReturnType<typeof setInterval>
    ) => undefined) as typeof clearInterval;

    try {
      const ctx = {
        chat: { id: 790 },
        reply: mock(async () => ({
          chat: { id: 790 },
          message_id: 1,
        })),
        api: {
          editMessageText: editMessageTextMock,
          deleteMessage: mock(async () => {}),
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);
      await state.progressUpdateChain;

      await statusCallback("thinking", "Investigating the issue");
      fakeNow += 20_000;
      await runHeartbeatTick(heartbeatTick);

      expect(state.progressSnapshots.some((snapshot) => snapshot.progressState === "Still working")).toBe(true);
      expect(editMessageTextMock).not.toHaveBeenCalled();
    } finally {
      Date.now = originalDateNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("retains bounded snapshot history and supports back/next navigation after completion", async () => {
    const {
      StreamingState,
      createStatusCallback,
      navigateRetainedProgressViewer,
    } = await loadFreshStreamingModule();
    const editMessageTextMock = mock(async () => {});
    const replyMock = mock(async (_text: string, _extra?: Record<string, unknown>) => ({
      chat: { id: 2468 },
      message_id: 1,
    }));

    const ctx = {
      chat: { id: 2468 },
      reply: replyMock,
      api: {
        editMessageText: editMessageTextMock,
        deleteMessage: mock(async () => {}),
      },
      callbackQuery: {
        data: "progress_nav:back",
        message: { message_id: 1 },
      },
    } as unknown as Context;

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
    await state.progressUpdateChain;

    await statusCallback("thinking", "Preparing response");
    for (let idx = 0; idx < 13; idx += 1) {
      await statusCallback("segment_end", `Answer draft ${idx + 1}`, idx);
    }
    await statusCallback("done", "");

    expect(state.progressSnapshots).toHaveLength(12);
    expect(state.progressSnapshots[0]?.progressState).toBe("Writing answer");
    expect(state.progressSnapshots[0]?.summary).toContain("Answer draft 2");
    expect(state.progressSnapshots[state.progressSnapshots.length - 1]?.progressState).toBe("Writing answer");
    expect(state.progressSnapshots[state.progressSnapshots.length - 1]?.terminal).toBe(true);
    expect(state.progressSnapshots[state.progressSnapshots.length - 1]?.summary).toContain("Answer draft 13");
    expect(state.selectedProgressSnapshotIndex).toBe(11);

    const finalEdit = getEditMessageTextCalls(editMessageTextMock).at(-1);
    expect(String(finalEdit?.[2])).toContain("12 / 12");
    expect((finalEdit?.[3] as any)?.reply_markup?.inline_keyboard).toEqual([
      [{ text: "⬅️", callback_data: "progress_nav:back" }],
    ]);

    const backResult = await navigateRetainedProgressViewer(ctx, "back");
    expect(backResult).toBe("updated");
    const afterBackEdit = getEditMessageTextCalls(editMessageTextMock).at(-1);
    expect(String(afterBackEdit?.[2])).toContain("11 / 12");
    expect(String(afterBackEdit?.[2])).toContain("Elapsed ");
    expect(String(afterBackEdit?.[2])).toContain("Answer draft 12");
    expect((afterBackEdit?.[3] as any)?.reply_markup?.inline_keyboard).toEqual([
      [
        { text: "⬅️", callback_data: "progress_nav:back" },
        { text: "➡️", callback_data: "progress_nav:next" },
      ],
    ]);

    const nextResult = await navigateRetainedProgressViewer(
      {
        ...ctx,
        callbackQuery: {
          data: "progress_nav:next",
          message: { message_id: 1 },
        },
      } as unknown as Context,
      "next"
    );
    expect(nextResult).toBe("updated");
    const afterNextEdit = getEditMessageTextCalls(editMessageTextMock).at(-1);
    expect(String(afterNextEdit?.[2])).toContain("12 / 12");
    expect(String(afterNextEdit?.[2])).toContain("Elapsed ");
    expect(String(afterNextEdit?.[2])).toContain("Answer draft 13");
  });

  it("paces live progress edits so visible content stays on screen for at least 200ms", async () => {
    const { StreamingState, createStatusCallback } = await loadFreshStreamingModule();
    const sleepCalls: number[] = [];
    const editMessageTextMock = mock(async () => {});
    const replyMock = mock(async () => ({
      chat: { id: 999 },
      message_id: 1,
    }));

    const originalDateNow = Date.now;
    const originalBunSleep = Bun.sleep;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;
    (Bun as any).sleep = mock(async (ms: number) => {
      sleepCalls.push(ms);
      fakeNow += ms;
    });

    try {
      const ctx = {
        chat: { id: 999 },
        reply: replyMock,
        api: {
          editMessageText: editMessageTextMock,
          deleteMessage: mock(async () => {}),
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
      await state.progressUpdateChain;

      await statusCallback("thinking", "Planning");
      await statusCallback("tool", "Running tool");
      await statusCallback("done", "");

      expect(sleepCalls).toEqual([200]);
      expect(editMessageTextMock).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = originalDateNow;
      (Bun as any).sleep = originalBunSleep;
    }
  });

  it("uses the final image as the notifying terminal result even after text output", async () => {
    const {
      checkPendingSendImageRequests,
      clearStreamingState,
      createStatusCallback,
      StreamingState,
    } = await loadFreshStreamingModule();
    const customIpcDir = `/tmp/streaming-text-wins-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousIpcDir = process.env.SUPERTURTLE_IPC_DIR;
    mkdirSync(customIpcDir, { recursive: true });
    process.env.SUPERTURTLE_IPC_DIR = customIpcDir;

    try {
      const requestId = `streaming-send-image-text-wins-${Date.now()}`;
      const requestFile = `${customIpcDir}/send-image-${requestId}.json`;
      const deleteMessageMock = mock(async () => {});
      let nextReplyMessageId = 1;
      const replyMock = mock(async (text: string, extra?: Record<string, unknown>) => ({
        chat: { id: 123 },
        message_id: nextReplyMessageId++,
        text,
        extra,
      }));
      const replyWithPhotoMock = mock(async () => ({
        chat: { id: 123 },
        message_id: 99,
        photo: [{ file_id: "photo-file-id" }],
      }));

      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          source: "https://example.com/final-image.png",
          caption: "Late image",
          status: "pending",
          chat_id: "123",
          created_at: new Date().toISOString(),
        })
      );

      const ctx = {
        chat: { id: 123 },
        reply: replyMock,
        replyWithPhoto: replyWithPhotoMock,
        api: {
          deleteMessage: deleteMessageMock,
          editMessageText: mock(async () => {}),
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);
      await state.progressUpdateChain;

      await statusCallback("segment_end", "Hello from Super Turtle", 0);
      expect(state.hasTextSegmentOutput).toBe(true);
      expect(replyWithPhotoMock).not.toHaveBeenCalled();

      const handled = await checkPendingSendImageRequests(ctx, 123);
      expect(handled).toBe(true);
      expect(replyWithPhotoMock).not.toHaveBeenCalled();
      expect(state.lastNotifiableOutput?.kind).toBe("final_artifact");

      await statusCallback("done", "");

      expect(replyMock).not.toHaveBeenCalled();
      expect(replyWithPhotoMock).toHaveBeenCalledTimes(1);
      const photoCall = replyWithPhotoMock.mock.calls[0] as
        | [unknown, { caption?: string; disable_notification?: boolean }]
        | undefined;
      expect(photoCall?.[1]).toMatchObject({
        caption: "Late image",
      });
      expect(photoCall?.[1]?.disable_notification).toBeUndefined();
      expect(deleteMessageMock).not.toHaveBeenCalledWith(123, 99);
    } finally {
      process.env.SUPERTURTLE_IPC_DIR = previousIpcDir || IPC_DIR;
      rmSync(customIpcDir, { recursive: true, force: true });
      clearStreamingState(123);
    }
  });

  it("retains artifact progress history and pagination when visible progress precedes a final image", async () => {
    const {
      checkPendingSendImageRequests,
      clearStreamingState,
      createStatusCallback,
      navigateRetainedProgressViewer,
      StreamingState,
    } = await loadFreshStreamingModule();
    const customIpcDir = `/tmp/streaming-image-history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousIpcDir = process.env.SUPERTURTLE_IPC_DIR;
    mkdirSync(customIpcDir, { recursive: true });
    process.env.SUPERTURTLE_IPC_DIR = customIpcDir;

    try {
      const requestId = `streaming-send-image-history-${Date.now()}`;
      const requestFile = `${customIpcDir}/send-image-${requestId}.json`;
      const editMessageTextMock = mock(async () => {});
      const deleteMessageMock = mock(async () => {});
      const replyMock = mock(async () => ({
        chat: { id: 124 },
        message_id: 1,
      }));
      const replyWithPhotoMock = mock(async () => ({
        chat: { id: 124 },
        message_id: 2,
        photo: [{ file_id: "photo-file-id" }],
      }));

      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          source: "https://example.com/final-image.png",
          caption: "Turtle portrait",
          status: "pending",
          chat_id: "124",
          created_at: new Date().toISOString(),
        })
      );

      const ctx = {
        chat: { id: 124 },
        callbackQuery: {
          data: "progress_nav:back",
          message: { message_id: 1 },
        },
        reply: replyMock,
        replyWithPhoto: replyWithPhotoMock,
        api: {
          deleteMessage: deleteMessageMock,
          editMessageText: editMessageTextMock,
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
      await state.progressUpdateChain;

      await statusCallback("thinking", "Rendering the final result");
      const handled = await checkPendingSendImageRequests(ctx, 124);
      expect(handled).toBe(true);
      expect(replyWithPhotoMock).not.toHaveBeenCalled();

      await statusCallback("done", "");

      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(replyWithPhotoMock).toHaveBeenCalledTimes(1);
      expect(deleteMessageMock).not.toHaveBeenCalled();
      expect(state.progressSnapshots).toHaveLength(2);
      expect(state.progressSnapshots[0]?.summary).toContain("Preparing final image");
      expect(state.progressSnapshots[1]?.summary).toContain("Final image ready");
      expect(state.progressSnapshots[1]?.terminal).toBe(true);
      expect(state.selectedProgressSnapshotIndex).toBe(1);

      const finalEdit = getEditMessageTextCalls(editMessageTextMock).at(-1);
      expect(String(finalEdit?.[2])).toContain("Final image ready: Turtle portrait");
      expect(String(finalEdit?.[2])).toContain("2 / 2");
      expect((finalEdit?.[3] as any)?.reply_markup?.inline_keyboard).toEqual([
        [{ text: "⬅️", callback_data: "progress_nav:back" }],
      ]);

      const backResult = await navigateRetainedProgressViewer(ctx, "back");
      expect(backResult).toBe("updated");
      const afterBackEdit = getEditMessageTextCalls(editMessageTextMock).at(-1);
      expect(String(afterBackEdit?.[2])).toContain("Preparing final image: Turtle portrait");
      expect(String(afterBackEdit?.[2])).toContain("1 / 2");
      expect((afterBackEdit?.[3] as any)?.reply_markup?.inline_keyboard).toEqual([
        [{ text: "➡️", callback_data: "progress_nav:next" }],
      ]);
    } finally {
      process.env.SUPERTURTLE_IPC_DIR = previousIpcDir || IPC_DIR;
      rmSync(customIpcDir, { recursive: true, force: true });
      clearStreamingState(124);
    }
  });

  it("promotes a final image reply as the notifying message", async () => {
    const {
      checkPendingSendImageRequests,
      clearStreamingState,
      createStatusCallback,
      StreamingState,
    } = await loadFreshStreamingModule();
    const customIpcDir = `/tmp/streaming-image-notify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousIpcDir = process.env.SUPERTURTLE_IPC_DIR;
    mkdirSync(customIpcDir, { recursive: true });
    process.env.SUPERTURTLE_IPC_DIR = customIpcDir;

    try {
      const requestId = `streaming-send-image-notify-${Date.now()}`;
      const requestFile = `${customIpcDir}/send-image-${requestId}.json`;
      const deleteMessageMock = mock(async () => {});
      const replyMock = mock(async (text: string, extra?: Record<string, unknown>) => ({
        chat: { id: 123 },
        message_id: extra?.disable_notification === true ? 3 : 4,
        text,
      }));
      const replyWithPhotoMock = mock(
        async (_source: unknown, extra?: Record<string, unknown>) => ({
          chat: { id: 123 },
          message_id: 1,
          photo: [{ file_id: "photo-file-id" }],
        })
      );

      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          source: "https://example.com/test.png",
          caption: "Final image",
          status: "pending",
          chat_id: "123",
          created_at: new Date().toISOString(),
        })
      );

      const ctx = {
        chat: { id: 123 },
        reply: replyMock,
        replyWithPhoto: replyWithPhotoMock,
        api: {
          deleteMessage: deleteMessageMock,
          editMessageText: mock(async () => {}),
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);
      await state.progressUpdateChain;

      const handled = await checkPendingSendImageRequests(ctx, 123);
      expect(handled).toBe(true);
      expect(state.lastNotifiableOutput?.kind).toBe("final_artifact");
      expect(replyWithPhotoMock).not.toHaveBeenCalled();

      await statusCallback("done", "");

      expect(replyWithPhotoMock).toHaveBeenCalledTimes(1);
      expect(replyWithPhotoMock.mock.calls[0]?.[1]).toMatchObject({
        caption: "Final image",
      });
      expect(replyWithPhotoMock.mock.calls[0]?.[1]?.disable_notification).toBeUndefined();
      expect(replyMock).not.toHaveBeenCalled();
      expect(deleteMessageMock).not.toHaveBeenCalled();
    } finally {
      process.env.SUPERTURTLE_IPC_DIR = previousIpcDir || IPC_DIR;
      rmSync(customIpcDir, { recursive: true, force: true });
      clearStreamingState(123);
    }
  });

  it("promotes a final sticker reply as the notifying message", async () => {
    const {
      checkPendingSendTurtleRequests,
      clearStreamingState,
      createStatusCallback,
      StreamingState,
    } = await loadFreshStreamingModule();
    const customIpcDir = `/tmp/streaming-sticker-notify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousIpcDir = process.env.SUPERTURTLE_IPC_DIR;
    mkdirSync(customIpcDir, { recursive: true });
    process.env.SUPERTURTLE_IPC_DIR = customIpcDir;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    ) as unknown as typeof fetch;

    try {
      const requestId = `streaming-send-turtle-notify-${Date.now()}`;
      const requestFile = `${customIpcDir}/send-turtle-${requestId}.json`;
      const deleteMessageMock = mock(async () => {});
      const replyMock = mock(async (text: string, extra?: Record<string, unknown>) => ({
        chat: { id: 321 },
        message_id: extra?.disable_notification === true ? 13 : 14,
        text,
      }));
      const replyWithStickerMock = mock(
        async (_source: unknown, extra?: Record<string, unknown>) => ({
          chat: { id: 321 },
          message_id: 11,
          sticker: { file_id: "sticker-file-id" },
        })
      );

      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          url: "https://example.com/turtle.webp",
          status: "pending",
          chat_id: "321",
          created_at: new Date().toISOString(),
        })
      );

      const ctx = {
        chat: { id: 321 },
        reply: replyMock,
        replyWithSticker: replyWithStickerMock,
        api: {
          deleteMessage: deleteMessageMock,
          editMessageText: mock(async () => {}),
        },
      } as unknown as Context;

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);
      await state.progressUpdateChain;

      const handled = await checkPendingSendTurtleRequests(ctx, 321);
      expect(handled).toBe(true);
      expect(state.lastNotifiableOutput?.kind).toBe("final_artifact");
      expect(replyWithStickerMock).not.toHaveBeenCalled();

      await statusCallback("done", "");

      expect(replyWithStickerMock).toHaveBeenCalledTimes(1);
      expect(replyWithStickerMock.mock.calls[0]?.[1]?.disable_notification).toBeUndefined();
      expect(replyMock).not.toHaveBeenCalled();
      expect(deleteMessageMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SUPERTURTLE_IPC_DIR = previousIpcDir || IPC_DIR;
      rmSync(customIpcDir, { recursive: true, force: true });
      clearStreamingState(321);
    }
  });
});
