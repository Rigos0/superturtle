import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

process.env.CLAUDE_WORKING_DIR ||= resolve(import.meta.dir, "../../..");

const { DASHBOARD_AUTH_TOKEN, WORKING_DIR, SUPERTURTLE_DATA_DIR } = await import("./config");

const {
  isAuthorized,
  safeSubstring,
  computeProgressPct,
  jsonResponse,
  notFoundResponse,
  readFileOr,
  parseMetaFile,
  validateSubturtleName,
  resetDashboardSessionCachesForTests,
} = await import("./dashboard");
const { session } = await import("./session");
const { codexSession } = await import("./codex-session");
const { enqueueDeferredMessage, clearDeferredQueue, getAllDeferredQueues } = await import("./deferred-queue");
const { appendTurnLogEntry, clearTurnLogFile } = await import("./turn-log");
const { setExecutingDriverForTests } = await import("./handlers/driver-routing");

const hasAuthToken = DASHBOARD_AUTH_TOKEN.length > 0;
const validToken = hasAuthToken ? DASHBOARD_AUTH_TOKEN : "any-token";

function clearAllDeferredQueuesForTest(): void {
  for (const chatId of getAllDeferredQueues().keys()) {
    clearDeferredQueue(chatId);
  }
}

beforeEach(() => {
  clearAllDeferredQueuesForTest();
  setExecutingDriverForTests(null);
  resetDashboardSessionCachesForTests();
});

afterEach(() => {
  clearAllDeferredQueuesForTest();
  setExecutingDriverForTests(null);
  resetDashboardSessionCachesForTests();
});

describe("isAuthorized()", () => {
  it("accepts token in query string", () => {
    const request = new Request(`http://localhost/dashboard?token=${encodeURIComponent(validToken)}`);
    expect(isAuthorized(request)).toBe(true);
  });

  it("accepts token in x-dashboard-token header", () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { "x-dashboard-token": validToken },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it("accepts token in Authorization header", () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it("handles missing token based on auth mode", () => {
    const request = new Request("http://localhost/dashboard");
    expect(isAuthorized(request)).toBe(!hasAuthToken);
  });

  it("handles incorrect token based on auth mode", () => {
    const request = new Request("http://localhost/dashboard?token=wrong-token");
    expect(isAuthorized(request)).toBe(!hasAuthToken);
  });
});

describe("safeSubstring()", () => {
  it("leaves short strings unchanged", () => {
    expect(safeSubstring("short", 10)).toBe("short");
  });

  it("truncates long strings with an ellipsis", () => {
    expect(safeSubstring("abcdefghijklmnopqrstuvwxyz", 5)).toBe("abcde...");
  });

  it("handles empty strings and maxLen=0", () => {
    expect(safeSubstring("", 5)).toBe("");
    expect(safeSubstring("abcdef", 0)).toBe("...");
  });
});

describe("computeProgressPct()", () => {
  it("returns 0 when total is zero", () => {
    expect(computeProgressPct(5, 0)).toBe(0);
  });

  it("returns rounded progress percent", () => {
    expect(computeProgressPct(3, 8)).toBe(38);
  });

  it("clamps to [0, 100]", () => {
    expect(computeProgressPct(-2, 5)).toBe(0);
    expect(computeProgressPct(9, 5)).toBe(100);
  });
});

describe("jsonResponse()", () => {
  it("returns JSON with correct content-type and status 200 by default", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts a custom status code", () => {
    const res = jsonResponse({ error: "bad" }, 400);
    expect(res.status).toBe(400);
  });
});

describe("notFoundResponse()", () => {
  it("returns 404 with default message", async () => {
    const res = notFoundResponse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("accepts a custom message", async () => {
    const res = notFoundResponse("no such turtle");
    expect(await res.json()).toEqual({ error: "no such turtle" });
  });
});

describe("readFileOr()", () => {
  it("returns fallback for non-existent file", async () => {
    const result = await readFileOr("/tmp/__nonexistent_test_file__", "default");
    expect(result).toBe("default");
  });
});

describe("parseMetaFile()", () => {
  it("parses a standard subturtle.meta file", () => {
    const content = [
      "SPAWNED_AT=1772626337",
      "TIMEOUT_SECONDS=7200",
      "LOOP_TYPE=yolo",
      'SKILLS=["web"]',
      "WATCHDOG_PID=58912",
      "CRON_JOB_ID=1b61a7",
    ].join("\n");

    const meta = parseMetaFile(content);
    expect(meta.spawnedAt).toBe(1772626337);
    expect(meta.timeoutSeconds).toBe(7200);
    expect(meta.loopType).toBe("yolo");
    expect(meta.skills).toEqual(["web"]);
    expect(meta.watchdogPid).toBe(58912);
    expect(meta.cronJobId).toBe("1b61a7");
  });

  it("handles empty content", () => {
    const meta = parseMetaFile("");
    expect(meta.spawnedAt).toBeNull();
    expect(meta.loopType).toBeNull();
    expect(meta.skills).toEqual([]);
  });

  it("handles empty SKILLS array", () => {
    const meta = parseMetaFile("SKILLS=[]");
    expect(meta.skills).toEqual([]);
  });

  it("ignores comment lines and blank lines", () => {
    const content = "# comment\n\nLOOP_TYPE=slow\n";
    const meta = parseMetaFile(content);
    expect(meta.loopType).toBe("slow");
  });

  it("stores unknown keys in the result", () => {
    const meta = parseMetaFile("CUSTOM_KEY=hello");
    expect(meta.CUSTOM_KEY).toBe("hello");
  });
});

describe("validateSubturtleName()", () => {
  it("accepts valid names", () => {
    expect(validateSubturtleName("my-turtle")).toBe(true);
    expect(validateSubturtleName("dash-foundation")).toBe(true);
    expect(validateSubturtleName("test_123")).toBe(true);
  });

  it("rejects empty names", () => {
    expect(validateSubturtleName("")).toBe(false);
  });

  it("rejects names with path traversal", () => {
    expect(validateSubturtleName("../evil")).toBe(false);
    expect(validateSubturtleName("foo/../bar")).toBe(false);
  });

  it("rejects names with slashes", () => {
    expect(validateSubturtleName("foo/bar")).toBe(false);
    expect(validateSubturtleName("foo\\bar")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(validateSubturtleName(".hidden")).toBe(false);
  });

  it("rejects excessively long names", () => {
    expect(validateSubturtleName("a".repeat(129))).toBe(false);
  });
});

/* ── Route table tests for /api/subturtles/:name and :name/logs ───── */

const { routes } = await import("./dashboard");

function findRoute(path: string) {
  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  return null;
}

function makeReq(path: string): { req: Request; url: URL; } {
  const fullUrl = `http://localhost${path}`;
  return { req: new Request(fullUrl), url: new URL(fullUrl) };
}

function enqueueTestMessage(chatId: number, text: string, enqueuedAt: number): void {
  enqueueDeferredMessage({
    text,
    userId: 1,
    username: "queue-test",
    chatId,
    source: "text",
    enqueuedAt,
  });
}

describe("GET /api/subturtles", () => {
  const testTurtleName = "__test_archived_lane_state__";
  const testDir = join(WORKING_DIR, ".subturtles", testTurtleName);
  const workerStateDir = join(SUPERTURTLE_DATA_DIR, "state", "workers");
  const workerStatePath = join(workerStateDir, `${testTurtleName}.json`);

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(workerStateDir, { recursive: true });
    writeFileSync(
      join(testDir, "CLAUDE.md"),
      [
        "# Current task",
        "- live current task",
        "",
        "# Backlog",
        "- [ ] still active",
      ].join("\n")
    );
    writeFileSync(
      workerStatePath,
      JSON.stringify({
        worker_name: testTurtleName,
        lifecycle_state: "archived",
        workspace: join(WORKING_DIR, ".subturtles", ".archive", testTurtleName),
        loop_type: "slow",
        current_task: "archived task from stale state",
        created_at: "2026-03-08T12:00:00Z",
        updated_at: "2026-03-08T12:05:00Z",
      })
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(workerStatePath, { force: true });
  });

  it("ignores archived conductor state for live workspaces", async () => {
    const result = findRoute("/api/subturtles");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/subturtles");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      lanes: Array<{ name: string; status: string; task: string }>;
    };
    const lane = body.lanes.find((entry) => entry.name === testTurtleName);
    expect(lane).toBeDefined();
    expect(lane?.status).toBe("stopped");
    expect(lane?.task).not.toBe("archived task from stale state");
  });
});

describe("GET /api/subturtles/:name", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/subturtles/my-turtle");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("my-turtle");
  });

  it("returns 404 for invalid name with path traversal", async () => {
    const result = findRoute("/api/subturtles/..%2Fevil");
    // The pattern matches, but handler should reject via validateSubturtleName
    if (result) {
      const { req, url } = makeReq("/api/subturtles/..%2Fevil");
      const res = await result.handler(req, url, result.match);
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toContain("Invalid");
    }
  });

  it("returns 404 for non-existent SubTurtle", async () => {
    // This will go through ctl list which won't find "__nonexistent__"
    const result = findRoute("/api/subturtles/__nonexistent_test_turtle__");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/subturtles/__nonexistent_test_turtle__");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("SubTurtle not found");
  });
});

