import type { Context } from "grammy";
import type { CronJob, CronJobKind, CronSupervisionMode } from "./cron";
import { session } from "./session";
import { auditLog, generateRequestId, startTypingIndicator } from "./utils";
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

const MAX_QUEUE_PER_CHAT = 10;
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
  if (queue.length > MAX_QUEUE_PER_CHAT) {
    queue.shift();
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

  queue.push(normalized);
  if (queue.length > MAX_QUEUE_PER_CHAT) {
    queue.shift();
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
      const next = dequeueDeferredMessage(chatId);
      if (!next) {
        break;
      }

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
          await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
        }
        break;
      } finally {
        stopProcessing();
        typing.stop();
        session.typingController = null;
      }
    }
  } finally {
    drainingChats.delete(chatId);
  }
}
