import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";

type CommandsModule = typeof import("./commands");

const originalWorkingDirEnv = process.env.SUPER_TURTLE_PROJECT_DIR;
let workingDir = originalWorkingDirEnv || process.cwd();
const authorizedUserId = Number(
  (process.env.TELEGRAM_ALLOWED_USERS || "123").split(",")[0]?.trim() || "123"
);
const originalSpawnSync = Bun.spawnSync;
const tempDirs: string[] = [];

function makeTempWorkingDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "commands-subturtle-"));
  tempDirs.push(dir);
  return dir;
}

async function loadActualConfig() {
  return import(`../config.ts?commands-subturtle-config=${Date.now()}-${Math.random()}`);
}

async function loadCommandsModule(): Promise<CommandsModule> {
  return import(`./commands.ts?commands-subturtle=${Date.now()}-${Math.random()}`);
}

async function handleSubturtleForTest(ctx: any) {
  const { handleSubturtle } = await loadCommandsModule();
  return handleSubturtle(ctx);
}

async function syncLiveSubturtleBoardForTest(api: any, chatId: number, options?: any) {
  const { syncLiveSubturtleBoard } = await loadCommandsModule();
  return syncLiveSubturtleBoard(api, chatId, options);
}

beforeEach(async () => {
  workingDir = makeTempWorkingDir();
  process.env.SUPER_TURTLE_PROJECT_DIR = workingDir;
  const actualConfig = await loadActualConfig();
  mock.module("../config", () => ({
    ...actualConfig,
    TELEGRAM_TOKEN: "test-token",
    ALLOWED_USERS: [authorizedUserId],
    WORKING_DIR: workingDir,
    SUPERTURTLE_DATA_DIR: join(workingDir, ".superturtle"),
  }));
});

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
  mock.restore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  if (typeof originalWorkingDirEnv === "string") {
    process.env.SUPER_TURTLE_PROJECT_DIR = originalWorkingDirEnv;
  } else {
    delete process.env.SUPER_TURTLE_PROJECT_DIR;
  }
});

