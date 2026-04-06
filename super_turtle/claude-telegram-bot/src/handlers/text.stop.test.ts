import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type StopProbePayload = {
  replies: string[];
  stopProcessingCalls: number;
  typingStopCalls: number;
  drainDeferredQueueCalls: number;
};

type StopProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: StopProbePayload | null;
};

const marker = "__HANDLE_TEXT_STOP_PROBE__=";
const projectRoot = resolve(import.meta.dir, "../..");

async function runStopSuppressionProbe(): Promise<StopProbeResult> {
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
    stopPath: resolve(import.meta.dir, "stop.ts"),
    stopReplyStatePath: resolve(import.meta.dir, "stop-reply-state.ts"),
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

    let stopProcessingCalls = 0;
    let typingStopCalls = 0;
    let drainDeferredQueueCalls = 0;

    const driver = {
      id: "claude",
      displayName: "Claude",
      auditEvent: "TEXT",
      runMessage: async () => {
        throw new Error("Query cancelled");
      },
      stop: async () => false,
      kill: async () => {},
      isCrashError: () => false,
      isStallError: () => false,
      isCancellationError: () => true,
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
      auditLogError: async () => {},
      auditLogRateLimit: async () => {},
      checkInterrupt: async (message) => message,
      generateRequestId: () => "text-stop-test",
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

    mock.module(paths.stopPath, () => ({
      handleStop: async () => {},
    }));

    mock.module(paths.stopReplyStatePath, () => ({
      consumeHandledStopReply: () => true,
    }));

    mock.module(paths.deferredQueueRuntimePath, () => ({
      drainDeferredQueue: async () => {
        drainDeferredQueueCalls += 1;
      },
      makeDrainItemNotifier: () => async () => {},
    }));

    mock.module(paths.streamingPath, () => ({
      ...actualStreaming,
      StreamingState: class StreamingState {},
      createStatusCallback: () => async () => {},
      createSilentStatusCallback: () => async () => {},
      teardownStreamingState: async () => {},
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
        text: "build something",
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as StopProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("handleText explicit stop suppression", () => {
  it("does not send a second stop reply after handleStop already acknowledged the cancel", async () => {
    const result = await runStopSuppressionProbe();
    if (result.exitCode !== 0) {
      throw new Error(
        `Stop suppression probe failed:\n${result.stderr || result.stdout}`
      );
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replies).toEqual([]);
    expect(result.payload?.stopProcessingCalls).toBe(1);
    expect(result.payload?.typingStopCalls).toBe(1);
    expect(result.payload?.drainDeferredQueueCalls).toBe(1);
  });
});