describe("GET /api/subturtles/:name/logs", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/subturtles/my-turtle/logs");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("my-turtle");
  });

  it("does not match the detail route", () => {
    // /logs path should match the logs route, not the detail route
    const logsResult = findRoute("/api/subturtles/my-turtle/logs");
    expect(logsResult).not.toBeNull();
    // Verify it matched the logs pattern (has /logs suffix)
    expect(logsResult!.match[0]).toContain("/logs");
  });

  it("returns 404 for invalid name", async () => {
    const result = findRoute("/api/subturtles/..%2Fevil/logs");
    if (result) {
      const { req, url } = makeReq("/api/subturtles/..%2Fevil/logs");
      const res = await result.handler(req, url, result.match);
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toContain("Invalid");
    }
  });

  it("returns 404 for non-existent SubTurtle (no pid or log)", async () => {
    const result = findRoute("/api/subturtles/__nonexistent_test_turtle__/logs");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/subturtles/__nonexistent_test_turtle__/logs");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("SubTurtle not found");
  });

  // Test with a real log file in the .subturtles directory
  const testTurtleName = "__test_logs_turtle__";
  const testDir = join(WORKING_DIR, ".subturtles", testTurtleName);

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "subturtle.pid"), "99999");
    writeFileSync(join(testDir, "subturtle.log"), "line1\nline2\nline3\n");
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns log lines for existing SubTurtle with log file", async () => {
    const result = findRoute(`/api/subturtles/${testTurtleName}/logs`);
    expect(result).not.toBeNull();
    const { req, url } = makeReq(`/api/subturtles/${testTurtleName}/logs?lines=10`);
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe(testTurtleName);
    expect(body.lines).toBeInstanceOf(Array);
    expect((body.lines as string[]).length).toBeGreaterThan(0);
    expect(body.totalLines).toBeGreaterThanOrEqual(3);
  });
});

/* ── Route table tests for /api/cron ──────────────────────────────── */

describe("GET /api/cron", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/cron");
    expect(result).not.toBeNull();
  });

  it("returns 200 with jobs array", async () => {
    const result = findRoute("/api/cron");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/cron");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect(body.jobs).toBeInstanceOf(Array);
  });
});

