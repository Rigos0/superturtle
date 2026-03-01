/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session, getAvailableModels, EFFORT_DISPLAY, type EffortLevel } from "../session";
import { codexSession } from "../codex-session";
import {
  ALLOWED_USERS,
  CODEX_AVAILABLE,
  CODEX_CLI_AVAILABLE,
  CODEX_USER_ENABLED,
  WORKING_DIR,
} from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import {
  StreamingState,
  createStatusCallback,
  isAskUserPromptMessage,
  checkPendingPinoLogsRequests,
} from "./streaming";
import { isAnyDriverRunning, runMessageWithActiveDriver, stopActiveDriverQuery } from "./driver-routing";
import { escapeHtml, convertMarkdownToHtml } from "../formatting";
import { removeJob } from "../cron";
import {
  buildSessionOverviewLines,
  chunkText,
  resetAllDriverSessions,
  readClaudeStateSummary,
  readClaudeBacklogItems,
  formatBacklogSummary,
} from "./commands";
import { streamLog } from "../logger";

const SAFE_CALLBACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_CALLBACK_OPTION_INDEX = /^\d+$/;
const PINOLOG_LEVELS = new Set(["info", "warn", "error"]);
const callbackLog = streamLog.child({ handler: "callback" });

function isSafeCallbackId(value: string): boolean {
  if (!SAFE_CALLBACK_ID.test(value)) {
    return false;
  }
  // Prevent path traversal-like values while allowing dotted SubTurtle names.
  if (value.includes("..") || value.startsWith(".")) {
    return false;
  }
  return true;
}

function codexUnavailableCallbackText(): string {
  if (!CODEX_USER_ENABLED) {
    return "Codex disabled in config";
  }
  if (!CODEX_CLI_AVAILABLE) {
    return "Codex CLI unavailable";
  }
  return "Codex unavailable";
}

function formatSessionPreview(preview?: string): string | null {
  if (!preview) return null;
  const trimmed = preview.trim();
  if (!trimmed) return null;
  const lines = trimmed.split("\n").slice(0, 4);
  const joined = lines.join("\n");
  return joined.length > 350 ? `${joined.slice(0, 347)}...` : joined;
}

/**
 * Format recentMessages array into a readable Telegram message.
 * Shows the last few conversation turns with role labels.
 */
