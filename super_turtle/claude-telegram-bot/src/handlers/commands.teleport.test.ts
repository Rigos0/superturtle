import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const commandsPath = resolve(import.meta.dir, "commands.ts");
const driverRoutingPath = resolve(import.meta.dir, "driver-routing.ts");
const deferredQueuePath = resolve(import.meta.dir, "../deferred-queue.ts");
const marker = "__TELEPORT_PROBE__=";

type TeleportProbePayload = {
  replies: string[];
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
    const { mkdirSync, rmSync, writeFileSync } = await import("fs");
    const { join } = await import("path");

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
      reply: async (text) => {
        replies.push(String(text));
      },
    };

    await handleTeleportCommand(ctx);
    if (running) {
      endBackgroundRun();
    }
    rmSync(teleportStateDir, { recursive: true, force: true });
    rmSync(teleportLogDir, { recursive: true, force: true });
    console.log(marker + JSON.stringify({ replies, spawnCmd, spawnOpts, unrefCalled }));
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
  it("launches the managed teleport script in the background", async () => {
    const result = await runTeleportProbe("/teleport dry-run");

    if (result.exitCode !== 0) {
      throw new Error(`Teleport probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replies).toEqual([
      expect.stringMatching(
        /^🛰️ Starting managed teleport dry-run in the background\.\nLog: .+\/\.superturtle\/logs\/teleport\/.+-dry-run\.log$/
      ),
    ]);
    expect(result.payload?.spawnCmd).toEqual([
      "bash",
      "-lc",
      expect.stringContaining('mkdir "$SUPERTURTLE_TELEPORT_CLAIM_DIR" 2>/dev/null'),
      "teleport-managed",
      "--dry-run",
    ]);
    expect(result.payload?.spawnCmd[2]).toContain(
      '"$TELEPORT_SCRIPT_PATH" --managed "$@" >>"$SUPERTURTLE_TELEPORT_LOG_PATH" 2>&1'
    );
    expect(result.payload?.spawnOpts?.detached).toBe(true);
    expect(result.payload?.spawnOpts?.stdin).toBe("ignore");
    expect(result.payload?.spawnOpts?.stdout).toBe("ignore");
    expect(result.payload?.spawnOpts?.stderr).toBe("ignore");
    expect(result.payload?.spawnOpts?.env?.TELEPORT_SCRIPT_PATH).toBe(
      `${process.cwd()}/super_turtle/scripts/teleport-manual.sh`
    );
    expect(result.payload?.spawnOpts?.env?.SUPERTURTLE_TELEPORT_LOG_PATH).toMatch(
      /\/\.superturtle\/logs\/teleport\/.+-dry-run\.log$/
    );
    expect(result.payload?.spawnOpts?.env?.SUPERTURTLE_TELEPORT_LOCK_PATH).toMatch(
      /\/\.superturtle\/teleport\/managed-active\.lock$/
    );
    expect(result.payload?.spawnOpts?.env?.SUPERTURTLE_TELEPORT_CLAIM_DIR).toMatch(
      /\/\.superturtle\/teleport\/managed-active\.lock\.d$/
    );
    expect(result.payload?.unrefCalled).toBe(true);
  });

  it("refuses to start while the bot is busy", async () => {
    const result = await runTeleportProbe("/teleport", { running: true });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport busy probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      "❌ Teleport requires the bot to be idle. Stop the current run and retry.",
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("refuses to start while queued work exists", async () => {
    const result = await runTeleportProbe("/teleport", { queuedItems: 1 });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport queue probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      "❌ Teleport requires an empty queue. Clear 1 queued item and retry.",
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("rejects unsupported arguments", async () => {
    const result = await runTeleportProbe("/teleport now");

    if (result.exitCode !== 0) {
      throw new Error(`Teleport usage probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      "❌ Usage: /teleport [status|managed] [dry-run]",
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
      "🛰️ Managed teleport dry-run is running.\nStarted: 2026-03-12T10:30:00Z\nLog: /tmp/existing-teleport.log",
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
      expect.stringMatching(
        new RegExp(
          `No managed teleport is running\\.\\nLast log: ${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.superturtle/logs/teleport/2026-03-12T10-00-00\\.000Z-dry-run\\.log$`
        )
      ),
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
      "❌ A managed teleport live is already running. Started: 2026-03-12T10:30:00Z Log: /tmp/existing-teleport.log",
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });
});
