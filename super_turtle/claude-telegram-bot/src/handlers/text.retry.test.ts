import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";
import { session } from "../session";

type TextModule = typeof import("./text");

const originalStartProcessing = session.startProcessing;
const originalActiveDriver = session.activeDriver;
const originalTypingController = session.typingController;
const originalConversationTitle = session.conversationTitle;
const originalLastMessage = session.lastMessage;

let runMessageWithActiveDriverMock: ReturnType<typeof mock>;
let startTypingIndicatorMock: ReturnType<typeof mock>;
let teardownStreamingStateMock: ReturnType<typeof mock>;
let drainDeferredQueueMock: ReturnType<typeof mock>;
let auditLogErrorMock: ReturnType<typeof mock>;
let stopProcessingMock: ReturnType<typeof mock>;
let typingStopMock: ReturnType<typeof mock>;

async function loadTextModule(): Promise<TextModule> {
  return import(`./text.ts?text-retry-test=${Date.now()}-${Math.random()}`);
}

beforeEach(async () => {
  const actualImportSuffix = `${Date.now()}-${Math.random()}`;
  const actualDeferredQueue = await import(
    `../deferred-queue.ts?actual=${actualImportSuffix}`
  );
  const actualDriverRouting = await import(
    `./driver-routing.ts?actual=${actualImportSuffix}`
  );
  const actualRegistry = await import(`../drivers/registry.ts?actual=${actualImportSuffix}`);
  const actualSecurity = await import(`../security.ts?actual=${actualImportSuffix}`);
  const actualStreaming = await import(`./streaming.ts?actual=${actualImportSuffix}`);
  const actualUtils = await import(`../utils.ts?actual=${actualImportSuffix}`);

  runMessageWithActiveDriverMock = mock(async () => {
    throw new Error("Event stream stalled for 120000ms before completion");
  });
  teardownStreamingStateMock = mock(async () => {});
  drainDeferredQueueMock = mock(async () => {});
  auditLogErrorMock = mock(async () => {});
  stopProcessingMock = mock(() => {});
  typingStopMock = mock(() => {});
  startTypingIndicatorMock = mock(() => ({ stop: typingStopMock }));

  session.activeDriver = "claude";
  session.startProcessing = mock(
    () => stopProcessingMock
  ) as unknown as typeof session.startProcessing;
  session.typingController = null;
  session.conversationTitle = null;
  session.lastMessage = null;

  const driver = {
    id: "claude" as const,
    displayName: "Claude",
    auditEvent: "TEXT" as const,
    runMessage: async () => "",
    stop: async () => false as const,
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

  mock.module("../drivers/registry", () => ({
    ...actualRegistry,
    getCurrentDriver: () => driver,
  }));

  mock.module("../security", () => ({
    ...actualSecurity,
    isAuthorized: () => true,
    rateLimiter: {
      check: () => [true, null] as const,
    },
  }));

  mock.module("../utils", () => ({
    ...actualUtils,
    auditLog: async (..._args: unknown[]) => {},
    auditLogAuth: async (..._args: unknown[]) => {},
    auditLogError: (...args: unknown[]) => auditLogErrorMock(...args),
    auditLogRateLimit: async (..._args: unknown[]) => {},
    checkInterrupt: async (message: string) => message,
    generateRequestId: () => "text-retry-test",
    isStopIntent: () => false,
    startTypingIndicator: (ctx: Context) => startTypingIndicatorMock(ctx),
  }));

  mock.module("./driver-routing", () => ({
    ...actualDriverRouting,
    isAnyDriverRunning: () => false,
    isBackgroundRunActive: () => false,
    preemptBackgroundRunForUserPriority: async () => false,
    runMessageWithActiveDriver: (input: unknown) => runMessageWithActiveDriverMock(input),
  }));

  mock.module("./streaming", () => ({
    ...actualStreaming,
    StreamingState: class StreamingState {},
    createStatusCallback: () => async () => {},
    createSilentStatusCallback: () => async () => {},
    teardownStreamingState: (
      ctx: Context,
      state: unknown,
      options?: { chatId?: number; clearRegisteredState?: boolean }
    ) => teardownStreamingStateMock(ctx, state, options),
  }));

  mock.module("../deferred-queue", () => ({
    ...actualDeferredQueue,
    drainDeferredQueue: (
      ctx: Context,
      chatId: number,
      onDrainItem?: (msg: unknown) => Promise<void>
    ) => drainDeferredQueueMock(ctx, chatId, onDrainItem),
    enqueueDeferredMessage: () => 1,
    makeDrainItemNotifier: () => async () => {},
    unsuppressDrain: () => {},
  }));
});

afterEach(() => {
  session.startProcessing = originalStartProcessing;
  session.activeDriver = originalActiveDriver;
  session.typingController = originalTypingController;
  session.conversationTitle = originalConversationTitle;
  session.lastMessage = originalLastMessage;
  mock.restore();
});

describe("handleText retry delegation", () => {
  it("calls runMessageWithActiveDriver once and leaves retry policy to driver-routing", async () => {
    const { handleText } = await loadTextModule();
    const replies: string[] = [];
    const chat = { id: 321, type: "private" } as const;

    const ctx = {
      from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
      chat,
      message: {
        text: "spawn subturtles",
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat,
      },
      reply: async (text: string) => {
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
    } as unknown as Context;

    await handleText(ctx);

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(runMessageWithActiveDriverMock.mock.calls[0]?.[0]).toMatchObject({
      message: "spawn subturtles",
      source: "text",
      username: "tester",
      userId: 123,
      chatId: 321,
      ctx,
    });
    expect(teardownStreamingStateMock).toHaveBeenCalledTimes(1);
    expect(auditLogErrorMock).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([
      "❌ Error: Event stream stalled for 120000ms before completion",
    ]);
    expect(stopProcessingMock).toHaveBeenCalledTimes(1);
    expect(typingStopMock).toHaveBeenCalledTimes(1);
    expect(drainDeferredQueueMock).toHaveBeenCalledTimes(1);
  });
});
