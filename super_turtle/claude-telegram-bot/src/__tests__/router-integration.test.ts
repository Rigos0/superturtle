/**
 * Integration tests for the router + client end-to-end.
 *
 * Starts a real router process with a mock Telegram API, connects real
 * RouterClient instances, and verifies updates flow correctly.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "fs";
import { resolve } from "path";
import { RouterClient } from "../router-client";
import type { Update, Message, User, Chat } from "grammy/types";

// ============== Config ==============

const TEST_DIR = `/tmp/router-integration-test-${process.pid}`;
const MOCK_PORT = 19200 + (process.pid % 1000);
const BOT_TOKEN = "123456:TEST_TOKEN";
const TOKEN_PREFIX = "123456";
// Router uses homedir()/.superturtle/ — we set HOME=TEST_DIR so paths land here
const GLOBAL_DIR = resolve(TEST_DIR, ".superturtle");
const SOCK_PATH = resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.sock`);
const PROJECTS_PATH = resolve(GLOBAL_DIR, "projects.json");

// ============== Mock Telegram API ==============

interface MockTelegramServer {
  /** Enqueue updates for the next getUpdates response. */
  enqueueUpdates: (updates: Update[]) => void;
  /** All sendMessage calls received. */
  sentMessages: Array<{ chat_id: number; text: string; message_thread_id?: number }>;
  /** All createForumTopic calls received. */
  createdTopics: Array<{ chat_id: number; name: string }>;
  /** All answerCallbackQuery calls received. */
  answeredCallbacks: Array<{ callback_query_id: string; text?: string }>;
  /** Set the forum chat ID that createForumTopic responds with. */
  nextTopicThreadId: number;
  /** Close the server. */
  close: () => void;
  /** URL for the mock server. */
  url: string;
}

function startMockTelegram(): MockTelegramServer {
  const pendingUpdates: Update[][] = [];
  const sentMessages: MockTelegramServer["sentMessages"] = [];
  const createdTopics: MockTelegramServer["createdTopics"] = [];
  const answeredCallbacks: MockTelegramServer["answeredCallbacks"] = [];
  let nextTopicThreadId = 100;

  // Track getUpdates waiters so we can resolve them when updates arrive.
  let getUpdatesWaiter: ((updates: Update[]) => void) | null = null;

  const server = Bun.serve({
    port: MOCK_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;

      // Parse method from /bot{token}/{method}
      const match = path.match(/^\/bot[^/]+\/(\w+)$/);
      if (!match) {
        return new Response(JSON.stringify({ ok: false, description: "Not found" }), { status: 404 });
      }
      const method = match[1];
      const body = req.method === "POST"
        ? await req.json().catch(() => ({})) as Record<string, unknown>
        : {};

      switch (method) {
        case "deleteWebhook":
          return Response.json({ ok: true, result: true });

        case "getUpdates": {
          // If we have queued updates, return them immediately.
          if (pendingUpdates.length > 0) {
            const updates = pendingUpdates.shift()!;
            return Response.json({ ok: true, result: updates });
          }
          // Otherwise wait up to 2s for updates to be enqueued (simulates long poll).
          const updates = await new Promise<Update[]>((resolve) => {
            getUpdatesWaiter = resolve;
            setTimeout(() => {
              if (getUpdatesWaiter === resolve) {
                getUpdatesWaiter = null;
                resolve([]);
              }
            }, 2000);
          });
          return Response.json({ ok: true, result: updates });
        }

        case "sendMessage":
          sentMessages.push({
            chat_id: body.chat_id as number,
            text: body.text as string,
            message_thread_id: body.message_thread_id as number | undefined,
          });
          return Response.json({
            ok: true,
            result: {
              message_id: Math.floor(Math.random() * 100000),
              chat: { id: body.chat_id, type: "supergroup" },
              date: Math.floor(Date.now() / 1000),
              text: body.text,
            },
          });

        case "createForumTopic": {
          const threadId = nextTopicThreadId++;
          createdTopics.push({
            chat_id: body.chat_id as number,
            name: body.name as string,
          });
          return Response.json({
            ok: true,
            result: { message_thread_id: threadId, name: body.name },
          });
        }

        case "answerCallbackQuery":
          answeredCallbacks.push({
            callback_query_id: body.callback_query_id as string,
            text: body.text as string | undefined,
          });
          return Response.json({ ok: true, result: true });

        default:
          return Response.json({ ok: true, result: true });
      }
    },
  });

  return {
    enqueueUpdates: (updates) => {
      if (getUpdatesWaiter) {
        const waiter = getUpdatesWaiter;
        getUpdatesWaiter = null;
        waiter(updates);
      } else {
        pendingUpdates.push(updates);
      }
    },
    sentMessages,
    createdTopics,
    answeredCallbacks,
    get nextTopicThreadId() { return nextTopicThreadId; },
    set nextTopicThreadId(v) { nextTopicThreadId = v; },
    close: () => server.stop(true),
    url: `http://localhost:${MOCK_PORT}`,
  };
}

