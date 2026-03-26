import type { Context } from "grammy";
import type { CronJob, CronJobKind, CronSupervisionMode } from "./cron";
import { advanceRecurringJob, removeJob } from "./cron";
import { executeNonSilentCronJob } from "./cron-execution";
import { session } from "./session";
import {
  auditLog,
  generateRequestId,
  sanitizeUserVisibleErrorMessage,
  startTypingIndicator,
} from "./utils";
import { isAnyDriverRunning, runMessageWithActiveDriver } from "./handlers/driver-routing";
import { StreamingState, createStatusCallback, getStreamingState } from "./handlers/streaming";
import { eventLog } from "./logger";

export interface DeferredMessage {
  kind: "user_message";
  text: string;
  userId: number;
  username: string;
  chatId: number;
  source: "voice" | "text";
  enqueuedAt: number;
}

export type DeferredMessageInput = Omit<DeferredMessage, "kind">;

export interface DeferredCronJob {
  kind: "cron_job";
  chatId: number;
  jobId: string;
  jobType: CronJob["type"];
  jobKind?: CronJobKind;
  workerName?: string;
  supervisionMode?: CronSupervisionMode;
  prompt: string;
  silent: boolean;
  scheduledFor: number;
  enqueuedAt: number;
}

export type DeferredCronJobInput = Omit<DeferredCronJob, "kind" | "chatId">;

export type DeferredQueueItem = DeferredMessage | DeferredCronJob;

function toDeferredMessage(item: DeferredMessageInput): DeferredMessage {
  return {
    kind: "user_message",
    ...item,
  };
}

function toDeferredCronJob(chatId: number, job: DeferredCronJobInput): DeferredCronJob {
  return {
    kind: "cron_job",
    chatId,
    ...job,
  };
}

function isDeferredMessage(item: DeferredQueueItem): item is DeferredMessage {
  return item.kind === "user_message";
}

function isDeferredCronJob(item: DeferredQueueItem): item is DeferredCronJob {
  return item.kind === "cron_job";
}

export function makeDrainItemNotifier(
  ctx: Context,
  chatId: number
): (msg: DeferredMessage) => Promise<void> {
  return async (msg: DeferredMessage): Promise<void> => {
    const preview = msg.text.replace(/\s+/g, " ").trim();
    const truncated = preview.length > 40 ? `${preview.slice(0, 40)}…` : preview;
    const notice = await ctx.reply(
      truncated ? `💬 Processing queued message…\n${truncated}` : "💬 Processing queued message…"
    );
    const state = getStreamingState(chatId);
    if (state) {
      state.toolMessages.push(notice);
    }
  };
}

const MAX_USER_MESSAGES_PER_CHAT = 10;
const MAX_CRON_ITEMS_PER_CHAT = 10;
const DEDUPE_WINDOW_MS = 5000;

const queues = new Map<number, DeferredQueueItem[]>();
const drainingChats = new Set<number>();

/**
 * Drain suppression is per-chat.
 * Used by stop handlers to prevent finally-block drains from processing
 * queued messages right after the user said stop, without affecting other chats.
 */
const drainSuppressedChats = new Set<number>();

/**
 * Clear all queued messages for a given chat. Returns the number cleared.
 */
export function clearDeferredQueue(chatId: number): number {
  const queue = queues.get(chatId);
  const count = queue?.length ?? 0;
  queues.delete(chatId);
  return count;
}

function countItemsByKind(
  queue: ReadonlyArray<DeferredQueueItem>,
  kind: DeferredQueueItem["kind"]
): number {
  return queue.reduce((count, item) => count + (item.kind === kind ? 1 : 0), 0);
}

function trimOldestItemOfKind(
  queue: DeferredQueueItem[],
  kind: DeferredQueueItem["kind"]
): DeferredQueueItem | undefined {
  const index = queue.findIndex((item) => item.kind === kind);
  if (index === -1) {
    return undefined;
  }

  const [trimmed] = queue.splice(index, 1);
  return trimmed;
}

/**
 * Suppress drain for a chat — prevents drainDeferredQueue() from processing items.
 * Called at the start of stop to win the race against finally-block drains for that chat.
 */
export function suppressDrain(chatId: number): void {
  drainSuppressedChats.add(chatId);
}

/**
 * Re-enable drain for a chat. Called when the next non-stop message starts processing.
 */
export function unsuppressDrain(chatId: number): void {
  drainSuppressedChats.delete(chatId);
}

