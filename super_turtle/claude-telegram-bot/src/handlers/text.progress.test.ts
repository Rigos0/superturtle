import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type ProgressProbePayload = {
  replies: string[];
  updateStates: string[];
  retainCalls: number;
  teardownCalls: number;
  auditLogErrorCalls: number;
};

type ProgressProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: ProgressProbePayload | null;
};

const marker = "__HANDLE_TEXT_PROGRESS_PROBE__=";
const projectRoot = resolve(import.meta.dir, "../..");

async function runProgressProbe(scriptBody: string): Promise<ProgressProbeResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    SUPER_TURTLE_PROJECT_DIR: process.cwd(),
    HOME: process.env.HOME || "/tmp",
  };

  const paths = {
    textHandlerPath: resolve(import.meta.dir, "text.ts"),
    sessionPath: resolve(import.meta.dir, "../session.ts"),
    driversRegistryPath: resolve(import.meta.dir, "../drivers/registry.ts"),
    securityPath: resolve(import.meta.dir, "../security.ts"),
    utilsPath: resolve(import.meta.dir, "../utils.ts"),
    deferredQueuePath: resolve(import.meta.dir, "../deferred-queue.ts"),
    deferredQueueRuntimePath: resolve(import.meta.dir, "../deferred-queue-runtime.ts"),
    driverRoutingPath: resolve(import.meta.dir, "driver-routing.ts"),
    streamingPath: resolve(import.meta.dir, "streaming.ts"),
    teleportPath: resolve(import.meta.dir, "../teleport.ts"),
    loggerPath: resolve(import.meta.dir, "../logger.ts"),
    stopPath: resolve(import.meta.dir, "stop.ts"),
    stopReplyStatePath: resolve(import.meta.dir, "stop-reply-state.ts"),
  };

  const script = `
    const { mock } = await import("bun:test");
    const marker = ${JSON.stringify(marker)};
    const paths = ${JSON.stringify(paths)};
    ${scriptBody}
  `;

  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    cwd: projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const payloadLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(marker));

  const payload = payloadLine
    ? (JSON.parse(payloadLine.slice(marker.length)) as ProgressProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("handleText retained progress outcomes", () => {
  it("retains the progress message as Failed before sending the terminal error reply", async () => {
    const result = await runProgressProbe(`
      const actualDeferredQueue = await import(paths.deferredQueuePath + "?actual=" + Date.now());
      const actualStreaming = await import(paths.streamingPath + "?actual=" + Date.now());

      const replies = [];
      const updateStates = [];
      let retainCalls = 0;
      let teardownCalls = 0;
      let auditLogErrorCalls = 0;

      const driver = {
        id: "claude",
        displayName: "Claude",
        auditEvent: "TEXT",
        runMessage: async () => "",
        stop: async () => false,
        kill: async () => {},
        isCrashError: () => false,
        isStallError: () => false,
        isCancellationError: () => false,
        getStatusSnapshot: () => ({
          driverName: "Claude",
          isActive: false,
          sessionId: null,
          lastActivity: null,
          lastError: null,
          lastErrorTime: null,
          lastUsage: null,
        }),
      };

      mock.module(paths.driversRegistryPath, () => ({
        getDriver: () => driver,
        getCurrentDriver: () => driver,
      }));

      mock.module(paths.securityPath, () => ({
        isAuthorized: () => true,
        rateLimiter: { check: () => [true, null] },
      }));

      mock.module(paths.utilsPath, () => ({
        auditLog: async () => {},
        auditLogAuth: async () => {},
        auditLogError: async () => {
          auditLogErrorCalls += 1;
        },
        auditLogRateLimit: async () => {},
        checkInterrupt: async (message) => message,
        generateRequestId: () => "text-progress-error",
        isStopIntent: () => false,
        startTypingIndicator: () => ({ stop: () => {} }),
      }));

      mock.module(paths.deferredQueuePath, () => ({
        ...actualDeferredQueue,
        enqueueDeferredMessage: () => 1,
        unsuppressDrain: () => {},
      }));

      mock.module(paths.deferredQueueRuntimePath, () => ({
        drainDeferredQueue: async () => {},
        makeDrainItemNotifier: () => async () => {},
      }));

      mock.module(paths.driverRoutingPath, () => ({
        isAnyDriverRunning: () => false,
        isBackgroundRunActive: () => false,
        preemptBackgroundRunForUserPriority: async () => false,
        runMessageWithActiveDriver: async () => {
          throw new Error("disk full");
        },
      }));

      mock.module(paths.streamingPath, () => ({
        ...actualStreaming,
        StreamingState: class StreamingState {
          awaitingUserAttention = false;
          teardownCompleted = false;
          stopRequestedByUser = false;
        },
        createStatusCallback: () => async () => {},
        createSilentStatusCallback: () => async () => {},
        retainStreamingState: async () => {
          retainCalls += 1;
        },
        teardownStreamingState: async () => {
          teardownCalls += 1;
        },
        updateRetainedProgressState: async (_ctx, _state, progressState) => {
          updateStates.push(String(progressState));
        },
      }));

      mock.module(paths.teleportPath, () => ({
        TELEPORT_CONTROL_MESSAGE: "remote-control",
        isTeleportRemoteControlMode: () => false,
      }));

      mock.module(paths.stopPath, () => ({
        handleStop: async () => {},
      }));

      mock.module(paths.stopReplyStatePath, () => ({
        consumeHandledStopReply: () => false,
      }));

      mock.module(paths.loggerPath, () => {
        const logger = {
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => logger,
        };
        return {
          logger,
          eventLog: logger,
          streamLog: logger,
          cmdLog: logger,
        };
      });

      const { session } = await import(paths.sessionPath);
      session.activeDriver = "claude";
      session.typingController = null;
      session.startProcessing = () => () => {};

      const { handleText } = await import(paths.textHandlerPath + "?probe=" + Date.now());
      const chat = { id: 321, type: "private" };
      const ctx = {
        from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
        chat,
        message: {
          text: "build something",
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat,
        },
        reply: async (text) => {
          replies.push(String(text));
          return { message_id: replies.length, chat, text };
        },
        replyWithChatAction: async () => {},
        api: {
          editMessageText: async () => {},
          deleteMessage: async () => {},
        },
      };

      await handleText(ctx);

      console.log(
        marker +
          JSON.stringify({
            replies,
            updateStates,
            retainCalls,
            teardownCalls,
            auditLogErrorCalls,
          })
      );
    `);

    if (result.exitCode !== 0) {
      throw new Error(`Progress failure probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.updateStates).toEqual(["Failed"]);
    expect(result.payload?.retainCalls).toBe(1);
    expect(result.payload?.teardownCalls).toBe(0);
    expect(result.payload?.auditLogErrorCalls).toBe(1);
    expect(result.payload?.replies).toEqual(["❌ Error: disk full"]);
  });

  it("retains the progress message in place when the run ends waiting for user input", async () => {
    const result = await runProgressProbe(`
      const actualDeferredQueue = await import(paths.deferredQueuePath + "?actual=" + Date.now());
      const actualStreaming = await import(paths.streamingPath + "?actual=" + Date.now());

      const replies = [];
      const updateStates = [];
      let retainCalls = 0;
      let teardownCalls = 0;

      const driver = {
        id: "claude",
        displayName: "Claude",
        auditEvent: "TEXT",
        runMessage: async () => "",
        stop: async () => false,
        kill: async () => {},
        isCrashError: () => false,
        isStallError: () => false,
        isCancellationError: () => false,
        getStatusSnapshot: () => ({
          driverName: "Claude",
          isActive: false,
          sessionId: null,
          lastActivity: null,
          lastError: null,
          lastErrorTime: null,
          lastUsage: null,
        }),
      };

      mock.module(paths.driversRegistryPath, () => ({
        getDriver: () => driver,
        getCurrentDriver: () => driver,
      }));

      mock.module(paths.securityPath, () => ({
        isAuthorized: () => true,
        rateLimiter: { check: () => [true, null] },
      }));

      mock.module(paths.utilsPath, () => ({
        auditLog: async () => {},
        auditLogAuth: async () => {},
        auditLogError: async () => {},
        auditLogRateLimit: async () => {},
        checkInterrupt: async (message) => message,
        generateRequestId: () => "text-progress-attention",
        isStopIntent: () => false,
        startTypingIndicator: () => ({ stop: () => {} }),
      }));

      mock.module(paths.deferredQueuePath, () => ({
        ...actualDeferredQueue,
        enqueueDeferredMessage: () => 1,
        unsuppressDrain: () => {},
      }));

      mock.module(paths.deferredQueueRuntimePath, () => ({
        drainDeferredQueue: async () => {},
        makeDrainItemNotifier: () => async () => {},
      }));

      mock.module(paths.driverRoutingPath, () => ({
        isAnyDriverRunning: () => false,
        isBackgroundRunActive: () => false,
        preemptBackgroundRunForUserPriority: async () => false,
        runMessageWithActiveDriver: async () => "[Waiting for user selection]",
      }));

      mock.module(paths.streamingPath, () => ({
        ...actualStreaming,
        StreamingState: class StreamingState {
          awaitingUserAttention = true;
          teardownCompleted = false;
          stopRequestedByUser = false;
        },
        createStatusCallback: () => async () => {},
        createSilentStatusCallback: () => async () => {},
        retainStreamingState: async () => {
          retainCalls += 1;
        },
        teardownStreamingState: async () => {
          teardownCalls += 1;
        },
        updateRetainedProgressState: async (_ctx, _state, progressState) => {
          updateStates.push(String(progressState));
        },
      }));

      mock.module(paths.teleportPath, () => ({
        TELEPORT_CONTROL_MESSAGE: "remote-control",
        isTeleportRemoteControlMode: () => false,
      }));

      mock.module(paths.stopPath, () => ({
        handleStop: async () => {},
      }));

      mock.module(paths.stopReplyStatePath, () => ({
        consumeHandledStopReply: () => false,
      }));

      mock.module(paths.loggerPath, () => {
        const logger = {
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => logger,
        };
        return {
          logger,
          eventLog: logger,
          streamLog: logger,
          cmdLog: logger,
        };
      });

      const { session } = await import(paths.sessionPath);
      session.activeDriver = "claude";
      session.typingController = null;
      session.startProcessing = () => () => {};

      const { handleText } = await import(paths.textHandlerPath + "?probe=" + Date.now());
      const chat = { id: 322, type: "private" };
      const ctx = {
        from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
        chat,
        message: {
          text: "pick one",
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat,
        },
        reply: async (text) => {
          replies.push(String(text));
          return { message_id: replies.length, chat, text };
        },
        replyWithChatAction: async () => {},
        api: {
          editMessageText: async () => {},
          deleteMessage: async () => {},
        },
      };

      await handleText(ctx);

      console.log(
        marker +
          JSON.stringify({
            replies,
            updateStates,
            retainCalls,
            teardownCalls,
            auditLogErrorCalls: 0,
          })
      );
    `);

    if (result.exitCode !== 0) {
      throw new Error(`Progress attention probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.updateStates).toEqual([]);
    expect(result.payload?.retainCalls).toBe(1);
    expect(result.payload?.teardownCalls).toBe(0);
    expect(result.payload?.replies).toEqual([]);
  });
});
