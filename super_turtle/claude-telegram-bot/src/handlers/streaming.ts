/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type { StatusCallback } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
  CODEX_AVAILABLE,
  CODEX_CLI_AVAILABLE,
  CODEX_ENABLED,
  CODEX_USER_ENABLED,
  RESTART_FILE,
  IPC_DIR,
} from "../config";
import { session, type ClaudeSession } from "../session";
import { codexSession, type CodexSession } from "../codex-session";
import { bot } from "../bot";
import { PINO_LOG_PATH, streamLog } from "../logger";
import {
  clamp,
  readPinoLogLines,
  buildLevelFilter,
  formatPinoEntry,
} from "../log-reader";

// Union type for bot control to work with both Claude and Codex sessions
type BotControlSession = ClaudeSession | CodexSession;
const PENDING_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TICK_MS = 5_000;

function getRequestChatId(data: Record<string, unknown>): string {
  const raw = data.chat_id;
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") return raw.trim();
  return "";
}

function isPendingRequestStale(data: Record<string, unknown>): boolean {
  const createdAtRaw = data.created_at;
  if (typeof createdAtRaw !== "string" || createdAtRaw.trim().length === 0) {
    return false;
  }
  const createdAtMs = Date.parse(createdAtRaw);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return Date.now() - createdAtMs > PENDING_REQUEST_MAX_AGE_MS;
}

function codexUnavailableBotControlMessage(): string {
  if (!CODEX_USER_ENABLED) {
    return "Codex is disabled in config (CODEX_ENABLED=false).";
  }
  if (!CODEX_CLI_AVAILABLE) {
    return "Codex CLI is not installed or not available on PATH.";
  }
  return "Codex is unavailable.";
}

/**
 * Ask-user prompt messages use inline keyboards and must stay visible
 * until the user taps an option.
 */
export function isAskUserPromptMessage(msg: Message): boolean {
  const inlineKeyboard = (msg as Message & {
    reply_markup?: { inline_keyboard?: unknown[] };
  }).reply_markup?.inline_keyboard;
  return Array.isArray(inlineKeyboard) && inlineKeyboard.length > 0;
}

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    const filepath = `${IPC_DIR}/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      const targetChatId = getRequestChatId(data);
      if (!targetChatId) {
        data.status = "error";
        data.error = "Missing chat_id on pending ask-user request";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }
      if (targetChatId !== String(chatId)) continue;
      if (isPendingRequestStale(data)) {
        data.status = "expired";
        data.error = "Pending ask-user request expired before delivery";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        const sentMsg = await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        data.sent_message_id = sentMsg.message_id;
        data.sent_at = new Date().toISOString();
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process ask-user file");
    }
  }

  return buttonsSent;
}

/**
 * Check for pending send-turtle requests and send photos.
 */
export async function checkPendingSendTurtleRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("send-turtle-*.json");
  let photoSent = false;

  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    const filepath = `${IPC_DIR}/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      const targetChatId = getRequestChatId(data);
      if (!targetChatId) {
        data.status = "error";
        data.error = "Missing chat_id on pending send-turtle request";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }
      if (targetChatId !== String(chatId)) continue;
      if (isPendingRequestStale(data)) {
        data.status = "expired";
        data.error = "Pending send-turtle request expired before delivery";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }

      const url = data.url || "";
      const caption = data.caption || undefined;

      if (url) {
        try {
          // Download image and send as a sticker (renders smaller/cuter than photo)
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          const inputFile = new InputFile(buffer, "turtle.webp");
          await ctx.replyWithSticker(inputFile);
        } catch (photoError) {
          // Photo send failed — try sending as a link instead
          streamLog.warn(
            { err: photoError, filepath, url, chatId },
            "Failed to send turtle photo, falling back to link"
          );
          await ctx.reply(`🐢 ${url}${caption ? `\n${caption}` : ""}`);
        }
        photoSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process send-turtle file");
    }
  }

  return photoSent;
}

