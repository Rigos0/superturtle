/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogAuth,
  auditLogError,
  auditLogRateLimit,
  generateRequestId,
  startTypingIndicator,
} from "../utils";
import { getDriverAuditType, isActiveDriverSessionActive, runMessageWithActiveDriver } from "./driver-routing";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { eventLog, streamLog } from "../logger";

const photoLog = streamLog.child({ handler: "photo" });

// Create photo-specific media group buffer
const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

/**
 * Download a photo and return the local path.
 */
async function downloadPhoto(ctx: Context): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const file = await ctx.getFile();

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const photoPath = `${TEMP_DIR}/photo_${timestamp}_${random}.jpg`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(photoPath, buffer);

  return photoPath;
}

/**
 * Process photos with Claude.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  requestId?: string
): Promise<void> {
  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build prompt
  let prompt: string;
  if (photoPaths.length === 1) {
    prompt = caption
      ? `[Photo: ${photoPaths[0]}]\n\n${caption}`
      : `Please analyze this image: ${photoPaths[0]}`;
  } else {
    const pathsList = photoPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
    prompt = caption
      ? `[Photos:\n${pathsList}]\n\n${caption}`
      : `Please analyze these ${photoPaths.length} images:\n${pathsList}`;
  }

  // Set conversation title (if new session)
  if (!isActiveDriverSessionActive()) {
    const rawTitle = caption || "[Foto]";
    const title =
      rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
    session.conversationTitle = title;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await runMessageWithActiveDriver({
      message: prompt,
      source: "photo",
      username,
      userId,
      chatId,
      ctx,
      statusCallback,
    });

    await auditLog(userId, username, getDriverAuditType("PHOTO"), prompt, response, {
      request_id: requestId,
      chat_id: chatId,
    });
  } catch (error) {
    await auditLogError(
      userId,
      username,
      String(error).slice(0, 200),
      "processPhotos",
      { request_id: requestId, chat_id: chatId }
    );
    await handleProcessingError(ctx, error, state.toolMessages);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const requestId = generateRequestId("photo");
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await auditLogAuth(userId, username, false, {
      request_id: requestId,
      source: "photo",
      chat_id: chatId,
    });
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  eventLog.info({
    event: "user.message.photo",
    requestId,
    userId,
    username,
    chatId,
    mediaGroupId: mediaGroupId || null,
    captionLength: ctx.message?.caption?.length || 0,
  });

  // 2. For single photos, show status and rate limit early
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    photoLog.info({ userId, username, chatId, msgType: "photo" }, "Received photo message");
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!, {
        request_id: requestId,
        source: "photo",
        chat_id: chatId,
      });
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Show status immediately
    statusMsg = await ctx.reply("📷 Processing image...");
  }

  // 3. Download photo
  let photoPath: string;
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    photoLog.error({ err: error, userId, username, chatId }, "Failed to download photo");
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo."
        );
      } catch (editError) {
        photoLog.debug(
          { err: editError, userId, username, chatId, messageId: statusMsg.message_id },
          "Failed to edit photo status message"
        );
        await ctx.reply("❌ Failed to download photo.");
      }
    } else {
      await ctx.reply("❌ Failed to download photo.");
    }
    return;
  }

  // 4. Single photo - process immediately
  if (!mediaGroupId && statusMsg) {
    await processPhotos(
      ctx,
      [photoPath],
      ctx.message?.caption,
      userId,
      username,
      chatId,
      requestId
    );

    // Clean up status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      photoLog.debug(
        { err: error, userId, username, chatId, messageId: statusMsg.message_id },
        "Failed to delete photo status message"
      );
    }
    return;
  }

  // 5. Media group - buffer with timeout
  if (!mediaGroupId) return; // TypeScript guard

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    (gctx, items, caption, gUserId, gUsername, gChatId) =>
      processPhotos(gctx, items, caption, gUserId, gUsername, gChatId, requestId)
  );
}
