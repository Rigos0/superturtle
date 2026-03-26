/**
 * Shared media group handling for Claude Telegram Bot.
 *
 * Provides a generic buffer for handling Telegram media groups (albums)
 * with configurable processing callbacks.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { PendingMediaGroup } from "../types";
import { MEDIA_GROUP_TIMEOUT } from "../config";
import { rateLimiter } from "../security";
import { auditLogRateLimit, sanitizeUserVisibleErrorMessage } from "../utils";
import { session } from "../session";
import { isAskUserPromptMessage } from "./streaming";
import { streamLog } from "../logger";
import { consumeHandledStopReply } from "./stop";

const mediaGroupLog = streamLog.child({ handler: "media-group" });

/**
 * Configuration for a media group handler.
 */
export interface MediaGroupConfig {
  /** Emoji for status messages (e.g., "📷" or "📄") */
  emoji: string;
  /** Label for items (e.g., "photo" or "document") */
  itemLabel: string;
  /** Plural label for items (e.g., "photos" or "documents") */
  itemLabelPlural: string;
}

/**
 * Callback to process a completed media group.
 */
export type ProcessGroupCallback = (
  ctx: Context,
  items: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
) => Promise<void>;

/**
 * Creates a media group buffer with the specified configuration.
 *
 * Returns functions for adding items and processing groups.
 */
export function createMediaGroupBuffer(config: MediaGroupConfig) {
  const pendingGroups = new Map<string, PendingMediaGroup>();

  /**
   * Process a completed media group.
   */
  async function processGroup(
    groupId: string,
    processCallback: ProcessGroupCallback
  ): Promise<void> {
    const group = pendingGroups.get(groupId);
    if (!group) return;

    pendingGroups.delete(groupId);

    const userId = group.ctx.from?.id;
    const username = group.ctx.from?.username || "unknown";
    const chatId = group.ctx.chat?.id;

    if (!userId || !chatId) return;

    mediaGroupLog.info(
      {
        userId,
        username,
        chatId,
        groupId,
        itemCount: group.items.length,
        itemLabelPlural: config.itemLabelPlural,
      },
      "Processing media group"
    );

    // Update status message
    if (group.statusMsg) {
      try {
        await group.ctx.api.editMessageText(
          group.statusMsg.chat.id,
          group.statusMsg.message_id,
          `${config.emoji} Processing ${group.items.length} ${config.itemLabelPlural}...`
        );
      } catch (error) {
        mediaGroupLog.debug(
          { err: error, userId, username, chatId, groupId, messageId: group.statusMsg.message_id },
          "Failed to update media-group status message"
        );
      }
    }

    await processCallback(
      group.ctx,
      group.items,
      group.caption,
      userId,
      username,
      chatId
    );

    // Delete status message
    if (group.statusMsg) {
      try {
        await group.ctx.api.deleteMessage(
          group.statusMsg.chat.id,
          group.statusMsg.message_id
        );
      } catch (error) {
        mediaGroupLog.debug(
          { err: error, userId, username, chatId, groupId, messageId: group.statusMsg.message_id },
          "Failed to delete media-group status message"
        );
      }
    }
  }

  /**
   * Add an item to a media group buffer.
   *
   * @returns true if the item was added successfully, false if rate limited
   */
  async function addToGroup(
    mediaGroupId: string,
    itemPath: string,
    ctx: Context,
    userId: number,
    username: string,
    processCallback: ProcessGroupCallback
  ): Promise<boolean> {
    if (!pendingGroups.has(mediaGroupId)) {
      // Rate limit on first item only
      const [allowed, retryAfter] = rateLimiter.check(userId);
      if (!allowed) {
        await auditLogRateLimit(userId, username, retryAfter!);
        await ctx.reply(
          `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
        );
        return false;
      }

      // Create new group
      mediaGroupLog.info(
        { userId, username, chatId: ctx.chat?.id, groupId: mediaGroupId, itemLabel: config.itemLabel },
        "Started media group buffer"
      );
      const statusMsg = await ctx.reply(
        `${config.emoji} Receiving ${config.itemLabelPlural}...`
      );

      pendingGroups.set(mediaGroupId, {
        items: [itemPath],
        ctx,
        caption: ctx.message?.caption,
        statusMsg,
        timeout: setTimeout(
          () => processGroup(mediaGroupId, processCallback),
          MEDIA_GROUP_TIMEOUT
        ),
      });
    } else {
      // Add to existing group
      const group = pendingGroups.get(mediaGroupId)!;
      group.items.push(itemPath);

      // Update caption if this message has one
      if (ctx.message?.caption && !group.caption) {
        group.caption = ctx.message.caption;
      }

      // Reset timeout
      clearTimeout(group.timeout);
      group.timeout = setTimeout(
        () => processGroup(mediaGroupId, processCallback),
        MEDIA_GROUP_TIMEOUT
      );
    }

    return true;
  }

  return {
    addToGroup,
    processGroup,
    pendingGroups,
  };
}

/**
 * Shared error handler for media processing.
 *
 * Cleans up tool messages and sends appropriate error response.
 */
export async function handleProcessingError(
  ctx: Context,
  error: unknown,
  toolMessages: Message[]
): Promise<void> {
  mediaGroupLog.error(
    {
      err: error,
      userId: ctx.from?.id,
      username: ctx.from?.username || "unknown",
      chatId: ctx.chat?.id,
      toolMessageCount: toolMessages.length,
    },
    "Error processing media"
  );

  // Clean up tool messages
  for (const toolMsg of toolMessages) {
    if (isAskUserPromptMessage(toolMsg)) continue;
    try {
      await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
    } catch (cleanupError) {
      mediaGroupLog.debug(
        { err: cleanupError, chatId: toolMsg.chat.id, messageId: toolMsg.message_id },
        "Failed to delete media tool message"
      );
    }
  }

  // Send error message
  const errorStr = String(error);
  if (errorStr.includes("abort") || errorStr.includes("cancel")) {
    // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
    const wasInterrupt = session.consumeInterruptFlag();
    const stopAlreadyHandled = consumeHandledStopReply(ctx.chat?.id);
    if (!wasInterrupt && !stopAlreadyHandled) {
      await ctx.reply("🛑 Query stopped.");
    }
  } else {
    await ctx.reply(
      `❌ Error: ${sanitizeUserVisibleErrorMessage(errorStr).slice(0, 200)}`
    );
  }
}
