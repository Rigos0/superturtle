/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import { closeSync, openSync, statSync, unlinkSync } from "fs";
import type { DriverStatusType, StatusCallback } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  classifyDriverStatusMessage,
  OutboundMessageKind,
} from "../message-kinds";
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
import { streamLog } from "../logger";
import {
  clamp,
  readPinoLogLines,
  buildLevelFilter,
  formatPinoEntry,
} from "../log-reader";
import {
  TerminalOutputPlan,
  type TerminalOutputEntry,
} from "./terminal-output-plan";

// Union type for bot control to work with both Claude and Codex sessions
type BotControlSession = ClaudeSession | CodexSession;
const PENDING_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const HEARTBEAT_IDLE_MS = 20_000;
const HEARTBEAT_REFRESH_MS = 30_000;
const HEARTBEAT_TICK_MS = 1_000;
const REQUEST_LOCK_STALE_MS = 60_000;
const MAX_PROGRESS_SNAPSHOTS = 12;
const MIN_PROGRESS_VISIBLE_MS = 200;
const INITIAL_PROGRESS_RENDER_DELAY_MS = (() => {
  const raw = Number(process.env.TELEGRAM_PROGRESS_INITIAL_DELAY_MS ?? "350");
  return Number.isFinite(raw) && raw >= 0 ? raw : 350;
})();

export type CanonicalProgressState =
  | "Starting"
  | "Thinking"
  | "Using tools"
  | "Writing answer"
  | "Still working"
  | "Stopping"
  | "Stopped"
  | "Done"
  | "Failed";

const DEFAULT_PROGRESS_SUMMARY: Record<CanonicalProgressState, string> = {
  Starting: "\u200b",
  Thinking: "Working through the request.",
  "Using tools": "Running tools.",
  "Writing answer": "Drafting the final reply.",
  "Still working": "No new updates yet.",
  Stopping: "Cancelling the run.",
  Stopped: "Run stopped.",
  Done: "Reply ready.",
  Failed: "The run failed.",
};

interface ProgressSnapshot {
  progressState: CanonicalProgressState;
  summary: string;
  toolHint: string | null;
  elapsedMs: number;
  terminal: boolean;
}

interface RenderedProgressPayload {
  text: string;
  replyMarkup?: InlineKeyboard;
  controlsKey: string;
}

const retainedProgressViewers = new Map<string, StreamingState>();

function getIpcDir(): string {
  const override = process.env.SUPERTURTLE_IPC_DIR?.trim();
  return override && override.length > 0 ? override : IPC_DIR;
}

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

function tryAcquirePendingRequestLock(filepath: string): (() => void) | null {
  const lockPath = `${filepath}.lock`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        try {
          const stats = statSync(lockPath);
          if (Date.now() - stats.mtimeMs > REQUEST_LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {}
        return null;
      }
      throw error;
    }
  }

  return null;
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
  const ipcDir = getIpcDir();
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: ipcDir, absolute: false })) {
    const filepath = `${ipcDir}/${filename}`;
    const releaseLock = tryAcquirePendingRequestLock(filepath);
    if (!releaseLock) continue;
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
        const state = getStreamingState(chatId);
        const sentMsg = await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;
        if (state) {
          state.awaitingUserAttention = true;
        }

        // Mark as sent
        data.status = "sent";
        data.sent_message_id = sentMsg.message_id;
        data.sent_at = new Date().toISOString();
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process ask-user file");
    } finally {
      releaseLock();
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
  const ipcDir = getIpcDir();
  const glob = new Bun.Glob("send-turtle-*.json");
  let photoSent = false;

  for await (const filename of glob.scan({ cwd: ipcDir, absolute: false })) {
    const filepath = `${ipcDir}/${filename}`;
    const releaseLock = tryAcquirePendingRequestLock(filepath);
    if (!releaseLock) continue;
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
      const state = getStreamingState(chatId);

      if (url) {
        if (state) {
          await maybeApplyTerminalProgressStateUpdate(ctx, state, "Writing answer", {
            summary: buildArtifactProgressSummary("sticker", caption),
            toolHint: null,
            storeSnapshot: true,
          });
          queueTerminalOutput(
            state,
            [],
            async (targetCtx, notify) =>
              sendStickerOutput(targetCtx, url, { caption, notify }),
            {
              kind: "final_artifact",
              progressSummary: buildArtifactDoneSummary("sticker", caption),
            }
          );
        } else {
          await sendStickerOutput(ctx, url, { caption, notify: true });
        }
        photoSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process send-turtle file");
    } finally {
      releaseLock();
    }
  }

  return photoSent;
}

/**
 * Check for pending send-image requests and send photos to Telegram.
 */
