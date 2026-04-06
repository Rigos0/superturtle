import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.SUPER_TURTLE_PROJECT_DIR ||= process.cwd();

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

// Re-assert the real driver registry before each test.
// Other test files may contaminate it via mock.module() + incomplete mock.restore().
beforeEach(() => {
  mock.module("../drivers/registry", () => ({
    getDriver: (id: string) => (id === "codex" ? codexDriver : claudeDriver),
    getCurrentDriver: () =>
      session.activeDriver === "codex" ? codexDriver : claudeDriver,
  }));
});

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

  it("stopForegroundWork leaves SubTurtles running", async () => {
    let stopTypingCalls = 0;
    let claudeStops = 0;
    let spawnSyncCalls = 0;

    session.stopTyping = () => {
      stopTypingCalls += 1;
    };
    session.activeDriver = "claude";
    claudeDriver.stop = async () => {
      claudeStops += 1;
      return "stopped";
    };

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      spawnSyncCalls += 1;
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }

      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const { stopForegroundWork } = await loadStopModule("stop-foreground-work");
    const result = await stopForegroundWork();

    expect(result).toEqual({
      driverStopResult: "stopped",
      queueCleared: 0,
      attempted: [],
      stopped: [],
      failed: [],
    });
    expect(stopTypingCalls).toBe(1);
    expect(claudeStops).toBe(1);
    expect(spawnSyncCalls).toBe(0);
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

  it("handleStop retains the progress message for an active foreground run", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;
    const actualStreaming = await import(`./streaming.ts?stop-test=${actualImportSuffix}`);
    const [deferredQueueState, deferredQueueRuntime] = await Promise.all([
      import(`../deferred-queue.ts?stop-test=${actualImportSuffix}`),
      import(`../deferred-queue-runtime.ts?stop-runtime-test=${actualImportSuffix}`),
    ]);
    const deferredQueue = {
      ...deferredQueueState,
      ...deferredQueueRuntime,
    };
    const actualDriverRouting = await import(
      `./driver-routing.ts?stop-test=${actualImportSuffix}`
    );

    const chatId = 41001;
    const state = new actualStreaming.StreamingState();
    const progressStates: string[] = [];
    const retainCalls: Array<number | undefined> = [];
    const replies: string[] = [];

    mock.module("./streaming", () => ({
      ...actualStreaming,
      getStreamingState: (id: number) => (id === chatId ? (state as any) : undefined),
      updateRetainedProgressState: async (
        _ctx: Context,
        _state: unknown,
        progressState: string
      ) => {
        progressStates.push(progressState);
      },
      retainStreamingState: async (
        _ctx: Context,
        _state: unknown,
        options?: { chatId?: number }
      ) => {
        retainCalls.push(options?.chatId);
      },
    }));
    mock.module("../deferred-queue", () => ({ ...deferredQueue }));
    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      stopActiveDriverQuery: async () => "stopped" as const,
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
      reply: async (text: string) => {
        replies.push(text);
        return {} as any;
      },
    } as unknown as Context;

    try {
      await handleStop(ctx, chatId);
      expect(progressStates).toEqual(["Stopping", "Stopped"]);
      expect(retainCalls).toEqual([chatId]);
      expect(replies).toEqual([]);
      expect(state.stopRequestedByUser).toBe(true);
    } finally {
      deferredQueue.clearDeferredQueue(chatId);
      deferredQueue.unsuppressDrain(chatId);
    }
  });

  it("handleStop reports foreground-only stop when driver work was active", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;
    const actualStreaming = await import(`./streaming.ts?stop-foreground=${actualImportSuffix}`);
    const deferredQueue = await import(`../deferred-queue.ts?stop-foreground=${actualImportSuffix}`);
    const actualDriverRouting = await import(
      `./driver-routing.ts?stop-foreground=${actualImportSuffix}`
    );

    mock.module("./streaming", () => ({
      ...actualStreaming,
      getStreamingState: () => undefined,
      clearStreamingState: () => {},
      cleanupToolMessages: async () => {},
    }));
    mock.module("../deferred-queue", () => ({ ...deferredQueue }));
    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      stopActiveDriverQuery: async () => "stopped" as const,
    }));

    let replies: string[] = [];
    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      throw new Error(`handleStop should not call ctl for foreground-only stop: ${cmd.join(" ")}`);
    }) as typeof Bun.spawnSync;

    const { handleStop } = await import(`./stop.ts?stop-foreground=${actualImportSuffix}`);
    const ctx = {
      chat: { id: 41003 },
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
      reply: async (text: string) => {
        replies.push(text);
        return {} as any;
      },
    } as unknown as Context;

    try {
      await handleStop(ctx, 41003);
      expect(replies).toEqual(["🛑 Stopped current work."]);
    } finally {
      deferredQueue.clearDeferredQueue(41003);
      deferredQueue.unsuppressDrain(41003);
    }
  });

  it("handleStop says nothing to stop when there is no foreground work or queued messages", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;
    const actualStreaming = await import(`./streaming.ts?stop-nothing=${actualImportSuffix}`);
    const deferredQueue = await import(`../deferred-queue.ts?stop-nothing=${actualImportSuffix}`);
    const actualDriverRouting = await import(
      `./driver-routing.ts?stop-nothing=${actualImportSuffix}`
    );

    mock.module("./streaming", () => ({
      ...actualStreaming,
      getStreamingState: () => undefined,
      clearStreamingState: () => {},
      cleanupToolMessages: async () => {},
    }));
    mock.module("../deferred-queue", () => ({ ...deferredQueue }));
    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      stopActiveDriverQuery: async () => false,
    }));

    let replies: string[] = [];
    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      throw new Error(`handleStop should not call ctl for foreground-only stop: ${cmd.join(" ")}`);
    }) as typeof Bun.spawnSync;

    const { handleStop } = await import(`./stop.ts?stop-nothing=${actualImportSuffix}`);
    const ctx = {
      chat: { id: 41004 },
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
      reply: async (text: string) => {
        replies.push(text);
        return {} as any;
      },
    } as unknown as Context;

    try {
      await handleStop(ctx, 41004);
      expect(replies).toEqual(["Nothing to stop."]);
    } finally {
      deferredQueue.clearDeferredQueue(41004);
      deferredQueue.unsuppressDrain(41004);
    }
  });

  it("handleStop suppresses duplicate replies for the same chat", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;
    const actualStreaming = await import(`./streaming.ts?stop-dedupe=${actualImportSuffix}`);
    const deferredQueue = await import(`../deferred-queue.ts?stop-dedupe=${actualImportSuffix}`);
    const actualDriverRouting = await import(
      `./driver-routing.ts?stop-dedupe=${actualImportSuffix}`
    );

    let stopCalls = 0;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    mock.module("./streaming", () => ({
      ...actualStreaming,
      getStreamingState: () => undefined,
      clearStreamingState: () => {},
      cleanupToolMessages: async () => {},
    }));
    mock.module("../deferred-queue", () => ({ ...deferredQueue }));
    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      stopActiveDriverQuery: async () => {
        stopCalls += 1;
        await stopGate;
        return "stopped" as const;
      },
    }));

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      throw new Error(`handleStop should not call ctl for foreground-only stop: ${cmd.join(" ")}`);
    }) as typeof Bun.spawnSync;

    const replies: string[] = [];
    const ctx = {
      chat: { id: 41005 },
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
      reply: async (text: string) => {
        replies.push(text);
        return {} as any;
      },
    } as unknown as Context;

    const { handleStop } = await import(`./stop.ts?stop-dedupe=${actualImportSuffix}`);

    try {
      const first = handleStop(ctx, 41005);
      const second = handleStop(ctx, 41005);
      releaseStop();
      await Promise.all([first, second]);

      expect(stopCalls).toBe(1);
      expect(replies).toEqual(["🛑 Stopped current work."]);

      await handleStop(ctx, 41005);
      expect(replies).toEqual(["🛑 Stopped current work."]);
    } finally {
      deferredQueue.clearDeferredQueue(41005);
      deferredQueue.unsuppressDrain(41005);
    }
  });

  it("handleStop does not suppress a new stop when fresh work starts within the dedupe window", async () => {
    const actualImportSuffix = `${Date.now()}-${Math.random()}`;
    const actualStreaming = await import(`./streaming.ts?stop-redo=${actualImportSuffix}`);
    const deferredQueue = await import(`../deferred-queue.ts?stop-redo=${actualImportSuffix}`);
    const actualDriverRouting = await import(
      `./driver-routing.ts?stop-redo=${actualImportSuffix}`
    );

    let driverRunning = false;
    let stopCalls = 0;

    mock.module("./streaming", () => ({
      ...actualStreaming,
      getStreamingState: () => undefined,
      clearStreamingState: () => {},
      cleanupToolMessages: async () => {},
    }));
    mock.module("../deferred-queue", () => ({ ...deferredQueue }));
    mock.module("./driver-routing", () => ({
      ...actualDriverRouting,
      isAnyDriverRunning: () => driverRunning,
      stopActiveDriverQuery: async () => {
        stopCalls += 1;
        return "stopped" as const;
      },
    }));

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      throw new Error(`handleStop should not call ctl for foreground-only stop: ${cmd.join(" ")}`);
    }) as typeof Bun.spawnSync;

    const replies: string[] = [];
    const chatId = 41006;
    const ctx = {
      chat: { id: chatId },
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
      reply: async (text: string) => {
        replies.push(text);
        return {} as any;
      },
    } as unknown as Context;

    const { handleStop } = await import(`./stop.ts?stop-redo=${actualImportSuffix}`);

    try {
      await handleStop(ctx, chatId);

      driverRunning = true;
      await handleStop(ctx, chatId);

      expect(stopCalls).toBe(2);
      expect(replies).toEqual(["🛑 Stopped current work.", "🛑 Stopped current work."]);
    } finally {
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