describe("GET /api/cron/:id", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/cron/abc123");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("abc123");
  });

  it("does not match the list route", () => {
    // /api/cron should match the list route, not the detail route
    const listResult = findRoute("/api/cron");
    expect(listResult).not.toBeNull();
    expect(listResult!.match[0]).toBe("/api/cron");
  });

  it("returns 404 for non-existent cron job", async () => {
    const result = findRoute("/api/cron/__nonexistent_job_id__");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/cron/__nonexistent_job_id__");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("Cron job not found");
  });
});

/* ── Route table tests for /api/processes ─────────────────────────── */

describe("GET /api/processes", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/processes");
    expect(result).not.toBeNull();
  });

  it("returns 200 with processes array containing detailLink", async () => {
    const result = findRoute("/api/processes");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/processes");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect(body.processes).toBeInstanceOf(Array);
    const processes = body.processes as Array<Record<string, unknown>>;
    // Should always have at least the built-in driver + background processes
    expect(processes.length).toBeGreaterThanOrEqual(3);
    for (const p of processes) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.detailLink).toBe("string");
      expect((p.detailLink as string)).toContain("/api/processes/");
    }
  });

  it("marks the active driver as queued when deferred messages exist", async () => {
    const queueChatId = 980101;
    const originalDriver = session.activeDriver;
    clearDeferredQueue(queueChatId);

    try {
      session.activeDriver = "claude";
      enqueueTestMessage(queueChatId, "queued while active", Date.now() - 1500);

      const result = findRoute("/api/processes");
      expect(result).not.toBeNull();
      const { req, url } = makeReq("/api/processes");
      const res = await result!.handler(req, url, result!.match);
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      const processes = body.processes as Array<Record<string, unknown>>;
      const claude = processes.find((p) => p.id === "driver-claude");
      const codex = processes.find((p) => p.id === "driver-codex");

      expect(claude).toBeDefined();
      expect(claude?.status).toBe("queued");
      expect(String(claude?.detail || "")).toContain("queued msg");
      expect(codex).toBeDefined();
      expect(codex?.status).not.toBe("queued");
    } finally {
      clearDeferredQueue(queueChatId);
      session.activeDriver = originalDriver;
    }
  });

  it("keeps stopped subturtles as stopped and formats elapsed as 0s", async () => {
    const testTurtleName = "__test_stopped_status_turtle__";
    const testDir = join(WORKING_DIR, ".subturtles", testTurtleName);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "CLAUDE.md"), "# Current task\nCheck stopped formatting\n");

    try {
      const result = findRoute("/api/processes");
      expect(result).not.toBeNull();
      const { req, url } = makeReq("/api/processes");
      const res = await result!.handler(req, url, result!.match);
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      const processes = body.processes as Array<Record<string, unknown>>;
      const subturtle = processes.find((p) => p.id === `subturtle-${testTurtleName}`);

      expect(subturtle).toBeDefined();
      expect(subturtle?.status).toBe("stopped");
      expect(subturtle?.elapsed).toBe("0s");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("shows only the executing driver as running during a codex turn", async () => {
    const originalDriver = session.activeDriver;
    const stopProcessing = session.startProcessing();

    try {
      session.activeDriver = "codex";
      setExecutingDriverForTests("codex");

      const result = findRoute("/api/processes");
      expect(result).not.toBeNull();
      const { req, url } = makeReq("/api/processes");
      const res = await result!.handler(req, url, result!.match);
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      const processes = body.processes as Array<Record<string, unknown>>;
      const claude = processes.find((p) => p.id === "driver-claude");
      const codex = processes.find((p) => p.id === "driver-codex");

      expect(claude).toBeDefined();
      expect(claude?.status).toBe("idle");
      expect(claude?.pid).toBe("-");
      expect(codex).toBeDefined();
      expect(codex?.status).toBe("running");
      expect(codex?.pid).toBe("active");
    } finally {
      stopProcessing();
      session.activeDriver = originalDriver;
      setExecutingDriverForTests(null);
    }
  });
});

describe("GET /api/queue", () => {
  const queueChatA = 980001;
  const queueChatB = 980002;

  beforeEach(() => {
    clearDeferredQueue(queueChatA);
    clearDeferredQueue(queueChatB);
  });

  afterEach(() => {
    clearDeferredQueue(queueChatA);
    clearDeferredQueue(queueChatB);
  });

  it("matches the route pattern", () => {
    const result = findRoute("/api/queue");
    expect(result).not.toBeNull();
  });

  it("returns 200 with queue-only payload", async () => {
    const result = findRoute("/api/queue");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/queue");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.totalChats).toBe("number");
    expect(typeof body.totalMessages).toBe("number");
    expect(body.chats).toBeInstanceOf(Array);
  });

  it("returns queue payload without nested dashboard wrappers", async () => {
    const now = Date.now();
    enqueueTestMessage(queueChatA, "first queue message", now - 5000);
    enqueueTestMessage(queueChatA, "second queue message", now - 2000);
    enqueueTestMessage(queueChatB, "single queue message", now - 1000);

    const result = findRoute("/api/queue");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/queue");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.deferredQueue).toBeUndefined();
    expect(body.totalChats).toBe(2);
    expect(body.totalMessages).toBe(3);

    const chats = body.chats as Array<Record<string, unknown>>;
    const chatA = chats.find((chat) => chat.chatId === queueChatA);
    const chatB = chats.find((chat) => chat.chatId === queueChatB);
    expect(chatA).toBeDefined();
    expect(chatB).toBeDefined();
    expect(chatA?.size).toBe(2);
    expect(chatB?.size).toBe(1);
    expect(chatA?.preview).toBeInstanceOf(Array);
    expect((chatA?.preview as string[])[0]).toContain("first queue message");
  });
});