export async function checkPendingSendImageRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const ipcDir = getIpcDir();
  const glob = new Bun.Glob("send-image-*.json");
  let imageSent = false;

  for await (const filename of glob.scan({ cwd: ipcDir, absolute: false })) {
    const filepath = `${ipcDir}/${filename}`;
    const releaseLock = tryAcquirePendingRequestLock(filepath);
    if (!releaseLock) continue;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.status !== "pending") continue;
      const targetChatId = getRequestChatId(data);
      if (!targetChatId) {
        data.status = "error";
        data.error = "Missing chat_id on pending send-image request";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }
      if (targetChatId !== String(chatId)) continue;
      if (isPendingRequestStale(data)) {
        data.status = "expired";
        data.error = "Pending send-image request expired before delivery";
        await Bun.write(filepath, JSON.stringify(data, null, 2));
        continue;
      }

      const source: string = data.source || "";
      const caption: string = data.caption || undefined;
      const state = getStreamingState(chatId);

      if (source) {
        try {
          const isUrl = source.startsWith("http://") || source.startsWith("https://");
          if (!isUrl) {
            const fileData = Bun.file(source);
            if (!(await fileData.exists())) {
              throw new Error(`File not found: ${source}`);
            }
          }

          if (state) {
            await maybeApplyTerminalProgressStateUpdate(ctx, state, "Writing answer", {
              summary: buildArtifactProgressSummary("image", caption),
              toolHint: null,
              storeSnapshot: true,
            });
            queueTerminalOutput(
              state,
              [],
              async (targetCtx, notify) =>
                sendImageOutput(targetCtx, source, { caption, notify }),
              {
                kind: "final_artifact",
                progressSummary: buildArtifactDoneSummary("image", caption),
              }
            );
          } else {
            await sendImageOutput(ctx, source, { caption, notify: true });
          }
          imageSent = true;
        } catch (sendError) {
          streamLog.warn(
            { err: sendError, filepath, source, chatId },
            "Failed to send image, falling back to link/path"
          );
          const fallback = source.startsWith("http") ? source : `📎 ${source}`;
          const fallbackText = `${fallback}${caption ? `\n${caption}` : ""}`;
          if (state) {
            await maybeApplyTerminalProgressStateUpdate(ctx, state, "Writing answer", {
              summary: buildArtifactProgressSummary("image", caption),
              toolHint: null,
              storeSnapshot: true,
            });
            queueTerminalOutput(
              state,
              [],
              async (targetCtx, notify) => [
                await sendTextMessage(targetCtx, fallbackText, { notify }),
              ],
              {
                kind: "final_artifact",
                progressSummary: buildArtifactDoneSummary("image", caption),
              }
            );
          } else if (!state) {
            await sendTextMessage(ctx, fallbackText, { notify: true });
          }
          imageSent = true;
        }

        data.status = "sent";
        data.sent_at = new Date().toISOString();
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      streamLog.warn({ err: error, filepath, chatId }, "Failed to process send-image file");
    } finally {
      releaseLock();
    }
  }

  return imageSent;
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
  const ipcDir = getIpcDir();
  const glob = new Bun.Glob("bot-control-*.json");
  let handled = false;

  for await (const filename of glob.scan({ cwd: ipcDir, absolute: false })) {
    const filepath = `${ipcDir}/${filename}`;
    const releaseLock = tryAcquirePendingRequestLock(filepath);
    if (!releaseLock) continue;
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
    } finally {
      releaseLock();
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
  const ipcDir = getIpcDir();
  const glob = new Bun.Glob("pino-logs-*.json");
  let handled = false;

  for await (const filename of glob.scan({ cwd: ipcDir, absolute: false })) {
    const filepath = `${ipcDir}/${filename}`;
    const releaseLock = tryAcquirePendingRequestLock(filepath);
    if (!releaseLock) continue;
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
    } finally {
      releaseLock();
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

      // Do not stop the active turn here: when restart is triggered from an
      // inline bot-control tool, that stop would abort the same turn that's
      // handling the restart request and can leave the chat without a clean
      // restart acknowledgement. Startup cleanup already resets stale work.
      setTimeout(() => {
        process.exit(0);
      }, 500);

      return "Restarting bot...";
    }

    case "update_runtime": {
      if (!chatId) {
        return "Cannot update runtime without an active Telegram chat.";
      }

      const { parseSelfUpdateRequest, startRemoteSelfUpdate } = await import("./commands");
      const request = parseSelfUpdateRequest(params.target);
      if (!request) {
        return "Invalid update target. Use default channel, a dist-tag like managed-codex, or superturtle@<exact-version>.";
      }

      return await startRemoteSelfUpdate({
        chatId,
        request,
        reply: async (text) => bot.api.sendMessage(chatId, text),
      });
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
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  progressMessage: Message | null = null; // retained silent progress message for foreground runs
  lastProgressContent: string | null = null;
  lastProgressControlsKey: string | null = null;
  lastProgressRenderedAt = 0;
  progressUpdateChain: Promise<void> = Promise.resolve();
  hasTextSegmentOutput = false;
  terminalOutputs = new TerminalOutputPlan();
  silentSegments = new Map<number, string>(); // segment_id -> captured text for silent mode
  sawToolUse = false; // used to avoid replaying side-effectful tool runs on retries
  sawSpawnOrchestration = false; // true when streamed tool activity indicates `ctl spawn` orchestration
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  heartbeatUpdating = false;
  statusStartedAt = Date.now();
  lastStatusAt = Date.now();
  progressState: CanonicalProgressState = "Starting";
  progressSummary = DEFAULT_PROGRESS_SUMMARY.Starting;
  progressToolHint: string | null = null;
  progressSnapshots: ProgressSnapshot[] = [];
  progressViewerCompleted = false;
  selectedProgressSnapshotIndex: number | null = null;
  retainedProgressViewerKey: string | null = null;
  lastAnswerPreview: string | null = null;
  lastHeartbeatAt = 0;
  teardownCompleted = false;
  awaitingUserAttention = false;
  stopRequestedByUser = false;
  visibleProgressMaterialized = false;
  pendingProgressPayload: RenderedProgressPayload | null = null;
  pendingProgressTimer: ReturnType<typeof setTimeout> | null = null;
  initialProgressDelayElapsed = INITIAL_PROGRESS_RENDER_DELAY_MS === 0;

  get lastNotifiableOutput(): TerminalOutputEntry | null {
    return this.terminalOutputs.getLatestOutput();
  }

  getSilentCapturedText(): string {
    return [...this.silentSegments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join("");
  }
}

const activeStreamingStates = new Map<number, StreamingState>();

function getRetainedProgressViewerKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function unregisterRetainedProgressViewer(state: StreamingState): void {
  if (!state.retainedProgressViewerKey) {
    return;
  }
  retainedProgressViewers.delete(state.retainedProgressViewerKey);
  state.retainedProgressViewerKey = null;
}

function clearPendingProgressRender(state: StreamingState): void {
  if (state.pendingProgressTimer) {
    clearTimeout(state.pendingProgressTimer);
    state.pendingProgressTimer = null;
  }
  state.pendingProgressPayload = null;
}

function shouldRenderTerminalProgress(state: StreamingState): boolean {
  return state.visibleProgressMaterialized;
}

function registerRetainedProgressViewer(state: StreamingState): void {
  if (!state.progressViewerCompleted || !state.progressMessage) {
    unregisterRetainedProgressViewer(state);
    return;
  }

  const nextKey = getRetainedProgressViewerKey(
    state.progressMessage.chat.id,
    state.progressMessage.message_id
  );
  if (state.retainedProgressViewerKey && state.retainedProgressViewerKey !== nextKey) {
    retainedProgressViewers.delete(state.retainedProgressViewerKey);
  }
  retainedProgressViewers.set(nextKey, state);
  state.retainedProgressViewerKey = nextKey;
}

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

export async function navigateRetainedProgressViewer(
  ctx: Context,
  direction: "back" | "next"
): Promise<"updated" | "boundary" | "missing"> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    return "missing";
  }

  const viewer = retainedProgressViewers.get(
    getRetainedProgressViewerKey(chatId, messageId)
  );
  if (!viewer || viewer.progressSnapshots.length < 2) {
    return "missing";
  }

  const currentIndex =
    viewer.selectedProgressSnapshotIndex ?? viewer.progressSnapshots.length - 1;
  const nextIndex = direction === "back" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= viewer.progressSnapshots.length) {
    return "boundary";
  }

  viewer.selectedProgressSnapshotIndex = nextIndex;
  await queueRenderedProgressMessageUpdate(ctx, viewer);
  return "updated";
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
}