/**
 * Check for pending bot-control requests, execute the action, and write
 * the result back so the MCP server's polling loop can pick it up.
 *
 * Unlike ask_user this does NOT break the event loop — Claude continues
 * after receiving the tool result.
 */
export async function checkPendingBotControlRequests(
  sessionObj: BotControlSession,
  chatId: number,
): Promise<boolean> {
  const glob = new Bun.Glob("bot-control-*.json");
  let handled = false;

  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    const filepath = `${IPC_DIR}/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      const targetChatId = getRequestChatId(data);
      if (!targetChatId) {
        data.status = "error";
        data.error = "Missing chat_id on pending bot-control request";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }
      if (targetChatId !== String(chatId)) continue;
      if (isPendingRequestStale(data)) {
        data.status = "expired";
        data.error = "Pending bot-control request expired before delivery";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }

      const action: string = data.action;
      const params: Record<string, string> = data.params || {};
      let result: string;

      try {
        result = await executeBotControlAction(sessionObj, action, params, chatId);
      } catch (err) {
        data.status = "error";
        data.error = String(err);
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        handled = true;
        continue;
      }

      // Write result back for MCP server to pick up
      data.status = "completed";
      data.result = result;
      await Bun.write(filepath, JSON.stringify(data, null, 2));
      handled = true;
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process bot-control file");
    }
  }

  return handled;
}


/**
 * Check for pending pino-logs requests, read log file, and write
 * the result back so the MCP server's polling loop can pick it up.
 */
export async function checkPendingPinoLogsRequests(
  chatId: number,
): Promise<boolean> {
  const glob = new Bun.Glob("pino-logs-*.json");
  let handled = false;

  for await (const filename of glob.scan({ cwd: IPC_DIR, absolute: false })) {
    const filepath = `${IPC_DIR}/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.status !== "pending") continue;
      const targetChatId = getRequestChatId(data);
      if (!targetChatId) {
        data.status = "error";
        data.error = "Missing chat_id on pending pino-logs request";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }
      if (targetChatId !== String(chatId)) continue;
      if (isPendingRequestStale(data)) {
        data.status = "expired";
        data.error = "Pending pino-logs request expired before delivery";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }

      const level = typeof data.level === "string" ? data.level : "error";
      const levels = Array.isArray(data.levels)
        ? data.levels.filter((item: unknown) => typeof item === "string")
        : [];
      const limit = clamp(Number(data.limit || 50), 1, 500);
      const moduleFilter =
        typeof data.module === "string" && data.module.length > 0
          ? data.module.toLowerCase()
          : null;

      const levelFilter = buildLevelFilter(level, levels);
      const scanLines = clamp(limit * 6, 200, 2000);

      const lines = await readPinoLogLines(scanLines);
      const results: string[] = [];

      for (let idx = lines.length - 1; idx >= 0; idx--) {
        const line = lines[idx];
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (moduleFilter) {
          const moduleValue = parsed.module ? String(parsed.module).toLowerCase() : "";
          if (!moduleValue.includes(moduleFilter)) continue;
        }

        if (levelFilter) {
          const levelValue = Number(parsed.level);
          if (!levelFilter.has(levelValue)) continue;
        }

        results.push(formatPinoEntry(parsed));
        if (results.length >= limit) break;
      }

      results.reverse();
      const payload =
        results.length > 0
          ? results.join("\n")
          : "No matching log entries.";

      data.status = "completed";
      data.result = payload;
      await Bun.write(filepath, JSON.stringify(data, null, 2));
      handled = true;
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process pino-logs file");
    }
  }

  return handled;
}

/**
 * Execute a single bot-control action and return a text result.
 */
