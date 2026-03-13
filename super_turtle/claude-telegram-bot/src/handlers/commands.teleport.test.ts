import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const commandsPath = resolve(import.meta.dir, "commands.ts");
const driverRoutingPath = resolve(import.meta.dir, "driver-routing.ts");
const deferredQueuePath = resolve(import.meta.dir, "../deferred-queue.ts");
const marker = "__TELEPORT_PROBE__=";

type TeleportProbePayload = {
  replies: Array<{
    text: string;
    extra?: {
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
      };
    };
  }>;
  askUserRequest?: Record<string, unknown> | null;
  spawnCmd: string[];
  spawnOpts: {
    cwd?: string;
    stdin?: string;
    stdout?: string;
    stderr?: string;
    detached?: boolean;
    env?: Record<string, string>;
  } | null;
  unrefCalled: boolean;
};

type TeleportProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: TeleportProbePayload | null;
};

async function runTeleportProbe(messageText: string, options?: {
  running?: boolean;
  queuedItems?: number;
  activeLock?: {
    pid: number;
    logPath: string;
    launchedAt: string;
    mode: "dry-run" | "live";
  };
  existingLogs?: string[];
}): Promise<TeleportProbeResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
    CODEX_ENABLED: "false",
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const modulePath = ${JSON.stringify(commandsPath)};
    const driverRoutingPath = ${JSON.stringify(driverRoutingPath)};
    const deferredQueuePath = ${JSON.stringify(deferredQueuePath)};
    const queuedItems = ${JSON.stringify(options?.queuedItems ?? 0)};
    const running = ${JSON.stringify(options?.running ?? false)};
    const activeLock = ${JSON.stringify(options?.activeLock ?? null)};
    const existingLogs = ${JSON.stringify(options?.existingLogs ?? [])};

    const replies = [];
    let spawnCmd = [];
    let spawnOpts = null;
    let unrefCalled = false;

    Bun.spawn = (cmd, opts) => {
      spawnCmd = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      spawnOpts = opts ?? null;
      return {
        unref: () => {
          unrefCalled = true;
        },
      };
    };

    const { beginBackgroundRun, endBackgroundRun } = await import(driverRoutingPath);
    const { enqueueDeferredMessage } = await import(deferredQueuePath);
    const { handleTeleportCommand } = await import(modulePath);
    const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const ipcDir = mkdtempSync(join(tmpdir(), "teleport-ask-user-"));
    process.env.SUPERTURTLE_IPC_DIR = ipcDir;

    const teleportStateDir = join(process.cwd(), ".superturtle", "teleport");
    const teleportLockPath = join(teleportStateDir, "managed-active.lock");
    const teleportLogDir = join(process.cwd(), ".superturtle", "logs", "teleport");
    rmSync(teleportStateDir, { recursive: true, force: true });
    rmSync(teleportLogDir, { recursive: true, force: true });
    if (activeLock) {
      mkdirSync(teleportStateDir, { recursive: true });
      writeFileSync(
        teleportLockPath,
        [
          "pid=" + String(activeLock.pid),
          "log=" + activeLock.logPath,
          "launched_at=" + activeLock.launchedAt,
          "mode=" + activeLock.mode,
          "",
        ].join("\\n")
      );
    }
    if (existingLogs.length > 0) {
      mkdirSync(teleportLogDir, { recursive: true });
      for (const logName of existingLogs) {
        writeFileSync(join(teleportLogDir, logName), "[teleport] existing log\\n");
      }
    }

    if (running) {
      beginBackgroundRun();
    }
    for (let index = 0; index < queuedItems; index += 1) {
      enqueueDeferredMessage({
        text: "queued work",
        userId: 123,
        username: "tester",
        chatId: 123,
        source: "text",
        enqueuedAt: Date.now() + index,
      });
    }

    const ctx = {
      from: { id: 123 },
      message: { text: ${JSON.stringify(messageText)} },
      chat: { id: 123, type: "private" },
      reply: async (text, extra) => {
        replies.push({ text: String(text), extra: extra || undefined });
        return { message_id: replies.length };
      },
    };

    await handleTeleportCommand(ctx);
    if (running) {
      endBackgroundRun();
    }
    const askUserFiles = readdirSync(ipcDir)
      .filter((name) => name.startsWith("ask-user-") && name.endsWith(".json"))
      .sort();
    const askUserRequest = askUserFiles[0]
      ? JSON.parse(readFileSync(join(ipcDir, askUserFiles[0]), "utf-8"))
      : null;

    rmSync(teleportStateDir, { recursive: true, force: true });
    rmSync(teleportLogDir, { recursive: true, force: true });
    rmSync(ipcDir, { recursive: true, force: true });
    console.log(marker + JSON.stringify({ replies, spawnCmd, spawnOpts, unrefCalled, askUserRequest }));
  `;

  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const payloadLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(marker));

  const payload = payloadLine
    ? (JSON.parse(payloadLine.slice(marker.length)) as TeleportProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("/teleport", () => {
  it("shows a preflight confirmation before launching managed teleport", async () => {
    const result = await runTeleportProbe("/teleport dry-run");

    if (result.exitCode !== 0) {
      throw new Error(`Teleport probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replies).toHaveLength(1);
    expect(result.payload?.replies[0]?.text).toBe(
      "❓ Teleport preflight:\nMode: dry-run\nDestination: linked managed SuperTurtle runtime\nChecks passed: bot idle, queue empty, no active teleport\nContinue?"
    );
    const keyboardRows = (result.payload?.replies[0]?.extra?.reply_markup?.inline_keyboard || [])
      .filter((row) => row.length > 0);
    expect(keyboardRows).toEqual([
      [{ text: "Start dry-run", callback_data: expect.stringMatching(/^askuser:[A-Za-z0-9._-]+:0$/) }],
      [{ text: "Cancel", callback_data: expect.stringMatching(/^askuser:[A-Za-z0-9._-]+:1$/) }],
    ]);
    expect(result.payload?.askUserRequest).toMatchObject({
      question: "Teleport preflight:\nMode: dry-run\nDestination: linked managed SuperTurtle runtime\nChecks passed: bot idle, queue empty, no active teleport\nContinue?",
      options: ["Start dry-run", "Cancel"],
      status: "sent",
      chat_id: "123",
      command_kind: "teleport_preflight",
      dry_run: true,
    });
    expect(result.payload?.spawnCmd).toEqual([]);
    expect(result.payload?.unrefCalled).toBe(false);
  });

  it("refuses to start while the bot is busy", async () => {
    const result = await runTeleportProbe("/teleport", { running: true });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport busy probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      { text: "❌ Teleport requires the bot to be idle. Stop the current run and retry." },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("refuses to start while queued work exists", async () => {
    const result = await runTeleportProbe("/teleport", { queuedItems: 1 });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport queue probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      { text: "❌ Teleport requires an empty queue. Clear 1 queued item and retry." },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("rejects unsupported arguments", async () => {
    const result = await runTeleportProbe("/teleport now");

    if (result.exitCode !== 0) {
      throw new Error(`Teleport usage probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      { text: "❌ Usage: /teleport [status|managed] [dry-run]" },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("reports the active managed teleport run via /teleport status", async () => {
    const result = await runTeleportProbe("/teleport status", {
      activeLock: {
        pid: process.pid,
        logPath: "/tmp/existing-teleport.log",
        launchedAt: "2026-03-12T10:30:00Z",
        mode: "dry-run",
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport status probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      { text: "🛰️ Managed teleport dry-run is running.\nStarted: 2026-03-12T10:30:00Z\nLog: /tmp/existing-teleport.log" },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("reports the latest teleport log when idle", async () => {
    const result = await runTeleportProbe("/teleport status", {
      existingLogs: [
        "2026-03-12T09-00-00.000Z.log",
        "2026-03-12T10-00-00.000Z-dry-run.log",
      ],
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport latest log probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text: expect.stringMatching(
          new RegExp(
            `No managed teleport is running\\.\\nLast log: ${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.superturtle/logs/teleport/2026-03-12T10-00-00\\.000Z-dry-run\\.log$`
          )
        ),
      },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("refuses to start while another teleport process holds the lock", async () => {
    const result = await runTeleportProbe("/teleport", {
      activeLock: {
        pid: process.pid,
        logPath: "/tmp/existing-teleport.log",
        launchedAt: "2026-03-12T10:30:00Z",
        mode: "live",
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport lock probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      { text: "❌ A managed teleport live is already running. Started: 2026-03-12T10:30:00Z Log: /tmp/existing-teleport.log" },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });
});
