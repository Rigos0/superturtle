/**
 * SuperTurtle Router — dedicated Telegram polling process.
 *
 * Polls getUpdates once and routes updates to project instances via Unix
 * domain sockets. Each project gets its own bot process with its own Claude
 * session — the router just handles Telegram I/O so they don't conflict
 * (multiple getUpdates callers on the same token cause 409 errors).
 *
 * Why a separate process instead of in-process routing: each project needs
 * its own Claude session with its own working directory. A single-process
 * design would need multiple sessions or context-switching — basically
 * re-inventing multi-process with more coupling.
 *
 * Started by `superturtle start`, runs persistently.
 * Usage: TELEGRAM_BOT_TOKEN=... bun run src/router.ts
 */
// Requires Bun runtime (uses Bun.sleep)
import * as net from "net";
import type { Socket } from "net";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";
import { WorkerTable, UpdateCache, routeUpdate, getThreadId, generateTopicName } from "./router-core";
import type { Update } from "grammy/types";

// ============== Config ==============

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("[router] TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const TOKEN_PREFIX = BOT_TOKEN.split(":")[0]!;
const HOME = homedir();
const GLOBAL_DIR = resolve(HOME, ".superturtle");
const SOCK_PATH = resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.sock`);
const PID_PATH = resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.pid`);
const OFFSET_PATH = resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.offset`);
const PROJECTS_PATH = resolve(GLOBAL_DIR, "projects.json");
const SHARED_DIR = resolve(GLOBAL_DIR, "shared", TOKEN_PREFIX);
const DETECT_FORUM_REQUEST = resolve(SHARED_DIR, "detect_forum.request");
const DETECT_FORUM_RESPONSE = resolve(SHARED_DIR, "detect_forum.response");

mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });

// ============== State ==============

const workers = new WorkerTable();
const cache = new UpdateCache(100, 5 * 60 * 1000);
const socketMap = new Map<string, Socket>();
const MAX_BUFFER = 1024 * 1024;
let server: net.Server | null = null;
let nextWorkerId = 1;
let offset = 0;
let running = true;
let shutdownCalled = false;

// Load persisted offset
try {
  offset = parseInt(readFileSync(OFFSET_PATH, "utf-8").trim(), 10) || 0;
} catch {
  offset = 0;
}

// ============== Telegram API ==============

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

// Allow overriding the Telegram API base URL for testing.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

async function telegramApi(
  method: string,
  params: Record<string, unknown> = {},
): Promise<TelegramResponse> {
  const resp = await fetch(
    `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(40_000),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram ${method}: HTTP ${resp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  return resp.json() as Promise<TelegramResponse>;
}

function sendTelegramMessage(chatId: number, text: string, threadId?: number): void {
  const params: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId) params.message_thread_id = threadId;
  telegramApi("sendMessage", params).catch(err =>
    console.error("[router] Failed to send message:", err),
  );
}

// ============== Worker Communication ==============

function sendToWorker(workerId: string, msg: object): boolean {
  const socket = socketMap.get(workerId);
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(JSON.stringify(msg) + "\n");
    return true;
  } catch {
    return false;
  }
}

function destroyWorkerSocket(workerId: string, delayMs = 100): void {
  const socket = socketMap.get(workerId);
  if (socket) setTimeout(() => socket.destroy(), delayMs);
}

// ============== Route Result Handling ==============

function handleRouteResult(
  result: ReturnType<typeof routeUpdate>,
): void {
  switch (result.type) {
    case "forward": {
      const sent = sendToWorker(result.workerId, {
        type: "update",
        data: result.update,
      });
      if (!sent) {
        const threadId = getThreadId(result.update) ?? 0;
        cache.push(threadId, result.update);
      }
      break;
    }
    case "redirect":
      sendTelegramMessage(result.chatId, buildRedirectMessage());
      break;
    case "ack_callback":
      telegramApi("answerCallbackQuery", {
        callback_query_id: result.callbackQueryId,
        text: "Use a project topic",
      }).catch(() => {});
      break;
    case "cached":
    case "drop":
      break;
  }
}

// Cached redirect message — rebuilt when the registry changes (worker registration),
// avoids reading projects.json from disk on every non-threaded message.
let cachedRedirectMsg: string | null = null;

function invalidateRedirectCache(): void {
  cachedRedirectMsg = null;
}