describe("GET /api/processes/:id", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/processes/driver-claude");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("driver-claude");
  });

  it("returns 200 with detail for driver-claude", async () => {
    const result = findRoute("/api/processes/driver-claude");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/processes/driver-claude");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    const process = body.process as Record<string, unknown>;
    expect(process.id).toBe("driver-claude");
    expect(process.kind).toBe("driver");
    expect(process.detailLink).toBe("/api/processes/driver-claude");
    const extra = body.extra as Record<string, unknown>;
    expect(extra.kind).toBe("driver");
    expect(typeof extra.model).toBe("string");
  });

  it("returns 200 with detail for background-check", async () => {
    const result = findRoute("/api/processes/background-check");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/processes/background-check");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const extra = body.extra as Record<string, unknown>;
    expect(extra.kind).toBe("background");
    expect(typeof extra.runActive).toBe("boolean");
  });

  it("returns 404 for non-existent process", async () => {
    const result = findRoute("/api/processes/__nonexistent__");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/processes/__nonexistent__");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("Process not found");
  });
});

/* ── Route table tests for /api/jobs ─────────────────────────────── */

describe("GET /api/jobs/current", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/jobs/current");
    expect(result).not.toBeNull();
  });

  it("returns 200 with jobs array", async () => {
    const result = findRoute("/api/jobs/current");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/jobs/current");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect(body.jobs).toBeInstanceOf(Array);
  });
});

describe("GET /api/jobs/:id", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/jobs/driver:claude:active");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("driver:claude:active");
  });

  it("does not match /api/jobs/current as a job ID", () => {
    // /api/jobs/current should match the current-jobs route, not job detail
    const result = findRoute("/api/jobs/current");
    expect(result).not.toBeNull();
    // The match should be the /current route (no capture group)
    expect(result!.match[1]).toBeUndefined();
  });

  it("returns 404 for non-existent job", async () => {
    const result = findRoute("/api/jobs/__nonexistent_job__");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/jobs/__nonexistent_job__");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("Job not found");
  });
});

describe("GET /dashboard", () => {
  it("matches the route pattern and renders styled HTML", async () => {
    const result = findRoute("/dashboard");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("<html");
    expect(html.toLowerCase()).toContain("<style>");
    expect(html).toContain("class=\"panel panel-sessions\"");
    expect(html).toContain("class=\"page-header\"");
    expect(html).toContain("id=\"sessionToggleBtn\"");
    expect(html).toContain("id=\"loadingOverlay\"");
    expect(html).toContain("Loading dashboard...");
    expect(html).toContain("Last updated");
    expect(html).toContain("Show more sessions");
    expect(html).toContain("/api/dashboard/overview");
    expect(html).not.toContain("/api/conductor");
    expect(html).not.toContain("Sessions: 0");
    expect(html).not.toContain("SubTurtles: 0");
    expect(html).not.toContain("Status: loading dashboard...");
    expect(html).toContain("height: clamp(180px, 26vh, 300px);");
  });

  it("renders JavaScript that parses successfully", async () => {
    const result = findRoute("/dashboard");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const html = await res.text();
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch![1]!)).not.toThrow();
  });
});

describe("GET /api/dashboard/overview", () => {
  it("matches the overview route pattern", () => {
    const result = findRoute("/api/dashboard/overview");
    expect(result).not.toBeNull();
  });

  it("returns a consolidated overview payload", async () => {
    const result = findRoute("/api/dashboard/overview");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/dashboard/overview");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      dashboard?: { turtles?: unknown[]; processes?: unknown[]; cronJobs?: unknown[] };
      sessions?: { sessions?: unknown[] };
      jobs?: { jobs?: unknown[] };
    };
    expect(Array.isArray(body.dashboard?.turtles)).toBe(true);
    expect(Array.isArray(body.dashboard?.processes)).toBe(true);
    expect(Array.isArray(body.dashboard?.cronJobs)).toBe(true);
    expect(Array.isArray(body.sessions?.sessions)).toBe(true);
    expect(Array.isArray(body.jobs?.jobs)).toBe(true);
  });
});

describe("GET /dashboard/subturtles/:name", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/dashboard/subturtles/my-turtle");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("my-turtle");
  });

  it("returns 404 for invalid name with path traversal", async () => {
    const result = findRoute("/dashboard/subturtles/..%2Fevil");
    if (result) {
      const { req, url } = makeReq("/dashboard/subturtles/..%2Fevil");
      const res = await result.handler(req, url, result.match);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Invalid SubTurtle name");
    }
  });
});

describe("GET /dashboard/processes/:id", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/dashboard/processes/driver-claude");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("driver-claude");
  });
});

describe("GET /dashboard/jobs/:id", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/dashboard/jobs/driver:claude:active");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("driver:claude:active");
  });
});

