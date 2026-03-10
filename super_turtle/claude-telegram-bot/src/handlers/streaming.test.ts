import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync } from "fs";
import type { Context } from "grammy";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const {
  checkPendingAskUserRequests,
  checkPendingBotControlRequests,
  checkPendingPinoLogsRequests,
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
  process.env.SUPERTURTLE_IPC_DIR = IPC_DIR;
  await cleanupIpcFiles(STREAMING_ASK_USER_PATTERN);
  await cleanupIpcFiles(STREAMING_PINO_LOGS_PATTERN);
  await cleanupIpcFiles(STREAMING_BOT_CONTROL_PATTERN);
});

afterEach(async () => {
  await cleanupIpcFiles(STREAMING_ASK_USER_PATTERN);
  await cleanupIpcFiles(STREAMING_PINO_LOGS_PATTERN);
  await cleanupIpcFiles(STREAMING_BOT_CONTROL_PATTERN);
});

async function loadStreamingModuleWithLogLines(lines: string[]) {
  const logReader = await import("../log-reader");
  mock.module("../log-reader", () => ({
    ...logReader,
    readPinoLogLines: async () => lines,
  }));

  return import(`./streaming.ts?pino-log-lines=${Date.now()}-${Math.random()}`);
}

async function loadFreshStreamingModule() {
  return import(`./streaming.ts?fresh=${Date.now()}-${Math.random()}`);
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
  });
});