function buildRedirectMessage(): string {
  if (cachedRedirectMsg !== null) return cachedRedirectMsg;

  const fallback = "This bot is running in multi-project mode. Send your message in a project topic.";
  try {
    const registry = loadRegistry();
    const projects = registry.projects || {};
    const names = Object.values(projects).map(p => p.name || "unnamed");
    if (names.length === 0) {
      cachedRedirectMsg = fallback;
      return cachedRedirectMsg;
    }
    cachedRedirectMsg = [
      "This bot is running in multi-project mode.",
      "Send your message in a project topic:",
      "",
      ...names.map(n => `  📁 ${n}`),
    ].join("\n");
    return cachedRedirectMsg;
  } catch {
    return fallback;
  }
}

// ============== Forum Detection ==============

/**
 * Check if `superturtle init` is waiting for forum group detection.
 * When the CLI writes detect_forum.request, we watch for any supergroup
 * message and write back the chat_id so the CLI can configure the forum.
 */
function checkForumDetection(update: Update): void {
  if (!existsSync(DETECT_FORUM_REQUEST)) return;
  const msg = update.message;
  if (!msg) return;
  if (msg.chat.type !== "supergroup" || !("is_forum" in msg.chat && msg.chat.is_forum)) return;

  const chatId = msg.chat.id;
  console.log(`[router] Detected forum group: ${chatId}`);
  try {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(DETECT_FORUM_RESPONSE, JSON.stringify({ chatId }));
    unlinkSync(DETECT_FORUM_REQUEST);
  } catch (err) {
    console.warn("[router] Failed to write forum detection response:", err);
  }
}

// ============== Project Registry ==============