export function enqueueDeferredMessage(item: DeferredMessageInput): number {
  const normalized = toDeferredMessage(item);
  const queue = queues.get(normalized.chatId) || [];
  const last = queue[queue.length - 1];
  if (
    last &&
    isDeferredMessage(last) &&
    last.text.trim() === item.text.trim() &&
    normalized.enqueuedAt - last.enqueuedAt <= DEDUPE_WINDOW_MS
  ) {
    queues.set(normalized.chatId, queue);
    eventLog.info({
      event: "deferred_queue.dedupe",
      chatId: normalized.chatId,
      userId: normalized.userId,
      source: normalized.source,
      queueSize: queue.length,
    });
    return queue.length;
  }

  queue.push(normalized);
  const trimmed = countItemsByKind(queue, "user_message") - MAX_USER_MESSAGES_PER_CHAT;
  for (let i = 0; i < trimmed; i++) {
    trimOldestItemOfKind(queue, "user_message");
  }

  queues.set(normalized.chatId, queue);
  eventLog.info({
    event: "deferred_queue.enqueued",
    chatId: normalized.chatId,
    userId: normalized.userId,
    source: normalized.source,
    queueSize: queue.length,
    textLength: normalized.text.length,
  });
  return queue.length;
}

export function enqueueDeferredCronJob(
  chatId: number,
  job: DeferredCronJobInput
): boolean {
  const queue = queues.get(chatId) || [];
  const normalized = toDeferredCronJob(chatId, job);

  if (normalized.jobType === "recurring") {
    const existingIndex = queue.findIndex(
      (item) =>
        item.kind === "cron_job" &&
        item.jobType === "recurring" &&
        item.jobId === normalized.jobId
    );
    if (existingIndex !== -1) {
      const existing = queue[existingIndex];
      if (existing && isDeferredCronJob(existing)) {
        queue[existingIndex] = {
          ...existing,
          ...normalized,
          scheduledFor: Math.max(existing.scheduledFor, normalized.scheduledFor),
        };
        queues.set(chatId, queue);
        eventLog.info({
          event: "deferred_queue.cron_coalesced",
          chatId,
          cronJobId: normalized.jobId,
          cronJobType: normalized.jobType,
          queueSize: queue.length,
          scheduledFor: queue[existingIndex]!.scheduledFor,
        });
        return false;
      }
    }
  }

  queue.push(normalized);
  const trimmed = countItemsByKind(queue, "cron_job") - MAX_CRON_ITEMS_PER_CHAT;
  for (let i = 0; i < trimmed; i++) {
    const dropped = trimOldestItemOfKind(queue, "cron_job");
    if (dropped && isDeferredCronJob(dropped)) {
      eventLog.info({
        event: "deferred_queue.cron_dropped_oldest",
        chatId,
        cronJobId: dropped.jobId,
        cronJobType: dropped.jobType,
        queueSize: queue.length,
      });
    }
  }

  queues.set(chatId, queue);
  eventLog.info({
    event: "deferred_queue.cron_enqueued",
    chatId,
    cronJobId: normalized.jobId,
    cronJobType: normalized.jobType,
    queueSize: queue.length,
    scheduledFor: normalized.scheduledFor,
  });
  return true;
}

export function isCronJobQueued(chatId: number, jobId: string): boolean {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) {
    return false;
  }

  return queue.some((item) => item.kind === "cron_job" && item.jobId === jobId);
}

export function dequeueDeferredMessage(chatId: number): DeferredMessage | undefined {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) {
    return undefined;
  }

  const nextIndex = queue.findIndex(isDeferredMessage);
  if (nextIndex === -1) {
    return undefined;
  }

  const next = queue[nextIndex];
  if (!next || !isDeferredMessage(next)) {
    return undefined;
  }

  queue.splice(nextIndex, 1);
  if (queue.length === 0) {
    queues.delete(chatId);
  } else {
    queues.set(chatId, queue);
  }
  return next;
}

function dequeueNextDeferredItem(chatId: number): DeferredQueueItem | undefined {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) {
    return undefined;
  }

  const nextIndex = queue.findIndex(isDeferredMessage);
  const resolvedIndex = nextIndex === -1 ? 0 : nextIndex;
  const next = queue[resolvedIndex];
  if (!next) {
    return undefined;
  }

  queue.splice(resolvedIndex, 1);
  if (queue.length === 0) {
    queues.delete(chatId);
  } else {
    queues.set(chatId, queue);
  }
  return next;
}

export function getDeferredQueueSize(chatId: number): number {
  return queues.get(chatId)?.length || 0;
}

