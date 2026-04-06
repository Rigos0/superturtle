import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.SUPER_TURTLE_PROJECT_DIR ||= process.cwd();

const { IPC_DIR, RESTART_FILE } = await import("../config");
mkdirSync(IPC_DIR, { recursive: true });

const INLINE_RESTART_PATTERN = "bot-control-inline-restart-*.json";
const INLINE_UPDATE_PATTERN = "bot-control-inline-update-*.json";

async function cleanupIpcFiles(pattern: string): Promise<void> {
  const glob = new Bun.Glob(pattern);
  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    try {
      rmSync(`${IPC_DIR}/${filename}`, { force: true });
    } catch {
      // best effort cleanup
    }
  }
}

async function loadFreshStreamingModule() {
  return import(`./streaming.ts?inline-restart=${Date.now()}-${Math.random()}`);
}

async function loadActualCommandsModule() {
  return import(`./commands.ts?inline-restart-commands=${Date.now()}-${Math.random()}`);
}

beforeEach(async () => {
  process.env.SUPERTURTLE_IPC_DIR = IPC_DIR;
  await cleanupIpcFiles(INLINE_RESTART_PATTERN);
  await cleanupIpcFiles(INLINE_UPDATE_PATTERN);
  rmSync(RESTART_FILE, { force: true });
});

afterEach(async () => {
  mock.restore();
  await cleanupIpcFiles(INLINE_RESTART_PATTERN);
  await cleanupIpcFiles(INLINE_UPDATE_PATTERN);
  rmSync(RESTART_FILE, { force: true });
});

describe("inline bot-control restart", () => {
  it("completes restart requests without resetting sessions inline", async () => {
    let sentChatId: number | null = null;
    let sentText = "";
    let resetCalls = 0;
    const scheduledCallbacks: Array<() => void> = [];
    const exitCodes: number[] = [];
    const actualCommands = await loadActualCommandsModule();

    const originalExit = process.exit;
    const originalSetTimeout = globalThis.setTimeout;

    process.exit = ((code?: number) => {
      exitCodes.push(Number(code ?? 0));
      return undefined as never;
    }) as typeof process.exit;

    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      scheduledCallbacks.push(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    mock.module("../bot", () => ({
      bot: {
        api: {
          sendMessage: async (chatId: number, text: string) => {
            sentChatId = chatId;
            sentText = text;
            return { message_id: 777 };
          },
        },
      },
    }));

    mock.module("./commands", () => ({
      ...actualCommands,
      resetAllDriverSessions: async () => {
        resetCalls += 1;
      },
    }));

    try {
      const { checkPendingBotControlRequests } = await loadFreshStreamingModule();
      const chatId = 12345;
      const requestId = `inline-restart-${Date.now()}-${Math.random()}`;
      const requestFile = `${IPC_DIR}/bot-control-${requestId}.json`;

      await Bun.write(
        requestFile,
        JSON.stringify({
          request_id: requestId,
          action: "restart",
          params: {},
          status: "pending",
          chat_id: String(chatId),
          created_at: new Date().toISOString(),
        }, null, 2)
      );

      const handled = await checkPendingBotControlRequests({} as any, chatId);
      expect(handled).toBe(true);
      expect(resetCalls).toBe(0);
      expect(sentChatId === chatId).toBe(true);
      expect(sentText).toBe("🔄 Restarting bot...");

      const requestState = JSON.parse(await Bun.file(requestFile).text());
      expect(requestState.status).toBe("completed");
      expect(requestState.result).toBe("Restarting bot...");

      const restartState = JSON.parse(await Bun.file(RESTART_FILE).text());
      expect(restartState.chat_id).toBe(chatId);
      expect(restartState.message_id).toBe(777);

      expect(scheduledCallbacks).toHaveLength(1);
      scheduledCallbacks[0]?.();
      expect(exitCodes).toEqual([0]);
    } finally {
      process.exit = originalExit;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe("inline bot-control update_runtime", () => {
  it("completes update_runtime requests through the shared self-update helper", async () => {
    let capturedChatId: number | undefined;
    let capturedRequest: unknown = null;

    mock.module("./commands", () => ({
      parseSelfUpdateRequest: (rawValue?: string) => {
        expect(rawValue).toBe("test");
        return { kind: "dist-tag", distTag: "test" } as const;
      },
      startRemoteSelfUpdate: async (options: { chatId: number; request: unknown }) => {
        capturedChatId = options.chatId;
        capturedRequest = options.request;
        return "Updating managed runtime to superturtle@9.9.9-beta.3...";
      },
    }));

    const { checkPendingBotControlRequests } = await loadFreshStreamingModule();
    const chatId = 12345;
    const requestId = `inline-update-${Date.now()}-${Math.random()}`;
    const requestFile = `${IPC_DIR}/bot-control-${requestId}.json`;

    await Bun.write(
      requestFile,
      JSON.stringify({
        request_id: requestId,
        action: "update_runtime",
        params: { target: "test" },
        status: "pending",
        chat_id: String(chatId),
        created_at: new Date().toISOString(),
      }, null, 2)
    );

    const handled = await checkPendingBotControlRequests({} as any, chatId);
    expect(handled).toBe(true);
    expect(capturedChatId).toBe(chatId);
    expect(capturedRequest).toEqual({ kind: "dist-tag", distTag: "test" });

    const requestState = JSON.parse(await Bun.file(requestFile).text());
    expect(requestState.status).toBe("completed");
    expect(requestState.result).toBe("Updating managed runtime to superturtle@9.9.9-beta.3...");
  });
});
