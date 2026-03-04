import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const { getDriver } = await import("../drivers/registry");
const { session } = await import("../session");

type StopModule = typeof import("./stop");

async function loadStopModule(tag: string): Promise<StopModule> {
  return import(`./stop.ts?stop-test=${tag}-${Date.now()}-${Math.random()}`);
}

const originalSpawnSync = Bun.spawnSync;
const originalSessionDriver = session.activeDriver;
const originalStopTyping = session.stopTyping;
const claudeDriver = getDriver("claude");
const codexDriver = getDriver("codex");
const originalClaudeStop = claudeDriver.stop;
const originalCodexStop = codexDriver.stop;

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
  session.activeDriver = originalSessionDriver;
  session.stopTyping = originalStopTyping;
  claudeDriver.stop = originalClaudeStop;
  codexDriver.stop = originalCodexStop;
  mock.restore();
});

describe("stop handlers", () => {
  it("deduplicates running SubTurtle names and stops each once", async () => {
    const commands: string[][] = [];

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      commands.push(args);

      if (args[1] === "list") {
        return {
          stdout: Buffer.from(
            [
              "alpha running yolo-codex (PID 1111) 9m left",
              "→ https://alpha.example",
              "alpha running yolo-codex (PID 1111) 8m left",
              "beta stopped",
            ].join("\n")
          ),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      if (args[1] === "stop" && args[2] === "alpha") {
        return {
          stdout: Buffer.from("stopped"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const { stopAllRunningSubturtles } = await loadStopModule("dedupe-subturtles");
    const result = stopAllRunningSubturtles();

    expect(result).toEqual({
      attempted: ["alpha"],
      stopped: ["alpha"],
      failed: [],
    });
    expect(commands.filter((args) => args[1] === "stop")).toHaveLength(1);
  });

  it("stops typing, stops active driver, and stops listed SubTurtles", async () => {
    let stopTypingCalls = 0;
    let claudeStops = 0;
    let codexStops = 0;

    session.stopTyping = () => {
      stopTypingCalls += 1;
    };
    session.activeDriver = "claude";
    claudeDriver.stop = async () => {
      claudeStops += 1;
      return "stopped";
    };
    codexDriver.stop = async () => {
      codexStops += 1;
      return false;
    };

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));

      if (args[1] === "list") {
        return {
          stdout: Buffer.from(
            [
              "alpha running yolo-codex (PID 1111) 9m left",
              "gamma running yolo (PID 2222) 1m left",
            ].join("\n")
          ),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      if (args[1] === "stop" && args[2] === "alpha") {
        return {
          stdout: Buffer.from("stopped"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      if (args[1] === "stop" && args[2] === "gamma") {
        return {
          stdout: Buffer.from("failed"),
          stderr: Buffer.from(""),
          success: false,
          exitCode: 1,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const { stopAllRunningWork } = await loadStopModule("stop-all-work");
    const result = await stopAllRunningWork();

    expect(result).toEqual({
      driverStopResult: "stopped",
      queueCleared: 0,
      attempted: ["alpha", "gamma"],
      stopped: ["alpha"],
      failed: ["gamma"],
    });
    expect(stopTypingCalls).toBe(1);
    expect(claudeStops).toBe(1);
    expect(codexStops).toBe(0);
  });

  it("does not clear stopRequested when Claude stop returns pending", async () => {
    const restoreProcessing = session.startProcessing();
    session.activeDriver = "claude";
    session.stopTyping = () => {};

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    try {
      const { stopAllRunningWork } = await loadStopModule("stop-pending");
      const result = await stopAllRunningWork();
      expect(result.driverStopResult).toBe("pending");
      expect(session.isStopRequested).toBe(true);
    } finally {
      session.clearStopRequested();
      restoreProcessing();
    }
  });

  it("clears stopRequested when Claude stop returns stopped", async () => {
    session.activeDriver = "claude";
    session.stopTyping = () => {};

    let clearCalls = 0;
    const originalClearStopRequested = session.clearStopRequested.bind(session);
    session.clearStopRequested = () => {
      clearCalls += 1;
      originalClearStopRequested();
    };

    let killed = false;
    (session as unknown as { isQueryRunning: boolean }).isQueryRunning = true;
    (session as unknown as { activeProcess: { kill: () => void } | null }).activeProcess = {
      kill: () => {
        killed = true;
      },
    };

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    try {
      const { stopAllRunningWork } = await loadStopModule("stop-stopped");
      const result = await stopAllRunningWork();
      expect(result.driverStopResult).toBe("stopped");
      expect(killed).toBe(true);
      expect(clearCalls).toBe(1);
      expect(session.isStopRequested).toBe(false);
    } finally {
      session.clearStopRequested = originalClearStopRequested;
      (session as unknown as { isQueryRunning: boolean }).isQueryRunning = false;
      (session as unknown as { activeProcess: null }).activeProcess = null;
      session.clearStopRequested();
    }
  });

  it("handleStop clears streaming state for the chat", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;
    const actualStreaming = await import(`./streaming.ts?stop-test=${actualImportSuffix}`);
    const deferredQueue = await import(`../deferred-queue.ts?stop-test=${actualImportSuffix}`);
    const actualDriverRouting = await import(
      `./driver-routing.ts?stop-test=${actualImportSuffix}`
    );

    const chatId = 41001;
    const state = new actualStreaming.StreamingState();

    let clearedChatId: number | null = null;
    let cleanupCalls = 0;

    mock.module("./streaming", () => ({
      ...actualStreaming,
      getStreamingState: (id: number) => (id === chatId ? (state as any) : undefined),
      clearStreamingState: (id: number) => {
        clearedChatId = id;
      },
      cleanupToolMessages: async () => {
        cleanupCalls += 1;
      },
    }));
    mock.module("../deferred-queue", () => ({ ...deferredQueue }));
    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      stopActiveDriverQuery: async () => false,
    }));

    const { handleStop } = await import(`./stop.ts?stop-test=${actualImportSuffix}`);

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const ctx = {
      chat: { id: chatId },
      api: {
        deleteMessage: async () => {},
        editMessageText: async () => {},
      },
      reply: async () => ({}) as any,
    } as unknown as Context;

    try {
      await handleStop(ctx, chatId);
      expect(cleanupCalls).toBe(1);
      expect(clearedChatId as number | null).toBe(chatId);
    } finally {
      deferredQueue.clearDeferredQueue(chatId);
      deferredQueue.unsuppressDrain(chatId);
    }
  });

  it("stopAllRunningWork suppresses drain, clears queue, then drains after unsuppress", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;

    const actualDriverRouting = await import(`./driver-routing.ts?actual=${actualImportSuffix}`);
    const actualUtils = await import(`../utils.ts?actual=${actualImportSuffix}`);
    const actualStreaming = await import(`./streaming.ts?actual=${actualImportSuffix}`);

    const isAnyDriverRunningMock = mock(() => false);
    const runMessageWithActiveDriverMock = mock(async (_input: unknown) => "queued response");
    const auditLogMock = mock(async (..._args: unknown[]) => {});
    const typingStopMock = mock(() => {});
    const startTypingIndicatorMock = mock((_ctx: Context) => ({ stop: typingStopMock }));
    const createStatusCallbackMock = mock((_ctx: Context, _state: unknown) => async () => {});
    const startProcessingMock = mock(() => () => {});

    const originalStartProcessing = session.startProcessing;
    const originalTypingController = session.typingController;
    session.startProcessing = startProcessingMock as unknown as typeof session.startProcessing;
    session.typingController = null;

    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      stopActiveDriverQuery: async () => false,
      isAnyDriverRunning: () => isAnyDriverRunningMock(),
      runMessageWithActiveDriver: (input: unknown) => runMessageWithActiveDriverMock(input),
    }));

    mock.module("../utils", () => ({
      ...actualUtils,
      auditLog: (...args: unknown[]) => auditLogMock(...args),
      startTypingIndicator: (ctx: Context) => startTypingIndicatorMock(ctx),
    }));

    mock.module("./streaming", () => ({
      ...actualStreaming,
      StreamingState: class StreamingState {},
      createStatusCallback: (ctx: Context, state: unknown) =>
        createStatusCallbackMock(ctx, state),
    }));

    const deferredQueue = await import(`../deferred-queue.ts?stop-test=${actualImportSuffix}`);

    mock.module("../deferred-queue", () => ({ ...deferredQueue }));

    const { stopAllRunningWork: stopAllRunningWorkIsolated } = await import(
      `./stop.ts?stop-test=${actualImportSuffix}`
    );

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const chatId = 41002;
    const ctx = {
      reply: async () => ({}),
    } as unknown as Context;

    try {
      deferredQueue.enqueueDeferredMessage({
        text: "queued one",
        userId: 1,
        username: "u",
        chatId,
        source: "text",
        enqueuedAt: 1000,
      });
      deferredQueue.enqueueDeferredMessage({
        text: "queued two",
        userId: 1,
        username: "u",
        chatId,
        source: "text",
        enqueuedAt: 2000,
      });

      const result = await stopAllRunningWorkIsolated(chatId);
      expect(result.queueCleared).toBe(2);
      expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);

      deferredQueue.enqueueDeferredMessage({
        text: "post-stop",
        userId: 1,
        username: "u",
        chatId,
        source: "text",
        enqueuedAt: 3000,
      });

      await deferredQueue.drainDeferredQueue(ctx, chatId);
      expect(runMessageWithActiveDriverMock).not.toHaveBeenCalled();
      expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(1);

      deferredQueue.unsuppressDrain(chatId);
      await deferredQueue.drainDeferredQueue(ctx, chatId);
      expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
      expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
    } finally {
      session.startProcessing = originalStartProcessing;
      session.typingController = originalTypingController;
      deferredQueue.clearDeferredQueue(chatId);
      deferredQueue.unsuppressDrain(chatId);
    }
  });

  it("stopAllRunningWork with no running SubTurtles returns empty arrays", async () => {
    session.activeDriver = "claude";
    session.stopTyping = () => {};
    claudeDriver.stop = async () => false;
    codexDriver.stop = async () => false;

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const { stopAllRunningWork } = await loadStopModule("no-subturtles");
    const result = await stopAllRunningWork();

    expect(result.attempted).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
