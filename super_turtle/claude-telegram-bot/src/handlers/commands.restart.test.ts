import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const commandsPath = resolve(import.meta.dir, "commands.ts");
const marker = "__RESTART_PROBE__=";

type RestartProbePayload = {
  replies: string[];
  writes: Array<{ path: string; data: string }>;
  spawnCmd: string[];
  spawnOpts: {
    cwd?: string;
    stdin?: string;
    stdout?: string;
    stderr?: string;
    detached?: boolean;
  } | null;
  unrefCalled: boolean;
  exitCode: number | null;
  timerScheduled: boolean;
};

type RestartProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: RestartProbePayload | null;
};

async function probeRestart(options: { transport?: "polling" | "webhook" } = {}): Promise<RestartProbeResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
    SUPERTURTLE_RUN_LOOP: "0",
    TELEGRAM_TRANSPORT: options.transport || "polling",
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const modulePath = ${JSON.stringify(commandsPath)};

    const writes = [];
    const replies = [];
    let spawnCmd = [];
    let spawnOpts = null;
    let unrefCalled = false;
    let exitCode = null;
    let timerScheduled = false;

    Bun.write = async (path, data) => {
      writes.push({ path: String(path), data: String(data) });
      return data?.length ?? 0;
    };

    Bun.sleep = async () => {};

    globalThis.setTimeout = (fn) => {
      timerScheduled = true;
      fn();
      return 1;
    };

    Bun.spawn = (cmd, opts) => {
      spawnCmd = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      spawnOpts = opts ?? null;
      return {
        unref: () => {
          unrefCalled = true;
        },
      };
    };

    process.exit = (code) => {
      exitCode = Number(code);
      throw new Error("__EXIT__");
    };

    const { handleRestart } = await import(modulePath);

    const ctx = {
      from: { id: 123 },
      chat: { id: 456 },
      reply: async (text) => {
        replies.push(text);
        return { message_id: 789 };
      },
    };

    try {
      await handleRestart(ctx);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "__EXIT__") {
        throw err;
      }
    }

    console.log(marker + JSON.stringify({
      replies,
      writes,
      spawnCmd,
      spawnOpts,
      unrefCalled,
      exitCode,
      timerScheduled,
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as RestartProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("/restart self-reexec", () => {
  it("writes restart state, spawns detached replacement, and exits", async () => {
    const result = await probeRestart();

    if (result.exitCode !== 0) {
      throw new Error(`Restart probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replies).toEqual(["🔄 Restarting bot..."]);
    expect(
      result.payload?.writes.some(
        (entry) => entry.path.endsWith("-restart.json") || entry.path.endsWith(".restart-pending.json")
      )
    ).toBe(true);

    expect(result.payload?.spawnCmd.length).toBeGreaterThan(0);
    expect(result.payload?.spawnOpts?.detached).toBe(true);
    expect(result.payload?.spawnOpts?.stdin).toBe("ignore");
    expect(result.payload?.spawnOpts?.stdout).toBe("ignore");
    expect(result.payload?.spawnOpts?.stderr).toBe("ignore");
    expect(result.payload?.spawnOpts?.cwd?.endsWith("/claude-telegram-bot")).toBe(true);
    expect(result.payload?.unrefCalled).toBe(true);
    expect(result.payload?.exitCode).toBe(0);
    expect(result.payload?.timerScheduled).toBe(false);
  });

  it("defers exit through a timer in webhook mode so the update can be acknowledged first", async () => {
    const result = await probeRestart({ transport: "webhook" });

    if (result.exitCode !== 0) {
      throw new Error(`Restart probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replies).toEqual(["🔄 Restarting bot..."]);
    expect(result.payload?.spawnCmd.length).toBeGreaterThan(0);
    expect(result.payload?.timerScheduled).toBe(true);
    expect(result.payload?.exitCode).toBe(0);
  });
});
