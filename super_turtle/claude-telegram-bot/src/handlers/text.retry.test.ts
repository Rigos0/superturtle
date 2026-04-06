import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type RetryProbePayload = {
  runCalls: number;
  firstInput: Record<string, unknown> | null;
  teardownStreamingStateCalls: number;
  auditLogErrorCalls: number;
  replies: string[];
  stopProcessingCalls: number;
  typingStopCalls: number;
  drainDeferredQueueCalls: number;
};

type RetryProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: RetryProbePayload | null;
};

const marker = "__HANDLE_TEXT_RETRY_PROBE__=";
const projectRoot = resolve(import.meta.dir, "../..");

async function runRetryDelegationProbe(): Promise<RetryProbeResult> {
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
  };

  const script = `
    const { mock } = await import("bun:test");
    const marker = ${JSON.stringify(marker)};
    const paths = ${JSON.stringify(paths)};
    const actualDeferredQueue = await import(paths.deferredQueuePath + "?actual=" + Date.now());
    const actualStreaming = await import(paths.streamingPath + "?actual=" + Date.now());

    let runCalls = 0;
    let firstInput = null;
    let teardownStreamingStateCalls = 0;
    let auditLogErrorCalls = 0;
    let stopProcessingCalls = 0;
    let typingStopCalls = 0;
    let drainDeferredQueueCalls = 0;

    const driver = {
      id: "claude",
      displayName: "Claude",
      auditEvent: "TEXT",
      runMessage: async () => "",
      stop: async () => false,
      kill: async () => {},
      isCrashError: () => false,
      isStallError: () => true,
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
      rateLimiter: {
        check: () => [true, null],
      },
    }));

    mock.module(paths.utilsPath, () => ({
      auditLog: async () => {},
      auditLogAuth: async () => {},
      auditLogError: async () => {
        auditLogErrorCalls += 1;
      },
      auditLogRateLimit: async () => {},
      checkInterrupt: async (message) => message,
      generateRequestId: () => "text-retry-test",
      isStopIntent: () => false,
      startTypingIndicator: () => ({
        stop: () => {
          typingStopCalls += 1;
        },
      }),
    }));

    mock.module(paths.deferredQueuePath, () => ({
      ...actualDeferredQueue,
      enqueueDeferredMessage: () => 1,
      unsuppressDrain: () => {},
    }));

    mock.module(paths.deferredQueueRuntimePath, () => ({
      drainDeferredQueue: async () => {
        drainDeferredQueueCalls += 1;
      },
      makeDrainItemNotifier: () => async () => {},
    }));

    mock.module(paths.driverRoutingPath, () => ({
      isAnyDriverRunning: () => false,
      isBackgroundRunActive: () => false,
      preemptBackgroundRunForUserPriority: async () => false,
      runMessageWithActiveDriver: async (input) => {
        runCalls += 1;
        if (runCalls === 1) {
          firstInput = input;
        }
        throw new Error("Event stream stalled for 120000ms before completion");
      },
    }));

    mock.module(paths.streamingPath, () => ({
      ...actualStreaming,
      StreamingState: class StreamingState {},
      createStatusCallback: () => async () => {},
      createSilentStatusCallback: () => async () => {},
      teardownStreamingState: async () => {
        teardownStreamingStateCalls += 1;
      },
    }));

    mock.module(paths.teleportPath, () => ({
      TELEPORT_CONTROL_MESSAGE: "remote-control",
      isTeleportRemoteControlMode: () => false,
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
    session.conversationTitle = null;
    session.lastMessage = null;
    session.startProcessing = () => () => {
      stopProcessingCalls += 1;
    };

    const { handleText } = await import(paths.textHandlerPath + "?probe=" + Date.now());
    const replies = [];
    const chat = { id: 321, type: "private" };
    const ctx = {
      from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
      chat,
      message: {
        text: "spawn subturtles",
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat,
      },
      reply: async (text) => {
        replies.push(String(text));
        return {
          message_id: replies.length,
          chat,
          text,
        };
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
          runCalls,
          firstInput,
          teardownStreamingStateCalls,
          auditLogErrorCalls,
          replies,
          stopProcessingCalls,
          typingStopCalls,
          drainDeferredQueueCalls,
        })
    );
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as RetryProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("handleText retry delegation", () => {
  it("calls runMessageWithActiveDriver once and leaves retry policy to driver-routing", async () => {
    const result = await runRetryDelegationProbe();
    if (result.exitCode !== 0) {
      throw new Error(
        `Retry delegation probe failed:\n${result.stderr || result.stdout}`
      );
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.runCalls).toBe(1);
    expect(result.payload?.firstInput).toMatchObject({
      message: "spawn subturtles",
      source: "text",
      username: "tester",
      userId: 123,
      chatId: 321,
    });
    expect(result.payload?.teardownStreamingStateCalls).toBe(1);
    expect(result.payload?.auditLogErrorCalls).toBe(1);
    expect(result.payload?.replies).toEqual([
      "❌ Error: Event stream stalled for 120000ms before completion",
    ]);
    expect(result.payload?.stopProcessingCalls).toBe(1);
    expect(result.payload?.typingStopCalls).toBe(1);
    expect(result.payload?.drainDeferredQueueCalls).toBe(1);
  });
});
