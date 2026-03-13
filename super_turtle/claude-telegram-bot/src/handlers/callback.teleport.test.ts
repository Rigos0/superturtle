import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const callbackPath = resolve(import.meta.dir, "callback.ts");
const marker = "__CALLBACK_TELEPORT_PROBE__=";

type CallbackTeleportProbePayload = {
  callbackAnswers: Array<{ text?: string; show_alert?: boolean }>;
  editTexts: string[];
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
  requestExistsAfter: boolean;
};

async function runCallbackTeleportProbe(optionIndex: 0 | 1): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: CallbackTeleportProbePayload | null;
}> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
    CODEX_ENABLED: "false",
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const callbackPath = ${JSON.stringify(callbackPath)};
    const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const ipcDir = mkdtempSync(join(tmpdir(), "teleport-callback-"));
    process.env.SUPERTURTLE_IPC_DIR = ipcDir;

    const requestId = "teleportcb";
    const requestFile = join(ipcDir, "ask-user-" + requestId + ".json");
    writeFileSync(
      requestFile,
      JSON.stringify({
        request_id: requestId,
        question: "Teleport preflight",
        options: ["Start dry-run", "Cancel"],
        status: "sent",
        chat_id: "123",
        created_at: new Date().toISOString(),
        command_kind: "teleport_preflight",
        dry_run: true,
      })
    );

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

    const { handleCallback } = await import(callbackPath);

    const callbackAnswers = [];
    const editTexts = [];
    const replies = [];
    const ctx = {
      from: { id: 123, username: "tester" },
      chat: { id: 123, type: "private" },
      callbackQuery: { data: "askuser:" + requestId + ":" + ${optionIndex} },
      answerCallbackQuery: async (payload) => {
        callbackAnswers.push(payload || {});
      },
      editMessageText: async (text) => {
        editTexts.push(String(text));
      },
      reply: async (text) => {
        replies.push(String(text));
      },
    };

    await handleCallback(ctx);

    console.log(marker + JSON.stringify({
      callbackAnswers,
      editTexts,
      replies,
      spawnCmd,
      spawnOpts,
      unrefCalled,
      requestExistsAfter: existsSync(requestFile),
    }));
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as CallbackTeleportProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("teleport ask-user callbacks", () => {
  it("launches managed teleport when the preflight confirm button is tapped", async () => {
    const result = await runCallbackTeleportProbe(0);

    if (result.exitCode !== 0) {
      throw new Error(`Teleport callback confirm probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers).toEqual([{ text: "Starting teleport dry-run" }]);
    expect(result.payload?.editTexts).toEqual(["✓ Start dry-run"]);
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
    expect(result.payload?.unrefCalled).toBe(true);
    expect(result.payload?.requestExistsAfter).toBe(false);
  });

  it("cancels managed teleport when the preflight cancel button is tapped", async () => {
    const result = await runCallbackTeleportProbe(1);

    if (result.exitCode !== 0) {
      throw new Error(`Teleport callback cancel probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers).toEqual([{ text: "Teleport canceled" }]);
    expect(result.payload?.editTexts).toEqual(["✖ Managed teleport dry-run canceled"]);
    expect(result.payload?.replies).toEqual([]);
    expect(result.payload?.spawnCmd).toEqual([]);
    expect(result.payload?.unrefCalled).toBe(false);
    expect(result.payload?.requestExistsAfter).toBe(false);
  });
});
