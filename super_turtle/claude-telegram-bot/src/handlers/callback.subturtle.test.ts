import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { PINO_LOG_PATH } from "../logger";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const { handleCallback } = await import("./callback");
const { ALLOWED_USERS, WORKING_DIR } = await import("../config");
const { IPC_DIR } = await import("../config");
const authorizedUserId =
  ALLOWED_USERS[0] ??
  Number((process.env.TELEGRAM_ALLOWED_USERS || "123").split(",")[0]?.trim() || "123");

const originalSpawnSync = Bun.spawnSync;
const hadOriginalPinoLog = existsSync(PINO_LOG_PATH);
const originalPinoLogContent = hadOriginalPinoLog ? readFileSync(PINO_LOG_PATH, "utf-8") : "";

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
  if (hadOriginalPinoLog) {
    writeFileSync(PINO_LOG_PATH, originalPinoLogContent);
  } else {
    rmSync(PINO_LOG_PATH, { force: true });
  }
});

async function cleanupPinoLogRequests(): Promise<void> {
  const glob = new Bun.Glob("pino-logs-pinologs-callback-*.json");
  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    try {
      rmSync(join(IPC_DIR, filename), { force: true });
    } catch {
      // best effort cleanup
    }
  }
}

beforeEach(async () => {
  await cleanupPinoLogRequests();
});

afterEach(async () => {
  await cleanupPinoLogRequests();
});

function makeCallbackCtx(callbackData: string, chatId = 912345678) {
  const callbackAnswers: string[] = [];
  const replies: Array<{ text: string; extra?: { parse_mode?: string } }> = [];
  const edits: Array<{ text: string; extra?: { parse_mode?: string } }> = [];

  const ctx = {
    from: { id: authorizedUserId, username: "tester" },
    chat: { id: chatId, type: "private" },
    callbackQuery: { data: callbackData },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      callbackAnswers.push(payload?.text || "");
    },
    reply: async (text: string, extra?: { parse_mode?: string }) => {
      replies.push({ text, extra });
    },
    editMessageText: async (text: string, extra?: { parse_mode?: string }) => {
      edits.push({ text, extra });
    },
  } as any;

  return { ctx, callbackAnswers, replies, edits };
}

describe("subturtle callback actions", () => {
  it("runs ctl stop for subturtle_stop callbacks and reports success", async () => {
    const commands: string[][] = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      commands.push(parts);

      if (parts[1] === "stop" && parts[2] === "worker-a") {
        return {
          stdout: Buffer.from("worker-a stopped"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return originalSpawnSync(
        cmd as Parameters<typeof Bun.spawnSync>[0],
        opts as Parameters<typeof Bun.spawnSync>[1]
      );
    }) as typeof Bun.spawnSync;

    const { ctx, callbackAnswers, edits } = makeCallbackCtx("subturtle_stop:worker-a");
    await handleCallback(ctx);

    expect(commands.some((parts) => parts[0]?.endsWith("/subturtle/ctl"))).toBe(true);
    expect(commands.some((parts) => parts[1] === "stop" && parts[2] === "worker-a")).toBe(true);
    expect(edits).toEqual([
      {
        text: "✅ <b>worker-a</b> stopped",
        extra: { parse_mode: "HTML" },
      },
    ]);
    expect(callbackAnswers).toEqual(["worker-a stopped"]);
  });

  it("renders SubTurtle state details for subturtle_logs callbacks", async () => {
    const turtleName = "callback-sub-1";
    const turtleDir = join(WORKING_DIR, ".subturtles", turtleName);
    const statePath = join(turtleDir, "CLAUDE.md");
    mkdirSync(turtleDir, { recursive: true });
    writeFileSync(
      statePath,
      [
        "## Current Task",
        "Implement callback tests.",
        "",
        "## Backlog",
        "- [x] Existing item",
        "- [ ] Active item <- current",
      ].join("\n")
    );

    const { ctx, callbackAnswers, replies } = makeCallbackCtx(`subturtle_logs:${turtleName}`);

    try {
      await handleCallback(ctx);
    } finally {
      rmSync(turtleDir, { recursive: true, force: true });
    }

    expect(callbackAnswers).toEqual([`State for ${turtleName}`]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.extra?.parse_mode).toBe("HTML");
    expect(replies[0]?.text).toContain(`📋 <b>State for ${turtleName}</b>`);
    expect(replies[0]?.text).toContain("🧩 <b>Task:</b> Implement callback tests.");
    expect(replies[0]?.text).toContain("✅ Existing item");
    expect(replies[0]?.text).toContain("⬜ Active item ← current");
  });
});

describe("pinologs callback levels", () => {
  it.each([
    {
      level: "info",
      includes: ["INFO [callback-test] info entry", "WARN [callback-test] warn entry", "ERROR [callback-test] error entry"],
      excludes: [],
    },
    {
      level: "warn",
      includes: ["WARN [callback-test] warn entry", "ERROR [callback-test] error entry"],
      excludes: ["INFO [callback-test] info entry"],
    },
    {
      level: "error",
      includes: ["ERROR [callback-test] error entry"],
      excludes: ["INFO [callback-test] info entry", "WARN [callback-test] warn entry"],
    },
  ])("routes $level level requests through callback processing", async ({ level, includes, excludes }) => {
    mkdirSync(dirname(PINO_LOG_PATH), { recursive: true });
    writeFileSync(PINO_LOG_PATH, "seed\n");

    const pinoTail = [
      JSON.stringify({ time: Date.UTC(2024, 0, 1, 0, 0, 1), level: 30, module: "callback-test", msg: "info entry" }),
      JSON.stringify({ time: Date.UTC(2024, 0, 1, 0, 0, 2), level: 40, module: "callback-test", msg: "warn entry" }),
      JSON.stringify({ time: Date.UTC(2024, 0, 1, 0, 0, 3), level: 50, module: "callback-test", msg: "error entry" }),
    ].join("\n");

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      const args = Array.isArray(cmd)
        ? cmd.map((part) => String(part))
        : typeof cmd === "object" && cmd !== null && "cmd" in cmd && Array.isArray((cmd as { cmd?: unknown }).cmd)
          ? ((cmd as { cmd: unknown[] }).cmd).map((part) => String(part))
          : [String(cmd)];

      if (args[0] === "tail") {
        return {
          stdout: Buffer.from(pinoTail),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return originalSpawnSync(
        cmd as Parameters<typeof Bun.spawnSync>[0],
        opts as Parameters<typeof Bun.spawnSync>[1]
      );
    }) as typeof Bun.spawnSync;

    const { ctx, callbackAnswers, replies } = makeCallbackCtx(`pinologs:${level}`, 934560000 + level.length);
    await handleCallback(ctx);

    expect(callbackAnswers).toEqual([`Fetching ${level} logs...`]);
    expect(replies).toHaveLength(1);
    for (const value of includes) {
      expect(replies[0]?.text).toContain(value);
    }
    for (const value of excludes) {
      expect(replies[0]?.text).not.toContain(value);
    }
  });

  it("rejects unsupported pinologs levels", async () => {
    const { ctx, callbackAnswers, replies } = makeCallbackCtx("pinologs:verbose");
    await handleCallback(ctx);

    expect(callbackAnswers).toEqual(["Invalid log level"]);
    expect(replies).toHaveLength(0);
  });
});