describe("GET /dashboard/sessions/:driver/:sessionId", () => {
  const originalState = {
    sessionId: session.sessionId,
    conversationTitle: session.conversationTitle,
  };
  const originalCodexState = {
    getSessionList: codexSession.getSessionList,
    getSessionTranscript: codexSession.getSessionTranscript,
    getActiveSessionSnapshot: codexSession.getActiveSessionSnapshot,
  };

  afterEach(() => {
    session.sessionId = originalState.sessionId;
    session.conversationTitle = originalState.conversationTitle;
    codexSession.getSessionList = originalCodexState.getSessionList;
    codexSession.getSessionTranscript = originalCodexState.getSessionTranscript;
    codexSession.getActiveSessionSnapshot = originalCodexState.getActiveSessionSnapshot;
    clearTurnLogFile();
  });

  it("matches the route pattern", () => {
    const result = findRoute("/dashboard/sessions/claude/session-123");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("claude");
    expect(result!.match[2]).toBe("session-123");
  });

  it("renders conversation-first layout with injected context message", async () => {
    session.sessionId = "dashboard-session-html";
    session.conversationTitle = "Dashboard html session";

    appendTurnLogEntry({
      driver: "claude",
      source: "text",
      sessionId: "dashboard-session-html",
      userId: 1,
      username: "tester",
      chatId: 1,
      model: "claude-opus-4-6",
      effort: "high",
      originalMessage: "Hello!!",
      effectivePrompt: "[Current date/time: ...]\n\nHello!!",
      injectedArtifacts: [
        {
          id: "claude-md",
          label: "CLAUDE.md context",
          order: 10,
          text: "## Current task\nAuditability\n",
          applied: true,
        },
        {
          id: "meta-prompt",
          label: "Meta system prompt",
          order: 20,
          text: "meta prompt text",
          applied: true,
        },
        {
          id: "date-prefix",
          label: "Date/time prefix",
          order: 30,
          text: "[Current date/time: ...]\n\n",
          applied: true,
        },
      ],
      injections: {
        datePrefixApplied: true,
        metaPromptApplied: true,
        cronScheduledPromptApplied: false,
        backgroundSnapshotPromptApplied: false,
      },
      context: {
        claudeMdLoaded: true,
        metaSharedLoaded: true,
      },
      startedAt: "2026-03-07T15:17:12.480Z",
      completedAt: "2026-03-07T15:17:17.895Z",
      elapsedMs: 5416,
      status: "completed",
      response: "Hey! 👋 What's up?",
      error: null,
      usage: {
        inputTokens: 3,
        outputTokens: 14,
      },
    });

    const result = findRoute("/dashboard/sessions/claude/dashboard-session-html");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard/sessions/claude/dashboard-session-html");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Conversation");
    expect(html).toContain("Injected context");
    expect(html).toContain("<div class=\"injected-heading\">");
    expect(html).toContain("<ol class=\"injected-list\">");
    expect(html).toContain("Project instructions");
    expect(html).toContain("META prompt");
    expect(html).toContain("Date/time prefix");
    expect(html).toContain("How instructions are passed to this CLI");
    expect(html).toContain("--setting-sources user,project");
    expect(html).toContain("--system-prompt");
    expect(html).toContain("<details><summary>CLAUDE.md context (");
    expect(html).toContain("<details><summary>Meta system prompt (");
    expect(html).toContain("<details><summary>Date/time prefix (");
    expect(html).toContain("<pre>[Current date/time: ...]");
    const claudeIdx = html.indexOf("<summary>CLAUDE.md context (");
    const metaIdx = html.indexOf("<summary>Meta system prompt (");
    const dateIdx = html.indexOf("<summary>Date/time prefix (");
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(metaIdx).toBeGreaterThan(claudeIdx);
    expect(metaIdx).toBeGreaterThan(-1);
    expect(dateIdx).toBeGreaterThan(metaIdx);
    expect(html).toContain("Debug details");
    expect(html).not.toContain("Turn Timeline");
  });

  it("renders a legacy notice when turn log has no injected artifacts", async () => {
    session.sessionId = "dashboard-session-legacy";
    session.conversationTitle = "Legacy session";

    appendTurnLogEntry({
      driver: "claude",
      source: "text",
      sessionId: "dashboard-session-legacy",
      userId: 1,
      username: "tester",
      chatId: 1,
      model: "claude-opus-4-6",
      effort: "high",
      originalMessage: "Hi",
      effectivePrompt: "Hi",
      injectedArtifacts: [],
      injections: {
        datePrefixApplied: false,
        metaPromptApplied: false,
        cronScheduledPromptApplied: false,
        backgroundSnapshotPromptApplied: false,
      },
      context: {
        claudeMdLoaded: false,
        metaSharedLoaded: false,
      },
      startedAt: "2026-03-07T16:00:00.000Z",
      completedAt: "2026-03-07T16:00:01.000Z",
      elapsedMs: 1000,
      status: "completed",
      response: "Hello",
      error: null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    });

    const result = findRoute("/dashboard/sessions/claude/dashboard-session-legacy");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard/sessions/claude/dashboard-session-legacy");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Legacy turn log");
    expect(html).toContain("No captured injected artifacts for this turn (legacy log entry).");
  });

  it("renders transcript-backed Codex history and meta prompt evidence without turn logs", async () => {
    codexSession.getSessionList = () => [
      {
        session_id: "codex-transcript-session",
        saved_at: "2026-03-07T16:00:00.000Z",
        working_dir: WORKING_DIR,
        title: "Codex transcript session",
      },
    ];
    codexSession.getSessionTranscript = async () => ({
      sessionId: "codex-transcript-session",
      path: "/tmp/codex-transcript-session.jsonl",
      messages: [
        {
          role: "user",
          text: "Older Codex user message",
          timestamp: "2026-03-07T16:00:00.000Z",
        },
        {
          role: "assistant",
          text: "Older Codex assistant reply",
          timestamp: "2026-03-07T16:00:01.000Z",
        },
      ],
      injectedArtifacts: [
        {
          id: "codex-bootstrap-prompt",
          label: "Codex bootstrap prompt",
          order: 20,
          text: "meta prompt from transcript",
          applied: true,
        },
        {
          id: "date-prefix",
          label: "Date/time prefix",
          order: 30,
          text: "[Current date/time: Saturday, March 7, 2026 at 05:00 PM GMT+1]\n\n",
          applied: true,
        },
      ],
      metaSharedLoaded: true,
      datePrefixApplied: true,
    });

    const result = findRoute("/dashboard/sessions/codex/codex-transcript-session");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard/sessions/codex/codex-transcript-session");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Older Codex user message");
    expect(html).toContain("Older Codex assistant reply");
    expect(html).toContain("<div class=\"injected-heading\">");
    expect(html).toContain("<ol class=\"injected-list\">");
    expect(html).toContain("Project instructions");
    expect(html).toContain("Codex bootstrap prompt");
    expect(html).toContain("Date/time prefix");
    expect(html).toContain("meta prompt from transcript");
    expect(html).toContain("How instructions are passed to this CLI");
    expect(html).toContain("workingDirectory set to the repo root");
    expect(html).toContain("&lt;system-instructions&gt;");
    expect(html).not.toContain("No captured injections for this session.");
  });

  it("merges Codex transcript artifacts with turn-log artifacts for stable session detail", async () => {
    codexSession.getSessionList = () => [
      {
        session_id: "codex-merged-artifacts",
        saved_at: "2026-03-07T16:00:00.000Z",
        working_dir: WORKING_DIR,
        title: "Codex merged artifacts session",
      },
    ];
    codexSession.getSessionTranscript = async () => ({
      sessionId: "codex-merged-artifacts",
      path: "/tmp/codex-merged-artifacts.jsonl",
      messages: [
        {
          role: "user",
          text: "Transcript user message",
          timestamp: "2026-03-07T16:00:00.000Z",
        },
        {
          role: "assistant",
          text: "Transcript assistant reply",
          timestamp: "2026-03-07T16:00:01.000Z",
        },
      ],
      injectedArtifacts: [
        {
          id: "codex-bootstrap-prompt",
          label: "Codex bootstrap prompt",
          order: 20,
          text: "meta prompt from transcript",
          applied: true,
        },
        {
          id: "date-prefix",
          label: "Date/time prefix",
          order: 30,
          text: "[Current date/time: Saturday, March 7, 2026 at 05:00 PM GMT+1]\n\n",
          applied: true,
        },
      ],
      metaSharedLoaded: true,
      datePrefixApplied: true,
    });

    appendTurnLogEntry({
      driver: "codex",
      source: "text",
      sessionId: "codex-merged-artifacts",
      userId: 1,
      username: "tester",
      chatId: 1,
      model: "gpt-5.3-codex",
      effort: "high",
      originalMessage: "Transcript user message",
      effectivePrompt: "Transcript user message",
      injectedArtifacts: [
        {
          id: "claude-md",
          label: "CLAUDE.md context",
          order: 10,
          text: "## Current task\nStabilize session detail\n",
          applied: true,
        },
      ],
      injections: {
        datePrefixApplied: false,
        metaPromptApplied: false,
        cronScheduledPromptApplied: false,
        backgroundSnapshotPromptApplied: false,
      },
      context: {
        claudeMdLoaded: true,
        metaSharedLoaded: true,
      },
      startedAt: "2026-03-07T16:00:00.000Z",
      completedAt: "2026-03-07T16:00:02.000Z",
      elapsedMs: 2000,
      status: "completed",
      response: "Transcript assistant reply",
      error: null,
      usage: {
        inputTokens: 5,
        outputTokens: 8,
      },
    });

    const result = findRoute("/dashboard/sessions/codex/codex-merged-artifacts");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard/sessions/codex/codex-merged-artifacts");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("CLAUDE.md context");
    expect(html).toContain("Codex bootstrap prompt");
    expect(html).toContain("Date/time prefix");
    expect(html).toContain("meta prompt from transcript");
    expect(html).toContain("Stabilize session detail");
  });

  it("prefers fresher active Codex messages over stale transcript history", async () => {
    codexSession.getSessionList = () => [
      {
        session_id: "codex-live-detail-session",
        saved_at: "2026-03-07T16:00:00.000Z",
        working_dir: WORKING_DIR,
        title: "Codex live detail session",
      },
    ];
    codexSession.getActiveSessionSnapshot = () => ({
      session_id: "codex-live-detail-session",
      saved_at: "2026-03-07T16:05:00.000Z",
      working_dir: WORKING_DIR,
      title: "Codex live detail session",
      recentMessages: [
        {
          role: "user",
          text: "Newer live Codex user message",
          timestamp: "2026-03-07T16:05:00.000Z",
        },
        {
          role: "assistant",
          text: "Newer live Codex assistant reply",
          timestamp: "2026-03-07T16:05:01.000Z",
        },
      ],
    });
    codexSession.getSessionTranscript = async () => ({
      sessionId: "codex-live-detail-session",
      path: "/tmp/codex-live-detail-session.jsonl",
      messages: [
        {
          role: "user",
          text: "Older transcript Codex user message",
          timestamp: "2026-03-07T16:00:00.000Z",
        },
        {
          role: "assistant",
          text: "Older transcript Codex assistant reply",
          timestamp: "2026-03-07T16:00:01.000Z",
        },
      ],
      injectedArtifacts: [],
      metaSharedLoaded: true,
      datePrefixApplied: true,
    });

    const result = findRoute("/dashboard/sessions/codex/codex-live-detail-session");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/dashboard/sessions/codex/codex-live-detail-session");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Newer live Codex user message");
    expect(html).toContain("Newer live Codex assistant reply");
    expect(html).not.toContain("Older transcript Codex user message");
    expect(html).not.toContain("Older transcript Codex assistant reply");
  });
});

