import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.SUPER_TURTLE_PROJECT_DIR ||= process.cwd();

const tempDirs: string[] = [];

async function loadBoardServiceModule() {
  return import(`./subturtle-board-service.ts?test=${Date.now()}-${Math.random()}`);
}

async function loadActualConfigModule() {
  return import(`./config.ts?board-config=${Date.now()}-${Math.random()}`);
}

async function loadActualCommandsModule() {
  return import(`./handlers/commands.ts?board-commands=${Date.now()}-${Math.random()}`);
}

function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for board service"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("subturtle board service", () => {
  it("treats worker lifecycle and checkpoint events as board-relevant", async () => {
    const { isRelevantSubturtleBoardEventType } = await loadBoardServiceModule();
    expect(isRelevantSubturtleBoardEventType("worker.started")).toBe(true);
    expect(isRelevantSubturtleBoardEventType("worker.checkpoint")).toBe(true);
    expect(isRelevantSubturtleBoardEventType("worker.archived")).toBe(true);
    expect(isRelevantSubturtleBoardEventType("worker.cleanup_verified")).toBe(true);
    expect(isRelevantSubturtleBoardEventType("worker.completed")).toBe(true);
    expect(isRelevantSubturtleBoardEventType("worker.notification_sent")).toBe(false);
    expect(isRelevantSubturtleBoardEventType("worker.supervision_checked")).toBe(false);
  });

  it("reconciles the live board when relevant events are appended to events.jsonl", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "subturtle-board-service-"));
    tempDirs.push(tempDir);
    const stateDir = join(tempDir, "state");
    const eventsPath = join(stateDir, "events.jsonl");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(eventsPath, "");

    const actualConfig = await loadActualConfigModule();
    const actualCommands = await loadActualCommandsModule();
    const reconcileCalls: number[] = [];
    mock.module("./config", () => ({
      ...actualConfig,
      ALLOWED_USERS: [123],
      SUPERTURTLE_DATA_DIR: tempDir,
    }));
    mock.module("./logger", () => ({
      botLog: {
        child: () => ({
          debug: () => {},
          warn: () => {},
        }),
      },
    }));
    mock.module("./handlers/commands", () => ({
      ...actualCommands,
      syncLiveSubturtleBoard: async () => {
        reconcileCalls.push(Date.now());
        return { status: "updated", messageId: 1, view: { kind: "board" } };
      },
    }));

    const { startSubturtleBoardService } = await loadBoardServiceModule();
    const service = startSubturtleBoardService({} as any);

    try {
      await waitFor(() => reconcileCalls.length === 1);

      writeFileSync(
        eventsPath,
        `${JSON.stringify({ event_type: "worker.notification_sent" })}\n`,
        { flag: "a" }
      );
      await Bun.sleep(900);
      expect(reconcileCalls).toHaveLength(1);

      writeFileSync(
        eventsPath,
        `${JSON.stringify({ event_type: "worker.completed" })}\n`,
        { flag: "a" }
      );
      await waitFor(() => reconcileCalls.length === 2);
    } finally {
      service.stop();
    }
  });
});
