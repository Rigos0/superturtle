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
  activeLogContent?: string;
  existingLogContents?: Record<string, string>;
  cloudSession?: "valid" | "missing" | "invalid";
  cloudStatusResponse?: {
    status?: number;
    body?: Record<string, unknown>;
  };
  claudeStatusResponse?: {
    status?: number;
    body?: Record<string, unknown>;
  };
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
    const activeLogContent = ${JSON.stringify(options?.activeLogContent ?? null)};
    const existingLogContents = ${JSON.stringify(options?.existingLogContents ?? {})};
    const cloudSessionMode = ${JSON.stringify(options?.cloudSession ?? "valid")};
    const cloudStatusResponse = ${JSON.stringify(options?.cloudStatusResponse ?? {
      status: 200,
      body: {
        response: {
          instance: {
            id: "inst_123",
            provider: "gcp",
            state: "running",
          },
          provisioning_job: null,
          audit_log: [],
        },
      },
    })};
    const claudeStatusResponse = ${JSON.stringify(options?.claudeStatusResponse ?? {
      status: 200,
      body: {
        response: {
          provider: "claude",
          configured: true,
          credential: {
            provider: "claude",
            state: "valid",
          },
          audit_log: [],
        },
      },
    })};

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
    const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import("fs");
    const { dirname, join } = await import("path");
    const { tmpdir } = await import("os");

    const ipcDir = mkdtempSync(join(tmpdir(), "teleport-ask-user-"));
    process.env.SUPERTURTLE_IPC_DIR = ipcDir;
    const cloudConfigDir = mkdtempSync(join(process.cwd(), ".teleport-cloud-config-"));
    process.env.XDG_CONFIG_HOME = cloudConfigDir;
    process.env.SUPERTURTLE_CLOUD_SESSION_PATH = join(
      cloudConfigDir,
      "superturtle",
      "cloud-session.json"
    );

    const teleportStateDir = join(process.cwd(), ".superturtle", "teleport");
    const teleportLockPath = join(teleportStateDir, "managed-active.lock");
    const teleportLogDir = join(process.cwd(), ".superturtle", "logs", "teleport");
    const cloudSessionPath = process.env.SUPERTURTLE_CLOUD_SESSION_PATH;
    rmSync(teleportStateDir, { recursive: true, force: true });
    rmSync(teleportLogDir, { recursive: true, force: true });
    rmSync(cloudConfigDir, { recursive: true, force: true });
    mkdirSync(dirname(cloudSessionPath), { recursive: true });
    if (cloudSessionMode === "valid") {
      writeFileSync(
        cloudSessionPath,
        JSON.stringify({
          schema_version: 1,
          control_plane: "https://cloud.example.com",
          access_token: "access-token",
        })
      );
    } else if (cloudSessionMode === "invalid") {
      writeFileSync(cloudSessionPath, "{not-json");
    }

    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      const selected = path === "/v1/cli/cloud/status"
        ? cloudStatusResponse
        : path === "/v1/cli/providers/claude/status"
        ? claudeStatusResponse
        : { status: 404, body: { error: "not_found" } };
      return new Response(JSON.stringify(selected.body), {
        status: selected.status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    };

    const { handleTeleportCommand } = await import(modulePath);

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
      if (activeLogContent != null) {
        mkdirSync(dirname(activeLock.logPath), { recursive: true });
        writeFileSync(activeLock.logPath, activeLogContent);
      }
    }
    if (existingLogs.length > 0) {
      mkdirSync(teleportLogDir, { recursive: true });
      for (const logName of existingLogs) {
        writeFileSync(
          join(teleportLogDir, logName),
          existingLogContents[logName] || "[teleport] existing log\\n"
        );
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
    if (activeLock?.logPath) {
      rmSync(activeLock.logPath, { force: true });
    }
    rmSync(cloudConfigDir, { recursive: true, force: true });
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
      "❓ Teleport preflight:\nMode: dry-run\nDestination: linked managed SuperTurtle cloud runtime\nChecks passed: bot idle, queue empty, no active teleport\nHosted checks: cloud login ready, managed Claude auth ready, destination runtime running\nContinue?"
    );
    const keyboardRows = (result.payload?.replies[0]?.extra?.reply_markup?.inline_keyboard || [])
      .filter((row) => row.length > 0);
    expect(keyboardRows).toEqual([
      [{ text: "Start dry-run", callback_data: expect.stringMatching(/^askuser:[A-Za-z0-9._-]+:0$/) }],
      [{ text: "Cancel", callback_data: expect.stringMatching(/^askuser:[A-Za-z0-9._-]+:1$/) }],
    ]);
    expect(result.payload?.askUserRequest).toMatchObject({
      question: "Teleport preflight:\nMode: dry-run\nDestination: linked managed SuperTurtle cloud runtime\nChecks passed: bot idle, queue empty, no active teleport\nHosted checks: cloud login ready, managed Claude auth ready, destination runtime running\nContinue?",
      options: ["Start dry-run", "Cancel"],
      status: "sent",
      chat_id: "123",
      command_kind: "teleport_preflight",
      dry_run: true,
    });
    expect(result.payload?.spawnCmd).toEqual([]);
    expect(result.payload?.unrefCalled).toBe(false);
  });

  it("labels an E2B-backed destination as a managed sandbox in the preflight prompt", async () => {
    const result = await runTeleportProbe("/teleport", {
      cloudStatusResponse: {
        status: 200,
        body: {
          response: {
            instance: {
              id: "inst_123",
              provider: "e2b",
              state: "running",
            },
            provisioning_job: null,
            audit_log: [],
          },
        },
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport e2b preflight probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toHaveLength(1);
    expect(result.payload?.replies[0]?.text).toBe(
      "❓ Teleport preflight:\n" +
      "Mode: live cutover\n" +
      "Destination: linked managed SuperTurtle sandbox\n" +
      "Checks passed: bot idle, queue empty, no active teleport\n" +
      "Hosted checks: cloud login ready, managed Claude auth ready, destination runtime running\n" +
      "Continue?"
    );
    const keyboardRows = (result.payload?.replies[0]?.extra?.reply_markup?.inline_keyboard || [])
      .filter((row) => row.length > 0);
    expect(keyboardRows).toEqual([
      [{ text: "Start teleport", callback_data: expect.stringMatching(/^askuser:[A-Za-z0-9._-]+:0$/) }],
      [{ text: "Cancel", callback_data: expect.stringMatching(/^askuser:[A-Za-z0-9._-]+:1$/) }],
    ]);
    expect(result.payload?.askUserRequest).toMatchObject({
      question:
        "Teleport preflight:\n" +
        "Mode: live cutover\n" +
        "Destination: linked managed SuperTurtle sandbox\n" +
        "Checks passed: bot idle, queue empty, no active teleport\n" +
        "Hosted checks: cloud login ready, managed Claude auth ready, destination runtime running\n" +
        "Continue?",
      options: ["Start teleport", "Cancel"],
      status: "sent",
      chat_id: "123",
      command_kind: "teleport_preflight",
      dry_run: false,
    });
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("surfaces a missing cloud login before opening teleport confirmation", async () => {
    const result = await runTeleportProbe("/teleport", {
      cloudSession: "missing",
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport missing-login probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text: expect.stringMatching(
          /^❌ Teleport requires a linked cloud account\. Run `superturtle login` on this machine first\.\nExpected session file: .+cloud-session\.json$/
        ),
      },
    ]);
    expect(result.payload?.askUserRequest).toBeNull();
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("surfaces an invalid cloud session before opening teleport confirmation", async () => {
    const result = await runTeleportProbe("/teleport", {
      cloudSession: "invalid",
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport invalid-session probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text: expect.stringMatching(
          /^❌ Teleport requires a valid linked cloud session\. Run `superturtle login` again on this machine\.\nReason: Hosted session file at .+cloud-session\.json is invalid JSON\. Run 'superturtle logout' and then 'superturtle login' again\.$/
        ),
      },
    ]);
    expect(result.payload?.askUserRequest).toBeNull();
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("surfaces missing managed Claude auth before opening teleport confirmation", async () => {
    const result = await runTeleportProbe("/teleport", {
      claudeStatusResponse: {
        status: 200,
        body: {
          response: {
            provider: "claude",
            configured: false,
            credential: null,
            audit_log: [],
          },
        },
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport missing-auth probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text:
          "❌ Teleport preflight failed:\n" +
          "- Managed Claude auth is not configured. Run `superturtle cloud claude setup` on this machine first.",
      },
    ]);
    expect(result.payload?.askUserRequest).toBeNull();
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("surfaces failed destination sandbox state before opening teleport confirmation", async () => {
    const result = await runTeleportProbe("/teleport", {
      cloudStatusResponse: {
        status: 200,
        body: {
          response: {
            instance: {
              id: "inst_123",
              provider: "gcp",
              state: "failed",
            },
            provisioning_job: {
              kind: "resume",
              state: "failed",
              error_code: "sandbox_boot_failed",
              error_message: "sandbox bootstrap failed",
            },
            audit_log: [],
          },
        },
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport destination-state probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text:
          "❌ Teleport preflight failed:\n" +
          "- The destination sandbox has a failed resume job: sandbox_boot_failed.\n" +
          "- The destination sandbox is failed.",
      },
    ]);
    expect(result.payload?.askUserRequest).toBeNull();
    expect(result.payload?.spawnCmd).toEqual([]);
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
      activeLogContent:
        "[teleport-status] phase=waiting_for_destination\n" +
        "[teleport-status] active_owner=local\n" +
        "[teleport-status] destination_state=provisioning\n" +
        "[teleport-status] failure_reason=\n",
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport status probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text:
          "🛰️ Managed teleport dry-run is running.\n" +
          "Started: 2026-03-12T10:30:00Z\n" +
          "Phase: waiting for destination\n" +
          "Active owner: local\n" +
          "Destination runtime: provisioning\n" +
          "Latest failure: none\n" +
          "Log: /tmp/existing-teleport.log",
      },
    ]);
    expect(result.payload?.spawnCmd).toEqual([]);
  });

  it("reports the latest teleport log when idle", async () => {
    const result = await runTeleportProbe("/teleport status", {
      existingLogs: [
        "2026-03-12T09-00-00.000Z.log",
        "2026-03-12T10-00-00.000Z-dry-run.log",
      ],
      existingLogContents: {
        "2026-03-12T10-00-00.000Z-dry-run.log":
          "[teleport-status] phase=waiting_for_destination\n" +
          "[teleport-status] active_owner=local\n" +
          "[teleport-status] destination_state=provisioning\n" +
          "[teleport-status] failure_reason=Timed out waiting for the managed SuperTurtle VM to become ready after 600000ms.\n",
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Teleport latest log probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload?.replies).toEqual([
      {
        text: expect.stringMatching(
          new RegExp(
            `No managed teleport is running\\.\\nPhase: waiting for destination\\nActive owner: local\\nDestination runtime: provisioning\\nLatest failure: Timed out waiting for the managed SuperTurtle VM to become ready after 600000ms\\.\\nLast log: ${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.superturtle/logs/teleport/2026-03-12T10-00-00\\.000Z-dry-run\\.log$`
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
