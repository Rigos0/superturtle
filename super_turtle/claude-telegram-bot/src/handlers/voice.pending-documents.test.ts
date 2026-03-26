import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";
import { join } from "path";
import { session } from "../session";
import { clearPendingDocuments, stagePendingDocuments } from "../pending-document-inputs";

type VoiceModule = typeof import("./voice");

const originalFetch = globalThis.fetch;
const originalSessionStartProcessing = session.startProcessing;
const originalSessionTypingController = session.typingController;

let processPendingDocumentBatchMock: ReturnType<typeof mock>;
let transcribeVoiceMock: ReturnType<typeof mock>;
let startTypingIndicatorMock: ReturnType<typeof mock>;
let drainDeferredQueueMock: ReturnType<typeof mock>;
let runMessageWithActiveDriverMock: ReturnType<typeof mock>;

async function loadVoiceModule(): Promise<VoiceModule> {
  return import(`./voice.ts?pending-docs-test=${Date.now()}-${Math.random()}`);
}

beforeEach(async () => {
  clearPendingDocuments(456);

  const actualImportSuffix = `${Date.now()}-${Math.random()}`;
  const actualConfig = await import(`../config.ts?actual=${actualImportSuffix}`);
  const actualDeferredQueue = await import(`../deferred-queue.ts?actual=${actualImportSuffix}`);
  const actualDriverRouting = await import(`./driver-routing.ts?actual=${actualImportSuffix}`);
  const actualSecurity = await import(`../security.ts?actual=${actualImportSuffix}`);
  const actualStreaming = await import(`./streaming.ts?actual=${actualImportSuffix}`);
  const actualUtils = await import(`../utils.ts?actual=${actualImportSuffix}`);
  const actualDocument = await import(`./document.ts?actual=${actualImportSuffix}`);

  processPendingDocumentBatchMock = mock(async () => {});
  transcribeVoiceMock = mock(async () => "analyze the spreadsheet for anomalies");
  const typingStopMock = mock(() => {});
  startTypingIndicatorMock = mock(() => ({ stop: typingStopMock }));
  drainDeferredQueueMock = mock(async () => {});
  runMessageWithActiveDriverMock = mock(async () => "voice response");

  session.startProcessing = mock(
    () => mock(() => {})
  ) as unknown as typeof session.startProcessing;
  session.typingController = null;

  globalThis.fetch = mock(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  ) as unknown as typeof fetch;

  mock.module("../config", () => ({
    ...actualConfig,
    TELEGRAM_TOKEN: "test-token",
    ALLOWED_USERS: [123],
    WORKING_DIR: process.cwd(),
    SUPERTURTLE_DATA_DIR: join(process.cwd(), ".superturtle"),
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
    generateRequestId: () => "voice-pending-docs-test",
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
    createStatusCallback: () => async () => {},
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

  mock.module("./document", () => ({
    ...actualDocument,
    processPendingDocumentBatch: (
      ctx: Context,
      batch: unknown,
      instruction: string,
      userId: number,
      username: string,
      chatId: number,
      requestId?: string
    ) => processPendingDocumentBatchMock(ctx, batch, instruction, userId, username, chatId, requestId),
  }));
});

afterEach(() => {
  clearPendingDocuments(456);
  session.startProcessing = originalSessionStartProcessing;
  session.typingController = originalSessionTypingController;
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("handleVoice with pending documents", () => {
  it("uses the transcribed voice message as instructions for staged documents", async () => {
    stagePendingDocuments(456, ["/tmp/report.xlsx", "/tmp/notes.pdf"]);
    const { handleVoice } = await loadVoiceModule();

    const editMessageTextMock = mock(
      async (_chatId: number, _messageId: number, _text: string) => {}
    );
    const replyMock = mock(async (_text: string) => ({ message_id: 99, chat: { id: 456 } }));
    const ctx = {
      from: { id: 123, username: "tester" },
      chat: { id: 456 },
      message: {
        voice: {
          duration: 7,
          file_id: "voice-file-id",
        },
      },
      getFile: async () => ({ file_path: "voice.ogg" }),
      reply: replyMock,
      api: {
        token: "test-token",
        editMessageText: (targetChatId: number, messageId: number, text: string) =>
          editMessageTextMock(targetChatId, messageId, text),
      },
    } as unknown as Context;

    await handleVoice(ctx);

    expect(processPendingDocumentBatchMock).toHaveBeenCalledTimes(1);
    expect(processPendingDocumentBatchMock.mock.calls[0]?.[2]).toBe(
      "analyze the spreadsheet for anomalies"
    );
    expect(runMessageWithActiveDriverMock).not.toHaveBeenCalled();
    expect(drainDeferredQueueMock).toHaveBeenCalledTimes(1);
  });
});
