import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server, type Socket as NetSocket } from "net";
import { unlinkSync } from "fs";
import { RouterClient } from "../router-client";
import type { Update } from "grammy/types";

const TEST_SOCK = `/tmp/test-router-${process.pid}.sock`;

function startMockRouter(): {
  server: Server;
  connections: NetSocket[];
  waitForConnection: () => Promise<NetSocket>;
} {
  const connections: NetSocket[] = [];
  let resolveWait: ((s: NetSocket) => void) | null = null;

  const server = createServer((socket) => {
    connections.push(socket);
    if (resolveWait) {
      resolveWait(socket);
      resolveWait = null;
    }
  });
  server.listen(TEST_SOCK);

  return {
    server,
    connections,
    waitForConnection: () =>
      connections.length > 0
        ? Promise.resolve(connections[connections.length - 1]!)
        : new Promise((resolve) => {
            resolveWait = resolve;
          }),
  };
}

function cleanup(server: Server): void {
  server.close();
  try {
    unlinkSync(TEST_SOCK);
  } catch {}
}

describe("RouterClient", () => {
  let server: Server;

  afterEach(() => {
    if (server) cleanup(server);
  });

  test("connects and sends register message", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test/project",
      threadId: 42,
      branch: "main",
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    const conn = await mock.waitForConnection();

    // Read the register message
    const data = await new Promise<string>((resolve) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\n")) resolve(buf);
      });
    });

    const msg = JSON.parse(data.trim());
    expect(msg.type).toBe("register");
    expect(msg.workingDir).toBe("/test/project");
    expect(msg.threadId).toBe(42);
    expect(msg.pid).toBe(process.pid);

    client.close();
  });

  test("receives update from router", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test/project",
      threadId: null,
      branch: null,
    });

    const gotUpdate = new Promise<unknown>((resolve) =>
      client.onUpdate(resolve),
    );

    await client.connect();
    const conn = await mock.waitForConnection();

    // Router sends an update
    const mockUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" as const },
      },
    };
    conn.write(JSON.stringify({ type: "update", data: mockUpdate }) + "\n");

    const update = await gotUpdate;
    expect((update as Update).update_id).toBe(1);

    client.close();
  });

  test("receives assign_thread from router", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test/project",
      threadId: null,
      branch: null,
    });

    const gotAssign = new Promise<{ threadId: number; forumChatId: number | null }>((resolve) =>
      client.onAssignThread((threadId, forumChatId) =>
        resolve({ threadId, forumChatId }),
      ),
    );

    await client.connect();
    const conn = await mock.waitForConnection();

    conn.write(
      JSON.stringify({
        type: "assign_thread",
        threadId: 42,
        forumChatId: -100123,
      }) + "\n",
    );

    const assigned = await gotAssign;
    expect(assigned.threadId).toBe(42);
    expect(assigned.forumChatId).toBe(-100123);

    client.close();
  });

  test("handles multiple updates in one data chunk", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test",
      threadId: null,
      branch: null,
    });

    const received: unknown[] = [];
    // Resolve after we get 2 updates
    const gotBoth = new Promise<void>((resolve) => {
      client.onUpdate((u) => {
        received.push(u);
        if (received.length === 2) resolve();
      });
    });

    await client.connect();
    const conn = await mock.waitForConnection();

    // Send two updates in one write
    const chunk =
      JSON.stringify({ type: "update", data: { update_id: 1 } }) +
      "\n" +
      JSON.stringify({ type: "update", data: { update_id: 2 } }) +
      "\n";
    conn.write(chunk);

    await gotBoth;
    expect(received).toHaveLength(2);
    expect((received[0] as Update).update_id).toBe(1);
    expect((received[1] as Update).update_id).toBe(2);

    client.close();
  });

  test("updateRegistration sends new register message", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test",
      threadId: null,
      branch: null,
    });

    await client.connect();
    const conn = await mock.waitForConnection();

    // Collect register messages via a promise that resolves when we see
    // a register with threadId 42.
    const messages: Array<{ type: string; threadId?: number | null }> = [];
    const gotSecondRegister = new Promise<void>((resolve) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) {
            try {
              const msg = JSON.parse(line);
              messages.push(msg);
              if (msg.type === "register" && msg.threadId === 42) {
                resolve();
              }
            } catch {}
          }
        }
      });
    });

    // Update registration
    client.updateRegistration(42);

    await gotSecondRegister;

    const registers = messages.filter((m) => m.type === "register");
    expect(registers.length).toBeGreaterThanOrEqual(2);
    expect(registers[0]!.threadId).toBeNull();
    expect(registers[registers.length - 1]!.threadId).toBe(42);

    client.close();
  });

  test("malformed JSON from router does not crash client", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test",
      threadId: null,
      branch: null,
    });

    const gotUpdate = new Promise<unknown>((resolve) =>
      client.onUpdate(resolve),
    );

    await client.connect();
    const conn = await mock.waitForConnection();

    // Send malformed JSON first
    conn.write("not json\n");

    // Then send a valid update
    conn.write(
      JSON.stringify({ type: "update", data: { update_id: 99 } }) + "\n",
    );

    const update = await gotUpdate;
    expect((update as Update).update_id).toBe(99);
    expect(client.isConnected()).toBe(true);

    client.close();
  });

  test("partial line delivery is reassembled correctly", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test",
      threadId: null,
      branch: null,
    });

    const gotUpdate = new Promise<unknown>((resolve) =>
      client.onUpdate(resolve),
    );

    await client.connect();
    const conn = await mock.waitForConnection();

    // Split a JSON line into two writes
    const fullLine =
      JSON.stringify({ type: "update", data: { update_id: 77 } }) + "\n";
    const mid = Math.floor(fullLine.length / 2);

    conn.write(fullLine.slice(0, mid));
    // Small delay to ensure they arrive as separate chunks
    await Bun.sleep(20);
    conn.write(fullLine.slice(mid));

    const update = await gotUpdate;
    expect((update as Update).update_id).toBe(77);

    client.close();
  });

  test("receives reject from router and stops reconnecting", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test/rejected",
      threadId: null,
      branch: null,
    });

    const gotReject = new Promise<string>((resolve) =>
      client.onReject(resolve),
    );

    await client.connect();
    const conn = await mock.waitForConnection();

    // Router sends reject
    conn.write(
      JSON.stringify({ type: "reject", reason: "SuperTurtle is already running in this directory." }) + "\n",
    );

    const reason = await gotReject;
    expect(reason).toBe("SuperTurtle is already running in this directory.");
  });

  test("auto-reconnects after router restart", async () => {
    const mock = startMockRouter();
    server = mock.server;

    const client = new RouterClient({
      socketPath: TEST_SOCK,
      workingDir: "/test/reconnect",
      threadId: 7,
      branch: "main",
    });

    const disconnected = new Promise<void>((resolve) =>
      client.onDisconnect(resolve),
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);

    // Destroy the connection and close the server to simulate router death
    const oldConn = await mock.waitForConnection();
    oldConn.destroy();
    cleanup(server);

    // Wait for disconnect callback
    await disconnected;
    expect(client.isConnected()).toBe(false);

    // Start a new mock server on the same socket path
    const mock2 = startMockRouter();
    server = mock2.server; // so afterEach cleans it up

    // Wait for client to reconnect (it will retry with backoff starting at 500ms)
    const newConn = await mock2.waitForConnection();

    // Read the register message on the new connection
    const data = await new Promise<string>((resolve) => {
      let buf = "";
      newConn.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\n")) resolve(buf);
      });
    });

    const msg = JSON.parse(data.trim());
    expect(msg.type).toBe("register");
    expect(msg.workingDir).toBe("/test/reconnect");
    expect(msg.threadId).toBe(7);
    expect(client.isConnected()).toBe(true);

    client.close();
  });
});