function formatRecentMessages(messages?: import("../types").RecentMessage[]): string | null {
  if (!messages || messages.length === 0) return null;

  // Show last 5 user messages to give context for what this session was about
  const userMessages = messages.filter((m) => m.role === "user").slice(-5);
  if (userMessages.length === 0) return null;

  const lines: string[] = [];
  for (const msg of userMessages) {
    // Truncate long messages for display
    const displayText = msg.text.length > 200
      ? msg.text.slice(0, 197) + "..."
      : msg.text;
    lines.push(`👤 ${displayText}`);
  }

  return lines.join("\n");
}

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle model selection: model:{model_id}
  if (callbackData.startsWith("model:")) {
    const modelId = callbackData.replace("model:", "");
    const models = getAvailableModels();
    const model = models.find((m) => m.value === modelId);
    if (model) {
      session.model = modelId;
      // Reset effort to high if switching to Haiku (no effort support)
      if (modelId.includes("haiku")) {
        session.effort = "high";
      }
      const effortStr = modelId.includes("haiku") ? "" : ` | ${EFFORT_DISPLAY[session.effort]} effort`;
      await ctx.editMessageText(`<b>Model:</b> ${model.displayName}${effortStr}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery({ text: `Switched to ${model.displayName}` });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown model" });
    }
    return;
  }

  // 3. Handle effort selection: effort:{level}
  if (callbackData.startsWith("effort:")) {
    const effort = callbackData.replace("effort:", "") as EffortLevel;
    if (effort in EFFORT_DISPLAY) {
      session.effort = effort;
      const models = getAvailableModels();
      const model = models.find((m) => m.value === session.model);
      const modelName = model?.displayName || session.model;
      await ctx.editMessageText(`<b>Model:</b> ${modelName} | ${EFFORT_DISPLAY[effort]} effort`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery({ text: `Effort set to ${EFFORT_DISPLAY[effort]}` });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown effort level" });
    }
    return;
  }

  if (callbackData === "switch:codex_unavailable") {
    await ctx.answerCallbackQuery({ text: codexUnavailableCallbackText(), show_alert: true });
    return;
  }

  // 3b. Handle Codex model selection: codex_model:{model_id}
  if (callbackData.startsWith("codex_model:")) {
    if (!CODEX_AVAILABLE) {
      await ctx.answerCallbackQuery({ text: codexUnavailableCallbackText(), show_alert: true });
      return;
    }
    const { getAvailableCodexModelsLive } = await import("../codex-session");
    const modelId = callbackData.replace("codex_model:", "");
    const models = await getAvailableCodexModelsLive();
    const model = models.find((m) => m.value === modelId);

    if (model) {
      const hadActiveSession = codexSession.isActive;
      codexSession.model = modelId;

      // Codex model is thread-level. Start a fresh thread so selection applies immediately.
      if (hadActiveSession) {
        try {
          await codexSession.startNewThread(codexSession.model, codexSession.reasoningEffort);
        } catch (error) {
          await ctx.answerCallbackQuery({ text: `Failed to apply model: ${String(error).slice(0, 50)}` });
          return;
        }
      }

      await ctx.editMessageText(`<b>Codex Model:</b> ${model.displayName}\n<b>Reasoning Effort:</b> ${codexSession.reasoningEffort}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery({
        text: hadActiveSession
          ? `Codex model set to ${model.displayName} (new thread)`
          : `Codex model set to ${model.displayName}`,
      });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown Codex model" });
    }
    return;
  }

  // 3c. Handle Codex effort selection: codex_effort:{level}
  if (callbackData.startsWith("codex_effort:")) {
    if (!CODEX_AVAILABLE) {
      await ctx.answerCallbackQuery({ text: codexUnavailableCallbackText(), show_alert: true });
      return;
    }
    const effort = callbackData.replace("codex_effort:", "") as any;
    const validEfforts = ["minimal", "low", "medium", "high", "xhigh"];

    if (validEfforts.includes(effort)) {
      const hadActiveSession = codexSession.isActive;
      codexSession.reasoningEffort = effort;

      // Reasoning effort is thread-level. Start a fresh thread so selection applies immediately.
      if (hadActiveSession) {
        try {
          await codexSession.startNewThread(codexSession.model, codexSession.reasoningEffort);
        } catch (error) {
          await ctx.answerCallbackQuery({ text: `Failed to apply effort: ${String(error).slice(0, 50)}` });
          return;
        }
      }

      const { getAvailableCodexModelsLive } = await import("../codex-session");
      const models = await getAvailableCodexModelsLive();
      const model = models.find((m) => m.value === codexSession.model);
      const modelName = model?.displayName || codexSession.model;
      await ctx.editMessageText(`<b>Codex Model:</b> ${modelName}\n<b>Reasoning Effort:</b> ${effort}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery({
        text: hadActiveSession
          ? `Codex reasoning effort set to ${effort} (new thread)`
          : `Codex reasoning effort set to ${effort}`,
      });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown effort level" });
    }
    return;
  }

  // 4. Handle driver selection: switch:{driver}
  if (callbackData.startsWith("switch:")) {
    const driver = callbackData.replace("switch:", "") as "claude" | "codex";
    if (driver === "claude") {
      await resetAllDriverSessions({ stopRunning: true });
      session.activeDriver = "claude";
      const lines = await buildSessionOverviewLines("Switched to Claude Code 🔵");
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML" });
      await ctx.answerCallbackQuery({ text: "Switched to Claude Code" });
    } else if (driver === "codex") {
      if (!CODEX_AVAILABLE) {
        await ctx.answerCallbackQuery({ text: codexUnavailableCallbackText(), show_alert: true });
        return;
      }
      try {
        await resetAllDriverSessions({ stopRunning: true });
        await codexSession.startNewThread();
        session.activeDriver = "codex";
        const lines = await buildSessionOverviewLines("Switched to Codex 🟢");
        await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML" });
        await ctx.answerCallbackQuery({ text: "Switched to Codex" });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: `Codex error: ${String(error).slice(0, 50)}` });
      }
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown driver" });
    }
    return;
  }

  // 5. Handle subturtle logs callbacks: subturtle_logs:{name}
  if (callbackData.startsWith("subturtle_logs:")) {
    await handleSubturtleLogsCallback(ctx, callbackData);
    return;
  }

  // 5. Handle subturtle stop callbacks: subturtle_stop:{name}
  if (callbackData.startsWith("subturtle_stop:")) {
    await handleSubturtleStopCallback(ctx, callbackData);
    return;
  }

  // 6. Handle cron cancel callbacks: cron_cancel:{job_id}
  if (callbackData.startsWith("cron_cancel:")) {
    await handleCronCancelCallback(ctx, callbackData);
    return;
  }

  // 7. Handle current-session resume callback.
  if (callbackData === "resume_current") {
    await handleResumeCurrentCallback(ctx);
    return;
  }

  // 7a. Handle resume callbacks: resume:{session_id}
  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // 7b. Handle Codex resume callbacks: codex_resume:{session_id}
  if (callbackData.startsWith("codex_resume:")) {
    await handleCodexResumeCallback(ctx, callbackData);
    return;
  }

  // 7c. Handle pinologs callbacks: pinologs:{level}
  if (callbackData.startsWith("pinologs:")) {
    await handlePinologsCallback(ctx, callbackData);
    return;
  }

  // 8. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndexRaw = parts[2]!;
  if (!isSafeCallbackId(requestId)) {
    await ctx.answerCallbackQuery({ text: "Invalid request ID" });
    return;
  }
  if (!SAFE_CALLBACK_OPTION_INDEX.test(optionIndexRaw)) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }
  const optionIndex = Number.parseInt(optionIndexRaw, 10);

  // 9. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    callbackLog.error({ err: error, requestId, userId, chatId }, "Failed to load ask-user request");
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 10. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 11. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 12. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 13. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 14. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (isAnyDriverRunning()) {
    callbackLog.info({ requestId, userId, chatId }, "Interrupting current query for button response");
    await stopActiveDriverQuery();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);
  session.typingController = typing;

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await runMessageWithActiveDriver({
      message,
      username,
      userId,
      chatId,
      ctx,
      statusCallback,
    });

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    callbackLog.error({ err: error, callbackData, userId, chatId }, "Error processing callback");

    for (const toolMsg of state.toolMessages) {
      if (isAskUserPromptMessage(toolMsg)) continue;
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

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
    typing.stop();
    session.typingController = null;
  }
}

/**
 * Handle subturtle state callback (subturtle_logs:{name}).
 */
async function handleSubturtleLogsCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const name = callbackData.replace("subturtle_logs:", "");

  if (!name || !isSafeCallbackId(name)) {
    await ctx.answerCallbackQuery({ text: "Invalid SubTurtle name" });
    return;
  }

  try {
    const turtleStatePath = `${WORKING_DIR}/.subturtles/${name}/CLAUDE.md`;
    const [turtleSummary, turtleBacklog] = await Promise.all([
      readClaudeStateSummary(turtleStatePath),
      readClaudeBacklogItems(turtleStatePath),
    ]);

    if (!turtleSummary) {
      await ctx.answerCallbackQuery({ text: "State file not found" });
      return;
    }

    const lines: string[] = [`📋 <b>State for ${escapeHtml(name)}</b>\n`];
    const turtleTask = turtleSummary.currentTask || "No current task in CLAUDE.md";
    lines.push(`🧩 <b>Task:</b> ${convertMarkdownToHtml(turtleTask)}`);
    if (turtleBacklog.length === 0) {
      lines.push(`📌 <b>Backlog:</b> ${convertMarkdownToHtml(formatBacklogSummary(turtleSummary))}`);
    } else {
      lines.push(`📌 <b>Backlog:</b>`);
      for (const item of turtleBacklog) {
        const status = item.done ? "✅" : "⬜";
        const currentTag = item.current ? " ← current" : "";
        lines.push(`${status} ${convertMarkdownToHtml(item.text)}${currentTag}`);
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery({ text: `State for ${name}` });
  } catch (error) {
    callbackLog.error({ err: error, name, chatId: ctx.chat?.id }, "Failed to read SubTurtle state");
    await ctx.answerCallbackQuery({ text: "Failed to read state" });
  }
}

/**
 * Handle subturtle stop callback (subturtle_stop:{name}).
 */
async function handleSubturtleStopCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const name = callbackData.replace("subturtle_stop:", "");

  if (!name || !isSafeCallbackId(name)) {
    await ctx.answerCallbackQuery({ text: "Invalid SubTurtle name" });
    return;
  }

  try {
    const ctlPath = `${WORKING_DIR}/super_turtle/subturtle/ctl`;
    const proc = Bun.spawnSync([ctlPath, "stop", name], { cwd: WORKING_DIR });
    const output = proc.stdout.toString();

    // Check if the output indicates success
    const isSuccess = output.includes("stopped") || output.includes("killing");

    if (isSuccess) {
      await ctx.editMessageText(`✅ <b>${escapeHtml(name)}</b> stopped`, {
        parse_mode: "HTML",
      });
      await ctx.answerCallbackQuery({ text: `${name} stopped` });
    } else {
      await ctx.answerCallbackQuery({ text: `Failed to stop ${name}` });
    }
  } catch (error) {
    callbackLog.error({ err: error, name, chatId: ctx.chat?.id }, "Failed to stop SubTurtle");
    await ctx.answerCallbackQuery({ text: "Failed to stop SubTurtle" });
  }
}

/**
 * Handle resume current session callback (resume_current).
 */
async function handleResumeCurrentCallback(ctx: Context): Promise<void> {
  if (session.activeDriver === "codex") {
    if (!CODEX_AVAILABLE) {
      await ctx.answerCallbackQuery({ text: codexUnavailableCallbackText(), show_alert: true });
      return;
    }

    const currentThreadId = codexSession.getThreadId();
    if (!currentThreadId) {
      await ctx.answerCallbackQuery({ text: "No active Codex session", show_alert: true });
      return;
    }

    try {
      await ctx.editMessageText("✅ Continuing current Codex session.");
    } catch (error) {
      console.debug("Failed to edit resume_current message:", error);
    }
    await ctx.answerCallbackQuery({ text: "Continuing current Codex session" });

    const recentPreview = formatRecentMessages(codexSession.recentMessages);
    if (recentPreview) {
      await ctx.reply(`📝 **Last messages:**\n\n${recentPreview}`);
    } else {
      await ctx.reply("ℹ️ Current Codex session is already linked. Send a message to continue.");
    }
    return;
  }

  const currentSessionId = session.sessionId;
  if (!currentSessionId) {
    await ctx.answerCallbackQuery({ text: "No active Claude session", show_alert: true });
    return;
  }

  try {
    await ctx.editMessageText("✅ Continuing current Claude session.");
  } catch (error) {
    console.debug("Failed to edit resume_current message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Continuing current Claude session" });

  const recentPreview = formatRecentMessages(session.recentMessages);
  if (recentPreview) {
    await ctx.reply(`📝 **Last messages:**\n\n${recentPreview}`);
  } else {
    await ctx.reply("ℹ️ Current Claude session is already linked. Send a message to continue.");
  }
}

/**
 * Handle resume session callback (resume:{session_id}).
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid session ID" });
    return;
  }

  if (isAnyDriverRunning()) {
    await stopActiveDriverQuery();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Resume the selected session
  const [success, message] = session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection
  try {
    await ctx.editMessageText(`✅ ${message}`);
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Session resumed!" });
  session.activeDriver = "claude";

  const sessionEntry = session.getSessionList().find((s) => s.session_id === sessionId);
  // Prefer in-memory buffer (current bot session) over persisted data
  const inMemoryMessages = session.recentMessages.length > 0
    ? session.recentMessages
    : undefined;
  const recentPreview = formatRecentMessages(
    inMemoryMessages || sessionEntry?.recentMessages
  );
  const legacyPreview = formatSessionPreview(sessionEntry?.preview);
  const displayPreview = recentPreview || legacyPreview;

  if (displayPreview) {
    await ctx.reply(`📝 **Last messages:**\n\n${displayPreview}`);
  } else {
    await ctx.reply("ℹ️ Session resumed. Send a message to continue.");
  }
}

/**
 * Handle Codex resume session callback (codex_resume:{session_id}).
 */
async function handleCodexResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  if (!CODEX_AVAILABLE) {
    await ctx.answerCallbackQuery({ text: codexUnavailableCallbackText(), show_alert: true });
    return;
  }

  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("codex_resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid session ID" });
    return;
  }

  if (isAnyDriverRunning()) {
    await stopActiveDriverQuery();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Resume the selected Codex session
  const [success, message] = await codexSession.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection
  try {
    await ctx.editMessageText(`✅ ${message}`);
  } catch (error) {
    console.debug("Failed to edit Codex resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Codex session resumed!" });
  session.activeDriver = "codex";

  // Check both local (has recentMessages) and live (has preview) — prefer local for richer context
  const localSessions = codexSession.getSessionList();
  const localMatch = localSessions.find((s) => s.session_id === sessionId);
  const liveSessions = await codexSession.getSessionListLive();
  const liveMatch = liveSessions.find((s) => s.session_id === sessionId);
  // Also check the in-memory buffer directly (populated during this bot session)
  const inMemoryMessages = codexSession.recentMessages.length > 0
    ? codexSession.recentMessages
    : undefined;
  const recentPreview = formatRecentMessages(
    inMemoryMessages || localMatch?.recentMessages || liveMatch?.recentMessages
  );
  const legacyPreview = formatSessionPreview(localMatch?.preview || liveMatch?.preview);
  const displayPreview = recentPreview || legacyPreview;

  if (displayPreview) {
    await ctx.reply(`📝 **Last messages:**\n\n${displayPreview}`);
  } else {
    await ctx.reply("ℹ️ Codex session resumed. Send a message to continue.");
  }
}

/**
 * Handle pino logs callback (pinologs:{level}).
 */
async function handlePinologsCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const chatId = ctx.chat?.id;
  const level = callbackData.replace("pinologs:", "").trim().toLowerCase();

  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid chat" });
    return;
  }

  if (!PINOLOG_LEVELS.has(level)) {
    await ctx.answerCallbackQuery({ text: "Invalid log level" });
    return;
  }

  const requestId = `pinologs-callback-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const requestFile = `/tmp/pino-logs-${requestId}.json`;

  try {
    await ctx.answerCallbackQuery({ text: `Fetching ${level} logs...` });
    await Bun.write(
      requestFile,
      JSON.stringify(
        {
          request_id: requestId,
          level,
          limit: 50,
          status: "pending",
          chat_id: String(chatId),
          created_at: new Date().toISOString(),
        },
        null,
        2
      )
    );

    let response: { status?: string; result?: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await checkPendingPinoLogsRequests(chatId);
      const responseText = await Bun.file(requestFile).text();
      const parsed = JSON.parse(responseText) as {
        status?: string;
        result?: string;
      };
      if (parsed.status === "completed") {
        response = parsed;
        break;
      }
      if (attempt < 2) {
        await Bun.sleep(100);
      }
    }

    if (!response || response.status !== "completed") {
      throw new Error("Pino logs request was not completed");
    }

    const payload = (response.result || "").trim() || "No matching log entries.";
    for (const chunk of chunkText(payload)) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    callbackLog.error({ err: error, callbackData, chatId }, "Failed to fetch pino logs");
    await ctx.reply("❌ Failed to fetch logs. Please try again.");
  } finally {
    try {
      unlinkSync(requestFile);
    } catch {
      // Best-effort cleanup for transient request files.
    }
  }
}

/**
 * Handle cron cancel callback (cron_cancel:{job_id}).
 */
async function handleCronCancelCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const jobId = callbackData.replace("cron_cancel:", "");

  if (!jobId) {
    await ctx.answerCallbackQuery({ text: "Invalid job ID" });
    return;
  }

  // Remove the job
  const success = removeJob(jobId);

  if (success) {
    // Update the message to show cancellation
    try {
      await ctx.editMessageText(`✅ Job cancelled`);
    } catch (error) {
      console.debug("Failed to edit callback message:", error);
    }
    await ctx.answerCallbackQuery({ text: "Job cancelled" });
  } else {
    await ctx.answerCallbackQuery({ text: "Job not found or already removed" });
  }
}
