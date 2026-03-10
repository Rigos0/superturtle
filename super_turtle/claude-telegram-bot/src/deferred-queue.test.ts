import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearDeferredQueue,
  dequeueDeferredMessage,
  enqueueDeferredCronJob,
  enqueueDeferredMessage,
  getAllDeferredQueues,
  getDeferredQueueSize,
  isCronJobQueued,
} from "./deferred-queue";

function clearAllDeferredQueuesForTest(): void {
  for (const chatId of getAllDeferredQueues().keys()) {
    clearDeferredQueue(chatId);
  }
}

beforeEach(() => {
  clearAllDeferredQueuesForTest();
});

afterEach(() => {
  clearAllDeferredQueuesForTest();
});

describe("deferred queue", () => {
  it("enqueues and dequeues FIFO", () => {
    const chatId = 99101;

    enqueueDeferredMessage({
      text: "first",
      userId: 1,
      username: "u",
      chatId,
      source: "voice",
      enqueuedAt: 1000,
    });

    enqueueDeferredMessage({
      text: "second",
      userId: 1,
      username: "u",
      chatId,
      source: "voice",
      enqueuedAt: 2000,
    });

    expect(getDeferredQueueSize(chatId)).toBe(2);
    expect(dequeueDeferredMessage(chatId)?.text).toBe("first");
    expect(dequeueDeferredMessage(chatId)?.text).toBe("second");
    expect(getDeferredQueueSize(chatId)).toBe(0);
  });

  it("dedupes immediate duplicate transcripts", () => {
    const chatId = 99102;

    enqueueDeferredMessage({
      text: "same",
      userId: 1,
      username: "u",
      chatId,
      source: "voice",
      enqueuedAt: 1000,
    });

    enqueueDeferredMessage({
      text: "same",
      userId: 1,
      username: "u",
      chatId,
      source: "voice",
      enqueuedAt: 5000,
    });

    expect(getDeferredQueueSize(chatId)).toBe(1);
  });

  it("keeps max 10 queued items", () => {
    const chatId = 99103;

    for (let i = 0; i < 12; i++) {
      enqueueDeferredMessage({
        text: `msg-${i}`,
        userId: 1,
        username: "u",
        chatId,
        source: "voice",
        enqueuedAt: 10000 + i,
      });
    }

    expect(getDeferredQueueSize(chatId)).toBe(10);
    expect(dequeueDeferredMessage(chatId)?.text).toBe("msg-2");
  });

  it("tracks queued cron jobs by job id", () => {
    const chatId = 99104;

    expect(enqueueDeferredCronJob(chatId, {
      jobId: "cron-1",
      jobType: "one-shot",
      prompt: "run report",
      silent: false,
      scheduledFor: 2000,
      enqueuedAt: 1000,
    })).toBe(true);

    expect(isCronJobQueued(chatId, "cron-1")).toBe(true);
    expect(isCronJobQueued(chatId, "missing")).toBe(false);
    expect(getDeferredQueueSize(chatId)).toBe(1);
    expect(dequeueDeferredMessage(chatId)).toBeUndefined();
  });

  it("dequeues the next user message even when cron items are queued", () => {
    const chatId = 99105;

    expect(enqueueDeferredCronJob(chatId, {
      jobId: "cron-2",
      jobType: "recurring",
      prompt: "cron first",
      silent: false,
      scheduledFor: 2000,
      enqueuedAt: 1000,
    })).toBe(true);

    enqueueDeferredMessage({
      text: "message second",
      userId: 1,
      username: "u",
      chatId,
      source: "text",
      enqueuedAt: 2000,
    });

    expect(dequeueDeferredMessage(chatId)?.text).toBe("message second");
    expect(isCronJobQueued(chatId, "cron-2")).toBe(true);
  });
});
