/**
 * Router core — pure routing logic, no I/O.
 *
 * Extracted for unit testing. The router process (router.ts) wires this
 * up with sockets and HTTP polling.
 */
import type { Update } from "grammy/types";

// ============== Thread ID Extraction ==============

export function getThreadId(update: Update): number | null {
  const msg =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post;
  if (msg && "message_thread_id" in msg && msg.message_thread_id) {
    return msg.message_thread_id;
  }

  const cbMsg = update.callback_query?.message;
  if (cbMsg && "message_thread_id" in cbMsg) {
    const threadId = (cbMsg as import("grammy/types").Message).message_thread_id;
    if (threadId) return threadId;
  }

  return null;
}

// ============== Worker Table ==============

interface WorkerEntry {
  workerId: string;
  workingDir: string;
  threadId: number | null;
  branch: string | null;
}

export class WorkerTable {
  private workers = new Map<string, WorkerEntry>();

  add(workerId: string, workingDir: string, threadId: number | null, branch?: string | null): void {
    this.workers.set(workerId, { workerId, workingDir, threadId, branch: branch ?? null });
  }

  remove(workerId: string): void {
    this.workers.delete(workerId);
  }

  findByThread(threadId: number): string | null {
    for (const w of this.workers.values()) {
      if (w.threadId === threadId) return w.workerId;
    }
    return null;
  }

  findDefault(): string | null {
    for (const w of this.workers.values()) {
      if (w.threadId === null) return w.workerId;
    }
    return null;
  }

  findByWorkingDir(workingDir: string): string | null {
    for (const w of this.workers.values()) {
      if (w.workingDir === workingDir) return w.workerId;
    }
    return null;
  }

  getEntry(workerId: string): WorkerEntry | undefined {
    return this.workers.get(workerId);
  }

  /** True when the router is in forum-topic mode (>1 worker, or a single worker with a thread). */
  isForumMode(): boolean {
    if (this.workers.size > 1) return true;
    for (const w of this.workers.values()) {
      if (w.threadId !== null) return true;
    }
    return false;
  }

  count(): number {
    return this.workers.size;
  }

  entries(): WorkerEntry[] {
    return [...this.workers.values()];
  }
}

// ============== Update Cache ==============

interface CachedUpdate {
  update: Update;
  timestamp: number;
}

const DEFAULT_THREAD_KEY = 0;

export class UpdateCache {
  constructor(
    private maxSize: number = 100,
    private ttlMs: number = 5 * 60 * 1000,
    private maxThreads: number = 1000,
  ) {}

  private cache = new Map<number, CachedUpdate[]>();

  /** Remove the thread with the oldest most-recent update. */
  private evictOldestThread(): void {
    let oldestThread: number | null = null;
    let oldestTimestamp = Infinity;
    for (const [tid, entries] of this.cache) {
      if (entries.length === 0) {
        this.cache.delete(tid);
        return;
      }
      const newest = entries[entries.length - 1]!.timestamp;
      if (newest < oldestTimestamp) {
        oldestTimestamp = newest;
        oldestThread = tid;
      }
    }
    if (oldestThread !== null) this.cache.delete(oldestThread);
  }

  /** Buffer an update for a thread that has no connected worker yet. */
  push(threadId: number, update: Update): void {
    if (!this.cache.has(threadId) && this.cache.size >= this.maxThreads) {
      this.evictOldestThread();
    }
    const list = this.cache.get(threadId) ?? [];
    list.push({ update, timestamp: Date.now() });
    while (list.length > this.maxSize) list.shift();
    this.cache.set(threadId, list);
  }

  drain(threadId: number): Update[] {
    const list = this.cache.get(threadId) ?? [];
    this.cache.delete(threadId);
    const cutoff = Date.now() - this.ttlMs;
    return list.filter(e => e.timestamp >= cutoff).map(e => e.update);
  }
}

// ============== Topic Naming ==============

const EMOJI_PALETTE = [
  "🐢", "🦊", "🐙", "🦉", "🐬", "🦎", "🐝", "🦋", "🐳", "🦈",
  "🐺", "🦅", "🐸", "🦇", "🐍", "🦑", "🐧", "🦜", "🐋", "🦫",
  "🐊", "🦩", "🐠", "🦚", "🐾", "🌵", "🌊", "🔥", "⚡", "🌸",
  "🍄", "🎯", "🚀", "💎", "🔮", "🎪", "🏔️", "🌋", "🎸", "🎭",
  "🧩", "🎲", "🪐", "🌙", "☀️", "🌈", "🍀", "🌻", "🎵", "🏴‍☠️",
];

export function pickEmoji(workingDir: string): string {
  let hash = 0;
  for (let i = 0; i < workingDir.length; i++) {
    hash = ((hash * 31) + workingDir.charCodeAt(i)) >>> 0;
  }
  return EMOJI_PALETTE[hash % EMOJI_PALETTE.length]!;
}

export function generateTopicName(
  workingDir: string,
  branch?: string | null,
): string {
  const emoji = pickEmoji(workingDir);
  const base = workingDir.split("/").pop() || workingDir;
  let name: string;
  if (branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
    name = `${emoji} ${base} / ${branch}`;
  } else {
    name = `${emoji} ${base}`;
  }
  // Telegram createForumTopic limits name to 128 characters.
  // Use Array.from to split on Unicode code points, not UTF-16 code units,
  // so multi-byte emoji at the boundary aren't corrupted.
  const codePoints = Array.from(name);
  if (codePoints.length > 128) {
    name = codePoints.slice(0, 125).join("") + "...";
  }
  return name;
}

// ============== Route Decision ==============

export type RouteResult =
  | { type: "forward"; workerId: string; update: Update }
  | { type: "cached"; threadId: number }
  | { type: "redirect"; chatId: number }
  | { type: "ack_callback"; callbackQueryId: string }
  | { type: "drop" };

/**
 * Decide where a Telegram update should go.
 *
 * DM mode (single worker, no thread): forward everything to that worker.
 * Forum mode (workers have threads): route by thread_id, redirect if non-threaded.
 * No workers: buffer in cache until one connects.
 */
export function routeUpdate(
  workers: WorkerTable,
  cache: UpdateCache,
  update: Update,
): RouteResult {
  const threadId = getThreadId(update);

  if (workers.count() === 0) {
    cache.push(threadId ?? DEFAULT_THREAD_KEY, update);
    return { type: "cached", threadId: threadId ?? DEFAULT_THREAD_KEY };
  }

  // Single worker without a forum thread → DM mode, forward everything
  if (!workers.isForumMode()) {
    const defaultId = workers.findDefault();
    if (defaultId) {
      return { type: "forward", workerId: defaultId, update };
    }
  }

  // Multi-worker mode (or single worker with threadId)
  if (threadId !== null) {
    const workerId = workers.findByThread(threadId);
    if (workerId) {
      return { type: "forward", workerId, update };
    }
    cache.push(threadId, update);
    return { type: "cached", threadId };
  }

  // Non-thread update in multi-worker mode
  if (update.callback_query) {
    return { type: "ack_callback", callbackQueryId: update.callback_query.id };
  }

  const msg = update.message ?? update.edited_message;
  if (
    msg &&
    ("text" in msg || "voice" in msg || "photo" in msg ||
     "document" in msg || "video" in msg || "audio" in msg)
  ) {
    return { type: "redirect", chatId: msg.chat.id };
  }

  return { type: "drop" };
}
