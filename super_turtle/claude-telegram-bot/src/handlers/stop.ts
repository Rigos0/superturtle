import type { Context } from "grammy";
import { WORKING_DIR, CTL_PATH } from "../config";
import {
  clearDeferredQueue,
  getDeferredQueueSize,
  suppressDrain,
} from "../deferred-queue";
import {
  hasRecentStopReply,
  markRecentStopReply,
  markStopReplyHandled,
} from "./stop-reply-state";
import { streamLog } from "../logger";
const stopLog = streamLog.child({ handler: "stop" });
const inFlightStopByChat = new Map<number, Promise<void>>();

async function loadSessionModule() {
  return import("../session");
}

async function loadDriverRoutingModule() {
  return import("./driver-routing");
}

async function loadStreamingModule() {
  return import("./streaming");
}

export interface StopSubturtlesResult {
  attempted: string[];
  stopped: string[];
  failed: string[];
}

export interface StopAllRunningWorkResult extends StopSubturtlesResult {
  driverStopResult: "stopped" | "pending" | false;
  queueCleared: number;
}

function parseRunningSubturtleNames(output: string): string[] {
  const names = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("→")) {
      continue;
    }

    const match = line.match(/^([a-zA-Z0-9._-]+)\s+running\b/);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }

  return Array.from(names);
}

export function stopAllRunningSubturtles(): StopSubturtlesResult {
  let runningNames: string[] = [];

  try {
    const listProc = Bun.spawnSync([CTL_PATH, "list"], {
      cwd: WORKING_DIR,
      env: {
        ...process.env,
        SUPER_TURTLE_PROJECT_DIR: WORKING_DIR,
      },
    });
    const listOutput = `${listProc.stdout.toString()}\n${listProc.stderr.toString()}`;
    runningNames = parseRunningSubturtleNames(listOutput);
  } catch (error) {
    stopLog.warn({ err: error }, "Failed to list running SubTurtles");
    return { attempted: [], stopped: [], failed: [] };
  }

  const stopped: string[] = [];
  const failed: string[] = [];

  for (const name of runningNames) {
    try {
      const stopProc = Bun.spawnSync([CTL_PATH, "stop", name], { cwd: WORKING_DIR });
      if (stopProc.exitCode === 0) {
        stopped.push(name);
      } else {
        failed.push(name);
      }
    } catch (error) {
      stopLog.warn({ err: error, name }, "Failed to stop SubTurtle");
      failed.push(name);
    }
  }

  return {
    attempted: runningNames,
    stopped,
    failed,
  };
}

async function performStop(
  chatId: number | undefined,
  stopSubturtles: boolean
): Promise<StopAllRunningWorkResult> {
  const [{ session }, { stopActiveDriverQuery }] = await Promise.all([
    loadSessionModule(),
    loadDriverRoutingModule(),
  ]);

  // Suppress drain FIRST — wins the race against finally-block drains
  // that fire when we kill the driver process below.
  if (chatId != null) {
    suppressDrain(chatId);
  }

  session.stopTyping();
  const driverStopResult = await stopActiveDriverQuery();
  const subturtleResult = stopSubturtles
    ? stopAllRunningSubturtles()
    : { attempted: [], stopped: [], failed: [] };
  const queueCleared = chatId != null ? clearDeferredQueue(chatId) : 0;

  return {
    driverStopResult,
    queueCleared,
    ...subturtleResult,
  };
}

export async function stopAllRunningWork(chatId?: number): Promise<StopAllRunningWorkResult> {
  return performStop(chatId, true);
}

export async function stopForegroundWork(chatId?: number): Promise<StopAllRunningWorkResult> {
  return performStop(chatId, false);
}

async function hasForegroundWorkToStop(chatId: number): Promise<boolean> {
  const [{ isAnyDriverRunning }] = await Promise.all([loadDriverRoutingModule()]);
  return isAnyDriverRunning() || getDeferredQueueSize(chatId) > 0;
}

/**
 * Unified user-facing stop handler for all stop entrypoints.
 * Stops the active foreground run and clears the queue, but leaves background
 * SubTurtles alone.
 */
export async function handleStop(ctx: Context, chatId: number): Promise<void> {
  if (hasRecentStopReply(chatId) && !(await hasForegroundWorkToStop(chatId))) {
    stopLog.info({ chatId }, "Suppressed duplicate stop reply");
    return;
  }

  const inFlightStop = inFlightStopByChat.get(chatId);
  if (inFlightStop) {
    stopLog.info({ chatId }, "Joined in-flight stop request");
    await inFlightStop;
    return;
  }

  const stopPromise = (async () => {
    const { getStreamingState, retainStreamingState, updateRetainedProgressState } =
      await loadStreamingModule();
    const state = getStreamingState(chatId);
    if (state) {
      state.stopRequestedByUser = true;
      try {
        await updateRetainedProgressState(ctx, state, "Stopping", {
          toolHint: null,
          storeSnapshot: true,
        });
      } catch (error) {
        stopLog.warn({ err: error, chatId }, "Failed to render stopping progress state");
      }
    }

    const result = await stopForegroundWork(chatId);
    const driverStopped = result.driverStopResult !== false;
    const retainProgressOnly = Boolean(state);

    if (state && result.driverStopResult !== "pending") {
      try {
        await updateRetainedProgressState(ctx, state, "Stopped", {
          summary:
            result.queueCleared > 0
              ? `Run stopped. Cleared ${result.queueCleared} queued message${result.queueCleared === 1 ? "" : "s"}.`
              : undefined,
          toolHint: null,
          storeSnapshot: true,
          terminalSnapshot: true,
        });
        await retainStreamingState(ctx, state, {
          chatId,
          clearRegisteredState: true,
        });
      } catch (error) {
        stopLog.warn({ err: error, chatId }, "Failed to retain stopped progress message");
      }
    }

    let message = "Nothing to stop.";
    if (driverStopped) {
      markStopReplyHandled(chatId);
      message = "🛑 Stopped current work.";
      if (result.queueCleared > 0) {
        message =
          `🛑 Stopped current work. Cleared ${result.queueCleared} queued message` +
          `${result.queueCleared === 1 ? "" : "s"}.`;
      }
    } else if (result.queueCleared > 0) {
      message =
        `🛑 Cleared ${result.queueCleared} queued message` +
        `${result.queueCleared === 1 ? "" : "s"}.`;
    }

    stopLog.info(
      {
        chatId,
        stopSubturtles: false,
        driverStopResult: result.driverStopResult,
        subturtlesAttempted: result.attempted.length,
        subturtlesStopped: result.stopped.length,
        queueCleared: result.queueCleared,
      },
      "Stop executed"
    );

    if (!retainProgressOnly) {
      await ctx.reply(message);
      markRecentStopReply(chatId);
    } else if (driverStopped || result.driverStopResult === "pending") {
      markStopReplyHandled(chatId);
      markRecentStopReply(chatId);
    }
  })();

  inFlightStopByChat.set(chatId, stopPromise);
  try {
    await stopPromise;
  } finally {
    if (inFlightStopByChat.get(chatId) === stopPromise) {
      inFlightStopByChat.delete(chatId);
    }
  }
}
