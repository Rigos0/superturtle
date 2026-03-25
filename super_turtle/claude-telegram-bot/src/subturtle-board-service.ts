import { existsSync, mkdirSync, readFileSync, statSync, watch, type FSWatcher } from "fs";
import { dirname, join } from "path";
import { SUPERTURTLE_DATA_DIR } from "./config";
import { botLog } from "./logger";
import { syncLiveSubturtleBoard, type LiveSubturtleBoardApi } from "./handlers/commands";
import { getPrimaryTelegramTarget } from "./telegram-owner";

const RELEVANT_EVENT_TYPES = new Set([
  "worker.started",
  "worker.checkpoint",
  "worker.stop_requested",
  "worker.stopped",
  "worker.archived",
  "worker.timed_out",
  "worker.failed",
  "worker.completion_requested",
  "worker.cleanup_verified",
  "worker.completed",
]);

const BOARD_RECONCILE_DEBOUNCE_MS = 750;

type WorkerEventRecord = {
  event_type?: string;
};

function stateEventsPath(stateDir: string): string {
  return join(stateDir, "events.jsonl");
}

function boardTargetChatId(): number | null {
  return getPrimaryTelegramTarget()?.chatId ?? null;
}

export function isRelevantSubturtleBoardEventType(eventType: string): boolean {
  return RELEVANT_EVENT_TYPES.has(eventType);
}

function parseJsonLines(
  buffer: Buffer<ArrayBufferLike>
): { lines: WorkerEventRecord[]; remainder: Buffer<ArrayBufferLike> } {
  const records: WorkerEventRecord[] = [];
  let start = 0;

  while (start < buffer.length) {
    const newlineIndex = buffer.indexOf(0x0a, start);
    if (newlineIndex === -1) {
      break;
    }
    const lineBuffer = buffer.subarray(start, newlineIndex);
    start = newlineIndex + 1;
    const text = lineBuffer.toString("utf-8").trim();
    if (!text) continue;
    try {
      records.push(JSON.parse(text) as WorkerEventRecord);
    } catch {
      // Ignore malformed tail lines; future writes will replace them with valid JSONL.
    }
  }

  return {
    lines: records,
    remainder: buffer.subarray(start),
  };
}

export function startSubturtleBoardService(api: LiveSubturtleBoardApi): { stop: () => void } {
  const stateDir = join(SUPERTURTLE_DATA_DIR, "state");
  const eventsPath = stateEventsPath(stateDir);
  mkdirSync(dirname(eventsPath), { recursive: true });

  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let fileOffset = existsSync(eventsPath) ? statSync(eventsPath).size : 0;
  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let reconciling = false;
  let pendingRerun = false;

  const log = botLog.child({ service: "subturtle-board" });

  const reconcileBoard = async (reason: string) => {
    if (stopped || reconciling) {
      pendingRerun = true;
      return;
    }

    const chatId = boardTargetChatId();
    if (chatId === null) {
      log.debug({ reason }, "Skipped live SubTurtle board reconcile: no Telegram target");
      return;
    }

    reconciling = true;
    try {
      const result = await syncLiveSubturtleBoard(api, chatId, {
        pin: true,
        disableNotification: true,
      });
      log.debug({ reason, result }, "Reconciled live SubTurtle board");
    } catch (error) {
      log.warn({ err: error, reason, chatId }, "Failed to reconcile live SubTurtle board");
    } finally {
      reconciling = false;
      if (pendingRerun && !stopped) {
        pendingRerun = false;
        queueReconcile("rerun");
      }
    }
  };

  const queueReconcile = (reason: string) => {
    if (stopped) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reconcileBoard(reason);
    }, BOARD_RECONCILE_DEBOUNCE_MS);
  };

  const readNewEvents = () => {
    if (stopped || !existsSync(eventsPath)) return;

    const buffer = readFileSync(eventsPath);
    if (buffer.length < fileOffset) {
      fileOffset = 0;
      remainder = Buffer.alloc(0);
    }
    if (buffer.length === fileOffset) return;

    const appended = buffer.subarray(fileOffset);
    fileOffset = buffer.length;
    const merged = remainder.length > 0 ? Buffer.concat([remainder, appended]) : appended;
    const parsed = parseJsonLines(merged);
    remainder = parsed.remainder;

    for (const event of parsed.lines) {
      const eventType = typeof event.event_type === "string" ? event.event_type : "";
      if (isRelevantSubturtleBoardEventType(eventType)) {
        queueReconcile(eventType);
        return;
      }
    }
  };

  try {
    watcher = watch(stateDir, (_eventType, filename) => {
      if (stopped) return;
      const name = typeof filename === "string" ? filename : String(filename ?? "");
      if (name === "events.jsonl") {
        readNewEvents();
      }
    });
  } catch (error) {
    log.warn({ err: error, stateDir }, "Failed to start SubTurtle board event watcher");
  }

  queueReconcile("startup");

  return {
    stop: () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}
