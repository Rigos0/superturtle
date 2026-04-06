import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";
import { codexSession } from "../codex-session";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();
process.env.CODEX_ENABLED ||= "true";
process.env.CODEX_CLI_AVAILABLE_OVERRIDE ||= "true";

const originalSendMessage = codexSession.sendMessage;

async function loadCodexDriverModule() {
  return import(`./codex-driver.ts?test=${Date.now()}-${Math.random()}`);
}

async function mockStreamingModule(
  overrides: Partial<typeof import("../handlers/streaming")>
): Promise<void> {
  const actualStreaming = await import(
    `../handlers/streaming.ts?actual=${Date.now()}-${Math.random()}`
  );
  mock.module("../handlers/streaming", () => ({
    ...actualStreaming,
    ...overrides,
  }));
}

afterEach(() => {
  codexSession.sendMessage = originalSendMessage;
  mock.restore();
});

describe("CodexDriver", () => {
  it("does not derive reasoning effort from message keywords", async () => {
    await mockStreamingModule({
      checkPendingAskUserRequests: async () => false,
      checkPendingBotControlRequests: async () => false,
      checkPendingPinoLogsRequests: async () => false,
      checkPendingSendFileRequests: async () => false,
      checkPendingSendImageRequests: async () => false,
      checkPendingSendTurtleRequests: async () => false,
    });

    const reasoningEfforts: Array<string | undefined> = [];
    codexSession.sendMessage = (async (
      _message,
      _statusCallback,
      _model,
      reasoningEffort
    ) => {
      reasoningEfforts.push(reasoningEffort);
      return "ok";
    }) as typeof codexSession.sendMessage;

    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    const response = await driver.runMessage({
      message: "please ultrathink about this",
      source: "text",
      username: "tester",
      userId: 123,
      chatId: 456,
      ctx: {} as Context,
      statusCallback: async () => {},
    });

    expect(response).toBe("ok");
    expect(reasoningEfforts).toEqual([undefined]);
  });

  it("treats malformed resumed-thread history errors as crash-retry eligible", async () => {
    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    expect(
      driver.isCrashError(
        `Codex stream error: {
          "error": {
            "message": "Invalid 'input[162].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.",
            "type": "invalid_request_error",
            "param": "input[162].content",
            "code": "array_above_max_length"
          }
        }`
      )
    ).toBe(true);
  });

  it("flushes pending send_image requests for Codex MCP tool calls", async () => {
    const sendImageChecks: number[] = [];

    await mockStreamingModule({
      checkPendingAskUserRequests: async () => false,
      checkPendingBotControlRequests: async () => false,
      checkPendingPinoLogsRequests: async () => false,
      checkPendingSendFileRequests: async () => false,
      checkPendingSendImageRequests: async (_ctx: Context, chatId: number) => {
        sendImageChecks.push(chatId);
        return true;
      },
      checkPendingSendTurtleRequests: async () => false,
    });

    codexSession.sendMessage = (async (
      _message,
      _statusCallback,
      _model,
      _reasoning,
      mcpCompletionCallback
    ) => {
      await mcpCompletionCallback?.("bot-control", "send_image");
      return "ok";
    }) as typeof codexSession.sendMessage;

    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    const response = await driver.runMessage({
      message: "send the screenshot",
      source: "text",
      username: "tester",
      userId: 123,
      chatId: 789,
      ctx: {} as Context,
      statusCallback: async () => {},
    });

    expect(response).toBe("ok");
    expect(sendImageChecks).toContain(789);
  });

  it("flushes pending send_file requests for Codex MCP tool calls", async () => {
    const sendFileChecks: number[] = [];

    await mockStreamingModule({
      checkPendingAskUserRequests: async () => false,
      checkPendingBotControlRequests: async () => false,
      checkPendingPinoLogsRequests: async () => false,
      checkPendingSendFileRequests: async (_ctx: Context, chatId: number) => {
        sendFileChecks.push(chatId);
        return true;
      },
      checkPendingSendImageRequests: async () => false,
      checkPendingSendTurtleRequests: async () => false,
    });

    codexSession.sendMessage = (async (
      _message,
      _statusCallback,
      _model,
      _reasoning,
      mcpCompletionCallback
    ) => {
      await mcpCompletionCallback?.("bot-control", "send_file");
      return "ok";
    }) as typeof codexSession.sendMessage;

    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    const response = await driver.runMessage({
      message: "send the report",
      source: "text",
      username: "tester",
      userId: 123,
      chatId: 654,
      ctx: {} as Context,
      statusCallback: async () => {},
    });

    expect(response).toBe("ok");
    expect(sendFileChecks).toContain(654);
  });

  it("forwards done even when a pending checker hangs after Codex completion", async () => {
    const originalPendingTimeout = process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS;
    const originalPumpShutdownTimeout = process.env.CODEX_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS;
    process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS = "10";
    process.env.CODEX_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS = "25";

    try {
      await mockStreamingModule({
        checkPendingAskUserRequests: async () => await new Promise<boolean>(() => {}),
        checkPendingBotControlRequests: async () => false,
        checkPendingPinoLogsRequests: async () => false,
        checkPendingSendFileRequests: async () => false,
        checkPendingSendImageRequests: async () => false,
        checkPendingSendTurtleRequests: async () => false,
      });

      codexSession.sendMessage = (async (_message, statusCallback) => {
        await statusCallback?.("done", "");
        return "ok";
      }) as typeof codexSession.sendMessage;

      const statusEvents: string[] = [];
      const { CodexDriver } = await loadCodexDriverModule();
      const driver = new CodexDriver();

      const response = await Promise.race([
        driver.runMessage({
          message: "finish cleanly",
          source: "text",
          username: "tester",
          userId: 123,
          chatId: 456,
          ctx: {} as Context,
          statusCallback: async (statusType: string) => {
            statusEvents.push(statusType);
          },
        }),
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("driver stalled")), 900);
        }),
      ]);

      expect(response).toBe("ok");
      expect(statusEvents).toContain("done");
    } finally {
      if (originalPendingTimeout === undefined) {
        delete process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS;
      } else {
        process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS = originalPendingTimeout;
      }

      if (originalPumpShutdownTimeout === undefined) {
        delete process.env.CODEX_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS;
      } else {
        process.env.CODEX_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS = originalPumpShutdownTimeout;
      }
    }
  });

  it("forwards deferred done when Codex emits done before stale-session retry throws", async () => {
    await mockStreamingModule({
      checkPendingAskUserRequests: async () => false,
      checkPendingBotControlRequests: async () => false,
      checkPendingPinoLogsRequests: async () => false,
      checkPendingSendFileRequests: async () => false,
      checkPendingSendImageRequests: async () => false,
      checkPendingSendTurtleRequests: async () => false,
    });

    codexSession.sendMessage = (async (_message, statusCallback) => {
      await statusCallback?.("done", "");
      throw new Error("Empty response from stale session");
    }) as typeof codexSession.sendMessage;

    const statusEvents: string[] = [];
    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    await expect(
      driver.runMessage({
        message: "retry the stale session",
        source: "text",
        username: "tester",
        userId: 123,
        chatId: 456,
        ctx: {} as Context,
        statusCallback: async (statusType: string) => {
          statusEvents.push(statusType);
        },
      })
    ).rejects.toThrow("Empty response from stale session");

    expect(statusEvents).toEqual(["done"]);
  });

  it("preserves the original stale-session error when deferred done cleanup fails", async () => {
    await mockStreamingModule({
      checkPendingAskUserRequests: async () => false,
      checkPendingBotControlRequests: async () => false,
      checkPendingPinoLogsRequests: async () => false,
      checkPendingSendFileRequests: async () => false,
      checkPendingSendImageRequests: async () => false,
      checkPendingSendTurtleRequests: async () => false,
    });

    codexSession.sendMessage = (async (_message, statusCallback) => {
      await statusCallback?.("done", "");
      throw new Error("Empty response from stale session");
    }) as typeof codexSession.sendMessage;

    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    await expect(
      driver.runMessage({
        message: "retry the stale session",
        source: "text",
        username: "tester",
        userId: 123,
        chatId: 456,
        ctx: {} as Context,
        statusCallback: async (statusType: string) => {
          if (statusType === "done") {
            throw new Error("status callback failed");
          }
        },
      })
    ).rejects.toThrow("Empty response from stale session");
  });
});
