import type { Context } from "grammy";
import { session } from "./session";
import { auditLog, startTypingIndicator } from "./utils";
import { isAnyDriverRunning, runMessageWithActiveDriver } from "./handlers/driver-routing";
import { StreamingState, createStatusCallback, getStreamingState } from "./handlers/streaming";

export interface DeferredMessage {
  text: string;
  userId: number;
  username: string;
  chatId: number;
  source: "voice" | "text";
  enqueuedAt: number;
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

const queues = new Map<number, DeferredMessage[]>();
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

export function enqueueDeferredMessage(item: DeferredMessage): number {
  const queue = queues.get(item.chatId) || [];
  const last = queue[queue.length - 1];
  if (
    last &&
    last.text.trim() === item.text.trim() &&
    item.enqueuedAt - last.enqueuedAt <= DEDUPE_WINDOW_MS
  ) {
    queues.set(item.chatId, queue);
    return queue.length;
  }

  queue.push(item);
  if (queue.length > MAX_QUEUE_PER_CHAT) {
    queue.shift();
  }

  queues.set(item.chatId, queue);
  return queue.length;
}

export function dequeueDeferredMessage(chatId: number): DeferredMessage | undefined {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) {
    return undefined;
  }

  const next = queue.shift();
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
 * Peek at all deferred messages across all chats (for debug/diagnostics).
 * Returns a snapshot — does NOT dequeue.
 */
export function getAllDeferredQueues(): Map<number, ReadonlyArray<DeferredMessage>> {
  return new Map(
    Array.from(queues.entries()).map(([chatId, msgs]) => [chatId, [...msgs]])
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

      try {
        const state = new StreamingState();
        const statusCallback = createStatusCallback(ctx, state);
        try {
          await onDrainItem?.(next);
        } catch {
          // Ignore notification failures
        }
        const response = await runMessageWithActiveDriver({
          message: next.text,
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
          response
        );
      } catch (error) {
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