/* ── Route table tests for /api/session ───────────────────────────── */

describe("GET /api/session", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/session");
    expect(result).not.toBeNull();
  });

  it("returns 200 with session state fields", async () => {
    const result = findRoute("/api/session");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/session");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.model).toBe("string");
    expect(typeof body.modelDisplayName).toBe("string");
    expect(typeof body.effort).toBe("string");
    expect(typeof body.activeDriver).toBe("string");
    expect(typeof body.isRunning).toBe("boolean");
    expect(typeof body.isActive).toBe("boolean");
  });
});

describe("GET /api/sessions", () => {
  const originalState = {
    sessionId: session.sessionId,
    conversationTitle: session.conversationTitle,
    recentMessages: [...session.recentMessages],
    lastActivity: session.lastActivity,
  };
  const originalCodexState = {
    recentMessages: [...codexSession.recentMessages],
    lastActivity: codexSession.lastActivity,
    getSessionList: codexSession.getSessionList,
    getSessionListLive: codexSession.getSessionListLive,
    getActiveSessionSnapshot: codexSession.getActiveSessionSnapshot,
  };

  afterEach(() => {
    session.sessionId = originalState.sessionId;
    session.conversationTitle = originalState.conversationTitle;
    session.recentMessages = [...originalState.recentMessages];
    session.lastActivity = originalState.lastActivity;
    codexSession.recentMessages = [...originalCodexState.recentMessages];
    codexSession.lastActivity = originalCodexState.lastActivity;
    codexSession.getSessionList = originalCodexState.getSessionList;
    codexSession.getSessionListLive = originalCodexState.getSessionListLive;
    codexSession.getActiveSessionSnapshot = originalCodexState.getActiveSessionSnapshot;
    resetDashboardSessionCachesForTests();
  });

  it("matches the route pattern", () => {
    const result = findRoute("/api/sessions");
    expect(result).not.toBeNull();
  });

  it("returns active claude session with recent messages", async () => {
    session.sessionId = "dashboard-test-session";
    session.conversationTitle = "Dashboard test title";
    session.lastActivity = new Date("2026-03-07T15:00:00.000Z");
    session.recentMessages = [
      {
        role: "user",
        text: "Hello dashboard",
        timestamp: "2026-03-07T15:00:00.000Z",
      },
      {
        role: "assistant",
        text: "Hi from assistant",
        timestamp: "2026-03-07T15:00:01.000Z",
      },
    ];

    const listRoute = findRoute("/api/sessions");
    expect(listRoute).not.toBeNull();
    const { req, url } = makeReq("/api/sessions");
    const listRes = await listRoute!.handler(req, url, listRoute!.match);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as Record<string, unknown>;
    expect(listBody.generatedAt).toBeDefined();
    expect(listBody.sessions).toBeInstanceOf(Array);

    const sessions = listBody.sessions as Array<Record<string, unknown>>;
    const match = sessions.find((entry) => entry.sessionId === "dashboard-test-session");
    expect(match).toBeDefined();
    expect(match?.driver).toBe("claude");
    expect(match?.status).toBe("active-idle");
    expect(match?.messageCount).toBe(2);
  });

  it("excludes live-only codex sessions from the app-server listing", async () => {
    codexSession.recentMessages = [];
    codexSession.lastActivity = null;
    codexSession.getSessionList = () => [];
    codexSession.getSessionListLive = async () => [
      {
        session_id: "codex-live-session",
        saved_at: "2026-03-07T16:30:00.000Z",
        working_dir: WORKING_DIR,
        title: "Live Codex session",
        preview: "You: check dashboard",
      },
    ];

    const listRoute = findRoute("/api/sessions");
    expect(listRoute).not.toBeNull();
    const { req, url } = makeReq("/api/sessions");
    const listRes = await listRoute!.handler(req, url, listRoute!.match);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as Record<string, unknown>;
    const sessions = listBody.sessions as Array<Record<string, unknown>>;
    const match = sessions.find((entry) => entry.sessionId === "codex-live-session");
    expect(match).toBeUndefined();
  });

  it("includes tracked live codex sessions from the app-server listing", async () => {
    codexSession.recentMessages = [];
    codexSession.lastActivity = null;
    codexSession.getSessionList = () => [];
    codexSession.getSessionListLive = async () => [
      {
        session_id: "codex-live-session",
        saved_at: "2026-03-07T16:30:00.000Z",
        working_dir: WORKING_DIR,
        title: "Live Codex session",
        preview: "You: check dashboard",
      },
    ];

    appendTurnLogEntry({
      driver: "codex",
      source: "text",
      sessionId: "codex-live-session",
      userId: 1,
      username: "tester",
      chatId: 1,
      model: "codex",
      effort: "high",
      originalMessage: "check dashboard",
      effectivePrompt: "<system-instructions>META</system-instructions>\n\n[Current date/time: ...]\n\ncheck dashboard",
      injectedArtifacts: [],
      injections: {
        datePrefixApplied: true,
        metaPromptApplied: true,
        cronScheduledPromptApplied: false,
        backgroundSnapshotPromptApplied: false,
      },
      context: {
        claudeMdLoaded: true,
        metaSharedLoaded: true,
      },
      startedAt: "2026-03-07T16:30:00.000Z",
      completedAt: "2026-03-07T16:30:01.000Z",
      elapsedMs: 1000,
      status: "completed",
      response: "dashboard checked",
      error: null,
      usage: {
        inputTokens: 5,
        outputTokens: 7,
      },
    });

    const listRoute = findRoute("/api/sessions");
    expect(listRoute).not.toBeNull();
    const { req, url } = makeReq("/api/sessions");
    const listRes = await listRoute!.handler(req, url, listRoute!.match);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as Record<string, unknown>;
    const sessions = listBody.sessions as Array<Record<string, unknown>>;
    const match = sessions.find((entry) => entry.sessionId === "codex-live-session");
    expect(match).toBeDefined();
    expect(match?.driver).toBe("codex");
  });

  it("includes an active codex session before it is saved or turn-logged", async () => {
    codexSession.getSessionList = () => [];
    codexSession.getSessionListLive = async () => [];
    codexSession.getActiveSessionSnapshot = () => ({
      session_id: "codex-active-session",
      saved_at: "2026-03-07T16:40:00.000Z",
      working_dir: WORKING_DIR,
      title: "Active Codex session",
      preview: "You: check live visibility",
      recentMessages: [
        {
          role: "user",
          text: "check live visibility",
          timestamp: "2026-03-07T16:40:00.000Z",
        },
      ],
    });

    const listRoute = findRoute("/api/sessions");
    expect(listRoute).not.toBeNull();
    const { req, url } = makeReq("/api/sessions");
    const listRes = await listRoute!.handler(req, url, listRoute!.match);
    expect(listRes.status).toBe(200);

    const listBody = await listRes.json() as Record<string, unknown>;
    const sessions = listBody.sessions as Array<Record<string, unknown>>;
    const match = sessions.find((entry) => entry.sessionId === "codex-active-session");

    expect(match).toBeDefined();
    expect(match?.driver).toBe("codex");
    expect(match?.status).toBe("active-idle");
  });
});

