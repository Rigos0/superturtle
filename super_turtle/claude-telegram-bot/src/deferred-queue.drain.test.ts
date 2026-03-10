import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";
import { session } from "./session";

type DeferredQueueModule = typeof import("./deferred-queue");

let isAnyDriverRunningMock: ReturnType<typeof mock>;
let runMessageWithActiveDriverMock: ReturnType<typeof mock>;
let executeNonSilentCronJobMock: ReturnType<typeof mock>;
let advanceRecurringJobMock: ReturnType<typeof mock>;
let removeJobMock: ReturnType<typeof mock>;
let auditLogMock: ReturnType<typeof mock>;
let startTypingIndicatorMock: ReturnType<typeof mock>;
let createStatusCallbackMock: ReturnType<typeof mock>;
let startProcessingMock: ReturnType<typeof mock>;
let typingStopMock: ReturnType<typeof mock>;

const originalSessionTypingController = session.typingController;
const originalSessionStartProcessing = session.startProcessing;

async function loadDeferredQueueModule(): Promise<DeferredQueueModule> {
  return import(`./deferred-queue.ts?drain-test=${Date.now()}-${Math.random()}`);
}

function makeCtx() {
  const replies: string[] = [];
  const ctx = {
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as Context;

  return { ctx, replies };
}

beforeEach(async () => {
  typingStopMock = mock(() => {});
  const actualImportSuffix = `${Date.now()}-${Math.random()}`;
  const actualDriverRouting = await import(
    `./handlers/driver-routing.ts?actual=${actualImportSuffix}`
  );
  const actualUtils = await import(`./utils.ts?actual=${actualImportSuffix}`);
  const actualStreaming = await import(
    `./handlers/streaming.ts?actual=${actualImportSuffix}`
  );

  isAnyDriverRunningMock = mock(() => false);
  runMessageWithActiveDriverMock = mock(async () => "queued response");
  executeNonSilentCronJobMock = mock(async () => {});
  advanceRecurringJobMock = mock(() => true);
  removeJobMock = mock(() => true);
  auditLogMock = mock(async () => {});
  createStatusCallbackMock = mock(() => async () => {});
  startTypingIndicatorMock = mock(() => ({ stop: typingStopMock }));
  startProcessingMock = mock(() => () => {});

  session.typingController = null;
  session.startProcessing = startProcessingMock as unknown as typeof session.startProcessing;

  mock.module("./handlers/driver-routing", () => ({
    ...actualDriverRouting,
    isAnyDriverRunning: () => isAnyDriverRunningMock(),
    runMessageWithActiveDriver: (input: unknown) => runMessageWithActiveDriverMock(input),
  }));

  mock.module("./utils", () => ({
    ...actualUtils,
    auditLog: (...args: unknown[]) => auditLogMock(...args),
    startTypingIndicator: (ctx: Context) => startTypingIndicatorMock(ctx),
  }));

  mock.module("./handlers/streaming", () => ({
    ...actualStreaming,
    StreamingState: class StreamingState {},
    createStatusCallback: (ctx: Context, state: unknown) =>
      createStatusCallbackMock(ctx, state),
  }));

  mock.module("./cron-execution", () => ({
    executeNonSilentCronJob: (job: unknown, target: unknown) =>
      executeNonSilentCronJobMock(job, target),
  }));

  mock.module("./cron", () => ({
    advanceRecurringJob: (jobId: string) => advanceRecurringJobMock(jobId),
    removeJob: (jobId: string) => removeJobMock(jobId),
  }));
});

afterEach(() => {
  session.typingController = originalSessionTypingController;
  session.startProcessing = originalSessionStartProcessing;
  mock.restore();
});

describe("drainDeferredQueue", () => {
  it("does not drain when a driver is already running", async () => {
    isAnyDriverRunningMock = mock(() => true);

    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31001;

    deferredQueue.enqueueDeferredMessage({
      text: "first",
      userId: 1,
      username: "u",
      chatId,
      source: "voice",
      enqueuedAt: 1000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(1);
  });

  it("drains queued voice messages and audits processed items", async () => {
    const runningStates = [false, false, true];
    isAnyDriverRunningMock = mock(() => runningStates.shift() ?? true);

    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31002;

    deferredQueue.enqueueDeferredMessage({
      text: "voice one",
      userId: 42,
      username: "queue-user",
      chatId,
      source: "voice",
      enqueuedAt: 1000,
    });

    deferredQueue.enqueueDeferredMessage({
      text: "voice two",
      userId: 42,
      username: "queue-user",
      chatId,
      source: "voice",
      enqueuedAt: 2000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(runMessageWithActiveDriverMock.mock.calls[0]?.[0]).toMatchObject({
      message: "voice one",
      userId: 42,
      username: "queue-user",
      chatId,
      ctx,
    });
    expect(auditLogMock).toHaveBeenCalledWith(
      42,
      "queue-user",
      "VOICE_QUEUED",
      "voice one",
      "queued response",
      expect.objectContaining({
        request_id: expect.any(String),
        chat_id: chatId,
        source: "voice",
      })
    );
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(1);
    expect(typingStopMock).toHaveBeenCalledTimes(1);
  });

  it("replies once on non-cancel error and stops draining", async () => {
    runMessageWithActiveDriverMock = mock(async () => {
      throw new Error("boom");
    });

    const deferredQueue = await loadDeferredQueueModule();
    const { ctx, replies } = makeCtx();
    const chatId = 31003;

    deferredQueue.enqueueDeferredMessage({
      text: "first",
      userId: 99,
      username: "err-user",
      chatId,
      source: "voice",
      enqueuedAt: 1000,
    });

    deferredQueue.enqueueDeferredMessage({
      text: "second",
      userId: 99,
      username: "err-user",
      chatId,
      source: "voice",
      enqueuedAt: 2000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(auditLogMock).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("❌ Error: Error: boom");
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(1);
  });

  it("preserves queued text messages while driver is running, then drains in FIFO order", async () => {
    isAnyDriverRunningMock = mock(() => true);

    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31004;

    deferredQueue.enqueueDeferredMessage({
      text: "text one",
      userId: 7,
      username: "text-user",
      chatId,
      source: "text",
      enqueuedAt: 1000,
    });

    deferredQueue.enqueueDeferredMessage({
      text: "text two",
      userId: 7,
      username: "text-user",
      chatId,
      source: "text",
      enqueuedAt: 2000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(2);

    isAnyDriverRunningMock = mock(() => false);

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(2);
    expect(runMessageWithActiveDriverMock.mock.calls[0]?.[0]).toMatchObject({
      message: "text one",
      userId: 7,
      username: "text-user",
      chatId,
      ctx,
    });
    expect(runMessageWithActiveDriverMock.mock.calls[1]?.[0]).toMatchObject({
      message: "text two",
      userId: 7,
      username: "text-user",
      chatId,
      ctx,
    });
    expect(auditLogMock).toHaveBeenCalledWith(
      7,
      "text-user",
      "TEXT_QUEUED",
      "text one",
      "queued response",
      expect.objectContaining({
        request_id: expect.any(String),
        chat_id: chatId,
        source: "text",
      })
    );
    expect(auditLogMock).toHaveBeenCalledWith(
      7,
      "text-user",
      "TEXT_QUEUED",
      "text two",
      "queued response",
      expect.objectContaining({
        request_id: expect.any(String),
        chat_id: chatId,
        source: "text",
      })
    );
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
    expect(typingStopMock).toHaveBeenCalledTimes(2);
  });

  it("drains after suppression is cleared and the queue is reset", async () => {
    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31005;

    deferredQueue.enqueueDeferredMessage({
      text: "first",
      userId: 8,
      username: "suppressed-user",
      chatId,
      source: "text",
      enqueuedAt: 1000,
    });

    deferredQueue.enqueueDeferredMessage({
      text: "second",
      userId: 8,
      username: "suppressed-user",
      chatId,
      source: "text",
      enqueuedAt: 2000,
    });

    deferredQueue.enqueueDeferredMessage({
      text: "third",
      userId: 8,
      username: "suppressed-user",
      chatId,
      source: "text",
      enqueuedAt: 3000,
    });

    deferredQueue.suppressDrain(chatId);
    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(3);

    expect(deferredQueue.clearDeferredQueue(chatId)).toBe(3);
    deferredQueue.unsuppressDrain(chatId);

    deferredQueue.enqueueDeferredMessage({
      text: "post-stop",
      userId: 8,
      username: "suppressed-user",
      chatId,
      source: "text",
      enqueuedAt: 4000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(runMessageWithActiveDriverMock.mock.calls[0]?.[0]).toMatchObject({
      message: "post-stop",
      userId: 8,
      username: "suppressed-user",
      chatId,
      ctx,
    });
    expect(auditLogMock).toHaveBeenCalledWith(
      8,
      "suppressed-user",
      "TEXT_QUEUED",
      "post-stop",
      "queued response",
      expect.objectContaining({
        request_id: expect.any(String),
        chat_id: chatId,
        source: "text",
      })
    );
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
  });

  it("drains queued cron items after queued user messages", async () => {
    const executionOrder: string[] = [];
    runMessageWithActiveDriverMock = mock(async () => {
      executionOrder.push("message");
      return "queued response";
    });
    executeNonSilentCronJobMock = mock(async () => {
      executionOrder.push("cron");
    });

    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31006;

    deferredQueue.enqueueDeferredCronJob(chatId, {
      jobId: "cron-queued",
      jobType: "one-shot",
      prompt: "scheduled work",
      silent: false,
      scheduledFor: 5000,
      enqueuedAt: 1000,
    });
    deferredQueue.enqueueDeferredMessage({
      text: "user first",
      userId: 12,
      username: "priority-user",
      chatId,
      source: "text",
      enqueuedAt: 2000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(executionOrder).toEqual(["message", "cron"]);
    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(executeNonSilentCronJobMock).toHaveBeenCalledTimes(1);
    expect(executeNonSilentCronJobMock).toHaveBeenCalledWith(
      {
        id: "cron-queued",
        prompt: "scheduled work",
      },
      {
        chatId,
        userId: chatId,
      }
    );
    expect(removeJobMock).toHaveBeenCalledWith("cron-queued");
    expect(advanceRecurringJobMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
  });

  it("keeps a queued one-shot cron item until a later idle drain if user work runs first", async () => {
    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 310061;

    const firstDrainStates = [false, false, true];
    isAnyDriverRunningMock = mock(() => firstDrainStates.shift() ?? true);

    deferredQueue.enqueueDeferredCronJob(chatId, {
      jobId: "cron-preempted",
      jobType: "one-shot",
      prompt: "finish scheduled work",
      silent: false,
      scheduledFor: 5100,
      enqueuedAt: 1000,
    });
    deferredQueue.enqueueDeferredMessage({
      text: "user before cron",
      userId: 14,
      username: "preempt-user",
      chatId,
      source: "text",
      enqueuedAt: 2000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).toHaveBeenCalledTimes(1);
    expect(executeNonSilentCronJobMock).not.toHaveBeenCalled();
    expect(removeJobMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(1);
    expect(deferredQueue.getAllDeferredQueues().get(chatId)).toEqual([
      expect.objectContaining({
        kind: "cron_job",
        jobId: "cron-preempted",
        jobType: "one-shot",
      }),
    ]);

    const followUpStates = [false, false, false];
    isAnyDriverRunningMock = mock(() => followUpStates.shift() ?? false);

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(executeNonSilentCronJobMock).toHaveBeenCalledTimes(1);
    expect(executeNonSilentCronJobMock).toHaveBeenCalledWith(
      {
        id: "cron-preempted",
        prompt: "finish scheduled work",
      },
      {
        chatId,
        userId: chatId,
      }
    );
    expect(removeJobMock).toHaveBeenCalledWith("cron-preempted");
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
  });

  it("drains queued cron items when no user message is waiting", async () => {
    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31007;

    deferredQueue.enqueueDeferredCronJob(chatId, {
      jobId: "cron-only",
      jobType: "recurring",
      prompt: "cron only work",
      silent: false,
      scheduledFor: 6000,
      enqueuedAt: 3000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(runMessageWithActiveDriverMock).not.toHaveBeenCalled();
    expect(executeNonSilentCronJobMock).toHaveBeenCalledTimes(1);
    expect(executeNonSilentCronJobMock).toHaveBeenCalledWith(
      {
        id: "cron-only",
        prompt: "cron only work",
      },
      {
        chatId,
        userId: chatId,
      }
    );
    expect(advanceRecurringJobMock).toHaveBeenCalledWith("cron-only");
    expect(removeJobMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
  });

  it("drops queued cron work when the backing cron record is already gone", async () => {
    removeJobMock = mock(() => false);

    const deferredQueue = await loadDeferredQueueModule();
    const { ctx } = makeCtx();
    const chatId = 31008;

    deferredQueue.enqueueDeferredCronJob(chatId, {
      jobId: "missing-cron",
      jobType: "one-shot",
      prompt: "should not run",
      silent: false,
      scheduledFor: 7000,
      enqueuedAt: 4000,
    });

    await deferredQueue.drainDeferredQueue(ctx, chatId);

    expect(removeJobMock).toHaveBeenCalledWith("missing-cron");
    expect(executeNonSilentCronJobMock).not.toHaveBeenCalled();
    expect(deferredQueue.getDeferredQueueSize(chatId)).toBe(0);
  });
});