async function executeBotControlAction(
  sessionObj: BotControlSession,
  action: string,
  params: Record<string, string>,
  chatId?: number,
): Promise<string> {
  try {
    switch (action) {
    case "usage": {
      const { formatUnifiedUsage, getCodexQuotaLines, getUsageLines } = await import("./commands");
      const [usageLines, codexLines] = await Promise.all([
        getUsageLines(),
        CODEX_ENABLED ? getCodexQuotaLines() : Promise.resolve<string[]>([]),
      ]);
      if (usageLines.length === 0) return "Failed to fetch usage data.";
      const unified = formatUnifiedUsage(usageLines, codexLines, CODEX_ENABLED);
      // Strip HTML tags but keep the unicode bar characters intact.
      const plain = unified.replace(/<[^>]+>/g, "");
      return `USAGE DATA (show this to the user as-is, in a code block):\n\n${plain}`;
    }

    case "switch_model": {
      // Determine if this is a Codex or Claude session
      const isCodexSession = "reasoningEffort" in sessionObj;

      if (params.model) {
        const requestedModel = params.model;

        if (isCodexSession) {
          // For Codex: get available Codex models
          const { getAvailableCodexModels } = await import("../codex-session");
          const codexModels = getAvailableCodexModels();
          const match = codexModels.find(
            (m) =>
              m.value === requestedModel ||
              m.displayName.toLowerCase() === requestedModel.toLowerCase(),
          );
          if (!match) {
            const valid = codexModels.map((m) => `${m.displayName} (${m.value})`).join(", ");
            return `Unknown Codex model "${requestedModel}". Available: ${valid}`;
          }
          (sessionObj as CodexSession).model = match.value;
        } else {
          // For Claude: get available Claude models
          const { getAvailableModels } = await import("../session");
          const models = getAvailableModels();
          const match = models.find(
            (m) =>
              m.value === requestedModel ||
              m.displayName.toLowerCase() === requestedModel.toLowerCase(),
          );
          if (!match) {
            const valid = models.map((m) => `${m.displayName} (${m.value})`).join(", ");
            return `Unknown model "${requestedModel}". Available: ${valid}`;
          }
          (sessionObj as ClaudeSession).model = match.value;
        }
      }

      if (params.effort) {
        const effort = params.effort.toLowerCase();

        if (isCodexSession) {
          // Codex uses: minimal, low, medium, high, xhigh
          if (!["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
            return `Invalid Codex effort "${params.effort}". Use: minimal, low, medium, high, xhigh`;
          }
          (sessionObj as CodexSession).reasoningEffort = effort as any;
          const model = (sessionObj as CodexSession).model;
          return `Model switched. Now using: ${model}, reasoning effort: ${effort}`;
        } else {
          // Claude uses: low, medium, high
          if (!["low", "medium", "high"].includes(effort)) {
            return `Invalid effort "${params.effort}". Use: low, medium, high`;
          }
          (sessionObj as ClaudeSession).effort = effort as "low" | "medium" | "high";
          const { getAvailableModels } = await import("../session");
          const models = getAvailableModels();
          const currentModel = models.find((m) => m.value === (sessionObj as ClaudeSession).model);
          const displayName = currentModel?.displayName || (sessionObj as ClaudeSession).model;
          return `Model switched. Now using: ${displayName}, effort: ${effort}`;
        }
      }

      if (isCodexSession) {
        return `Codex model: ${(sessionObj as CodexSession).model}, reasoning effort: ${(sessionObj as CodexSession).reasoningEffort}`;
      } else {
        const { getAvailableModels } = await import("../session");
        const models = getAvailableModels();
        const currentModel = models.find((m) => m.value === (sessionObj as ClaudeSession).model);
        const displayName = currentModel?.displayName || (sessionObj as ClaudeSession).model;
        return `Model: ${displayName}, effort: ${(sessionObj as ClaudeSession).effort}`;
      }
    }

    case "switch_driver": {
      const { buildSessionOverviewLines, resetAllDriverSessions } = await import("./commands");
      const driver = params.driver?.toLowerCase();
      if (driver !== "claude" && driver !== "codex") {
        return `Invalid driver "${params.driver ?? ""}". Use: claude or codex`;
      }

      if (driver === "codex" && !CODEX_AVAILABLE) {
        return `Cannot switch to Codex: ${codexUnavailableBotControlMessage()}`;
      }

      await resetAllDriverSessions({ stopRunning: true });

      if (driver === "codex") {
        await codexSession.startNewThread();
        session.activeDriver = "codex";
        if (chatId) {
          try {
            const lines = await buildSessionOverviewLines("Switched to Codex 🟢");
            await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
          } catch (err) {
            streamLog.warn(
              { err, action: "switch_driver", driver: "codex", chatId },
              "Failed to send switch overview"
            );
          }
        }
        return "Switched to Codex";
      }

      session.activeDriver = "claude";
      if (chatId) {
        try {
          const lines = await buildSessionOverviewLines("Switched to Claude Code 🔵");
          await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
        } catch (err) {
          streamLog.warn(
            { err, action: "switch_driver", driver: "claude", chatId },
            "Failed to send switch overview"
          );
        }
      }
      return "Switched to Claude Code";
    }

    case "new_session": {
      const { buildSessionOverviewLines } = await import("./commands");
      await sessionObj.stop();
      await sessionObj.kill();

      if (chatId) {
        try {
          const lines = await buildSessionOverviewLines("New session");
          await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
        } catch (err) {
          streamLog.warn({ err, action: "new_session", chatId }, "Failed to send new session overview");
        }
      }

      return "Session cleared. Next message will start a fresh session.";
    }

    case "list_sessions": {
      const sessions = sessionObj.getSessionList();
      if (sessions.length === 0) return "No saved sessions.";

      const lines = sessions.map((s, i) => {
        const date = new Date(s.saved_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        return `${i + 1}. "${s.title}" (${date}) — ID: ${s.session_id.slice(0, 8)}...`;
      });
      return lines.join("\n");
    }

    case "resume_session": {
      const sessionId = params.session_id;
      if (!sessionId) return "Missing session_id parameter.";

      const isCodexSession = "reasoningEffort" in sessionObj;
      const sessions = isCodexSession
        ? [
          ...(await (sessionObj as CodexSession).getSessionListLive()),
          ...sessionObj.getSessionList(),
        ]
        : sessionObj.getSessionList();
      const match = sessions.find(
        (s) => s.session_id === sessionId || s.session_id.startsWith(sessionId),
      );
      if (!match) return `No session found matching "${sessionId}".`;

      let result: [success: boolean, message: string];

      await sessionObj.stop();

      if (isCodexSession) {
        // Codex resumeSession is async
        result = await (sessionObj as CodexSession).resumeSession(match.session_id);
      } else {
        // Claude resumeSession is synchronous
        result = (sessionObj as ClaudeSession).resumeSession(match.session_id);
      }

      session.activeDriver = isCodexSession ? "codex" : "claude";
      const [success, message] = result;
      return success ? `Resumed: "${match.title}"` : `Failed: ${message}`;
    }

    case "restart": {
      const { resetAllDriverSessions } = await import("./commands");
      // Stop any active work before restarting
      await resetAllDriverSessions({ stopRunning: true });

      if (chatId) {
        try {
          const msg = await bot.api.sendMessage(chatId, "🔄 Restarting bot...");
          await Bun.write(
            RESTART_FILE,
            JSON.stringify({
              chat_id: chatId,
              message_id: msg.message_id,
              timestamp: Date.now(),
            }),
          );
        } catch (e) {
          streamLog.warn({ err: e, action: "restart", chatId }, "Failed to save restart info");
        }
      }

      setTimeout(() => {
        process.exit(0);
      }, 500);

      return "Restarting bot...";
    }

    default:
      return `Unknown action: ${action}`;
    }
  } catch (error) {
    streamLog.warn({ err: error, action, chatId }, "Bot-control action failed");
    return `Bot-control error: ${String(error).slice(0, 200)}`;
  }
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
  silentSegments = new Map<number, string>(); // segment_id -> captured text for silent mode
  sawToolUse = false; // used to avoid replaying side-effectful tool runs on retries
  sawSpawnOrchestration = false; // true when streamed tool activity indicates `ctl spawn` orchestration
  thinkingPlaceholder: Message | null = null; // ephemeral "Thinking..." indicator
  heartbeatMessage: Message | null = null; // ephemeral "still working" indicator
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  heartbeatUpdating = false;
  statusStartedAt = Date.now();
  lastStatusAt = Date.now();
  teardownCompleted = false;

  getSilentCapturedText(): string {
    return [...this.silentSegments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join("");
  }
}

const activeStreamingStates = new Map<number, StreamingState>();

export function getStreamingState(chatId: number): StreamingState | undefined {
  return activeStreamingStates.get(chatId);
}

export function clearStreamingState(chatId: number): void {
  const existing = activeStreamingStates.get(chatId);
  if (existing) {
    stopHeartbeat(existing);
  }
  activeStreamingStates.delete(chatId);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isIgnorableDeleteMessageError(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("message to delete not found") ||
    message.includes("message can't be deleted") ||
    message.includes("chat not found")
  );
}

/** Delete the thinking placeholder if it exists. */
async function deleteThinkingPlaceholder(ctx: Context, state: StreamingState): Promise<void> {
  if (!state.thinkingPlaceholder) return;
  const msg = state.thinkingPlaceholder;
  state.thinkingPlaceholder = null;
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch (error) {
    if (!isIgnorableDeleteMessageError(error)) {
      streamLog.debug(
        { errorSummary: describeError(error) },
        "Failed to delete thinking placeholder"
      );
    }
  }
}

export async function cleanupToolMessages(ctx: Context, state: StreamingState): Promise<void> {
  for (const toolMsg of state.toolMessages) {
    if (isAskUserPromptMessage(toolMsg)) {
      continue;
    }
    try {
      await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
    } catch (error) {
      if (!isIgnorableDeleteMessageError(error)) {
        streamLog.debug(
          { errorSummary: describeError(error), chatId: toolMsg.chat.id, messageId: toolMsg.message_id },
          "Failed to delete tool message"
        );
      }
    }
  }
  state.toolMessages = [];
  state.heartbeatMessage = null;
}

async function clearHeartbeatMessage(ctx: Context, state: StreamingState): Promise<void> {
  if (!state.heartbeatMessage) return;
  const msg = state.heartbeatMessage;
  state.heartbeatMessage = null;
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch (error) {
    if (!isIgnorableDeleteMessageError(error)) {
      streamLog.debug(
        { errorSummary: describeError(error), chatId: msg.chat.id, messageId: msg.message_id },
        "Failed to delete heartbeat message"
      );
    }
  }
}

function startHeartbeat(ctx: Context, state: StreamingState): void {
  if (state.heartbeatTimer) return;
  state.statusStartedAt = Date.now();
  state.lastStatusAt = Date.now();
  state.heartbeatTimer = setInterval(async () => {
    if (state.heartbeatUpdating) return;
    if (Date.now() - state.lastStatusAt < HEARTBEAT_IDLE_MS) return;
    if (state.thinkingPlaceholder) return;

    state.heartbeatUpdating = true;
    try {
      const elapsedSec = Math.floor((Date.now() - state.statusStartedAt) / 1000);
      const text = `<i>Still working… ${elapsedSec}s</i>`;

      if (state.heartbeatMessage) {
        await ctx.api.editMessageText(
          state.heartbeatMessage.chat.id,
          state.heartbeatMessage.message_id,
          text,
          { parse_mode: "HTML" }
        );
      } else {
        const msg = await ctx.reply(text, { parse_mode: "HTML" });
        state.heartbeatMessage = msg;
        state.toolMessages.push(msg);
      }
    } catch (error) {
      streamLog.debug({ errorSummary: describeError(error) }, "Heartbeat update skipped");
    } finally {
      state.heartbeatUpdating = false;
    }
  }, HEARTBEAT_TICK_MS);
}

function stopHeartbeat(state: StreamingState): void {
  if (!state.heartbeatTimer) return;
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

interface TeardownOptions {
  chatId?: number;
  clearRegisteredState?: boolean;
}

export async function teardownStreamingState(
  ctx: Context,
  state: StreamingState,
  options: TeardownOptions = {}
): Promise<void> {
  if (state.teardownCompleted) return;
  state.teardownCompleted = true;
  stopHeartbeat(state);
  await deleteThinkingPlaceholder(ctx, state);
  await clearHeartbeatMessage(ctx, state);
  await cleanupToolMessages(ctx, state);
  if (options.clearRegisteredState) {
    if (typeof options.chatId === "number") {
      clearStreamingState(options.chatId);
    } else if (ctx.chat?.id !== undefined) {
      clearStreamingState(ctx.chat.id);
    }
  }
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

export function isSpawnOrchestrationToolStatus(content: string): boolean {
  const normalized = decodeBasicHtmlEntities(content)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized.includes("spawn")) {
    return false;
  }

  if (normalized.includes("subturtle")) {
    return true;
  }

  return normalized.includes("/ctl") || normalized.includes(" ctl ");
}

/**
 * Format content for Telegram, ensuring it fits within the message limit.
 * Truncates raw content and re-converts if HTML output exceeds the limit.
 */
function formatWithinLimit(
  content: string,
  safeLimit: number = TELEGRAM_SAFE_LIMIT
): string {
  let display =
    content.length > safeLimit ? content.slice(0, safeLimit) + "..." : content;
  let formatted = convertMarkdownToHtml(display);

  // HTML tags can inflate content beyond the limit - shrink until it fits
  if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
    const ratio = TELEGRAM_MESSAGE_LIMIT / formatted.length;
    display = content.slice(0, Math.floor(safeLimit * ratio * 0.95)) + "...";
    formatted = convertMarkdownToHtml(display);
  }

  return formatted;
}

/**
 * Split long formatted content into chunks and send as separate messages.
 */
async function sendChunkedMessages(
  ctx: Context,
  content: string
): Promise<void> {
  // Split on markdown content first, then format each chunk
  for (let i = 0; i < content.length; i += TELEGRAM_SAFE_LIMIT) {
    const chunk = content.slice(i, i + TELEGRAM_SAFE_LIMIT);
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      // HTML failed (possibly broken tags from split) - try plain text
      try {
        await ctx.reply(chunk);
      } catch (plainError) {
        streamLog.debug({ err: plainError }, "Failed to send chunk");
      }
    }
  }
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  const chatId = ctx.chat?.id;
  if (typeof chatId === "number") {
    activeStreamingStates.set(chatId, state);
  }
  startHeartbeat(ctx, state);
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType !== "done") {
        state.lastStatusAt = Date.now();
      }
      if (
        state.heartbeatMessage &&
        (statusType === "thinking" ||
          statusType === "tool" ||
          statusType === "text" ||
          statusType === "segment_end")
      ) {
        await clearHeartbeatMessage(ctx, state);
      }

      if (statusType === "thinking_start") {
        // Immediate placeholder shown before any CLI events arrive
        const msg = await ctx.reply("<i>Thinking\u2026</i>", {
          parse_mode: "HTML",
        });
        state.thinkingPlaceholder = msg;
      } else if (statusType === "thinking") {
        // Thinking block arrived — remove the placeholder first
        await deleteThinkingPlaceholder(ctx, state);
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`<i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        state.sawToolUse = true;
        if (isSpawnOrchestrationToolStatus(content)) {
          state.sawSpawnOrchestration = true;
        }
        // Tool status content is pre-formatted HTML (from formatToolStatus
        // or formatCodexToolStatus) — do NOT double-escape.
        try {
          const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
          state.toolMessages.push(toolMsg);
        } catch (htmlError) {
          // HTML parse failed (unexpected entity edge case) - try plain text
          streamLog.debug({ err: htmlError }, "HTML tool status failed, using plain text");
          const toolMsg = await ctx.reply(escapeHtml(content));
          state.toolMessages.push(toolMsg);
        }
      } else if (statusType === "text" && segmentId !== undefined) {
        // First real text content — remove the thinking placeholder if still showing
        await deleteThinkingPlaceholder(ctx, state);
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const formatted = formatWithinLimit(content);
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            streamLog.debug({ err: htmlError }, "HTML reply failed, using plain text");
            const msg = await ctx.reply(formatted);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const formatted = formatWithinLimit(content);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (error) {
            const errorStr = String(error);
            if (errorStr.includes("MESSAGE_TOO_LONG")) {
              // Skip this intermediate update - segment_end will chunk properly
              streamLog.debug("Streaming edit too long, deferring to segment_end");
            } else {
              streamLog.debug({ err: error }, "HTML edit failed, trying plain text");
              try {
                await ctx.api.editMessageText(
                  msg.chat.id,
                  msg.message_id,
                  formatted
                );
                state.lastContent.set(segmentId, formatted);
              } catch (editError) {
                streamLog.debug({ err: editError }, "Edit message failed");
              }
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (content) {
          const formatted = convertMarkdownToHtml(content);

          if (state.textMessages.has(segmentId)) {
            const msg = state.textMessages.get(segmentId)!;

            // Skip if content unchanged
            if (formatted === state.lastContent.get(segmentId)) {
              return;
            }

            if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                await ctx.api.editMessageText(
                  msg.chat.id,
                  msg.message_id,
                  formatted,
                  {
                    parse_mode: "HTML",
                  }
                );
              } catch (error) {
                const errorStr = String(error);
                if (errorStr.includes("MESSAGE_TOO_LONG")) {
                  // HTML overhead pushed it over - delete and chunk
                  try {
                    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
                  } catch (delError) {
                    streamLog.debug({ err: delError }, "Failed to delete for chunking");
                  }
                  await sendChunkedMessages(ctx, formatted);
                } else {
                  streamLog.debug({ err: error }, "Failed to edit final message");
                }
              }
            } else {
              // Too long - delete and split
              try {
                await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
              } catch (error) {
                streamLog.debug({ err: error }, "Failed to delete message for splitting");
              }
              await sendChunkedMessages(ctx, formatted);
            }
          } else {
            // No streaming message was created (response was too short to trigger
            // the throttled text callback). Send the final content as a new message.
            if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                await ctx.reply(formatted, { parse_mode: "HTML" });
              } catch {
                try {
                  await ctx.reply(formatted);
                } catch (plainError) {
                  streamLog.debug({ err: plainError }, "Failed to send short segment");
                }
              }
            } else {
              await sendChunkedMessages(ctx, formatted);
            }
          }
        }
      } else if (statusType === "done") {
        await teardownStreamingState(ctx, state, {
          chatId,
          clearRegisteredState: true,
        });
      }
    } catch (error) {
      await teardownStreamingState(ctx, state, {
        chatId,
        clearRegisteredState: true,
      });
      streamLog.error({ err: error, statusType, segmentId }, "Status callback error");
    }
  };
}

/**
 * Create a silent status callback for background runs.
 * Captures streamed text by segment, but never sends Telegram messages.
 */
export function createSilentStatusCallback(
  _ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "tool") {
        state.sawToolUse = true;
        if (isSpawnOrchestrationToolStatus(content)) {
          state.sawSpawnOrchestration = true;
        }
      }
      if (
        (statusType === "text" || statusType === "segment_end") &&
        segmentId !== undefined
      ) {
        state.silentSegments.set(segmentId, content);
      }
    } catch (error) {
      streamLog.error({ err: error, statusType, segmentId }, "Silent status callback error");
    }
  };
}
