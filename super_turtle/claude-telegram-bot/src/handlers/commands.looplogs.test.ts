import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USERS = "123";
process.env.SUPER_TURTLE_PROJECT_DIR = process.cwd();

type CommandsModule = typeof import("./commands");

const authorizedUserId = 123;

async function loadLooplogsModule(): Promise<Pick<CommandsModule, "handleLooplogs" | "MAIN_LOOP_LOG_PATH">> {
  const actualSecurity = await import(`../security.ts?looplogs-security=${Date.now()}-${Math.random()}`);
  mock.module("../security", () => ({
    ...actualSecurity,
    isAuthorized: () => true,
  }));
  return import(`./commands.ts?looplogs=${Date.now()}-${Math.random()}`);
}

async function withLoopLogPathEnv(path: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.SUPERTURTLE_LOOP_LOG_PATH;
  if (path === undefined) {
    delete process.env.SUPERTURTLE_LOOP_LOG_PATH;
  } else {
    process.env.SUPERTURTLE_LOOP_LOG_PATH = path;
  }
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.SUPERTURTLE_LOOP_LOG_PATH;
    } else {
      process.env.SUPERTURTLE_LOOP_LOG_PATH = previous;
    }
  }
}

beforeEach(() => {
  mock.restore();
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USERS = "123";
  process.env.SUPER_TURTLE_PROJECT_DIR = process.cwd();
});

afterEach(() => {
  mock.restore();
});

describe("/looplogs", () => {
  it("falls back to legacy main-loop path when token-prefixed path is missing", async () => {
    await withLoopLogPathEnv(undefined, async () => {
      const { handleLooplogs, MAIN_LOOP_LOG_PATH } = await loadLooplogsModule();
      const expectedLogText = "legacy log line";
      const originalSpawnSync = Bun.spawnSync;
      const spawnedCommands: string[][] = [];

      Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
        const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        spawnedCommands.push(parts);
        if (parts[0] === "tail") {
          const targetPath = parts[3];
          if (targetPath === MAIN_LOOP_LOG_PATH) {
            return {
              stdout: Buffer.from(""),
              stderr: Buffer.from(`tail: ${MAIN_LOOP_LOG_PATH}: No such file or directory`),
              success: false,
              exitCode: 1,
            } as ReturnType<typeof Bun.spawnSync>;
          }
          if (targetPath === "/tmp/claude-telegram-bot-ts.log") {
            return {
              stdout: Buffer.from(expectedLogText),
              stderr: Buffer.from(""),
              success: true,
              exitCode: 0,
            } as ReturnType<typeof Bun.spawnSync>;
          }
        }
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
      }) as typeof Bun.spawnSync;

      const replies: string[] = [];
      const ctx = {
        from: { id: authorizedUserId },
        reply: async (text: string) => {
          replies.push(text);
        },
      } as any;

      try {
        await handleLooplogs(ctx);
      } finally {
        Bun.spawnSync = originalSpawnSync;
      }

      expect(spawnedCommands.some((parts) => parts[0] === "tail" && parts[3] === MAIN_LOOP_LOG_PATH)).toBe(true);
      expect(
        spawnedCommands.some((parts) => parts[0] === "tail" && parts[3] === "/tmp/claude-telegram-bot-ts.log")
      ).toBe(true);
      expect(replies).toEqual([expectedLogText]);
    });
  });

  it("returns the tailed main-loop logs", async () => {
    const { handleLooplogs, MAIN_LOOP_LOG_PATH } = await loadLooplogsModule();
    await withLoopLogPathEnv(MAIN_LOOP_LOG_PATH, async () => {
      const expectedLogText = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const originalSpawnSync = Bun.spawnSync;
      const spawnedCommands: string[][] = [];

      Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
        const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        spawnedCommands.push(parts);
        if (parts[0] === "tail") {
          return {
            stdout: Buffer.from(expectedLogText),
            stderr: Buffer.from(""),
            success: true,
            exitCode: 0,
          } as ReturnType<typeof Bun.spawnSync>;
        }
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
      }) as typeof Bun.spawnSync;

      const replies: string[] = [];
      const ctx = {
        from: { id: authorizedUserId },
        reply: async (text: string) => {
          replies.push(text);
        },
      } as any;

      try {
        await handleLooplogs(ctx);
      } finally {
        Bun.spawnSync = originalSpawnSync;
      }

      expect(spawnedCommands.some((parts) => parts[0] === "tail" && parts[1] === "-n" && parts[2] === "50")).toBe(true);
      expect(spawnedCommands.some((parts) => parts.includes(MAIN_LOOP_LOG_PATH))).toBe(true);
      expect(replies).toEqual([expectedLogText]);
    });
  });

  it("returns an actionable error when the log file is missing", async () => {
    const { handleLooplogs, MAIN_LOOP_LOG_PATH } = await loadLooplogsModule();
    await withLoopLogPathEnv(MAIN_LOOP_LOG_PATH, async () => {
      const originalSpawnSync = Bun.spawnSync;
      Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
        const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        if (parts[0] === "tail") {
          return {
            stdout: Buffer.from(""),
            stderr: Buffer.from(`tail: ${MAIN_LOOP_LOG_PATH}: No such file or directory`),
            success: false,
            exitCode: 1,
          } as ReturnType<typeof Bun.spawnSync>;
        }
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
      }) as typeof Bun.spawnSync;

      const replies: string[] = [];
      const ctx = {
        from: { id: authorizedUserId },
        reply: async (text: string) => {
          replies.push(text);
        },
      } as any;

      try {
        await handleLooplogs(ctx);
      } finally {
        Bun.spawnSync = originalSpawnSync;
      }

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain(`Cannot read main loop log at ${MAIN_LOOP_LOG_PATH}`);
      expect(replies[0]).toContain("superturtle start");
    });
  });
});