// ============== Test Helpers ==============

const TEST_USER: User = { id: 42, is_bot: false, first_name: "Tester" };

function makeUpdate(
  updateId: number,
  opts: {
    chatId?: number;
    threadId?: number;
    text?: string;
    callbackData?: string;
  } = {},
): Update {
  const chatId = opts.chatId ?? -100123;
  if (opts.callbackData) {
    return {
      update_id: updateId,
      callback_query: {
        id: `cb_${updateId}`,
        chat_instance: "test",
        from: TEST_USER,
        data: opts.callbackData,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "supergroup", title: "Test" } as Chat.SupergroupChat,
          from: { id: 1, is_bot: true, first_name: "Bot" },
          ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
        } as Message,
      },
    } as Update;
  }
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "supergroup", title: "Test" } as Chat.SupergroupChat,
      from: TEST_USER,
      text: opts.text ?? "hello",
      ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
    },
  } as Update;
}

/** Wait for a condition to be true, polling every intervalMs. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(intervalMs);
  }
}

/** Collect updates received by a RouterClient. */
function collectUpdates(client: RouterClient): Update[] {
  const updates: Update[] = [];
  client.onUpdate((u) => updates.push(u));
  return updates;
}

/** Collect thread assignments received by a RouterClient. */
function collectAssignments(client: RouterClient): Array<{ threadId: number; forumChatId: number | null }> {
  const assignments: Array<{ threadId: number; forumChatId: number | null }> = [];
  client.onAssignThread((threadId, forumChatId) => assignments.push({ threadId, forumChatId }));
  return assignments;
}

// ============== Router Process Management ==============

let mockTg: MockTelegramServer;
let routerProc: Subprocess | null = null;
const clients: RouterClient[] = [];

