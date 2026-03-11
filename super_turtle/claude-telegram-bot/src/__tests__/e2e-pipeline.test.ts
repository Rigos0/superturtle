/**
 * E2E pipeline tests — uses the REAL bot.ts transformer and assignThread
 * function (not recreated copies) to verify thread injection end-to-end.
 *
 * Tests the full path:
 *   Mock Telegram → Router → Socket → RouterClient
 *     → real bot.handleUpdate (bot.ts) → handler → ctx.reply
 *     → real thread transformer (bot.ts) → Mock Telegram (verify thread_id)
 *
 * The only synthetic part is the handler (echo instead of Claude) — the
 * routing and thread injection pipeline is entirely production code.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { RouterClient } from "../router-client";
import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import { resolve } from "path";
import { writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from "fs";
import type { Update } from "grammy/types";

// ============== Constants ==============

const TEST_DIR = `/tmp/e2e-pipeline-${process.pid}`;
const GLOBAL_DIR = resolve(TEST_DIR, ".superturtle");
const BOT_TOKEN = "123456:E2ETEST";
const TOKEN_PREFIX = "123456";
const SOCK_PATH = resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.sock`);
const PROJECTS_PATH = resolve(GLOBAL_DIR, "projects.json");
const ROUTER_SRC = resolve(import.meta.dir, "..", "router.ts");

// ============== Mock Telegram Server ==============

interface CapturedRequest {
  method: string;
  payload: Record<string, unknown>;
}

const capturedRequests: CapturedRequest[] = [];
let updateQueue: Update[] = [];
let updateWaiters: Array<(updates: Update[]) => void> = [];

let mockServer: ReturnType<typeof Bun.serve>;

function startMock(): number {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const methodMatch = url.pathname.match(/\/bot[^/]+\/(\w+)/);
      const method = methodMatch?.[1] ?? "";
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;

      const json = (data: unknown) => Response.json({ ok: true, result: data });

      switch (method) {
        case "getMe":
          return json({
            id: 123456, is_bot: true, first_name: "E2EBot", username: "e2e_bot",
            can_join_groups: true, can_read_all_group_messages: true,
            supports_inline_queries: false,
          });

        case "deleteWebhook":
          return json(true);

        case "getUpdates": {
          if (updateQueue.length > 0) {
            const updates = [...updateQueue];
            updateQueue = [];
            return json(updates);
          }
          return new Promise<Response>((resolveResp) => {
            const timeout = setTimeout(() => {
              const idx = updateWaiters.indexOf(cb);
              if (idx >= 0) updateWaiters.splice(idx, 1);
              resolveResp(json([]));
            }, 2000);
            const cb = (updates: Update[]) => {
              clearTimeout(timeout);
              resolveResp(json(updates));
            };
            updateWaiters.push(cb);
          });
        }

        case "createForumTopic": {
          const topicId = 100 + capturedRequests.filter(r => r.method === "createForumTopic").length;
          capturedRequests.push({ method, payload: body });
          return json({
            message_thread_id: topicId,
            name: (body as Record<string, unknown>).name || "Test",
            icon_color: 0,
          });
        }

        default: {
          // Capture all outgoing calls (sendMessage, sendChatAction, etc.)
          capturedRequests.push({ method, payload: body });
          return json({
            message_id: capturedRequests.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: body.chat_id ?? 1, type: "supergroup", title: "Test" },
            text: body.text ?? "",
          });
        }
      }
    },
  });
  return mockServer.port!;
}

function enqueueUpdates(updates: Update[]): void {
  if (updateWaiters.length > 0) {
    updateWaiters.shift()!(updates);
  } else {
    updateQueue.push(...updates);
  }
}

// ============== Router Process ==============

let routerProc: ChildProcess | null = null;

function startRouter(port: number): void {
  routerProc = spawn("bun", ["run", ROUTER_SRC], {
    env: {
      ...process.env,
      HOME: TEST_DIR,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_BASE: `http://localhost:${port}`,
      NODE_ENV: "test",
    },
    stdio: "pipe",
  });
}

function stopRouter(): void {
  routerProc?.kill();
  routerProc = null;
}

async function waitForRouter(timeout = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(SOCK_PATH)) return;
    await Bun.sleep(100);
  }
  throw new Error("Router socket not found within timeout");
}

// ============== Update Factory ==============

let updateIdCounter = 5000;

function makeTextUpdate(opts: {
  chatId: number;
  userId: number;
  threadId?: number;
  text: string;
}): Update {
  const msg: Record<string, unknown> = {
    message_id: updateIdCounter,
    date: Math.floor(Date.now() / 1000),
    chat: { id: opts.chatId, type: opts.threadId ? "supergroup" : "private", title: "Test" },
    from: { id: opts.userId, is_bot: false, first_name: "Tester" },
    text: opts.text,
  };
  if (opts.threadId) {
    msg.message_thread_id = opts.threadId;
  }
  return { update_id: updateIdCounter++, message: msg } as unknown as Update;
}

// ============== Helpers ==============

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

// ============== Tests ==============

describe("E2E Pipeline (real bot.ts)", () => {
  // These are populated in beforeAll via dynamic import of the REAL bot.ts
  let bot: import("grammy").Bot;
  let assignThread: (threadId: number, forumChatId: number | null) => void;
  let runtimeForumConfig: { threadId: number | null; forumChatId: number | null };
  let mockPort: number;

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(GLOBAL_DIR, { recursive: true });

    // 1. Start mock Telegram (port known immediately)
    mockPort = startMock();

    // 2. Import the REAL bot module — the thread transformer and assignThread
    //    are production code, not recreated copies.
    const botModule = await import("../bot");
    bot = botModule.bot;
    assignThread = botModule.assignThread;
    runtimeForumConfig = botModule.runtimeForumConfig;

    // 3. Install an API interceptor that redirects to our mock.
    //    Grammy's apiRoot is captured in a closure at construction time and
    //    can't be changed later. When running in the full test suite, bot.ts
    //    may already be cached from another test file with the default apiRoot.
    //
    //    Strategy: add an outermost transformer that lets the thread transformer
    //    run (mutating payload in-place), then checks the result. If the real
    //    Telegram API failed (expected — fake token), redirect to our mock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bot.api.config.use((async (prev: any, method: string, payload: any, signal: any) => {
      const p = payload as Record<string, unknown>;
      const result = await prev(method, payload, signal);
      capturedRequests.push({ method, payload: { ...p } });
      if (result?.ok) return result;
      // Real API failed — redirect to our mock with the MUTATED payload
      const url = `http://localhost:${mockPort}/bot${bot.token}/${method}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      return await res.json();
    }) as any);

    // 4. Register a simple echo handler (we're testing routing, not Claude)
    bot.on("message:text", async (ctx) => {
      await ctx.reply(`Echo: ${ctx.message.text}`);
    });

    bot.catch((err) => {
      console.error("Bot error in e2e test:", err);
    });

    // 5. Initialize bot (sets botInfo). When running in the full suite,
    //    the module may be cached but not yet initialized. The interceptor
    //    redirects the getMe call to our mock if the real API fails.
    try {
      await bot.init();
    } catch {
      // Already initialized by another test file — that's fine
    }
  });

  afterAll(() => {
    stopRouter();
    mockServer?.stop();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    capturedRequests.length = 0;
    updateQueue = [];
    updateWaiters = [];
    // Reset forum config between tests
    runtimeForumConfig.threadId = null;
    runtimeForumConfig.forumChatId = null;
  });

  afterEach(() => {
    stopRouter();
    try { unlinkSync(SOCK_PATH); } catch {}
    try { unlinkSync(PROJECTS_PATH); } catch {}
    try { unlinkSync(resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.offset`)); } catch {}
  });

  test("forum mode: real transformer injects message_thread_id", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter(mockPort);
    await waitForRouter();

    // Create RouterClient — SAME wiring as index.ts lines 975-994
    const client = new RouterClient({
      socketPath: SOCK_PATH,
      workingDir: "/tmp/project-a",
      threadId: null,
      branch: "main",
    });

    // Wire exactly like index.ts
    client.onUpdate((update) => bot.handleUpdate(update));
    client.onAssignThread((threadId, forumChatId) => {
      // This is the REAL assignThread from bot.ts
      assignThread(threadId, forumChatId);
    });

    let rejected = false;
    client.onReject(() => { rejected = true; });

    await client.connect(5);

    // Wait for router to assign a thread (creates forum topic on mock)
    await waitFor(() => runtimeForumConfig.threadId !== null, 5000);
    const assignedThread = runtimeForumConfig.threadId!;
    expect(assignedThread).toBeGreaterThan(0);

    // Send a text message from the forum group targeting this thread
    enqueueUpdates([makeTextUpdate({
      chatId: -100999,
      userId: 42,
      threadId: assignedThread,
      text: "hello from forum",
    })]);

    // Wait for the real bot to process and reply via the real transformer
    await waitFor(
      () => capturedRequests.some(r =>
        r.method === "sendMessage" && r.payload.text === "Echo: hello from forum"
      ),
      5000
    );

    const reply = capturedRequests.find(r =>
      r.method === "sendMessage" && r.payload.text === "Echo: hello from forum"
    )!;

    // THE KEY ASSERTION: the REAL transformer from bot.ts injected message_thread_id
    expect(reply.payload.message_thread_id).toBe(assignedThread);
    expect(reply.payload.chat_id).toBe(-100999);
    expect(rejected).toBe(false);

    client.close();
  });

  test("DM mode: real transformer does NOT inject thread_id", async () => {
    // No projects.json → DM mode (single client, no forum)
    startRouter(mockPort);
    await waitForRouter();

    const client = new RouterClient({
      socketPath: SOCK_PATH,
      workingDir: "/tmp/project-dm",
      threadId: null,
      branch: "main",
    });

    client.onUpdate((update) => bot.handleUpdate(update));
    client.onAssignThread((t, c) => assignThread(t, c));

    await client.connect(5);
    await Bun.sleep(500); // Let router register the worker

    // Send DM (no thread)
    enqueueUpdates([makeTextUpdate({
      chatId: 42,
      userId: 42,
      text: "dm hello",
    })]);

    await waitFor(
      () => capturedRequests.some(r =>
        r.method === "sendMessage" && r.payload.text === "Echo: dm hello"
      ),
      5000
    );

    const reply = capturedRequests.find(r =>
      r.method === "sendMessage" && r.payload.text === "Echo: dm hello"
    )!;

    // No thread injection — runtimeForumConfig.threadId is null
    expect(reply.payload.message_thread_id).toBeUndefined();
    expect(reply.payload.chat_id).toBe(42);

    client.close();
  });

  test("chat_id rewrite: positive chat_id → forum group when forum is active", async () => {
    // Simulate forum mode being active (as if router assigned a thread)
    assignThread(200, -100999);

    // Directly call bot.api.sendMessage with a POSITIVE chat_id
    // This simulates what cron notifications do (they use ALLOWED_USERS[0] as chat_id)
    await bot.api.sendMessage(42, "cron notification");

    await waitFor(
      () => capturedRequests.some(r =>
        r.method === "sendMessage" && r.payload.text === "cron notification"
      ),
      2000
    );

    const call = capturedRequests.find(r =>
      r.method === "sendMessage" && r.payload.text === "cron notification"
    )!;

    // The REAL transformer should have:
    // 1. Injected message_thread_id
    // 2. Rewritten positive chat_id (42) to forum group (-100999)
    expect(call.payload.message_thread_id).toBe(200);
    expect(call.payload.chat_id).toBe(-100999);
  });

  test("chat_id rewrite: negative chat_id stays unchanged", async () => {
    // Forum mode active
    assignThread(200, -100999);

    // Call with a NEGATIVE chat_id (already a group — no rewrite needed)
    await bot.api.sendMessage(-100888, "group message");

    await waitFor(
      () => capturedRequests.some(r =>
        r.method === "sendMessage" && r.payload.text === "group message"
      ),
      2000
    );

    const call = capturedRequests.find(r =>
      r.method === "sendMessage" && r.payload.text === "group message"
    )!;

    // thread_id injected, but chat_id NOT rewritten (already negative)
    expect(call.payload.message_thread_id).toBe(200);
    expect(call.payload.chat_id).toBe(-100888);
  });

  test("multiple methods: thread_id injected on sendChatAction too", async () => {
    // Verify the transformer covers sendChatAction (not just sendMessage)
    assignThread(300, -100555);

    await bot.api.sendChatAction(-100555, "typing");

    await waitFor(
      () => capturedRequests.some(r => r.method === "sendChatAction"),
      2000
    );

    const call = capturedRequests.find(r => r.method === "sendChatAction")!;
    expect(call.payload.message_thread_id).toBe(300);
    expect(call.payload.chat_id).toBe(-100555);
  });

  test("full pipeline: router assigns thread, bot replies with correct thread_id", async () => {
    // Complete end-to-end: mock Telegram → router → socket → RouterClient →
    // real bot.handleUpdate → handler → ctx.reply → real transformer → mock Telegram
    // This is the same as the first test but verifies the full chain works together
    // with two separate clients (each getting its own topic).
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter(mockPort);
    await waitForRouter();

    // Client A
    const clientA = new RouterClient({
      socketPath: SOCK_PATH,
      workingDir: "/tmp/project-alpha",
      threadId: null,
      branch: "main",
    });

    clientA.onUpdate((update) => bot.handleUpdate(update));
    clientA.onAssignThread((t, c) => assignThread(t, c));
    clientA.onReject((r) => { throw new Error(`Unexpected reject: ${r}`); });

    await clientA.connect(5);
    await waitFor(() => runtimeForumConfig.threadId !== null, 5000);

    const threadA = runtimeForumConfig.threadId!;

    enqueueUpdates([makeTextUpdate({
      chatId: -100999,
      userId: 42,
      threadId: threadA,
      text: "project alpha message",
    })]);

    await waitFor(
      () => capturedRequests.some(r =>
        r.method === "sendMessage" && r.payload.text === "Echo: project alpha message"
      ),
      5000
    );

    const reply = capturedRequests.find(r =>
      r.method === "sendMessage" && r.payload.text === "Echo: project alpha message"
    )!;

    // Verify the entire production pipeline: router assigned a thread,
    // assignThread() updated runtimeForumConfig, the real transformer
    // read from runtimeForumConfig and injected message_thread_id
    expect(reply.payload.message_thread_id).toBe(threadA);
    expect(reply.payload.chat_id).toBe(-100999);

    clientA.close();
  });
});

// ============== Subprocess E2E ==============
//
// Spawns the REAL index.ts and router.ts as separate processes (exactly like
// production), with only the Telegram API mocked. This tests the actual
// startup sequence, wiring, handler chain, and transformer — no imports,
// no synthetic handlers.

describe("E2E Subprocess (real index.ts + real router.ts)", () => {
  const SUB_DIR = `/tmp/e2e-subprocess-${process.pid}`;
  const SUB_GLOBAL = resolve(SUB_DIR, ".superturtle");
  const SUB_WORKING = resolve(SUB_DIR, "project");
  const SUB_TOKEN = "999888:SUBPROCESS";
  const SUB_PREFIX = "999888";
  const SUB_SOCK = resolve(SUB_GLOBAL, `router-${SUB_PREFIX}.sock`);
  const SUB_PROJECTS = resolve(SUB_GLOBAL, "projects.json");
  const INDEX_SRC = resolve(import.meta.dir, "..", "index.ts");

  let subMockServer: ReturnType<typeof Bun.serve>;
  let subMockPort: number;
  const subCaptured: CapturedRequest[] = [];
  let subUpdateQueue: Update[] = [];
  let subUpdateWaiters: Array<(updates: Update[]) => void> = [];
  let routerProc: ChildProcess | null = null;
  let botProc: ChildProcess | null = null;

  function startSubMock(): number {
    subMockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const methodMatch = url.pathname.match(/\/bot[^/]+\/(\w+)/);
        const method = methodMatch?.[1] ?? "";
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const json = (data: unknown) => Response.json({ ok: true, result: data });

        switch (method) {
          case "getMe":
            return json({
              id: 999888, is_bot: true, first_name: "SubBot", username: "sub_e2e_bot",
              can_join_groups: true, can_read_all_group_messages: true,
              supports_inline_queries: false,
            });
          case "deleteWebhook":
            return json(true);
          case "getUpdates": {
            if (subUpdateQueue.length > 0) {
              const updates = [...subUpdateQueue];
              subUpdateQueue = [];
              return json(updates);
            }
            return new Promise<Response>((resolveResp) => {
              const timeout = setTimeout(() => {
                const idx = subUpdateWaiters.indexOf(cb);
                if (idx >= 0) subUpdateWaiters.splice(idx, 1);
                resolveResp(json([]));
              }, 2000);
              const cb = (updates: Update[]) => {
                clearTimeout(timeout);
                resolveResp(json(updates));
              };
              subUpdateWaiters.push(cb);
            });
          }
          case "createForumTopic": {
            const topicId = 500 + subCaptured.filter(r => r.method === "createForumTopic").length;
            subCaptured.push({ method, payload: body });
            return json({ message_thread_id: topicId, name: body.name || "Test", icon_color: 0 });
          }
          default: {
            subCaptured.push({ method, payload: body });
            return json({
              message_id: subCaptured.length,
              date: Math.floor(Date.now() / 1000),
              chat: { id: body.chat_id ?? 1, type: "supergroup", title: "Test" },
              text: body.text ?? "",
            });
          }
        }
      },
    });
    return subMockServer.port!;
  }

  function subEnqueue(updates: Update[]): void {
    if (subUpdateWaiters.length > 0) {
      subUpdateWaiters.shift()!(updates);
    } else {
      subUpdateQueue.push(...updates);
    }
  }

  beforeAll(() => {
    if (existsSync(SUB_DIR)) rmSync(SUB_DIR, { recursive: true });
    mkdirSync(SUB_GLOBAL, { recursive: true });
    mkdirSync(SUB_WORKING, { recursive: true });
    // Git init so getGitBranch() in index.ts doesn't fail
    Bun.spawnSync(["git", "init"], { cwd: SUB_WORKING });
    subMockPort = startSubMock();
  });

  afterAll(() => {
    botProc?.kill();
    routerProc?.kill();
    subMockServer?.stop();
    if (existsSync(SUB_DIR)) rmSync(SUB_DIR, { recursive: true });
  });

  afterEach(() => {
    botProc?.kill();
    botProc = null;
    routerProc?.kill();
    routerProc = null;
    subCaptured.length = 0;
    subUpdateQueue = [];
    subUpdateWaiters = [];
    try { unlinkSync(SUB_SOCK); } catch {}
    try { unlinkSync(SUB_PROJECTS); } catch {}
    try { unlinkSync(resolve(SUB_GLOBAL, `router-${SUB_PREFIX}.offset`)); } catch {}
  });

  test("real index.ts: sendChatAction has message_thread_id in forum mode", async () => {
    writeFileSync(SUB_PROJECTS, JSON.stringify({ forumChatId: -200999 }));

    // Shared env for both processes
    const sharedEnv = {
      ...process.env,
      HOME: SUB_DIR,
      TELEGRAM_BOT_TOKEN: SUB_TOKEN,
      TELEGRAM_API_BASE: `http://localhost:${subMockPort}`,
      TELEGRAM_API_ROOT: `http://localhost:${subMockPort}`,
      TELEGRAM_ALLOWED_USERS: "42",
      CLAUDE_WORKING_DIR: SUB_WORKING,
      NODE_ENV: "test",
      DASHBOARD_ENABLED: "false",
      TURTLE_GREETINGS: "false",
    };

    // 1. Start real router
    routerProc = spawn("bun", ["run", ROUTER_SRC], { env: sharedEnv, stdio: "pipe" });

    // Wait for router socket
    const rStart = Date.now();
    while (Date.now() - rStart < 10000) {
      if (existsSync(SUB_SOCK)) break;
      await Bun.sleep(100);
    }
    expect(existsSync(SUB_SOCK)).toBe(true);

    // 2. Start real bot (index.ts) — this is the actual production entry point
    botProc = spawn("bun", ["run", INDEX_SRC], { env: sharedEnv, stdio: "pipe" });

    // Wait for bot to connect: watch for a createForumTopic call (means router
    // registered the bot and created a topic)
    await waitFor(
      () => subCaptured.some(r => r.method === "createForumTopic"),
      10000,
    );

    const topicCall = subCaptured.find(r => r.method === "createForumTopic")!;
    const assignedThread = (topicCall.payload as Record<string, unknown>).message_thread_id;
    // The topic ID is returned by our mock, not sent in the request.
    // Find it from the mock's response pattern: 500 + index
    const threadId = 500; // First topic created

    // Clear captures to isolate the test
    subCaptured.length = 0;

    // 3. Send a text message from user 42 in the forum topic
    subEnqueue([{
      update_id: 9001,
      message: {
        message_id: 9001,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -200999, type: "supergroup" as const, title: "Test Forum" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        text: "hello real bot",
        message_thread_id: threadId,
      },
    } as unknown as Update]);

    // 4. Wait for the bot to send ANYTHING back (sendChatAction or sendMessage)
    //    The typing indicator fires before Claude session, so it's reliable.
    await waitFor(
      () => subCaptured.some(r =>
        (r.method === "sendChatAction" || r.method === "sendMessage") &&
        r.payload.message_thread_id !== undefined
      ),
      10000,
    );

    // 5. Verify: the REAL index.ts → REAL bot.ts transformer injected thread_id
    const outgoing = subCaptured.find(r =>
      (r.method === "sendChatAction" || r.method === "sendMessage") &&
      r.payload.message_thread_id !== undefined
    )!;

    expect(outgoing.payload.message_thread_id).toBe(threadId);
    // chat_id should be the forum group (negative), not rewritten
    expect(outgoing.payload.chat_id).toBe(-200999);
  }, 30000);

  test("real index.ts: DM mode — no thread injection when no forum configured", async () => {
    // No projects.json (or empty one) → no forumChatId → DM mode
    writeFileSync(SUB_PROJECTS, JSON.stringify({}));

    const sharedEnv = {
      ...process.env,
      HOME: SUB_DIR,
      TELEGRAM_BOT_TOKEN: SUB_TOKEN,
      TELEGRAM_API_BASE: `http://localhost:${subMockPort}`,
      TELEGRAM_API_ROOT: `http://localhost:${subMockPort}`,
      TELEGRAM_ALLOWED_USERS: "42",
      CLAUDE_WORKING_DIR: SUB_WORKING,
      NODE_ENV: "test",
      DASHBOARD_ENABLED: "false",
      TURTLE_GREETINGS: "false",
    };

    // 1. Start real router
    routerProc = spawn("bun", ["run", ROUTER_SRC], { env: sharedEnv, stdio: "pipe" });

    const rStart = Date.now();
    while (Date.now() - rStart < 10000) {
      if (existsSync(SUB_SOCK)) break;
      await Bun.sleep(100);
    }
    expect(existsSync(SUB_SOCK)).toBe(true);

    // 2. Start real bot — no forum → no createForumTopic call
    botProc = spawn("bun", ["run", INDEX_SRC], { env: sharedEnv, stdio: "pipe" });

    // Wait for bot to be ready by sending a getMe (already handled by mock)
    // Since there's no forum, there's no createForumTopic to wait for.
    // Instead wait for the router to log a worker connection — we detect this
    // by watching for any non-getMe/deleteWebhook captured request or just wait a bit.
    await Bun.sleep(3000);

    // Clear captures
    subCaptured.length = 0;

    // 3. Send a DM (private chat, no thread_id)
    subEnqueue([{
      update_id: 8001,
      message: {
        message_id: 8001,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" as const, first_name: "Tester" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        text: "hello dm mode",
      },
    } as unknown as Update]);

    // 4. Wait for the bot to respond
    await waitFor(
      () => subCaptured.some(r =>
        r.method === "sendChatAction" || r.method === "sendMessage"
      ),
      10000,
    );

    // 5. Verify: NO message_thread_id in DM mode
    const outgoing = subCaptured.find(r =>
      r.method === "sendChatAction" || r.method === "sendMessage"
    )!;

    expect(outgoing.payload.message_thread_id).toBeUndefined();
    // chat_id stays as the private chat (positive)
    expect(outgoing.payload.chat_id).toBe(42);
  }, 30000);

  test("real router: two instances route messages to correct bot", async () => {
    writeFileSync(SUB_PROJECTS, JSON.stringify({ forumChatId: -200999 }));

    // Create a second working directory (simulates second project)
    const SUB_WORKING_2 = resolve(SUB_DIR, "project2");
    mkdirSync(SUB_WORKING_2, { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: SUB_WORKING_2 });

    const sharedEnv = {
      ...process.env,
      HOME: SUB_DIR,
      TELEGRAM_BOT_TOKEN: SUB_TOKEN,
      TELEGRAM_API_BASE: `http://localhost:${subMockPort}`,
      TELEGRAM_API_ROOT: `http://localhost:${subMockPort}`,
      TELEGRAM_ALLOWED_USERS: "42",
      NODE_ENV: "test",
      DASHBOARD_ENABLED: "false",
      TURTLE_GREETINGS: "false",
    };

    // 1. Start real router
    routerProc = spawn("bun", ["run", ROUTER_SRC], { env: { ...sharedEnv, CLAUDE_WORKING_DIR: SUB_WORKING }, stdio: "pipe" });

    const rStart = Date.now();
    while (Date.now() - rStart < 10000) {
      if (existsSync(SUB_SOCK)) break;
      await Bun.sleep(100);
    }
    expect(existsSync(SUB_SOCK)).toBe(true);

    // 2. Start bot 1 (project)
    botProc = spawn("bun", ["run", INDEX_SRC], {
      env: { ...sharedEnv, CLAUDE_WORKING_DIR: SUB_WORKING },
      stdio: "pipe",
    });

    // Wait for bot 1 to get a forum topic
    await waitFor(
      () => subCaptured.filter(r => r.method === "createForumTopic").length >= 1,
      10000,
    );
    const topic1Id = 500; // First topic

    // 3. Start bot 2 (project2)
    const botProc2 = spawn("bun", ["run", INDEX_SRC], {
      env: { ...sharedEnv, CLAUDE_WORKING_DIR: SUB_WORKING_2 },
      stdio: "pipe",
    });

    // Wait for bot 2 to get a SECOND forum topic
    await waitFor(
      () => subCaptured.filter(r => r.method === "createForumTopic").length >= 2,
      10000,
    );
    const topic2Id = 501; // Second topic

    // Clear captures
    subCaptured.length = 0;

    // 4. Send a message to topic 1
    subEnqueue([{
      update_id: 7001,
      message: {
        message_id: 7001,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -200999, type: "supergroup" as const, title: "Test Forum" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        text: "message for bot 1",
        message_thread_id: topic1Id,
      },
    } as unknown as Update]);

    // Wait for bot 1 to respond
    await waitFor(
      () => subCaptured.some(r =>
        (r.method === "sendChatAction" || r.method === "sendMessage") &&
        r.payload.message_thread_id === topic1Id
      ),
      10000,
    );

    // 5. Send a message to topic 2
    subEnqueue([{
      update_id: 7002,
      message: {
        message_id: 7002,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -200999, type: "supergroup" as const, title: "Test Forum" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        text: "message for bot 2",
        message_thread_id: topic2Id,
      },
    } as unknown as Update]);

    // Wait for bot 2 to respond
    await waitFor(
      () => subCaptured.some(r =>
        (r.method === "sendChatAction" || r.method === "sendMessage") &&
        r.payload.message_thread_id === topic2Id
      ),
      10000,
    );

    // 6. Verify: each bot responded to its own topic
    const responses1 = subCaptured.filter(r =>
      (r.method === "sendChatAction" || r.method === "sendMessage") &&
      r.payload.message_thread_id === topic1Id
    );
    const responses2 = subCaptured.filter(r =>
      (r.method === "sendChatAction" || r.method === "sendMessage") &&
      r.payload.message_thread_id === topic2Id
    );

    expect(responses1.length).toBeGreaterThan(0);
    expect(responses2.length).toBeGreaterThan(0);

    // All responses to topic 1 should have the correct thread_id
    for (const r of responses1) {
      expect(r.payload.message_thread_id).toBe(topic1Id);
    }
    // All responses to topic 2 should have the correct thread_id
    for (const r of responses2) {
      expect(r.payload.message_thread_id).toBe(topic2Id);
    }

    // Clean up bot 2
    botProc2.kill();
    rmSync(SUB_WORKING_2, { recursive: true, force: true });
  }, 45000);

  test("real transition: DM → forum when second instance joins", async () => {
    // Start with NO forum configured → DM mode
    writeFileSync(SUB_PROJECTS, JSON.stringify({}));

    const SUB_WORKING_2 = resolve(SUB_DIR, "project-transition");
    mkdirSync(SUB_WORKING_2, { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: SUB_WORKING_2 });

    const sharedEnv = {
      ...process.env,
      HOME: SUB_DIR,
      TELEGRAM_BOT_TOKEN: SUB_TOKEN,
      TELEGRAM_API_BASE: `http://localhost:${subMockPort}`,
      TELEGRAM_API_ROOT: `http://localhost:${subMockPort}`,
      TELEGRAM_ALLOWED_USERS: "42",
      CLAUDE_WORKING_DIR: SUB_WORKING,
      NODE_ENV: "test",
      DASHBOARD_ENABLED: "false",
      TURTLE_GREETINGS: "false",
    };

    // 1. Start router + bot 1 — no forum
    routerProc = spawn("bun", ["run", ROUTER_SRC], { env: sharedEnv, stdio: "pipe" });

    const rStart = Date.now();
    while (Date.now() - rStart < 10000) {
      if (existsSync(SUB_SOCK)) break;
      await Bun.sleep(100);
    }
    expect(existsSync(SUB_SOCK)).toBe(true);

    botProc = spawn("bun", ["run", INDEX_SRC], { env: sharedEnv, stdio: "pipe" });
    await Bun.sleep(3000); // No forum → no createForumTopic to wait for

    // 2. Send a DM → should have NO thread injection
    subCaptured.length = 0;
    subEnqueue([{
      update_id: 6001,
      message: {
        message_id: 6001,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" as const, first_name: "Tester" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        text: "hello before forum",
      },
    } as unknown as Update]);

    await waitFor(
      () => subCaptured.some(r =>
        r.method === "sendChatAction" || r.method === "sendMessage"
      ),
      10000,
    );

    const dmResponse = subCaptured.find(r =>
      r.method === "sendChatAction" || r.method === "sendMessage"
    )!;
    expect(dmResponse.payload.message_thread_id).toBeUndefined();
    expect(dmResponse.payload.chat_id).toBe(42);

    // 3. NOW configure forum mode (simulates user running `superturtle init` with a forum group)
    writeFileSync(SUB_PROJECTS, JSON.stringify({ forumChatId: -200999 }));

    // 4. Start bot 2 → triggers forum topic creation for bot 2,
    //    then upgradeDefaultWorker creates a topic for bot 1 too
    subCaptured.length = 0;
    const botProc2 = spawn("bun", ["run", INDEX_SRC], {
      env: { ...sharedEnv, CLAUDE_WORKING_DIR: SUB_WORKING_2 },
      stdio: "pipe",
    });

    // Wait for BOTH topics to be created (bot 2's topic + bot 1's upgrade)
    await waitFor(
      () => subCaptured.filter(r => r.method === "createForumTopic").length >= 2,
      15000,
    );

    // Find the topic assigned to bot 1 (by working dir name in the topic name)
    const topicCalls = subCaptured.filter(r => r.method === "createForumTopic");
    const bot1TopicCall = topicCalls.find(r =>
      String(r.payload.name || "").includes("project")
      && !String(r.payload.name || "").includes("transition")
    );
    const bot1ThreadId = bot1TopicCall
      ? 500 + topicCalls.indexOf(bot1TopicCall)
      : 500; // fallback — first topic is always 500

    // Clear captures for the final test
    subCaptured.length = 0;

    // 5. Send a message in bot 1's forum topic → should now have thread injection
    subEnqueue([{
      update_id: 6002,
      message: {
        message_id: 6002,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -200999, type: "supergroup" as const, title: "Test Forum" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        text: "hello after forum upgrade",
        message_thread_id: bot1ThreadId,
      },
    } as unknown as Update]);

    await waitFor(
      () => subCaptured.some(r =>
        (r.method === "sendChatAction" || r.method === "sendMessage") &&
        r.payload.message_thread_id === bot1ThreadId
      ),
      10000,
    );

    const forumResponse = subCaptured.find(r =>
      (r.method === "sendChatAction" || r.method === "sendMessage") &&
      r.payload.message_thread_id === bot1ThreadId
    )!;

    // Bot 1 now has thread injection active (runtimeForumConfig was updated
    // via assignThread when the router sent assign_thread)
    expect(forumResponse.payload.message_thread_id).toBe(bot1ThreadId);
    expect(forumResponse.payload.chat_id).toBe(-200999);

    botProc2.kill();
    rmSync(SUB_WORKING_2, { recursive: true, force: true });
  }, 60000);
});