async function clearProgressMessage(ctx: Context, state: StreamingState): Promise<void> {
  if (!state.progressMessage) return;
  const msg = state.progressMessage;
  unregisterRetainedProgressViewer(state);
  state.progressMessage = null;
  state.lastProgressContent = null;
  state.lastProgressControlsKey = null;
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch (error) {
    if (!isIgnorableDeleteMessageError(error)) {
      streamLog.debug(
        { errorSummary: describeError(error), chatId: msg.chat.id, messageId: msg.message_id },
        "Failed to delete progress message"
      );
    }
  }
}

type ReplyExtra = NonNullable<Parameters<Context["reply"]>[1]>;
type PhotoReplyExtra = NonNullable<Parameters<Context["replyWithPhoto"]>[1]>;
type StickerReplyExtra = NonNullable<Parameters<Context["replyWithSticker"]>[1]>;

function withSilentNotification(extra?: ReplyExtra): ReplyExtra {
  return {
    ...(extra || {}),
    disable_notification: true,
  } as ReplyExtra;
}

function withSilentPhotoNotification(extra?: PhotoReplyExtra): PhotoReplyExtra {
  return {
    ...(extra || {}),
    disable_notification: true,
  } as PhotoReplyExtra;
}

function withSilentStickerNotification(extra?: StickerReplyExtra): StickerReplyExtra {
  return {
    ...(extra || {}),
    disable_notification: true,
  } as StickerReplyExtra;
}

async function replySilently(
  ctx: Context,
  text: string,
  extra?: ReplyExtra
): Promise<Message> {
  return ctx.reply(text, withSilentNotification(extra));
}