describe("GET /api/sessions/:driver/:sessionId", () => {
  const originalState = {
    sessionId: session.sessionId,
    recentMessages: [...session.recentMessages],
  };

  afterEach(() => {
    session.sessionId = originalState.sessionId;
    session.recentMessages = [...originalState.recentMessages];
  });

  it("matches the route pattern", () => {
    const result = findRoute("/api/sessions/claude/session-123");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("claude");
    expect(result!.match[2]).toBe("session-123");
  });

  it("returns detail payload for active claude session", async () => {
    session.sessionId = "session-detail-test";
    session.recentMessages = [
      { role: "user", text: "A", timestamp: "2026-03-07T15:10:00.000Z" },
      { role: "assistant", text: "B", timestamp: "2026-03-07T15:10:01.000Z" },
    ];

    const result = findRoute("/api/sessions/claude/session-detail-test");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/sessions/claude/session-detail-test");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    const sessionInfo = body.session as Record<string, unknown>;
    expect(sessionInfo.sessionId).toBe("session-detail-test");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    const meta = body.meta as Record<string, unknown>;
    expect(typeof meta.model).toBe("string");
    expect(typeof meta.effort).toBe("string");
  });

  it("returns 404 for missing session", async () => {
    const result = findRoute("/api/sessions/claude/__nope__");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/sessions/claude/__nope__");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:driver/:sessionId/turns", () => {
  const originalState = {
    sessionId: session.sessionId,
    conversationTitle: session.conversationTitle,
  };

  afterEach(() => {
    session.sessionId = originalState.sessionId;
    session.conversationTitle = originalState.conversationTitle;
    clearTurnLogFile();
  });

  it("matches the route pattern", () => {
    const result = findRoute("/api/sessions/claude/session-123/turns");
    expect(result).not.toBeNull();
    expect(result!.match[1]).toBe("claude");
    expect(result!.match[2]).toBe("session-123");
  });

  it("returns turn timeline for an active session", async () => {
    session.sessionId = "turn-log-session";
    session.conversationTitle = "Turn log title";

    appendTurnLogEntry({
      driver: "claude",
      source: "cron_scheduled",
      sessionId: "turn-log-session",
      userId: 123,
      username: "tester",
      chatId: 456,
      model: "claude-opus-4-6",
      effort: "high",
      originalMessage: "run the daily update",
      effectivePrompt: "[Current date/time: ...]\nrun the daily update",
      injectedArtifacts: [
        {
          id: "cron-scheduled",
          label: "Cron scheduled instruction",
          order: 40,
          text: "(This is a scheduled message. Start your response with \"🔔 Scheduled:\" on its own line before anything else.)",
          applied: true,
        },
      ],
      injections: {
        datePrefixApplied: true,
        metaPromptApplied: true,
        cronScheduledPromptApplied: true,
        backgroundSnapshotPromptApplied: false,
      },
      context: {
        claudeMdLoaded: true,
        metaSharedLoaded: true,
      },
      startedAt: "2026-03-07T15:00:00.000Z",
      completedAt: "2026-03-07T15:00:03.000Z",
      elapsedMs: 3000,
      status: "completed",
      response: "Done.",
      error: null,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
      },
    });

    const result = findRoute("/api/sessions/claude/turn-log-session/turns");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/sessions/claude/turn-log-session/turns");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect((body.session as Record<string, unknown>).sessionId).toBe("turn-log-session");
    const turns = body.turns as Array<Record<string, unknown>>;
    expect(turns.length).toBe(1);
    expect(turns[0]?.source).toBe("cron_scheduled");
    expect((turns[0]?.injections as Record<string, unknown>).cronScheduledPromptApplied).toBe(true);
    const artifacts = turns[0]?.injectedArtifacts as Array<Record<string, unknown>>;
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]?.id).toBe("cron-scheduled");
  });
});

/* ── Route table tests for /api/context ───────────────────────────── */

describe("GET /api/context", () => {
  it("matches the route pattern", () => {
    const result = findRoute("/api/context");
    expect(result).not.toBeNull();
  });

  it("returns 200 with context fields", async () => {
    const result = findRoute("/api/context");
    expect(result).not.toBeNull();
    const { req, url } = makeReq("/api/context");
    const res = await result!.handler(req, url, result!.match);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.claudeMd).toBe("string");
    expect(typeof body.claudeMdPath).toBe("string");
    expect(typeof body.claudeMdExists).toBe("boolean");
    expect(typeof body.metaPrompt).toBe("string");
    expect(typeof body.metaPromptSource).toBe("string");
    expect(typeof body.metaPromptExists).toBe("boolean");
    expect(typeof body.agentsMdExists).toBe("boolean");
  });
});