function loadRegistry(): { forumChatId?: number; projects?: Record<string, { threadId?: number; name?: string }> } {
  try {
    return JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// Serialize registry writes so concurrent topic creations for different
// directories don't clobber each other (read-modify-write race).
let registryWriteChain = Promise.resolve();
function registryWriteLock(fn: () => void): Promise<void> {
  registryWriteChain = registryWriteChain.then(fn, fn);
  return registryWriteChain;
}

function saveRegistry(registry: object): void {
  const tmpPath = PROJECTS_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
  renameSync(tmpPath, PROJECTS_PATH);
  invalidateRedirectCache();
}

// ============== Worker Registration ==============

// Per-directory async mutex: prevents two registrations for the same dir from
// racing past the duplicate check or creating duplicate forum topics.
const registrationLocks = new Map<string, Promise<void>>();

function serializeRegistration(workingDir: string, fn: () => Promise<void>): void {
  const prev = registrationLocks.get(workingDir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  registrationLocks.set(workingDir, next);
  next.then(() => {
    if (registrationLocks.get(workingDir) === next) registrationLocks.delete(workingDir);
  });
}

/** Check if workingDir is already owned by another worker. */
function isDuplicateWorker(workerId: string, workingDir: string): boolean {
  if (!workingDir) return false;
  const existingId = workers.findByWorkingDir(workingDir);
  return existingId !== null && existingId !== workerId;
}

/** Send a nudge to the existing worker's topic so the user knows where to go. */
function nudgeExistingTopic(workingDir: string): void {
  const existingId = workers.findByWorkingDir(workingDir);
  if (!existingId) return;
  const entry = workers.getEntry(existingId);
  if (!entry?.threadId) return;
  const registry = loadRegistry();
  if (!registry.forumChatId) return;
  sendTelegramMessage(
    registry.forumChatId,
    "👋 Hey! I'm already running here. Send me a message to continue.",
    entry.threadId,
  );
}

/** Send any cached updates for this thread to the newly connected worker. */
function drainCachedUpdates(workerId: string, threadId: number | null): void {
  const cached = cache.drain(threadId ?? 0);
  for (const update of cached) {
    sendToWorker(workerId, { type: "update", data: update });
  }
}

/**
 * When a new worker gets a thread, any existing threadless ("default") worker
 * also needs one — otherwise it would swallow all non-threaded messages.
 */
function upgradeDefaultWorker(excludeWorkerId: string): void {
  const defaultId = workers.findDefault();
  if (!defaultId || defaultId === excludeWorkerId) return;
  const defaultEntry = workers.getEntry(defaultId);
  if (!defaultEntry) return;
  serializeRegistration(defaultEntry.workingDir, () => assignOrCreateThread(defaultId));
}

async function handleWorkerRegister(
  workerId: string,
  msg: { workingDir?: string; threadId?: number | null; branch?: string | null },
): Promise<void> {
  const workingDir = msg.workingDir || "";
  const threadId = msg.threadId ?? null;
  const branch = msg.branch ?? null;

  if (isDuplicateWorker(workerId, workingDir)) {
    console.log(`[router] Rejecting worker ${workerId}: dir=${workingDir} already owned by ${workers.findByWorkingDir(workingDir)}`);
    sendToWorker(workerId, { type: "reject", reason: "SuperTurtle is already running in this directory." });
    nudgeExistingTopic(workingDir);
    destroyWorkerSocket(workerId);
    return;
  }

  // Resolve thread BEFORE adding to worker table to avoid a window where
  // the worker is registered with threadId=null while a thread exists.
  const resolvedThreadId = await resolveThread(workerId, workingDir, threadId, branch);
  workers.add(workerId, workingDir, resolvedThreadId, branch);
  console.log(
    `[router] Worker ${workerId} registered: dir=${workingDir} thread=${resolvedThreadId} (${workers.count()} total)`,
  );

  drainCachedUpdates(workerId, resolvedThreadId);

  if (resolvedThreadId !== null) {
    upgradeDefaultWorker(workerId);
  }
}

// ============== Thread Resolution ==============

/** Tell a worker which forum thread it should use. */
function notifyThreadAssignment(workerId: string, threadId: number, forumChatId: number | null): void {
  sendToWorker(workerId, { type: "assign_thread", threadId, forumChatId });
}

/** Look up an existing thread for this directory in the registry. */
function lookupRegistryThread(workingDir: string): { threadId: number; forumChatId: number | null } | null {
  const registry = loadRegistry();
  const entry = (registry.projects || {})[workingDir];
  if (!entry?.threadId) return null;
  return { threadId: entry.threadId, forumChatId: registry.forumChatId || null };
}

/** Get the forum chat ID from the registry, or null if not configured. */
function getForumChatId(): number | null {
  return loadRegistry().forumChatId || null;
}

/**
 * Create a forum topic and persist it in the registry.
 * Returns the new threadId, or null if creation failed.
 */
async function createForumTopic(
  forumChatId: number,
  topicName: string,
  workingDir: string,
): Promise<number | null> {
  try {
    const result = await telegramApi("createForumTopic", {
      chat_id: forumChatId,
      name: topicName,
    });
    const threadResult = result.result as Record<string, unknown> | undefined;
    const newThreadId = threadResult?.message_thread_id;
    if (!result.ok || typeof newThreadId !== "number") return null;

    await registryWriteLock(() => {
      const freshRegistry = loadRegistry();
      freshRegistry.projects = freshRegistry.projects || {};
      freshRegistry.projects[workingDir] = { threadId: newThreadId, name: topicName };
      saveRegistry(freshRegistry);
    });

    console.log(`[router] Created topic "${topicName}" (thread ${newThreadId}) for ${workingDir}`);
    return newThreadId;
  } catch (err) {
    console.error("[router] Failed to create forum topic:", err);
    return null;
  }
}

/**
 * Resolve a thread for a worker: use provided threadId, look up registry, or auto-create.
 * Returns the final threadId (null if single-instance mode).
 */
async function resolveThread(
  workerId: string,
  workingDir: string,
  threadId: number | null,
  branch: string | null,
): Promise<number | null> {
  // Explicit thread — use as-is
  if (threadId !== null) return threadId;

  // Check registry for existing assignment
  const existing = lookupRegistryThread(workingDir);
  if (existing) {
    notifyThreadAssignment(workerId, existing.threadId, existing.forumChatId);
    return existing.threadId;
  }

  // No forum group configured → single-instance mode
  const forumChatId = getForumChatId();
  if (!forumChatId) return null;

  // Auto-create a forum topic for this project
  const topicName = generateTopicName(workingDir, branch);
  const newThreadId = await createForumTopic(forumChatId, topicName, workingDir);
  if (newThreadId === null) {
    console.warn(
      `[router] Worker ${workerId} has no thread (topic creation failed). ` +
      `In multi-worker mode, it will receive non-threaded updates only.`,
    );
    return null;
  }

  notifyThreadAssignment(workerId, newThreadId, forumChatId);
  sendTelegramMessage(forumChatId, `Ready! Send messages here to work on ${basename(workingDir)}.`, newThreadId);
  return newThreadId;
}

/**
 * Try to assign or create a thread for a worker that currently has threadId=null.
 */
async function assignOrCreateThread(workerId: string): Promise<void> {
  const entry = workers.getEntry(workerId);
  if (!entry || entry.threadId !== null) return;

  const resolvedThreadId = await resolveThread(workerId, entry.workingDir, null, entry.branch);
  if (resolvedThreadId !== null) {
    workers.add(workerId, entry.workingDir, resolvedThreadId, entry.branch);
    drainCachedUpdates(workerId, resolvedThreadId);
  }
}

// ============== Socket Server ==============

/** Probe an existing socket to see if it's alive. */
async function isSocketAlive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise<boolean>((done) => {
    const probe = net.connect(path);
    probe.setTimeout(5000, () => { probe.destroy(); done(false); });
    probe.on("connect", () => { probe.destroy(); done(true); });
    probe.on("error", () => { done(false); });
  });
}

/**
 * Parse newline-delimited JSON from a socket buffer.
 * Calls handler for each complete line. Returns the remaining partial buffer.
 */
function parseLines(buffer: string, handler: (line: string) => void): string {
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) handler(line);
  }
  return buffer;
}

