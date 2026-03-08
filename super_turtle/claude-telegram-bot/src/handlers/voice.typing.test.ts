import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";
import { session } from "../session";

type VoiceModule = typeof import("./voice");

type TypingController = { stop: () => void } | null;

function getInternalTypingController(): TypingController {
  return (session as unknown as { _typingController: TypingController })._typingController;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalFetch = globalThis.fetch;
const originalSessionStartProcessing = session.startProcessing;
const originalSessionTypingController = getInternalTypingController();

let runMessageWithActiveDriverMock: ReturnType<typeof mock>;
let transcribeVoiceMock: ReturnType<typeof mock>;
let startTypingIndicatorMock: ReturnType<typeof mock>;
let createStatusCallbackMock: ReturnType<typeof mock>;
let drainDeferredQueueMock: ReturnType<typeof mock>;
let stopProcessingMock: ReturnType<typeof mock>;
let typingStopMock: ReturnType<typeof mock>;

async function loadVoiceModule(): Promise<VoiceModule> {
  return import(`./voice.ts?typing-test=${Date.now()}-${Math.random()}`);
}

beforeEach(async () => {
  const actualImportSuffix = `${Date.now()}-${Math.random()}`;
  const actualConfig = await import(`../config.ts?actual=${actualImportSuffix}`);
  const actualDeferredQueue = await import(
    `../deferred-queue.ts?actual=${actualImportSuffix}`
  );
  const actualDriverRouting = await import(
    `./driver-routing.ts?actual=${actualImportSuffix}`
  );
  const actualSecurity = await import(`../security.ts?actual=${actualImportSuffix}`);
  const actualStreaming = await import(`./streaming.ts?actual=${actualImportSuffix}`);
  const actualUtils = await import(`../utils.ts?actual=${actualImportSuffix}`);

  runMessageWithActiveDriverMock = mock(async () => "voice response");
  transcribeVoiceMock = mock();
  typingStopMock = mock(() => {});
  createStatusCallbackMock = mock(() => async () => {});
  drainDeferredQueueMock = mock(async () => {});
  stopProcessingMock = mock(() => {});
  const typingController = { stop: typingStopMock };
  startTypingIndicatorMock = mock(() => typingController);

  session.startProcessing = mock(
    () => stopProcessingMock
  ) as unknown as typeof session.startProcessing;
  session.typingController = null;

  globalThis.fetch = mock(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  ) as unknown as typeof fetch;

  mock.module("../config", () => ({
    ...actualConfig,
    TEMP_DIR: "/tmp",
    TRANSCRIPTION_AVAILABLE: true,
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
    auditLogError: async (..._args: unknown[]) => {},
    auditLogRateLimit: async (..._args: unknown[]) => {},
    generateRequestId: () => "voice-test",
    isStopIntent: () => false,
    startTypingIndicator: (ctx: Context) => startTypingIndicatorMock(ctx),
    transcribeVoice: (path: string) => transcribeVoiceMock(path),
  }));

  mock.module("./driver-routing", () => ({
    ...actualDriverRouting,
    getDriverAuditType: () => "VOICE",
    isActiveDriverSessionActive: () => true,
    isAnyDriverRunning: () => false,
    isBackgroundRunActive: () => false,
    preemptBackgroundRunForUserPriority: async () => {},
    runMessageWithActiveDriver: (input: unknown) => runMessageWithActiveDriverMock(input),
  }));

  mock.module("./streaming", () => ({
    ...actualStreaming,
    StreamingState: class StreamingState {},
    createStatusCallback: (ctx: Context, state: unknown) =>
      createStatusCallbackMock(ctx, state),
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
  session.startProcessing = originalSessionStartProcessing;
  session.typingController = originalSessionTypingController;
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("handleVoice typing cleanup", () => {
  it("registers the typing controller during voice processing and clears it afterward", async () => {
    const transcriptionStarted = createDeferred<void>();
    const transcriptionResult = createDeferred<string | null>();
    const typingController = { stop: typingStopMock };

    startTypingIndicatorMock = mock(() => typingController);
    transcribeVoiceMock = mock(async () => {
      transcriptionStarted.resolve();
      return transcriptionResult.promise;
    });

    const { handleVoice } = await loadVoiceModule();
    const chatId = 32001;
    const editMessageTextMock = mock(
      async (_chatId: number, _messageId: number, _text: string) => {}
    );
    const ctx = {
      from: { id: 123, username: "tester" },
      chat: { id: chatId },
      message: {
        voice: {
          duration: 7,
          file_id: "voice-file-id",
        },
      },
      getFile: async () => ({ file_path: "voice.ogg" }),
      reply: async (_text: string) => ({ message_id: 99 }),
      api: {
        token: "test-token",
        editMessageText: (targetChatId: number, messageId: number, text: string) =>
          editMessageTextMock(targetChatId, messageId, text),
      },
    } as unknown as Context;

    const handlePromise = handleVoice(ctx);
    await transcriptionStarted.promise;

    expect(startTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(getInternalTypingController()).toBe(typingController);

    transcriptionResult.resolve("transcribed voice message");
    await handlePromise;

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(stopProcessingMock).toHaveBeenCalledTimes(1);
    expect(typingStopMock).toHaveBeenCalledTimes(1);
    expect(drainDeferredQueueMock).toHaveBeenCalledTimes(1);
    expect(getInternalTypingController()).toBeNull();
  });
});
