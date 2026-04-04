import { afterEach, describe, expect, it, mock } from "bun:test";

type ReplyRecord = {
  text: string;
};

function makeCtx(messageText: string) {
  const replies: ReplyRecord[] = [];
  return {
    ctx: {
      from: { id: 123, username: "tester" },
      chat: { id: 456, type: "private" },
      message: { text: messageText },
      reply: async (text: string) => {
        replies.push({ text });
        return { message_id: replies.length, chat: { id: 456 } };
      },
      replyWithChatAction: async () => {},
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
    },
    replies,
  };
}

async function loadTextModuleForRemoteMode(
  mode: "control" | "agent",
  driverOverrides: Record<string, unknown> = {}
) {
  const actualConfig = await import("../config");
  const actualTeleport = await import("../teleport");
  const actualSession = await import("../session");
  const actualSecurity = await import("../security");
  const actualUtils = await import("../utils");
  const actualDeferredQueue = await import("../deferred-queue");
  const actualDeferredQueueRuntime = await import("../deferred-queue-runtime");
  const actualStop = await import("./stop");
  const actualStopReplyState = await import("./stop-reply-state");
  const actualStreaming = await import("./streaming");
  const actualLogger = await import("../logger");
  const actualDriversRegistry = await import("../drivers/registry");
  const actualDriverRouting = await import("./driver-routing");

  mock.module("../config", () => ({
    ...actualConfig,
    ALLOWED_USERS: [123],
    SUPERTURTLE_RUNTIME_ROLE: "teleport-remote",
    SUPERTURTLE_REMOTE_MODE: mode,
  }));
  mock.module("../teleport", () => ({
    ...actualTeleport,
    isTeleportRemoteRuntime: () => true,
    isTeleportRemoteControlMode: () => mode === "control",
    isTeleportRemoteAgentMode: () => mode === "agent",
    getTeleportRemoteUnsupportedMessage: () =>
      mode === "control"
        ? actualTeleport.TELEPORT_CONTROL_MESSAGE
        : actualTeleport.TELEPORT_AGENT_TEXT_ONLY_MESSAGE,
  }));
  mock.module("../session", () => ({
    ...actualSession,
    session: Object.assign(
      Object.create(Object.getPrototypeOf(actualSession.session)),
      actualSession.session,
      {
        lastMessage: "",
        conversationTitle: "",
        typingController: null,
      }
    ),
  }));
  mock.module("../security", () => ({
    ...actualSecurity,
    isAuthorized: () => true,
    rateLimiter: {
      ...actualSecurity.rateLimiter,
      check: () => [true, null],
    },
  }));
  mock.module("../utils", () => ({
    ...actualUtils,
    auditLog: async () => {},
    auditLogAuth: async () => {},
    auditLogError: async () => {},
    auditLogRateLimit: async () => {},
    checkInterrupt: async (message: string) => message,
    generateRequestId: () => "text-remote-test",
    isStopIntent: () => false,
    startTypingIndicator: () => ({
      stop() {},
    }),
  }));
  mock.module("../deferred-queue", () => ({
    ...actualDeferredQueue,
    enqueueDeferredMessage: () => 1,
    unsuppressDrain: () => {},
  }));
  mock.module("../deferred-queue-runtime", () => ({
    ...actualDeferredQueueRuntime,
    drainDeferredQueue: async () => {},
    makeDrainItemNotifier: () => () => {},
  }));
  mock.module("./stop", () => ({
    ...actualStop,
    handleStop: async () => {},
  }));
  mock.module("./stop-reply-state", () => ({
    ...actualStopReplyState,
    consumeHandledStopReply: () => false,
  }));
  mock.module("./streaming", () => ({
    ...actualStreaming,
    StreamingState: class {},
    createSilentStatusCallback: () => async () => {},
    createStatusCallback: () => async () => {},
    teardownStreamingState: async () => {},
  }));
  mock.module("../logger", () => ({
    ...actualLogger,
    eventLog: { info() {}, error() {} },
    streamLog: { error() {}, child() { return { error() {}, info() {}, warn() {}, debug() {} }; } },
  }));
  mock.module("../drivers/registry", () => ({
    ...actualDriversRegistry,
    getCurrentDriver: () => ({
      id: "codex",
      auditEvent: "TEXT",
    }),
  }));
  mock.module("./driver-routing", () => ({
    ...actualDriverRouting,
    isAnyDriverRunning: () => false,
    isBackgroundRunActive: () => false,
    preemptBackgroundRunForUserPriority: async () => {},
    runMessageWithActiveDriver: async () => "remote ok",
    ...driverOverrides,
  }));

  return import(`./text.ts?remote-mode=${mode}-${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  mock.restore();
});

describe("remote text mode", () => {
  it("keeps control mode control-only", async () => {
    const runCalls: string[] = [];
    const { handleText } = await loadTextModuleForRemoteMode("control", {
      runMessageWithActiveDriver: async (...args: unknown[]) => {
        runCalls.push(JSON.stringify(args));
        return "should not run";
      },
    });
    const { ctx, replies } = makeCtx("hello");

    await handleText(ctx as never);

    expect(runCalls).toHaveLength(0);
    expect(replies).toEqual([
      {
        text: "Teleport is disabled in this branch. Use SUPERTURTLE_RUNTIME_PROFILE=managed for the managed E2B runtime.",
      },
    ]);
  });

  it("runs normal text through the agent in remote agent mode", async () => {
    const runCalls: Array<{ message: string; source: string }> = [];
    const { handleText } = await loadTextModuleForRemoteMode("agent", {
      runMessageWithActiveDriver: async (input: { message: string; source: string }) => {
        runCalls.push(input);
        return "remote ok";
      },
    });
    const { ctx, replies } = makeCtx("hello from e2b");

    await handleText(ctx as never);

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({
      message: "hello from e2b",
      source: "text",
      userId: 123,
      username: "tester",
      chatId: 456,
    });
    expect(replies).toEqual([]);
  });
});