/**
 * Peek at all deferred queue items across all chats (for debug/diagnostics).
 * Returns a snapshot — does NOT dequeue.
 */
export function getAllDeferredQueues(): Map<number, ReadonlyArray<DeferredQueueItem>> {
  return new Map(
    Array.from(queues.entries()).map(([chatId, items]) => [chatId, [...items]])
  );
}

export async function drainDeferredQueue(
  ctx: Context,
  chatId: number,
  onDrainItem?: (msg: DeferredMessage) => Promise<void>
): Promise<void> {
  if (drainSuppressedChats.has(chatId) || drainingChats.has(chatId) || isAnyDriverRunning()) {
    return;
  }

  drainingChats.add(chatId);
  try {
    while (!isAnyDriverRunning() && !drainSuppressedChats.has(chatId)) {
      const next = dequeueNextDeferredItem(chatId);
      if (!next) {
        break;
      }

      if (isDeferredMessage(next)) {
        const stopProcessing = session.startProcessing();
        const typing = startTypingIndicator(ctx);
        session.typingController = typing;
        const requestId = generateRequestId("queue");

        try {
          eventLog.info({
            event: "deferred_queue.processing_start",
            requestId,
            chatId,
            userId: next.userId,
            source: next.source,
            queueRemaining: getDeferredQueueSize(chatId),
          });
          const state = new StreamingState();
          const statusCallback = createStatusCallback(ctx, state);
          try {
            await onDrainItem?.(next);
          } catch {
            // Ignore notification failures
          }
          const response = await runMessageWithActiveDriver({
            message: next.text,
            source: next.source === "voice" ? "queue_voice" : "queue_text",
            username: next.username,
            userId: next.userId,
            chatId: next.chatId,
            ctx,
            statusCallback,
          });

          await auditLog(
            next.userId,
            next.username,
            next.source === "voice" ? "VOICE_QUEUED" : "TEXT_QUEUED",
            next.text,
            response,
            { request_id: requestId, chat_id: chatId, source: next.source }
          );
          eventLog.info({
            event: "deferred_queue.processing_done",
            requestId,
            chatId,
            userId: next.userId,
            source: next.source,
            queueRemaining: getDeferredQueueSize(chatId),
          });
        } catch (error) {
          eventLog.error({
            event: "deferred_queue.processing_error",
            requestId,
            chatId,
            userId: next.userId,
            source: next.source,
            error: String(error).slice(0, 200),
          });
          const message = String(error).toLowerCase();
          if (!message.includes("abort") && !message.includes("cancel")) {
            await ctx.reply(
              `❌ Error: ${sanitizeUserVisibleErrorMessage(String(error)).slice(0, 200)}`
            );
          }
          break;
        } finally {
          stopProcessing();
          typing.stop();
          session.typingController = null;
        }
        continue;
      }

      if (!isDeferredCronJob(next)) {
        continue;
      }

      const requestId = generateRequestId("queue-cron");

      try {
        eventLog.info({
          event: "deferred_queue.cron_processing_start",
          requestId,
          chatId,
          cronJobId: next.jobId,
          cronJobType: next.jobType,
          queueRemaining: getDeferredQueueSize(chatId),
        });
        const advancedOrRemoved =
          next.jobType === "recurring"
            ? advanceRecurringJob(next.jobId)
            : removeJob(next.jobId);
        if (!advancedOrRemoved) {
          eventLog.warn({
            event: "deferred_queue.cron_missing",
            requestId,
            chatId,
            cronJobId: next.jobId,
            cronJobType: next.jobType,
          });
          continue;
        }
        await executeNonSilentCronJob(
          {
            id: next.jobId,
            prompt: next.prompt,
          },
          {
            chatId: next.chatId,
            userId: next.chatId,
          }
        );
        eventLog.info({
          event: "deferred_queue.cron_processing_done",
          requestId,
          chatId,
          cronJobId: next.jobId,
          cronJobType: next.jobType,
          queueRemaining: getDeferredQueueSize(chatId),
        });
      } catch (error) {
        eventLog.error({
          event: "deferred_queue.cron_processing_error",
          requestId,
          chatId,
          cronJobId: next.jobId,
          cronJobType: next.jobType,
          error: String(error).slice(0, 200),
        });
        const message = String(error).toLowerCase();
        if (!message.includes("abort") && !message.includes("cancel")) {
          await ctx.reply(
            `❌ Error: ${sanitizeUserVisibleErrorMessage(String(error)).slice(0, 200)}`
          );
        }
        break;
      }
    }
  } finally {
    drainingChats.delete(chatId);
  }
}
