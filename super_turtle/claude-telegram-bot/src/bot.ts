/**
 * Bot instance — extracted to its own module to avoid circular imports.
 *
 * index.ts imports handlers → handlers import bot. If bot lived in index.ts,
 * that would be a circular dependency. This module breaks the cycle.
 */

import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { TELEGRAM_TOKEN } from "./config";
import type { BotContext } from "./types";

export const bot = new Bot<BotContext>(TELEGRAM_TOKEN);

// Auto-retry must be installed before the stream plugin middleware.
// It converts Telegram rate-limit errors (429) into delayed retries,
// which prevents sendMessageDraft calls from failing under load.
bot.api.config.use(autoRetry());