describe("/subturtle", () => {
  it("renders the live board as compact running-worker blocks", async () => {
    const workdir = workingDir;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${authorizedUserId}.json`
    );
    rmSync(boardPath, { force: true });
    const turtleName = "test-sub-ux";
    const turtleDir = join(workdir, ".superturtle/subturtles", turtleName);
    mkdirSync(turtleDir, { recursive: true });
    const rootStatePath = join(workdir, "CLAUDE.md");
    const hadRootState = existsSync(rootStatePath);
    const originalRootState = hadRootState ? readFileSync(rootStatePath, "utf-8") : "";

    writeFileSync(
      rootStatePath,
      [
        "## Current Task",
        "Keep root summary available.",
        "",
        "## Backlog",
        "- [x] Root seed",
        "- [ ] Another root item <- current",
      ].join("\n")
    );
    writeFileSync(
      join(turtleDir, "CLAUDE.md"),
      [
        "## Current Task",
        "Add /subs aliases and summarize backlog state.",
        "",
        "## Backlog",
        "- [x] Locate /sub command handler",
        "- [ ] Add aliases <- current",
        "- [ ] Replace logs output",
      ].join("\n")
    );

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        const output = [
          `  ${turtleName}      running  yolo-codex   (PID 12345)   9m left       Tail raw logs here [skills: ["frontend"]]`,
          "                 → https://example.trycloudflare.com",
          "  worker-2        stopped                                             (no task)",
        ].join("\n");

        return {
          stdout: Buffer.from(output),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    const replies: Array<{ text: string; extra?: { parse_mode?: string; reply_markup?: unknown } }> = [];
    const pins: Array<{ chatId: number; messageId: number }> = [];

    const ctx = {
      from: { id: authorizedUserId },
      chat: { id: authorizedUserId },
      api: {
        sendMessage: async (
          _chatId: number,
          text: string,
          extra?: { parse_mode?: string; reply_markup?: unknown }
        ) => {
          replies.push({ text, extra });
          return { message_id: 501, chat: { id: authorizedUserId } };
        },
        editMessageText: async (
          _chatId: number,
          _messageId: number,
          text: string,
          extra?: { parse_mode?: string; reply_markup?: unknown }
        ) => {
          replies.push({ text, extra });
        },
        pinChatMessage: async (chatId: number, messageId: number) => {
          pins.push({ chatId, messageId });
        },
      },
      reply: async (text: string, extra?: { parse_mode?: string; reply_markup?: unknown }) => {
        replies.push({ text, extra });
      },
    } as any;

    try {
      await handleSubturtleForTest(ctx);
    } finally {
      if (hadRootState) {
        writeFileSync(rootStatePath, originalRootState);
      } else {
        rmSync(rootStatePath, { force: true });
      }
      rmSync(turtleDir, { recursive: true, force: true });
    }

    expect(replies).toHaveLength(1);

    const text = replies[0]!.text;
    expect(text).toContain(`🟢 <b>${turtleName}</b>`);
    expect(text).toContain("yolo-codex");
    expect(text).not.toContain("9m left");
    expect(text).toContain("Add /subs aliases and summarize backlog state.");
    expect(text).toContain("1/3 done");
    expect(text).not.toContain("Tail raw logs here");
    expect(text).not.toContain("<b>Root</b>");
    expect(text).not.toContain("https://example.trycloudflare.com");
    expect(text).not.toContain("<b>worker-2</b>");
    expect(text).not.toContain("Current:");
    expect(text).not.toContain("<b>→</b>");

    const keyboard = (
      replies[0]!.extra?.reply_markup as {
        inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
      }
    )?.inline_keyboard;
    expect(Array.isArray(keyboard)).toBe(true);
    expect(keyboard?.flat().some((button) => button.text === "📝 Tasks")).toBe(true);
    expect(keyboard?.flat().some((button) => button.text === "📜 Logs")).toBe(true);
    expect(keyboard?.flat().some((button) => button.text === "🛑 Stop")).toBe(true);
    expect(keyboard?.flat().some((button) => button.callback_data === "sub_board_refresh")).toBe(false);
    expect(keyboard?.flat().some((button) => button.callback_data === `sub_board_pick:${turtleName}`)).toBe(false);
    expect(keyboard?.flat().some((button) => button.callback_data === `sub_board_bl:${turtleName}:0`)).toBe(true);
    expect(keyboard?.flat().some((button) => button.callback_data === `sub_board_lg:${turtleName}:0`)).toBe(true);
    expect(keyboard?.flat().some((button) => button.callback_data === `sub_board_stop:${turtleName}`)).toBe(true);
    expect(keyboard?.flat().some((button) => button.callback_data === `subturtle_stop:${turtleName}`)).toBe(false);
    expect(keyboard?.flat().some((button) => button.callback_data === `subturtle_logs:${turtleName}`)).toBe(false);
    expect(keyboard?.flat().some((button) => button.callback_data === `sub_bl:${turtleName}:0`)).toBe(false);
    expect(keyboard?.flat().some((button) => button.callback_data === `sub_lg:${turtleName}:0`)).toBe(false);
    expect(pins).toEqual([{ chatId: authorizedUserId, messageId: 501 }]);

    const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
    expect(trackedBoard.chat_id).toBe(authorizedUserId);
    expect(trackedBoard.message_id).toBe(501);
    rmSync(boardPath, { force: true });
  });

  it("paginates running subturtle picker buttons three at a time", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 1;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    const turtleNames = ["sub-1", "sub-2", "sub-3", "sub-4"];
    const replies: Array<{ text: string; extra?: { parse_mode?: string; reply_markup?: unknown } }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        const output = turtleNames
          .map((name, idx) => `  ${name}      running  yolo-codex   (PID ${12340 + idx})   9m left       Task ${idx + 1}`)
          .join("\n");

        return {
          stdout: Buffer.from(output),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    const ctx = {
      from: { id: authorizedUserId },
      chat: { id: chatId },
      api: {
        sendMessage: async (
          _chatId: number,
          text: string,
          extra?: { parse_mode?: string; reply_markup?: unknown }
        ) => {
          replies.push({ text, extra });
          return { message_id: 601, chat: { id: chatId } };
        },
        editMessageText: async (
          _chatId: number,
          _messageId: number,
          text: string,
          extra?: { parse_mode?: string; reply_markup?: unknown }
        ) => {
          replies.push({ text, extra });
        },
        pinChatMessage: async () => {},
      },
      reply: async (text: string, extra?: { parse_mode?: string; reply_markup?: unknown }) => {
        replies.push({ text, extra });
      },
    } as any;

    try {
      await handleSubturtleForTest(ctx);
    } finally {
      for (const name of turtleNames) {
        rmSync(join(workdir, ".superturtle/subturtles", name), { recursive: true, force: true });
      }
      rmSync(boardPath, { force: true });
    }

    const keyboard = (replies[0]!.extra?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> })?.inline_keyboard || [];
    expect(keyboard.flat().some((button) => button.callback_data === "sub_board_refresh")).toBe(false);
    expect(keyboard.flat().filter((button) => button.callback_data?.startsWith("sub_board_pick:"))).toHaveLength(4);
    expect(keyboard.flat().some((button) => button.callback_data === "sub_board_pick:sub-1")).toBe(true);
    expect(keyboard.flat().some((button) => button.callback_data === "sub_board_pick:sub-4")).toBe(true);
    expect(replies[0]!.text).not.toContain("page 1/2");
  });

  it("skips redundant live board edits when nothing changed recently", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 2;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const first = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 701, chat: { id: chatId } }),
        editMessageText: async () => {},
        pinChatMessage: async () => {},
      }, chatId, { force: true, pin: true, disableNotification: true });

      let edited = 0;
      const second = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 702, chat: { id: chatId } }),
        editMessageText: async () => {
          edited += 1;
        },
        pinChatMessage: async () => {},
      }, chatId, { pin: true, disableNotification: true });

      expect(first.status).toBe("created");
      expect(second.status).toBe("unchanged");
      expect(edited).toBe(0);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("unpins an unchanged board when no workers are running", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 21;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 731,
        last_render_hash: "28b3cd8ce5ec336c47af1462763213578abc4636",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: new Date().toISOString(),
        current_view: { kind: "board" },
      })
    );

    const unpinned: Array<{ chatId: number; messageId?: number }> = [];
    let edited = 0;
    let sent = 0;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("No SubTurtles found."),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 732, chat: { id: chatId } };
        },
        editMessageText: async () => {
          edited += 1;
        },
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
      }, chatId, { pin: true, disableNotification: true });

      expect(result.status).toBe("unchanged");
      expect(result.messageId).toBe(731);
      expect(edited).toBe(0);
      expect(unpinned).toEqual([{ chatId, messageId: 731 }]);
      expect(sent).toBe(0);
      expect(existsSync(boardPath)).toBe(false);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("does not auto-create a board when no workers are running", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 3;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("No SubTurtles found."),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 801, chat: { id: chatId } }),
        editMessageText: async () => {},
        pinChatMessage: async () => {},
        unpinChatMessage: async () => {},
      }, chatId, { pin: true, disableNotification: true, createIfMissing: false });

      expect(result.status).toBe("skipped");
      expect(existsSync(boardPath)).toBe(false);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("auto-creates a board when workers are already running", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 4;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    const pins: Array<{ chatId: number; messageId: number }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 851, chat: { id: chatId } }),
        editMessageText: async () => {},
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pins.push({ chatId: targetChatId, messageId });
        },
      }, chatId, { pin: true, disableNotification: true });

      expect(result.status).toBe("created");
      expect(pins).toEqual([{ chatId, messageId: 851 }]);
      expect(existsSync(boardPath)).toBe(true);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("acknowledges /sub when it refreshes an existing pinned board in place", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 44;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 881,
        last_render_hash: "stale-hash",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    const replies: string[] = [];
    let edited = 0;
    const pinCalls: Array<{ chatId: number; messageId: number; disableNotification?: boolean }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    const ctx = {
      from: { id: authorizedUserId },
      chat: { id: chatId },
      message: { text: "/sub" },
      api: {
        sendMessage: async () => ({ message_id: 999, chat: { id: chatId } }),
        editMessageText: async () => {
          edited += 1;
        },
        pinChatMessage: async (
          targetChatId: number,
          messageId: number,
          extra?: { disable_notification?: boolean }
        ) => {
          pinCalls.push({ chatId: targetChatId, messageId, disableNotification: extra?.disable_notification });
        },
      },
      reply: async (text: string) => {
        replies.push(text);
      },
    } as any;

    try {
      await handleSubturtleForTest(ctx);
      expect(edited).toBe(1);
      expect(replies).toEqual(["📌 SubTurtle board refreshed."]);
      expect(pinCalls).toEqual([{ chatId, messageId: 881, disableNotification: false }]);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("serializes concurrent board creation so a spawn reconcile cannot pin twice", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 43;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    let sent = 0;
    let pins = 0;
    let releaseFirstSend: (() => void) | null = null;
    const firstSendStarted = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let firstSendBarrierResolved = false;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    const api = {
      sendMessage: async () => {
        sent += 1;
        if (!firstSendBarrierResolved) {
          firstSendBarrierResolved = true;
          await firstSendStarted;
        }
        return { message_id: 871, chat: { id: chatId } };
      },
      editMessageText: async () => {},
      pinChatMessage: async () => {
        pins += 1;
      },
    };

    try {
      const first = syncLiveSubturtleBoardForTest(api, chatId, {
        pin: true,
        disableNotification: true,
      });

      await Bun.sleep(25);

      const second = syncLiveSubturtleBoardForTest(api, chatId, {
        force: true,
        pin: true,
        disableNotification: true,
      });

      await Bun.sleep(150);
      expect(sent).toBe(1);

      const releaseFirstSendNow = releaseFirstSend;
      if (releaseFirstSendNow !== null) {
        (releaseFirstSendNow as () => void)();
      }

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.status).toBe("created");
      expect(secondResult.messageId).toBe(871);
      expect(["updated", "unchanged"]).toContain(secondResult.status);
      expect(sent).toBe(1);
      expect(pins).toBe(2);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(871);
    } finally {
      const releaseFirstSendFinally = releaseFirstSend;
      if (releaseFirstSendFinally !== null) {
        (releaseFirstSendFinally as () => void)();
      }
      rmSync(boardPath, { force: true });
      rmSync(`${boardPath}.lock`, { force: true });
    }
  });

  it("tracks pin-rights failures as unestablished instead of treating them as a successful board", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 41;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    let sent = 0;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 861, chat: { id: chatId } };
        },
        editMessageText: async () => {},
        pinChatMessage: async () => {
          throw new Error("not enough rights to manage pinned messages");
        },
      }, chatId, { pin: true, disableNotification: true });

      expect(result.status).toBe("unestablished");
      expect(result.messageId).toBe(861);
      expect(sent).toBe(1);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.chat_id).toBe(chatId);
      expect(trackedBoard.message_id).toBe(861);
      expect(trackedBoard.pin_state).toBe("unestablished");
      expect(trackedBoard.current_view).toEqual({ kind: "board" });
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("reuses an unestablished board record instead of sending duplicate board messages", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 42;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    let sent = 0;
    const pinAttempts: Array<{ chatId: number; messageId: number }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const first = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 862, chat: { id: chatId } };
        },
        editMessageText: async () => {},
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pinAttempts.push({ chatId: targetChatId, messageId });
          throw new Error("not enough rights to manage pinned messages");
        },
      }, chatId, { pin: true, disableNotification: true });

      const second = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 999, chat: { id: chatId } };
        },
        editMessageText: async () => {},
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pinAttempts.push({ chatId: targetChatId, messageId });
          throw new Error("not enough rights to manage pinned messages");
        },
      }, chatId, { pin: true, disableNotification: true });

      expect(first.status).toBe("unestablished");
      expect(second.status).toBe("unestablished");
      expect(second.messageId).toBe(862);
      expect(sent).toBe(1);
      expect(pinAttempts).toEqual([
        { chatId, messageId: 862 },
        { chatId, messageId: 862 },
      ]);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(862);
      expect(trackedBoard.pin_state).toBe("unestablished");
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("unpins an existing board when no workers remain", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 5;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 901,
        last_render_hash: "old",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    let unpinned: Array<{ chatId: number; messageId?: number }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("No SubTurtles found."),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 902, chat: { id: chatId } }),
        editMessageText: async () => {},
        pinChatMessage: async () => {},
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
      }, chatId, { pin: true, disableNotification: true });

      expect(result.status).toBe("updated");
      expect(unpinned).toEqual([{ chatId, messageId: 901 }]);
      expect(existsSync(boardPath)).toBe(false);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("creates a fresh board for the next active run after an idle board was cleared", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 51;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 1201,
        last_render_hash: "old",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    const unpinned: Array<{ chatId: number; messageId?: number }> = [];
    let sent = 0;
    let edited = 0;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("No SubTurtles found."),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const idleResult = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 1202, chat: { id: chatId } }),
        editMessageText: async () => {
          edited += 1;
        },
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
      }, chatId, { pin: true, disableNotification: true });

      expect(idleResult.status).toBe("updated");
      expect(unpinned).toEqual([{ chatId, messageId: 1201 }]);
      expect(existsSync(boardPath)).toBe(false);

      Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
        if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
          return {
            stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
            stderr: Buffer.from(""),
            success: true,
            exitCode: 0,
          } as ReturnType<typeof Bun.spawnSync>;
        }
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
      }) as typeof Bun.spawnSync;

      const activeResult = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 1203, chat: { id: chatId } };
        },
        editMessageText: async () => {
          edited += 1;
        },
        pinChatMessage: async () => {},
      }, chatId, { pin: true, disableNotification: true });

      expect(activeResult.status).toBe("created");
      expect(activeResult.messageId).toBe(1203);
      expect(sent).toBe(1);
      expect(edited).toBe(1);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(1203);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("unpins the old tracked board before recreating it", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 6;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 951,
        last_render_hash: "old",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    const pins: Array<{ chatId: number; messageId: number }> = [];
    const unpinned: Array<{ chatId: number; messageId?: number }> = [];
    const deleted: Array<{ chatId: number; messageId: number }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => ({ message_id: 952, chat: { id: chatId } }),
        editMessageText: async () => {
          throw new Error("message can't be edited");
        },
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pins.push({ chatId: targetChatId, messageId });
        },
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
        deleteMessage: async (targetChatId: number, messageId: number) => {
          deleted.push({ chatId: targetChatId, messageId });
        },
      }, chatId, { force: true, pin: true, disableNotification: true });

      expect(result.status).toBe("created");
      expect(unpinned).toEqual([{ chatId, messageId: 951 }]);
      expect(deleted).toEqual([{ chatId, messageId: 951 }]);
      expect(pins).toEqual([{ chatId, messageId: 952 }]);
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("recovers the pinned live board when the tracking record was deleted", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 61;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });

    const pins: Array<{ chatId: number; messageId: number }> = [];
    const edits: Array<{ chatId: number; messageId: number }> = [];
    let sent = 0;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 1002, chat: { id: chatId } };
        },
        editMessageText: async (targetChatId: number, messageId: number) => {
          edits.push({ chatId: targetChatId, messageId });
        },
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pins.push({ chatId: targetChatId, messageId });
        },
        getChat: async () => ({
          pinned_message: {
            message_id: 1001,
            text: "🟢 worker-a\n\nSame task",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📝 Tasks", callback_data: "sub_board_bl:worker-a:0" },
                  { text: "📜 Logs", callback_data: "sub_board_lg:worker-a:0" },
                ],
                [{ text: "🛑 Stop", callback_data: "sub_board_stop:worker-a" }],
                [{ text: "Back", callback_data: "sub_board_home" }],
              ],
            },
          },
        }),
      }, chatId, { force: true, pin: true, disableNotification: true });

      expect(result.status).toBe("updated");
      expect(result.messageId).toBe(1001);
      expect(result.view).toEqual({ kind: "detail", name: "worker-a" });
      expect(sent).toBe(0);
      expect(edits).toEqual([{ chatId, messageId: 1001 }]);
      expect(pins).toEqual([{ chatId, messageId: 1001 }]);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(1001);
      expect(trackedBoard.current_view).toEqual({ kind: "detail", name: "worker-a" });
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("falls back to the currently pinned board when the tracked message went stale", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 62;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 1101,
        last_render_hash: "old",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    const pins: Array<{ chatId: number; messageId: number }> = [];
    const unpinned: Array<{ chatId: number; messageId?: number }> = [];
    const deleted: Array<{ chatId: number; messageId: number }> = [];
    const edits: Array<{ chatId: number; messageId: number }> = [];
    let sent = 0;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 1103, chat: { id: chatId } };
        },
        editMessageText: async (targetChatId: number, messageId: number) => {
          edits.push({ chatId: targetChatId, messageId });
          if (messageId === 1101) {
            throw new Error("message to edit not found");
          }
        },
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pins.push({ chatId: targetChatId, messageId });
        },
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
        deleteMessage: async (targetChatId: number, messageId: number) => {
          deleted.push({ chatId: targetChatId, messageId });
        },
        getChat: async () => ({
          pinned_message: {
            message_id: 1102,
            text: "🐢 SubTurtles\n\n🟢 worker-a",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📝 Tasks", callback_data: "sub_board_bl:worker-a:0" }],
              ],
            },
          },
        }),
      }, chatId, { force: true, pin: true, disableNotification: true });

      expect(result.status).toBe("updated");
      expect(result.messageId).toBe(1102);
      expect(sent).toBe(0);
      expect(edits).toEqual([
        { chatId, messageId: 1101 },
        { chatId, messageId: 1102 },
      ]);
      expect(pins).toEqual([{ chatId, messageId: 1102 }]);
      expect(unpinned).toEqual([{ chatId, messageId: 1101 }]);
      expect(deleted).toEqual([{ chatId, messageId: 1101 }]);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(1102);
      expect(trackedBoard.current_view).toEqual({ kind: "board" });
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("dedupes both stale tracked and pinned boards before recreating a fresh board", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 63;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 1201,
        last_render_hash: "old",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    const pins: Array<{ chatId: number; messageId: number }> = [];
    const unpinned: Array<{ chatId: number; messageId?: number }> = [];
    const deleted: Array<{ chatId: number; messageId: number }> = [];
    const edits: Array<{ chatId: number; messageId: number }> = [];
    let sent = 0;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 1203, chat: { id: chatId } };
        },
        editMessageText: async (targetChatId: number, messageId: number) => {
          edits.push({ chatId: targetChatId, messageId });
          if (messageId === 1201) {
            throw new Error("message to edit not found");
          }
          throw new Error("message can't be edited");
        },
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pins.push({ chatId: targetChatId, messageId });
        },
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
        deleteMessage: async (targetChatId: number, messageId: number) => {
          deleted.push({ chatId: targetChatId, messageId });
        },
        getChat: async () => ({
          pinned_message: {
            message_id: 1202,
            text: "🐢 SubTurtles\n\n🟢 worker-a",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📝 Tasks", callback_data: "sub_board_bl:worker-a:0" }],
              ],
            },
          },
        }),
      }, chatId, { force: true, pin: true, disableNotification: true });

      expect(result.status).toBe("created");
      expect(result.messageId).toBe(1203);
      expect(sent).toBe(1);
      expect(edits).toEqual([
        { chatId, messageId: 1201 },
        { chatId, messageId: 1202 },
      ]);
      expect(unpinned).toEqual([
        { chatId, messageId: 1201 },
        { chatId, messageId: 1202 },
      ]);
      expect(deleted).toEqual([
        { chatId, messageId: 1201 },
        { chatId, messageId: 1202 },
      ]);
      expect(pins).toEqual([{ chatId, messageId: 1203 }]);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(1203);
      expect(trackedBoard.current_view).toEqual({ kind: "board" });
    } finally {
      rmSync(boardPath, { force: true });
    }
  });

  it("edits the callback-target board message instead of creating a duplicate when the stored record drifted", async () => {
    const workdir = workingDir;
    const chatId = authorizedUserId + 7;
    const boardPath = join(
      workdir,
      ".superturtle/state/telegram/subturtle-boards",
      `${chatId}.json`
    );
    rmSync(boardPath, { force: true });
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(
      boardPath,
      JSON.stringify({
        chat_id: chatId,
        message_id: 991,
        last_render_hash: "old",
        last_rendered_at: "2026-03-19T00:00:00Z",
        created_at: "2026-03-19T00:00:00Z",
        updated_at: "2026-03-19T00:00:00Z",
        current_view: { kind: "board" },
      })
    );

    const pins: Array<{ chatId: number; messageId: number }> = [];
    const unpinned: Array<{ chatId: number; messageId?: number }> = [];
    const deleted: Array<{ chatId: number; messageId: number }> = [];
    let sent = 0;
    let edited: Array<{ chatId: number; messageId: number }> = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      if (Array.isArray(cmd) && String(cmd[0]).endsWith("/subturtle/ctl") && cmd[1] === "list") {
        return {
          stdout: Buffer.from("  worker-a      running  yolo-codex   (PID 12345)   9m left       Same task"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      const result = await syncLiveSubturtleBoardForTest({
        sendMessage: async () => {
          sent += 1;
          return { message_id: 993, chat: { id: chatId } };
        },
        editMessageText: async (targetChatId: number, messageId: number) => {
          edited.push({ chatId: targetChatId, messageId });
        },
        pinChatMessage: async (targetChatId: number, messageId: number) => {
          pins.push({ chatId: targetChatId, messageId });
        },
        unpinChatMessage: async (targetChatId: number, messageId?: number) => {
          unpinned.push({ chatId: targetChatId, messageId });
        },
        deleteMessage: async (targetChatId: number, messageId: number) => {
          deleted.push({ chatId: targetChatId, messageId });
        },
      }, chatId, {
        force: true,
        pin: true,
        disableNotification: true,
        view: { kind: "detail", name: "worker-a" },
        targetMessageId: 992,
        allowCreateOnEditFailure: false,
      });

      expect(result.status).toBe("updated");
      expect(result.messageId).toBe(992);
      expect(sent).toBe(0);
      expect(edited).toEqual([{ chatId, messageId: 992 }]);
      expect(pins).toEqual([{ chatId, messageId: 992 }]);
      expect(unpinned).toEqual([{ chatId, messageId: 991 }]);
      expect(deleted).toEqual([{ chatId, messageId: 991 }]);

      const trackedBoard = JSON.parse(readFileSync(boardPath, "utf-8"));
      expect(trackedBoard.message_id).toBe(992);
      expect(trackedBoard.current_view).toEqual({ kind: "detail", name: "worker-a" });
    } finally {
      rmSync(boardPath, { force: true });
    }
  });
});
