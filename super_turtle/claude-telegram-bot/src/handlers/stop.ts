import type { Context } from "grammy";
import { WORKING_DIR, CTL_PATH } from "../config";
import { session } from "../session";
import { stopActiveDriverQuery } from "./driver-routing";
import { clearDeferredQueue, suppressDrain } from "../deferred-queue";
import { cleanupToolMessages, clearStreamingState, getStreamingState } from "./streaming";
import { streamLog } from "../logger";
const stopLog = streamLog.child({ handler: "stop" });

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
    const listProc = Bun.spawnSync([CTL_PATH, "list"], { cwd: WORKING_DIR });
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

export async function stopAllRunningWork(chatId?: number): Promise<StopAllRunningWorkResult> {
  // Suppress drain FIRST — wins the race against finally-block drains
  // that fire when we kill the driver process below.
  if (chatId != null) {
    suppressDrain(chatId);
  }

  session.stopTyping();
  const driverStopResult = await stopActiveDriverQuery();
  const subturtleResult = stopAllRunningSubturtles();
  const queueCleared = chatId != null ? clearDeferredQueue(chatId) : 0;

  return {
    driverStopResult,
    queueCleared,
    ...subturtleResult,
  };
}

/**
 * Unified stop handler — used by text "stop", voice "stop", and /stop command.
 * Kills current work, clears the queue, stops SubTurtles, confirms to user.
 */
export async function handleStop(ctx: Context, chatId: number): Promise<void> {
  const state = getStreamingState(chatId);
  const result = await stopAllRunningWork(chatId);
  if (state) {
    await cleanupToolMessages(ctx, state);

    // Append an explicit stopped indicator to the last streamed text segment, if any.
    const segmentIds = [...state.textMessages.keys()];
    if (segmentIds.length > 0) {
      const lastSegmentId = Math.max(...segmentIds);
      const lastMsg = state.textMessages.get(lastSegmentId);
      const lastContent = state.lastContent.get(lastSegmentId);
      const suffix = "\n\n⏹ <i>Stopped</i>";

      if (
        lastMsg &&
        lastContent &&
        lastContent.trim().length > 0 &&
        !lastContent.includes("⏹ <i>Stopped</i>")
      ) {
        try {
          await ctx.api.editMessageText(
            lastMsg.chat.id,
            lastMsg.message_id,
            `${lastContent}${suffix}`,
            { parse_mode: "HTML" }
          );
        } catch {
          // Ignore edit failures (message deleted, unchanged, or invalid HTML)
        }
      }
    }
  }
  clearStreamingState(chatId);

  let message = "🛑 Stopped.";
  if (result.queueCleared > 0) {
    message = `🛑 Stopped. Cleared ${result.queueCleared} queued message${result.queueCleared === 1 ? "" : "s"}.`;
  }

  stopLog.info(
    {
      chatId,
      driverStopResult: result.driverStopResult,
      subturtlesAttempted: result.attempted.length,
      subturtlesStopped: result.stopped.length,
      queueCleared: result.queueCleared,
    },
    "Stop executed"
  );

  await ctx.reply(message);
}