/** Handle a new worker connection: parse newline-delimited JSON, dispatch messages. */
function handleConnection(socket: Socket): void {
  const workerId = `w${nextWorkerId++}`;
  socketMap.set(workerId, socket);
  console.log(`[router] Connection from worker ${workerId}`);

  let buffer = "";

  socket.on("data", (data) => {
    buffer += data.toString();
    if (buffer.length > MAX_BUFFER) {
      console.error(`[router] Buffer overflow from worker ${workerId}, disconnecting`);
      socket.destroy();
      buffer = "";
      return;
    }
    buffer = parseLines(buffer, (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "register") {
          serializeRegistration(msg.workingDir || "", () =>
            handleWorkerRegister(workerId, msg).catch(err =>
              console.error("[router] Worker registration error:", err),
            ),
          );
        }
      } catch (err) {
        console.error("[router] Bad message from worker:", err);
      }
    });
  });

  socket.on("close", () => {
    workers.remove(workerId);
    socketMap.delete(workerId);
    console.log(`[router] Worker ${workerId} disconnected (${workers.count()} remaining)`);
  });

  socket.on("error", () => {
    workers.remove(workerId);
    socketMap.delete(workerId);
  });
}

async function main(): Promise<void> {
  // Exit if another router is already running; clean up stale sockets
  if (await isSocketAlive(SOCK_PATH)) {
    console.log(`[router] Another router is already running on ${SOCK_PATH}`);
    process.exit(0);
  }
  try { unlinkSync(SOCK_PATH); } catch {}

  server = net.createServer(handleConnection);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log("[router] Another router started first");
      process.exit(0);
    }
    throw err;
  });

  // Set restrictive umask so the socket is created with 0o600 (no TOCTOU gap)
  const oldUmask = process.umask(0o177);
  server.listen(SOCK_PATH, () => {
    process.umask(oldUmask);
    console.log(`[router] Listening on ${SOCK_PATH} (PID ${process.pid})`);
    writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  });

  // Start polling
  pollLoop();
}

// ============== Polling Loop ==============

function persistOffset(): void {
  try {
    writeFileSync(OFFSET_PATH, String(offset), "utf-8");
  } catch (err) {
    console.warn("[router] Failed to persist offset:", err);
  }
}

async function pollLoop(): Promise<void> {
  // Delete webhook and drop pending updates on startup
  try {
    await telegramApi("deleteWebhook", { drop_pending_updates: true });
    console.log("[router] Webhook deleted");
  } catch (err) {
    console.error("[router] Failed to delete webhook:", err);
  }

  while (running) {
    try {
      const result = await telegramApi("getUpdates", {
        offset,
        timeout: 30,
        limit: 100,
      });

      if (!result.ok || !Array.isArray(result.result)) {
        console.error(
          "[router] getUpdates error:",
          result.description || "unknown",
        );
        await Bun.sleep(2000);
        continue;
      }

      const updates: Update[] = result.result;
      if (updates.length === 0) continue;

      offset = Math.max(...updates.map((u) => u.update_id)) + 1;
      persistOffset();

      for (const update of updates) {
        checkForumDetection(update);
        const decision = routeUpdate(workers, cache, update);
        handleRouteResult(decision);
      }
    } catch (err: unknown) {
      if (!running) break;
      console.error("[router] Poll error:", err);
      await Bun.sleep(2000);
    }
  }
}

// ============== Graceful Shutdown ==============

function shutdown(): void {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.log("[router] Shutting down...");
  running = false;
  if (server) server.close();
  for (const socket of socketMap.values()) {
    socket.destroy();
  }
  try { unlinkSync(SOCK_PATH); } catch {}
  try { unlinkSync(PID_PATH); } catch {}
  try { unlinkSync(DETECT_FORUM_REQUEST); } catch {}
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (err) => {
  console.error("[router] Unhandled rejection:", err);
  shutdown();
});
process.on("uncaughtException", (err) => {
  console.error("[router] Uncaught exception:", err);
  shutdown();
});

// Start
main();