function toPlainProgressText(text: string): string {
  return decodeBasicHtmlEntities(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|pre|blockquote|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeProgressLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateProgressLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function summarizeProgressContent(
  content: string,
  maxLength: number,
  fallback: string
): string {
  const normalized = normalizeProgressLine(toPlainProgressText(content));
  if (!normalized) {
    return fallback;
  }
  return truncateProgressLine(normalized, maxLength);
}

function summarizeToolHint(content: string): string | null {
  const normalized = normalizeProgressLine(toPlainProgressText(content))
    .replace(/^[^\p{L}\p{N}]+/u, "");
  if (!normalized) {
    return null;
  }
  return truncateProgressLine(normalized, 40);
}

function buildArtifactProgressSummary(
  noun: "image" | "sticker",
  caption?: string
): string {
  const prefix = noun === "image" ? "Preparing final image" : "Preparing final sticker";
  const normalizedCaption =
    typeof caption === "string" ? normalizeProgressLine(caption) : "";
  const summary = normalizedCaption ? `${prefix}: ${normalizedCaption}` : `${prefix}.`;
  return truncateProgressLine(summary, 160);
}

function buildArtifactDoneSummary(
  noun: "image" | "sticker",
  caption?: string
): string {
  const prefix = noun === "image" ? "Final image ready" : "Final sticker ready";
  const normalizedCaption =
    typeof caption === "string" ? normalizeProgressLine(caption) : "";
  const summary = normalizedCaption ? `${prefix}: ${normalizedCaption}` : `${prefix}.`;
  return truncateProgressLine(summary, 160);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function getSelectedProgressSnapshot(state: StreamingState): ProgressSnapshot | null {
  if (
    !state.progressViewerCompleted ||
    state.selectedProgressSnapshotIndex === null
  ) {
    return null;
  }
  return state.progressSnapshots[state.selectedProgressSnapshotIndex] || null;
}

function trimProgressSnapshots(state: StreamingState): void {
  while (state.progressSnapshots.length > MAX_PROGRESS_SNAPSHOTS) {
    const removalIndex = state.progressSnapshots.findIndex((snapshot) => !snapshot.terminal);
    const safeIndex = removalIndex === -1 ? 0 : removalIndex;
    state.progressSnapshots.splice(safeIndex, 1);
    if (
      state.selectedProgressSnapshotIndex !== null &&
      state.selectedProgressSnapshotIndex >= safeIndex
    ) {
      state.selectedProgressSnapshotIndex = Math.max(
        0,
        state.selectedProgressSnapshotIndex - 1
      );
    }
  }
}

function isBlankProgressSummary(text: string): boolean {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length === 0;
}

function recordProgressSnapshot(
  state: StreamingState,
  options: { force?: boolean; terminal?: boolean } = {}
): void {
  if (!options.terminal && isBlankProgressSummary(state.progressSummary)) {
    return;
  }
  if (
    !options.terminal &&
    state.progressState !== "Writing answer" &&
    state.progressState !== "Still working"
  ) {
    return;
  }

  const snapshot: ProgressSnapshot = {
    progressState: state.progressState,
    summary: state.progressSummary,
    toolHint: state.progressToolHint,
    elapsedMs: Math.max(0, Date.now() - state.statusStartedAt),
    terminal: options.terminal === true,
  };
  const previous = state.progressSnapshots[state.progressSnapshots.length - 1];
  const isDuplicate =
    previous &&
    previous.summary === snapshot.summary &&
    previous.toolHint === snapshot.toolHint &&
    (
      previous.progressState === snapshot.progressState ||
      options.terminal === true
    );

  if (!options.force && isDuplicate) {
    if (options.terminal === true && previous) {
      previous.terminal = true;
    }
    return;
  }

  state.progressSnapshots.push(snapshot);
  trimProgressSnapshots(state);
}

function finalizeExistingProgressHistory(state: StreamingState): boolean {
  const lastSnapshot = state.progressSnapshots[state.progressSnapshots.length - 1];
  if (!lastSnapshot) {
    state.progressViewerCompleted = false;
    state.selectedProgressSnapshotIndex = null;
    return false;
  }

  lastSnapshot.elapsedMs = Math.max(0, Date.now() - state.statusStartedAt);
  lastSnapshot.terminal = true;
  state.progressViewerCompleted = true;
  state.selectedProgressSnapshotIndex = state.progressSnapshots.length - 1;
  return true;
}

function buildProgressKeyboard(state: StreamingState): InlineKeyboard | undefined {
  if (!state.progressViewerCompleted || state.progressSnapshots.length < 2) {
    return undefined;
  }

  const selectedIndex =
    state.selectedProgressSnapshotIndex ?? state.progressSnapshots.length - 1;
  const keyboard = new InlineKeyboard();
  if (selectedIndex > 0) {
    keyboard.text("⬅️", "progress_nav:back");
  }
  if (selectedIndex < state.progressSnapshots.length - 1) {
    keyboard.text("➡️", "progress_nav:next");
  }

  return (keyboard as { inline_keyboard?: unknown[] }).inline_keyboard?.length
    ? keyboard
    : undefined;
}

function renderProgressMessage(state: StreamingState): {
  text: string;
  replyMarkup?: InlineKeyboard;
  controlsKey: string;
} {
  const snapshot = getSelectedProgressSnapshot(state);
  const progressSummary = snapshot?.summary ?? state.progressSummary;
  const elapsedMs = snapshot?.elapsedMs ?? Date.now() - state.statusStartedAt;
  const footerParts: string[] = [];
  if (state.progressViewerCompleted) {
    footerParts.push(`Elapsed ${formatElapsed(elapsedMs)}`);
  }
  if (
    state.progressViewerCompleted &&
    state.progressSnapshots.length > 1 &&
    state.selectedProgressSnapshotIndex !== null
  ) {
    footerParts.push(
      `${state.selectedProgressSnapshotIndex + 1} / ${state.progressSnapshots.length}`
    );
  }

  const replyMarkup = buildProgressKeyboard(state);

  return {
    text: footerParts.length
      ? [
        escapeHtml(progressSummary),
        `<i>${escapeHtml(footerParts.join(" • "))}</i>`,
      ].join("\n")
      : escapeHtml(progressSummary),
    replyMarkup,
    controlsKey:
      state.progressViewerCompleted && state.selectedProgressSnapshotIndex !== null
        ? `${state.selectedProgressSnapshotIndex}:${state.progressSnapshots.length}`
        : "live",
  };
}

function isEffectivelyBlankProgressText(text: string | null): boolean {
  if (!text) {
    return true;
  }
  return toPlainProgressText(text).replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length === 0;
}

async function waitForMinimumVisibleProgressDuration(state: StreamingState): Promise<void> {
  if (state.progressViewerCompleted || state.lastProgressRenderedAt <= 0) {
    return;
  }
  if (isEffectivelyBlankProgressText(state.lastProgressContent)) {
    return;
  }
  const elapsed = Date.now() - state.lastProgressRenderedAt;
  if (elapsed >= MIN_PROGRESS_VISIBLE_MS) {
    return;
  }
  await Bun.sleep(MIN_PROGRESS_VISIBLE_MS - elapsed);
}

function markProgressRendered(state: StreamingState, payloadText: string): void {
  state.lastProgressRenderedAt = isEffectivelyBlankProgressText(payloadText) ? 0 : Date.now();
}

async function queueRenderedProgressMessageUpdate(
  ctx: Context,
  state: StreamingState
): Promise<void> {
  await queueProgressMessageUpdate(ctx, state, renderProgressMessage(state));
}

async function applyProgressStateUpdate(
  ctx: Context,
  state: StreamingState,
  progressState: CanonicalProgressState,
  options: {
    summary?: string;
    toolHint?: string | null;
    trackActivity?: boolean;
    storeSnapshot?: boolean;
    terminalSnapshot?: boolean;
  } = {}
): Promise<void> {
  if (options.terminalSnapshot === true) {
    state.progressViewerCompleted = true;
  } else if (!state.progressViewerCompleted) {
    state.selectedProgressSnapshotIndex = null;
  }

  const nextSummary = options.summary ?? DEFAULT_PROGRESS_SUMMARY[progressState];
  const nextToolHint =
    options.toolHint === undefined ? state.progressToolHint : options.toolHint;
  const changed =
    state.progressState !== progressState ||
    state.progressSummary !== nextSummary ||
    state.progressToolHint !== nextToolHint;

  state.progressState = progressState;
  state.progressSummary = nextSummary;
  state.progressToolHint = nextToolHint;

  if (changed && options.trackActivity !== false) {
    state.lastStatusAt = Date.now();
    state.lastHeartbeatAt = 0;
  }

  if (options.storeSnapshot === true) {
    recordProgressSnapshot(state, { terminal: options.terminalSnapshot === true });
    if (state.progressViewerCompleted) {
      state.selectedProgressSnapshotIndex = state.progressSnapshots.length - 1;
    }
  }

  await queueRenderedProgressMessageUpdate(ctx, state);
}

export async function updateRetainedProgressState(
  ctx: Context,
  state: StreamingState,
  progressState: CanonicalProgressState,
  options: {
    summary?: string;
    toolHint?: string | null;
    trackActivity?: boolean;
    storeSnapshot?: boolean;
    terminalSnapshot?: boolean;
  } = {}
): Promise<void> {
  await applyProgressStateUpdate(ctx, state, progressState, options);
}

async function updateProgressMessage(
  ctx: Context,
  state: StreamingState,
  payload: RenderedProgressPayload
): Promise<void> {
  if (state.teardownCompleted && !state.progressViewerCompleted) {
    return;
  }

  if (
    payload.text === state.lastProgressContent &&
    payload.controlsKey === state.lastProgressControlsKey
  ) {
    return;
  }

  await waitForMinimumVisibleProgressDuration(state);

  if (state.teardownCompleted && !state.progressViewerCompleted) {
    return;
  }

  if (
    !state.progressMessage &&
    !state.progressViewerCompleted &&
    state.lastProgressContent === null &&
    !state.initialProgressDelayElapsed
  ) {
    state.pendingProgressPayload = payload;
    if (!state.pendingProgressTimer) {
      state.pendingProgressTimer = setTimeout(() => {
        state.pendingProgressTimer = null;
        state.initialProgressDelayElapsed = true;
        const pendingPayload = state.pendingProgressPayload;
        state.pendingProgressPayload = null;
        if (!pendingPayload || state.teardownCompleted || state.progressMessage) {
          return;
        }
        void queueProgressMessageUpdate(ctx, state, pendingPayload);
      }, INITIAL_PROGRESS_RENDER_DELAY_MS);
    }
    return;
  }

  if (state.progressMessage) {
    try {
      await ctx.api.editMessageText(
        state.progressMessage.chat.id,
        state.progressMessage.message_id,
        payload.text,
        {
          parse_mode: "HTML",
          ...(payload.replyMarkup ? { reply_markup: payload.replyMarkup } : {}),
        }
      );
      state.lastProgressContent = payload.text;
      state.lastProgressControlsKey = payload.controlsKey;
      markProgressRendered(state, payload.text);
      registerRetainedProgressViewer(state);
      return;
    } catch (error) {
      const errorSummary = describeError(error).toLowerCase();
      if (errorSummary.includes("message is not modified")) {
        state.lastProgressContent = payload.text;
        state.lastProgressControlsKey = payload.controlsKey;
        markProgressRendered(state, payload.text);
        registerRetainedProgressViewer(state);
        return;
      }
      const plainText = toPlainProgressText(payload.text);
      if (plainText.length > 0) {
        try {
          await ctx.api.editMessageText(
            state.progressMessage.chat.id,
            state.progressMessage.message_id,
            plainText,
            payload.replyMarkup ? { reply_markup: payload.replyMarkup } : undefined
          );
          state.lastProgressContent = payload.text;
          state.lastProgressControlsKey = payload.controlsKey;
          markProgressRendered(state, payload.text);
          registerRetainedProgressViewer(state);
          return;
        } catch (plainError) {
          const plainErrorSummary = describeError(plainError).toLowerCase();
          if (plainErrorSummary.includes("message is not modified")) {
            state.lastProgressContent = payload.text;
            state.lastProgressControlsKey = payload.controlsKey;
            markProgressRendered(state, payload.text);
            registerRetainedProgressViewer(state);
            return;
          }
          if (!isIgnorableDeleteMessageError(plainError)) {
            streamLog.debug(
              { err: plainError },
              "Failed to edit retained progress message as plain text"
            );
          }
        }
      }
      if (!isIgnorableDeleteMessageError(error)) {
        streamLog.debug({ err: error }, "Failed to edit retained progress message as HTML");
      }
      unregisterRetainedProgressViewer(state);
      state.progressMessage = null;
      state.lastProgressContent = null;
      state.lastProgressControlsKey = null;
      state.lastProgressRenderedAt = 0;
    }
  }

  if (typeof ctx.reply !== "function") {
    return;
  }

  if (state.teardownCompleted && !state.progressViewerCompleted) {
    return;
  }

  try {
    clearPendingProgressRender(state);
    state.initialProgressDelayElapsed = true;
    const msg = await replySilently(ctx, payload.text, {
      parse_mode: "HTML",
      ...(payload.replyMarkup ? { reply_markup: payload.replyMarkup } : {}),
    });
    state.progressMessage = msg;
    state.visibleProgressMaterialized = true;
    state.lastProgressContent = payload.text;
    state.lastProgressControlsKey = payload.controlsKey;
    markProgressRendered(state, payload.text);
    registerRetainedProgressViewer(state);
  } catch (error) {
    const plainText = toPlainProgressText(payload.text);
    if (plainText.length === 0) {
      throw error;
    }
    clearPendingProgressRender(state);
    state.initialProgressDelayElapsed = true;
    const msg = await replySilently(ctx, plainText, {
      ...(payload.replyMarkup ? { reply_markup: payload.replyMarkup } : {}),
    });
    state.progressMessage = msg;
    state.visibleProgressMaterialized = true;
    state.lastProgressContent = payload.text;
    state.lastProgressControlsKey = payload.controlsKey;
    markProgressRendered(state, payload.text);
    registerRetainedProgressViewer(state);
  }
}

function queueProgressMessageUpdate(
  ctx: Context,
  state: StreamingState,
  payload: RenderedProgressPayload
): Promise<void> {
  if (state.teardownCompleted && !state.progressViewerCompleted) {
    return state.progressUpdateChain;
  }

  state.progressUpdateChain = state.progressUpdateChain
    .catch(() => {})
    .then(() => updateProgressMessage(ctx, state, payload));
  return state.progressUpdateChain;
}

function getNotificationExtra(notify: boolean, extra?: ReplyExtra): ReplyExtra | undefined {
  return notify ? extra : withSilentNotification(extra);
}

function getPhotoNotificationExtra(
  notify: boolean,
  extra?: PhotoReplyExtra
): PhotoReplyExtra | undefined {
  return notify ? extra : withSilentPhotoNotification(extra);
}

function getStickerNotificationExtra(
  notify: boolean,
  extra?: StickerReplyExtra
): StickerReplyExtra | undefined {
  return notify ? extra : withSilentStickerNotification(extra);
}

async function sendTextMessage(
  ctx: Context,
  text: string,
  options: { parseModeHtml?: boolean; notify?: boolean } = {}
): Promise<Message> {
  if (options.parseModeHtml) {
    return ctx.reply(
      text,
      getNotificationExtra(options.notify ?? false, { parse_mode: "HTML" })
    );
  }
  return ctx.reply(text, getNotificationExtra(options.notify ?? false));
}

async function sendImageOutput(
  ctx: Context,
  source: string,
  options: { caption?: string; notify?: boolean } = {}
): Promise<Message[]> {
  const caption = options.caption || undefined;
  const notify = options.notify ?? false;
  const replyOptions = getPhotoNotificationExtra(notify, caption ? { caption } : undefined);

  try {
    const isUrl = source.startsWith("http://") || source.startsWith("https://");
    if (isUrl) {
      return [await ctx.replyWithPhoto(source, replyOptions)];
    }

    const fileData = Bun.file(source);
    if (!(await fileData.exists())) {
      throw new Error(`File not found: ${source}`);
    }
    const buffer = Buffer.from(await fileData.arrayBuffer());
    const fileName = source.split("/").pop() || "image.png";
    return [await ctx.replyWithPhoto(new InputFile(buffer, fileName), replyOptions)];
  } catch (sendError) {
    streamLog.warn({ err: sendError, source }, "Failed to send image, falling back to link/path");
    const fallback = source.startsWith("http") ? source : `📎 ${source}`;
    const fallbackText = `${fallback}${caption ? `\n${caption}` : ""}`;
    return [await sendTextMessage(ctx, fallbackText, { notify })];
  }
}

async function sendStickerOutput(
  ctx: Context,
  url: string,
  options: { caption?: string; notify?: boolean } = {}
): Promise<Message[]> {
  const caption = options.caption || undefined;
  const notify = options.notify ?? false;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return [
      await ctx.replyWithSticker(
        new InputFile(buffer, "turtle.webp"),
        getStickerNotificationExtra(notify)
      ),
    ];
  } catch (photoError) {
    streamLog.warn(
      { err: photoError, url, chatId: ctx.chat?.id },
      "Failed to send turtle photo, falling back to link"
    );
    const fallbackText = `🐢 ${url}${caption ? `\n${caption}` : ""}`;
    return [await sendTextMessage(ctx, fallbackText, { notify })];
  }
}

async function sendRenderedContent(
  ctx: Context,
  formatted: string,
  notify: boolean
): Promise<Message[]> {
  if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
    try {
      return [await sendTextMessage(ctx, formatted, { parseModeHtml: true, notify })];
    } catch (htmlError) {
      streamLog.debug({ err: htmlError }, "HTML content send failed, using plain text");
      try {
        return [await sendTextMessage(ctx, formatted, { notify })];
      } catch (plainError) {
        streamLog.debug({ err: plainError }, "Plain content send failed");
        return [];
      }
    }
  }

  return sendChunkedMessages(ctx, formatted, { notifyFinalChunk: notify });
}

async function maybeApplyTerminalProgressStateUpdate(
  ctx: Context,
  state: StreamingState,
  progressState: CanonicalProgressState,
  options: {
    summary: string;
    toolHint?: string | null;
    storeSnapshot?: boolean;
    terminalSnapshot?: boolean;
  }
): Promise<boolean> {
  if (!shouldRenderTerminalProgress(state)) {
    return false;
  }
  await applyProgressStateUpdate(ctx, state, progressState, options);
  return true;
}

function queueTerminalOutput(
  state: StreamingState,
  messages: Message[],
  resend: (ctx: Context, notify: boolean) => Promise<Message[]>,
  options: {
    kind?: "final_success" | "final_artifact";
    progressSummary?: string | null;
    replaceExisting?: boolean;
  } = {}
): void {
  const output: TerminalOutputEntry = {
    messages,
    resend,
    kind: options.kind ?? "final_success",
    progressSummary: options.progressSummary ?? null,
    replaceExisting: options.replaceExisting === true,
  };
  if (output.kind === "final_artifact") {
    state.terminalOutputs.appendArtifact(output);
    return;
  }
  state.terminalOutputs.queueSuccess(output);
}

function startHeartbeat(ctx: Context, state: StreamingState): void {
  if (state.heartbeatTimer) return;
  state.statusStartedAt = Date.now();
  state.lastStatusAt = Date.now();
  state.lastHeartbeatAt = 0;
  state.heartbeatTimer = setInterval(async () => {
    if (state.heartbeatUpdating) return;
    if (Date.now() - state.lastStatusAt < HEARTBEAT_IDLE_MS) return;
    if (
      state.progressState === "Still working" &&
      Date.now() - state.lastHeartbeatAt < HEARTBEAT_REFRESH_MS
    ) {
      return;
    }

    state.heartbeatUpdating = true;
    try {
      state.lastHeartbeatAt = Date.now();
      const enteringStillWorking = state.progressState !== "Still working";
      await applyProgressStateUpdate(ctx, state, "Still working", {
        summary: state.progressSummary,
        toolHint: state.progressToolHint,
        trackActivity: false,
        storeSnapshot: enteringStillWorking,
      });
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
  retainProgressMessage?: boolean;
}

export async function teardownStreamingState(
  ctx: Context,
  state: StreamingState,
  options: TeardownOptions = {}
): Promise<void> {
  if (state.teardownCompleted) return;
  state.teardownCompleted = true;
  stopHeartbeat(state);
  clearPendingProgressRender(state);
  if (options.retainProgressMessage !== true) {
    await clearProgressMessage(ctx, state);
  }
  await cleanupToolMessages(ctx, state);
  if (options.clearRegisteredState) {
    if (typeof options.chatId === "number") {
      clearStreamingState(options.chatId);
    } else if (ctx.chat?.id !== undefined) {
      clearStreamingState(ctx.chat.id);
    }
  }
}

export async function retainStreamingState(
  ctx: Context,
  state: StreamingState,
  options: Omit<TeardownOptions, "retainProgressMessage"> = {}
): Promise<void> {
  await teardownStreamingState(ctx, state, {
    ...options,
    retainProgressMessage: true,
  });
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function normalizeToolStatus(content: string): string {
  return decodeBasicHtmlEntities(content)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function shouldSendToolStatusMessage(
  content: string,
  showToolStatus: boolean = (
    (process.env.SHOW_TOOL_STATUS || "false").toLowerCase() === "true"
  )
): boolean {
  if (showToolStatus) {
    return true;
  }

  const normalized = normalizeToolStatus(content);
  return (
    normalized.startsWith("blocked:") ||
    normalized.startsWith("access denied:") ||
    normalized.startsWith("error:") ||
    normalized.includes("failed:")
  );
}

export function isSpawnOrchestrationToolStatus(content: string): boolean {
  const normalized = normalizeToolStatus(content);

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
  content: string,
  options: { notifyFinalChunk?: boolean } = {}
): Promise<Message[]> {
  const messages: Message[] = [];
  const chunks: string[] = [];

  // Split on markdown content first, then format each chunk
  for (let i = 0; i < content.length; i += TELEGRAM_SAFE_LIMIT) {
    chunks.push(content.slice(i, i + TELEGRAM_SAFE_LIMIT));
  }

  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx]!;
    const notifyThisChunk = options.notifyFinalChunk === true && idx === chunks.length - 1;
    try {
      const msg = notifyThisChunk
        ? await ctx.reply(chunk, { parse_mode: "HTML" })
        : await replySilently(ctx, chunk, { parse_mode: "HTML" });
      messages.push(msg);
    } catch {
      // HTML failed (possibly broken tags from split) - try plain text
      try {
        const msg = notifyThisChunk
          ? await ctx.reply(chunk)
          : await replySilently(ctx, chunk);
        messages.push(msg);
      } catch (plainError) {
        streamLog.debug({ err: plainError }, "Failed to send chunk");
      }
    }
  }

  return messages;
}

async function promoteTerminalOutputs(
  ctx: Context,
  state: StreamingState
): Promise<boolean> {
  const outputs = state.terminalOutputs.getOutputs();
  if (outputs.length === 0) {
    return false;
  }

  let sentAny = false;

  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]!;
    if (output.replaceExisting) {
      for (const msg of output.messages) {
        try {
          await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
        } catch (error) {
          if (!isIgnorableDeleteMessageError(error)) {
            streamLog.debug(
              {
                errorSummary: describeError(error),
                chatId: msg.chat.id,
                messageId: msg.message_id,
              },
              "Failed to delete queued terminal output before promotion"
            );
          }
        }
      }
    }

    try {
      output.messages = await output.resend(ctx, index === outputs.length - 1);
      sentAny = output.messages.length > 0 || sentAny;
    } catch (error) {
      streamLog.debug({ err: error }, "Failed to promote queued terminal output");
    }
  }

  return sentAny;
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState,
  options: { showToolStatus?: boolean } = {}
): StatusCallback {
  const chatId = ctx.chat?.id;
  if (typeof chatId === "number") {
    activeStreamingStates.set(chatId, state);
  }
  startHeartbeat(ctx, state);
  return async (statusType: DriverStatusType, content: string, segmentId?: number) => {
    try {
      const outboundMessageKind = classifyDriverStatusMessage(statusType);

      if (statusType === "thinking") {
        await applyProgressStateUpdate(ctx, state, "Thinking", {
          summary: summarizeProgressContent(
            content,
            140,
            DEFAULT_PROGRESS_SUMMARY.Thinking
          ),
          toolHint: null,
          storeSnapshot: true,
        });
      } else if (statusType === "tool") {
        state.sawToolUse = true;
        if (isSpawnOrchestrationToolStatus(content)) {
          state.sawSpawnOrchestration = true;
        }
        const showToolDetails = shouldSendToolStatusMessage(
          content,
          options.showToolStatus
        );
        await applyProgressStateUpdate(ctx, state, "Using tools", {
          summary: showToolDetails
            ? summarizeProgressContent(
              content,
              140,
              DEFAULT_PROGRESS_SUMMARY["Using tools"]
            )
            : DEFAULT_PROGRESS_SUMMARY["Using tools"],
          toolHint: showToolDetails ? summarizeToolHint(content) : null,
          storeSnapshot: true,
        });
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;
        if (now - lastEdit > STREAMING_THROTTLE_MS) {
          const preview = summarizeProgressContent(
            convertMarkdownToHtml(content),
            160,
            DEFAULT_PROGRESS_SUMMARY["Writing answer"]
          );
          if (preview === state.lastAnswerPreview) {
            return;
          }
          state.lastAnswerPreview = preview;
          if (!shouldRenderTerminalProgress(state)) {
            return;
          }
          await applyProgressStateUpdate(ctx, state, "Writing answer", {
            summary: preview,
            toolHint: null,
            storeSnapshot: true,
          });
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (content) {
          state.hasTextSegmentOutput = true;
          const preview = summarizeProgressContent(
            convertMarkdownToHtml(content),
            160,
            DEFAULT_PROGRESS_SUMMARY["Writing answer"]
          );
          state.lastAnswerPreview = preview;
          await maybeApplyTerminalProgressStateUpdate(ctx, state, "Writing answer", {
            summary: preview,
            toolHint: null,
            storeSnapshot: true,
          });
          const formatted = convertMarkdownToHtml(content);
          queueTerminalOutput(
            state,
            [],
            async (targetCtx, notify) => sendRenderedContent(targetCtx, formatted, notify),
            {
              kind: "final_success",
              progressSummary: preview,
            }
          );
        }
      } else if (statusType === "done") {
        const finalOutput = state.lastNotifiableOutput;
        const doneSummary =
          finalOutput?.progressSummary ||
          state.lastAnswerPreview ||
          DEFAULT_PROGRESS_SUMMARY.Done;
        let retainProgressMessage = false;

        if (finalOutput?.kind === "final_artifact") {
          await promoteTerminalOutputs(ctx, state);
          retainProgressMessage = await maybeApplyTerminalProgressStateUpdate(
            ctx,
            state,
            "Done",
            {
              summary: doneSummary,
              toolHint: null,
              storeSnapshot: true,
              terminalSnapshot: true,
            }
          );
        } else if (!finalOutput) {
          await applyProgressStateUpdate(ctx, state, "Done", {
            summary: doneSummary,
            toolHint: null,
            storeSnapshot: true,
            terminalSnapshot: true,
          });
          retainProgressMessage = true;
        } else {
          if (shouldRenderTerminalProgress(state)) {
            retainProgressMessage = finalizeExistingProgressHistory(state);
            if (!retainProgressMessage && state.visibleProgressMaterialized) {
              await applyProgressStateUpdate(ctx, state, "Done", {
                summary: DEFAULT_PROGRESS_SUMMARY.Done,
                toolHint: null,
                storeSnapshot: true,
                terminalSnapshot: true,
              });
              retainProgressMessage = true;
            } else if (retainProgressMessage) {
              await queueRenderedProgressMessageUpdate(ctx, state);
            }
          }
        }

        if (finalOutput?.kind !== "final_artifact") {
          await promoteTerminalOutputs(ctx, state);
        }
        await teardownStreamingState(ctx, state, {
          chatId,
          clearRegisteredState: true,
          retainProgressMessage: retainProgressMessage && outboundMessageKind === null,
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
  return async (statusType: DriverStatusType, content: string, segmentId?: number) => {
    try {
      const outboundMessageKind = classifyDriverStatusMessage(statusType);
      if (statusType === "tool") {
        state.sawToolUse = true;
        if (isSpawnOrchestrationToolStatus(content)) {
          state.sawSpawnOrchestration = true;
        }
      }
      if (
        (outboundMessageKind === OutboundMessageKind.InteractiveProgress ||
          outboundMessageKind === OutboundMessageKind.InteractiveFinal) &&
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
