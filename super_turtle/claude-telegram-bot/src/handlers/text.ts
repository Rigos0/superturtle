/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context, NextFunction } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS } from "../config";
import { getCurrentDriver } from "../drivers/registry";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogAuth,
  auditLogError,
  auditLogRateLimit,
  checkInterrupt,
  generateRequestId,
  isStopIntent,
  startTypingIndicator,
} from "../utils";
import {
  drainDeferredQueue,
  enqueueDeferredMessage,
  makeDrainItemNotifier,
  unsuppressDrain,
} from "../deferred-queue";
import { handleStop } from "./stop";
import {
  StreamingState,
  createSilentStatusCallback,
  createStatusCallback,
  teardownStreamingState,
} from "./streaming";
import { eventLog, streamLog } from "../logger";
import {
  isAnyDriverRunning,
  isBackgroundRunActive,
  preemptBackgroundRunForUserPriority,
  runMessageWithActiveDriver,
} from "./driver-routing";

export interface HandleTextOptions {
  silent?: boolean;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeErrorMessage(error: unknown, maxLength = 240): string {
  const compact = getErrorMessage(error).replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 3)}...`
    : compact;
}

/**
 * Handle incoming text messages.
 */
export async function handleText(
  ctx: Context,
  nextOrOptions?: NextFunction | HandleTextOptions
): Promise<void> {
  const options =
    typeof nextOrOptions === "function" || nextOrOptions === undefined
      ? {}
      : nextOrOptions;
  const silent = options.silent ?? false;
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const requestId = generateRequestId("text");
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await auditLogAuth(userId, username, false, {
      request_id: requestId,
      source: "text",
      chat_id: chatId,
    });
    if (!silent) {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
    }
    return;
  }
  eventLog.info({
    event: "user.message.text",
    requestId,
    userId,
    username,
    chatId,
    messageLength: message.length,
    message:
      message.length > 500
        ? `${message.slice(0, 500)}...`
        : message,
    messageTruncated: message.length > 500,
  });

  // 1.5. Bare "stop" — interrupt the foreground run/queue only.
  if (isStopIntent(message)) {
    await handleStop(ctx, chatId);
    return;
  }

  // Clear drain suppression so this message's finally block can drain normally.
  unsuppressDrain(chatId);

  // 2. Check for interrupt prefix
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!, {
      request_id: requestId,
      source: "text",
      chat_id: chatId,
    });
    if (!silent) {
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
    }
    return;
  }

  // 4. Store message for retry
  session.lastMessage = message;

  // 5. If agent is already answering, queue this message to run after completion.
  if (isBackgroundRunActive()) {
    await preemptBackgroundRunForUserPriority();
  }
  if (isAnyDriverRunning()) {
    const queueSize = enqueueDeferredMessage({
      text: message,
      userId,
      username,
      chatId,
      source: "text",
      enqueuedAt: Date.now(),
    });
    if (!silent) {
      await ctx.reply(
        `📝 Queued (#${queueSize}). I will run this once the current answer finishes.`
      );
    }
    return;
  }

  // 6. Mark processing started
  const stopProcessing = session.startProcessing();

  // 7. Set conversation title from first message (if new session)
  if (!session.isActive) {
    // Truncate title to ~50 chars
    const title =
      message.length > 50 ? message.slice(0, 47) + "..." : message;
    session.conversationTitle = title;
  }

  // 8. Start typing indicator
  const typing = startTypingIndicator(ctx);
  session.typingController = typing;
  const driver = getCurrentDriver();
  const state = new StreamingState();
  const statusCallback = silent
    ? createSilentStatusCallback(ctx, state)
    : createStatusCallback(ctx, state);

  try {
    const response = await runMessageWithActiveDriver({
      message,
      source: "text",
      username,
      userId,
      chatId,
      ctx,
      statusCallback,
    });

    await auditLog(userId, username, driver.auditEvent, message, response, {
      request_id: requestId,
      chat_id: chatId,
      driver: driver.id,
    });
  } catch (error) {
    const errorSummary = summarizeErrorMessage(error);
    await teardownStreamingState(ctx, state, {
      chatId,
      clearRegisteredState: true,
    });

    streamLog.error(
      {
        err: error,
        errorSummary,
        requestId,
        userId,
        username,
        chatId,
        driver: driver.id,
      },
      "Error processing message"
    );

    if (driver.isCancellationError(error)) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!silent && !wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else if (!silent) {
      await auditLogError(
        userId,
        username,
        errorSummary,
        "handleText",
        {
          request_id: requestId,
          chat_id: chatId,
          driver: driver.id,
        }
      );
      await ctx.reply(`❌ Error: ${errorSummary.slice(0, 200)}`);
    }
  } finally {
    // Keep processing state consistent even if error-path notifications fail.
    stopProcessing();
    typing.stop();
    session.typingController = null;
    await drainDeferredQueue(ctx, chatId, makeDrainItemNotifier(ctx, chatId));
  }
}
