/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  isStopIntent,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import {
  getDriverAuditType,
  isActiveDriverSessionActive,
  isBackgroundRunActive,
  isAnyDriverRunning,
  preemptBackgroundRunForUserPriority,
  runMessageWithActiveDriver,
} from "./driver-routing";
import { StreamingState, createStatusCallback } from "./streaming";
import {
  drainDeferredQueue,
  enqueueDeferredMessage,
  makeDrainItemNotifier,
  unsuppressDrain,
} from "../deferred-queue";
import { handleStop } from "./stop";
import { eventLog, streamLog } from "../logger";

const voiceLog = streamLog.child({ handler: "voice" });

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  // NOTE: startProcessing() is called AFTER the queue check (step 10) to avoid
  // isAnyDriverRunning() seeing our own _isProcessing flag and always queueing.

  let voicePath: string | null = null;
  let stopProcessing: (() => void) | null = null;

  try {
    // 6. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 7. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed."
      );
      return;
    }
    eventLog.info({
      event: "user.message.voice",
      userId,
      username,
      chatId,
      transcriptLength: transcript.length,
      transcript:
        transcript.length > 500
          ? `${transcript.slice(0, 500)}...`
          : transcript,
      transcriptTruncated: transcript.length > 500,
      voiceDurationSec: voice.duration,
      voiceFileId: voice.file_id,
    });

    // 8. Show transcript (truncate display if needed - full transcript still sent to Claude)
    const maxDisplay = 4000; // Leave room for 🎤 "" wrapper within 4096 limit
    const displayTranscript =
      transcript.length > maxDisplay
        ? transcript.slice(0, maxDisplay) + "…"
        : transcript;
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${displayTranscript}"`
    );

    // 9. Voice stop intent should interrupt active runs immediately.
    if (isStopIntent(transcript)) {
      await handleStop(ctx, chatId);
      return;
    }

    // Clear drain suppression so this message's finally block can drain normally.
    unsuppressDrain(chatId);

    // 10. If agent is already answering, queue transcript to run after completion.
    if (isBackgroundRunActive()) {
      await preemptBackgroundRunForUserPriority();
    }
    if (isAnyDriverRunning()) {
      const queueSize = enqueueDeferredMessage({
        text: transcript,
        userId,
        username,
        chatId,
        source: "voice",
        enqueuedAt: Date.now(),
      });
      await ctx.reply(
        `📝 Queued (#${queueSize}). I will run this once the current answer finishes.`
      );
      return;
    }

    // 10b. NOW mark processing started — after the queue check so our own flag
    // doesn't cause isAnyDriverRunning() to always return true.
    stopProcessing = session.startProcessing();

    // 11. Set conversation title from transcript (if new session)
    if (!isActiveDriverSessionActive()) {
      const title =
        transcript.length > 50 ? transcript.slice(0, 47) + "..." : transcript;
      session.conversationTitle = title;
    }

    // 12. Create streaming state and callback
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    // 13. Send to active driver
    const response = await runMessageWithActiveDriver({
      message: transcript,
      username,
      userId,
      chatId,
      ctx,
      statusCallback,
    });

    // 14. Audit log
    await auditLog(userId, username, getDriverAuditType("VOICE"), transcript, response);
  } catch (error) {
    voiceLog.error({ err: error, userId, username, chatId }, "Voice processing failed");

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    stopProcessing?.();
    typing.stop();
    await drainDeferredQueue(ctx, chatId, makeDrainItemNotifier(ctx, chatId));

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        voiceLog.debug({ err: error, voicePath }, "Failed to delete voice file");
      }
    }
  }
}