function startRouter(): Subprocess {
  const proc = spawn(["bun", "run", resolve(__dirname, "../router.ts")], {
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_BASE: mockTg.url,
      HOME: TEST_DIR,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  routerProc = proc;
  return proc;
}

async function waitForRouter(): Promise<void> {
  // Wait until the socket file exists
  await waitFor(() => existsSync(SOCK_PATH), 10000, 100);
  // Small extra delay for the server to be ready to accept
  await Bun.sleep(200);
}

function createClient(workingDir: string, threadId: number | null = null): RouterClient {
  const client = new RouterClient({
    socketPath: SOCK_PATH,
    workingDir,
    threadId,
    branch: null,
  });
  clients.push(client);
  return client;
}

// ============== Setup / Teardown ==============

beforeAll(() => {
  // Clean slate
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(GLOBAL_DIR, { recursive: true });

  mockTg = startMockTelegram();
});

afterEach(async () => {
  // Close all clients
  for (const c of clients) c.close();
  clients.length = 0;

  // Kill router
  if (routerProc) {
    routerProc.kill("SIGTERM");
    await routerProc.exited;
    routerProc = null;
  }

  // Clean up socket and state files
  try { unlinkSync(SOCK_PATH); } catch {}
  try { unlinkSync(resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.pid`)); } catch {}
  try { unlinkSync(resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.offset`)); } catch {}
  try { unlinkSync(PROJECTS_PATH); } catch {}

  // Reset mock state
  mockTg.sentMessages.length = 0;
  mockTg.createdTopics.length = 0;
  mockTg.answeredCallbacks.length = 0;
  mockTg.nextTopicThreadId = 100;
});

afterAll(() => {
  mockTg.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ============== Tests ==============

describe("Router Integration", () => {
  test("single client in DM mode receives all updates", async () => {
    startRouter();
    await waitForRouter();

    const client = createClient("/tmp/project-a");
    const updates = collectUpdates(client);
    await client.connect(5);

    // Inject an update
    mockTg.enqueueUpdates([makeUpdate(1, { text: "hello from DM" })]);
    await waitFor(() => updates.length === 1);

    expect(updates[0]!.update_id).toBe(1);
    expect((updates[0]!.message as Message).text).toBe("hello from DM");
  });

  test("two clients get forum topics auto-created", async () => {
    // Pre-configure forum chat ID in registry
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    const clientA = createClient("/tmp/project-a");
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);

    // Wait for topic creation
    await waitFor(() => assignA.length === 1, 5000);
    expect(assignA[0]!.threadId).toBe(100); // first auto-created topic
    expect(assignA[0]!.forumChatId).toBe(-100999);

    const clientB = createClient("/tmp/project-b");
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);

    await waitFor(() => assignB.length === 1, 5000);
    expect(assignB[0]!.threadId).toBe(101); // second topic

    // Verify createForumTopic was called twice
    expect(mockTg.createdTopics.length).toBe(2);
    expect(mockTg.createdTopics[0]!.chat_id).toBe(-100999);
    expect(mockTg.createdTopics[1]!.chat_id).toBe(-100999);
  });

  test("updates routed to correct client by thread_id", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    // Connect two clients, wait for topic assignments
    const clientA = createClient("/tmp/project-a");
    const updatesA = collectUpdates(clientA);
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);

    const clientB = createClient("/tmp/project-b");
    const updatesB = collectUpdates(clientB);
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);
    await waitFor(() => assignB.length === 1);

    const threadA = assignA[0]!.threadId;
    const threadB = assignB[0]!.threadId;

    // Send update to thread A
    mockTg.enqueueUpdates([makeUpdate(10, { threadId: threadA, text: "for A" })]);
    await waitFor(() => updatesA.length === 1);
    expect(updatesA[0]!.update_id).toBe(10);
    expect(updatesB.length).toBe(0);

    // Send update to thread B
    mockTg.enqueueUpdates([makeUpdate(11, { threadId: threadB, text: "for B" })]);
    await waitFor(() => updatesB.length === 1);
    expect(updatesB[0]!.update_id).toBe(11);
    expect(updatesA.length).toBe(1); // still 1, no new updates
  });

  test("non-threaded message in forum mode sends redirect", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    // Connect two clients to trigger forum mode
    const clientA = createClient("/tmp/project-a");
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);

    const clientB = createClient("/tmp/project-b");
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);
    await waitFor(() => assignB.length === 1);

    // Send a non-threaded message (DM to the bot)
    mockTg.enqueueUpdates([makeUpdate(20, { chatId: 42, text: "wrong place" })]);

    // Router should send a redirect message
    await waitFor(() => mockTg.sentMessages.some(m => m.text.includes("multi-project")), 5000);
    const redirect = mockTg.sentMessages.find(m => m.text.includes("multi-project"));
    expect(redirect).toBeDefined();
    expect(redirect!.chat_id).toBe(42);
  });

  test("duplicate working directory is rejected", async () => {
    startRouter();
    await waitForRouter();

    const clientA = createClient("/tmp/same-dir");
    await clientA.connect(5);

    // Try to connect another client with the same working dir
    const clientB = createClient("/tmp/same-dir");
    let rejected = false;
    let rejectReason = "";
    clientB.onReject((reason) => {
      rejected = true;
      rejectReason = reason;
    });

    try {
      await clientB.connect(3);
    } catch {
      // Connection might fail after reject
    }

    await waitFor(() => rejected, 5000);
    expect(rejectReason).toContain("already running");
  });

  test("updates buffered while no clients, drained on connect", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({
      forumChatId: -100999,
      projects: {
        "/tmp/project-a": { threadId: 50, name: "project-a" },
      },
    }));

    startRouter();
    await waitForRouter();

    // Inject updates BEFORE any client connects
    mockTg.enqueueUpdates([
      makeUpdate(30, { threadId: 50, text: "buffered 1" }),
      makeUpdate(31, { threadId: 50, text: "buffered 2" }),
    ]);

    // Give the router time to poll and cache
    await Bun.sleep(500);

    // Now connect the client
    const client = createClient("/tmp/project-a", 50);
    const updates = collectUpdates(client);
    await client.connect(5);

    // Should receive the buffered updates
    await waitFor(() => updates.length === 2, 5000);
    expect(updates[0]!.update_id).toBe(30);
    expect(updates[1]!.update_id).toBe(31);
  });

  test("client reconnects and re-registers after disconnect", async () => {
    startRouter();
    await waitForRouter();

    const client = createClient("/tmp/project-a");
    const updates = collectUpdates(client);
    await client.connect(5);

    // Verify first update works
    mockTg.enqueueUpdates([makeUpdate(40, { text: "before disconnect" })]);
    await waitFor(() => updates.length === 1);

    // Kill the router and restart it
    routerProc!.kill("SIGTERM");
    await routerProc!.exited;

    // Clean up socket so new router can bind
    try { unlinkSync(SOCK_PATH); } catch {}

    startRouter();
    await waitForRouter();

    // Client should auto-reconnect
    await waitFor(() => client.isConnected(), 15000, 200);

    // Send another update — should arrive on the reconnected client
    mockTg.enqueueUpdates([makeUpdate(41, { text: "after reconnect" })]);
    await waitFor(() => updates.length === 2, 5000);
    expect(updates[1]!.update_id).toBe(41);
  });

  test("restarted client reuses existing topic from registry", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({
      forumChatId: -100999,
      projects: {
        "/tmp/project-a": { threadId: 77, name: "🐢 project-a" },
      },
    }));

    startRouter();
    await waitForRouter();

    // Connect with the persisted thread ID
    const client = createClient("/tmp/project-a", 77);
    const updates = collectUpdates(client);
    const assignments = collectAssignments(client);
    await client.connect(5);

    // Should NOT create a new topic (already in registry)
    await Bun.sleep(500);
    expect(mockTg.createdTopics.length).toBe(0);

    // Updates to thread 77 should arrive
    mockTg.enqueueUpdates([makeUpdate(50, { threadId: 77, text: "persisted topic" })]);
    await waitFor(() => updates.length === 1);
    expect(updates[0]!.update_id).toBe(50);
  });

  test("callback query in forum mode without thread gets acked", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    // Connect two clients to trigger forum mode
    const clientA = createClient("/tmp/project-a");
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);

    const clientB = createClient("/tmp/project-b");
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);
    await waitFor(() => assignB.length === 1);

    // Non-threaded callback query
    mockTg.enqueueUpdates([makeUpdate(60, { callbackData: "test_click" })]);

    await waitFor(() => mockTg.answeredCallbacks.length === 1, 5000);
    expect(mockTg.answeredCallbacks[0]!.callback_query_id).toBe("cb_60");
  });

  test("callback query with thread_id routed to correct client", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    const clientA = createClient("/tmp/project-a");
    const updatesA = collectUpdates(clientA);
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);

    const clientB = createClient("/tmp/project-b");
    const updatesB = collectUpdates(clientB);
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);
    await waitFor(() => assignB.length === 1);

    const threadB = assignB[0]!.threadId;

    // Callback with thread_id targeting client B
    mockTg.enqueueUpdates([makeUpdate(70, { threadId: threadB, callbackData: "click_b" })]);
    await waitFor(() => updatesB.length === 1, 5000);
    expect(updatesB[0]!.update_id).toBe(70);
    expect(updatesA.length).toBe(0);
  });

  test("default worker gets upgraded when second client connects", async () => {
    // Start WITHOUT forum config — first client enters DM mode
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    // First client connects — gets a topic since forumChatId exists
    const clientA = createClient("/tmp/project-a");
    const updatesA = collectUpdates(clientA);
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);

    // In DM mode (single worker, no thread) if forumChatId is set,
    // the router auto-creates a topic. Wait for it.
    await waitFor(() => assignA.length === 1, 5000);
    const threadA = assignA[0]!.threadId;

    // Second client connects — should also get its own topic
    const clientB = createClient("/tmp/project-b");
    const updatesB = collectUpdates(clientB);
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);
    await waitFor(() => assignB.length === 1, 5000);
    const threadB = assignB[0]!.threadId;

    expect(threadA).not.toBe(threadB);

    // Now verify routing works: update to thread A goes to client A only
    mockTg.enqueueUpdates([makeUpdate(80, { threadId: threadA, text: "for A after upgrade" })]);
    await waitFor(() => updatesA.length === 1);
    expect(updatesB.length).toBe(0);
  });

  test("updates for unknown thread get cached then drained on register", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    // Connect one client so the router is in forum mode
    const clientA = createClient("/tmp/project-a");
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);

    // Send updates to a thread that no worker owns yet
    const unknownThread = 999;
    mockTg.enqueueUpdates([
      makeUpdate(90, { threadId: unknownThread, text: "cached 1" }),
      makeUpdate(91, { threadId: unknownThread, text: "cached 2" }),
    ]);

    // Give router time to poll and cache them
    await Bun.sleep(1000);

    // Now connect a client that claims that thread
    const clientB = createClient("/tmp/project-b", unknownThread);
    const updatesB = collectUpdates(clientB);
    await clientB.connect(5);

    // Should receive the cached updates
    await waitFor(() => updatesB.length === 2, 5000);
    expect(updatesB[0]!.update_id).toBe(90);
    expect(updatesB[1]!.update_id).toBe(91);
  });

  test("offset persists across router restart — no re-delivery", async () => {
    startRouter();
    await waitForRouter();

    const clientA = createClient("/tmp/project-a");
    const updatesA = collectUpdates(clientA);
    await clientA.connect(5);

    // Send updates — router will advance offset
    mockTg.enqueueUpdates([
      makeUpdate(100, { text: "before restart" }),
      makeUpdate(101, { text: "before restart 2" }),
    ]);
    await waitFor(() => updatesA.length === 2);

    // Kill router, close client
    clientA.close();
    clients.length = 0;
    routerProc!.kill("SIGTERM");
    await routerProc!.exited;
    try { unlinkSync(SOCK_PATH); } catch {}

    // Verify offset file was persisted
    const offsetFile = resolve(GLOBAL_DIR, `router-${TOKEN_PREFIX}.offset`);
    expect(existsSync(offsetFile)).toBe(true);
    const savedOffset = parseInt(readFileSync(offsetFile, "utf-8").trim(), 10);
    expect(savedOffset).toBe(102); // max(100,101) + 1

    // Restart router — it should NOT re-request updates 100/101
    // The mock server will return empty for getUpdates since nothing new is queued
    startRouter();
    await waitForRouter();

    const clientB = createClient("/tmp/project-a");
    const updatesB = collectUpdates(clientB);
    await clientB.connect(5);

    // Send a NEW update
    mockTg.enqueueUpdates([makeUpdate(200, { text: "after restart" })]);
    await waitFor(() => updatesB.length === 1, 5000);

    // Should only get the new update, not the old ones
    expect(updatesB[0]!.update_id).toBe(200);
    expect(updatesB.length).toBe(1);
  });

  test("batch of updates splits across clients by thread", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    const clientA = createClient("/tmp/project-a");
    const updatesA = collectUpdates(clientA);
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);
    const threadA = assignA[0]!.threadId;

    const clientB = createClient("/tmp/project-b");
    const updatesB = collectUpdates(clientB);
    const assignB = collectAssignments(clientB);
    await clientB.connect(5);
    await waitFor(() => assignB.length === 1);
    const threadB = assignB[0]!.threadId;

    // One getUpdates batch with interleaved updates for both clients
    mockTg.enqueueUpdates([
      makeUpdate(110, { threadId: threadA, text: "A1" }),
      makeUpdate(111, { threadId: threadB, text: "B1" }),
      makeUpdate(112, { threadId: threadA, text: "A2" }),
      makeUpdate(113, { threadId: threadB, text: "B2" }),
      makeUpdate(114, { threadId: threadA, text: "A3" }),
    ]);

    await waitFor(() => updatesA.length === 3 && updatesB.length === 2, 5000);

    expect(updatesA.map(u => u.update_id)).toEqual([110, 112, 114]);
    expect(updatesB.map(u => u.update_id)).toEqual([111, 113]);
  });

  test("duplicate rejection nudges existing topic", async () => {
    writeFileSync(PROJECTS_PATH, JSON.stringify({ forumChatId: -100999 }));

    startRouter();
    await waitForRouter();

    // Connect first client — gets a topic
    const clientA = createClient("/tmp/same-dir");
    const assignA = collectAssignments(clientA);
    await clientA.connect(5);
    await waitFor(() => assignA.length === 1);
    const threadA = assignA[0]!.threadId;

    // Clear mock state so we can isolate the nudge message
    mockTg.sentMessages.length = 0;

    // Try to connect duplicate
    const clientB = createClient("/tmp/same-dir");
    let rejected = false;
    clientB.onReject(() => { rejected = true; });

    try { await clientB.connect(3); } catch {}
    await waitFor(() => rejected, 5000);

    // Router should have sent a nudge to the existing topic
    await waitFor(() => mockTg.sentMessages.length > 0, 3000);
    const nudge = mockTg.sentMessages.find(m =>
      m.message_thread_id === threadA && m.text.includes("already running"),
    );
    expect(nudge).toBeDefined();
    expect(nudge!.chat_id).toBe(-100999);
  });
});

