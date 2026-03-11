/**
 * Bot instance — extracted to its own module to avoid circular imports.
 *
 * index.ts imports handlers → handlers import bot. If bot lived in index.ts,
 * that would be a circular dependency. This module breaks the cycle.
 */

import { Bot } from "grammy";
import { TELEGRAM_TOKEN, TELEGRAM_THREAD_ID, TELEGRAM_FORUM_CHAT_ID } from "./config";

// Allow overriding the Telegram API root URL for testing (same pattern as router.ts).
export const bot = new Bot(TELEGRAM_TOKEN, process.env.TELEGRAM_API_ROOT
  ? { client: { apiRoot: process.env.TELEGRAM_API_ROOT } }
  : undefined);

// ============== Runtime Forum Config ==============
//
// Mutable config that can be updated at runtime when the router
// sends an assign_thread message (DM→forum transition).
// This allows the first worker to switch to forum-topic mode
// without a restart.

export const runtimeForumConfig = {
  threadId: TELEGRAM_THREAD_ID as number | null,
  forumChatId: TELEGRAM_FORUM_CHAT_ID as number | null,
};

// Inject message_thread_id into all outgoing API calls.
// Always installed — reads from runtimeForumConfig so it activates
// dynamically when multi-project mode is set up.
const THREAD_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendAudio",
  "sendVideoNote",
  "sendSticker",
  "sendLocation",
  "sendContact",
  "sendPoll",
  "sendDice",
  "sendMediaGroup",
  "sendChatAction",
  "copyMessage",
  "forwardMessage",
]);

bot.api.config.use((prev, method, payload, signal) => {
  const { threadId, forumChatId } = runtimeForumConfig;
  if (threadId && THREAD_METHODS.has(method) && payload) {
    const p = payload as Record<string, unknown>;
    // Inject thread_id so messages go to the right topic
    if (!("message_thread_id" in p)) {
      p.message_thread_id = threadId;
    }
    // Rewrite chat_id from private chat to forum group when needed.
    // Cron/background notifications use ALLOWED_USERS[0] as chat_id,
    // which is a private chat — redirect to the forum group instead.
    if (forumChatId && typeof p.chat_id === "number" && p.chat_id > 0) {
      // Positive chat_id = private chat. Negative = group/supergroup.
      // Only rewrite private chat IDs to the forum group.
      p.chat_id = forumChatId;
    }
  }
  return prev(method, payload, signal);
});

/**
 * Update forum config at runtime (called when router assigns a thread).
 * When forumChatId is null, the existing value is preserved — avoids
 * clearing a known forum chat ID from env config or a previous assignment.
 */
export function assignThread(threadId: number, forumChatId: number | null): void {
  runtimeForumConfig.threadId = threadId;
  if (forumChatId !== null) {
    runtimeForumConfig.forumChatId = forumChatId;
  }
}
