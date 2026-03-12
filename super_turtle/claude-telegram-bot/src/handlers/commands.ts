/**
 * Command handlers for Claude Telegram Bot.
 */

import { InlineKeyboard, type Context } from "grammy";
import { session, getAvailableModels, EFFORT_DISPLAY, type EffortLevel } from "../session";
import { codexSession } from "../codex-session";
import {
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
  TELEGRAM_SAFE_LIMIT,
  BUTTON_LABEL_MAX_LENGTH,
  CODEX_AVAILABLE,
  CODEX_CLI_AVAILABLE,
  CODEX_ENABLED,
  CODEX_USER_ENABLED,
  IS_MACOS,
  IS_LINUX,
  CTL_PATH,
  BOT_DIR,
  TOKEN_PREFIX,
  DEFAULT_CODEX_EFFORT,
  getCodexUnavailableReason,
} from "../config";
import { getContextReport } from "../context-command";
import { isAuthorized } from "../security";
import { escapeHtml, convertMarkdownToHtml } from "../formatting";
import { getJobs } from "../cron";
import { isAnyDriverRunning, isBackgroundRunActive, wasBackgroundRunPreempted, stopActiveDriverQuery } from "./driver-routing";
import { handleStop } from "./stop";
import { clearPreparedSnapshots, getPreparedSnapshotCount } from "../cron-supervision-queue";
import { getAllDeferredQueues } from "../deferred-queue";
import { cmdLog } from "../logger";
import type { BotCommand } from "grammy/types";

// Canonical main-loop log written by live.sh (tmux + caffeinate + run-loop).
export const MAIN_LOOP_LOG_PATH = `/tmp/claude-telegram-${TOKEN_PREFIX}-bot-ts.log`;
const LEGACY_MAIN_LOOP_LOG_PATH = "/tmp/claude-telegram-bot-ts.log";
const TELEPORT_SCRIPT_PATH = `${WORKING_DIR}/super_turtle/scripts/teleport-manual.sh`;
const LOOPLOGS_LINE_COUNT = 50;
const RESUME_SESSIONS_LIMIT = 5;
const CLAUDE_USAGE_RATE_LIMIT_MESSAGE =
  "Claude usage is temporarily unavailable due to Anthropic service limits. This comes from Anthropic's usage endpoint, not from Super Turtle.";

export const TELEGRAM_COMMANDS: readonly BotCommand[] = [
  { command: "new", description: "Start a fresh session" },
  { command: "stop", description: "Stop current work" },
  { command: "teleport", description: "Teleport to managed VM" },
  { command: "model", description: "Switch model or effort" },
  { command: "switch", description: "Switch between Claude and Codex" },
  { command: "usage", description: "Show subscription usage" },
  { command: "context", description: "Show context usage" },
  { command: "status", description: "Show detailed status" },
  { command: "looplogs", description: "Show main loop logs" },
  { command: "pinologs", description: "Show Pino logs" },
  { command: "resume", description: "Resume a past session" },
  { command: "sub", description: "Manage SubTurtles" },
  { command: "cron", description: "Show scheduled jobs" },
  { command: "debug", description: "Show debug state" },
  { command: "restart", description: "Restart the bot" },
] as const;

/**
 * Shared command list for display in /new and /status, and new_session bot-control.
 */
export function getCommandLines(): string[] {
  const switchLine = CODEX_AVAILABLE
    ? `/switch - Claude ↔ Codex`
    : `/switch - Driver controls (Codex unavailable)`;
  return [
    `/new - Fresh session`,
    `/stop - Stop current work`,
    `/teleport - Move to managed VM`,
    `/model - Switch model/effort`,
    switchLine,
    `/usage - Subscription usage`,
    `/context - Context usage`,
    `/status - Detailed status`,
    `/looplogs - Main loop logs`,
    `/pinologs - Pino logs`,
    `/resume - Resume a session`,
    `/sub - SubTurtles`,
    `/cron - Scheduled jobs`,
  ];
}

/**
 * /stop command — explicit slash command to stop current foreground work.
 * Same behavior as typing "stop" or saying "stop" via voice.
 */
export async function handleStopCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  await handleStop(ctx, chatId);
}

type TeleportCommandOptions = {
  dryRun: boolean;
};

function parseTeleportCommandOptions(text: string | undefined): TeleportCommandOptions | null {
  const args = text?.split(/\s+/).slice(1).filter(Boolean) || [];
  let dryRun = false;

  for (const arg of args) {
    const normalized = arg.trim().toLowerCase();
    if (normalized === "managed" || normalized === "--managed") {
      continue;
    }
    if (normalized === "dry-run" || normalized === "--dry-run") {
      dryRun = true;
      continue;
    }
    return null;
  }

  return { dryRun };
}

function countDeferredQueueItems(): number {
  return Array.from(getAllDeferredQueues().values()).reduce(
    (count, queue) => count + queue.length,
    0
  );
}

export async function handleTeleportCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const options = parseTeleportCommandOptions(ctx.message?.text);
  if (!options) {
    await ctx.reply("❌ Usage: /teleport [managed] [dry-run]");
    return;
  }

  if (isBackgroundRunActive() || isAnyDriverRunning()) {
    await ctx.reply("❌ Teleport requires the bot to be idle. Stop the current run and retry.");
    return;
  }

  const queuedItems = countDeferredQueueItems();
  if (queuedItems > 0) {
    await ctx.reply(
      `❌ Teleport requires an empty queue. Clear ${queuedItems} queued item${queuedItems === 1 ? "" : "s"} and retry.`
    );
    return;
  }

  try {
    const child = Bun.spawn(
      [
        "bash",
        TELEPORT_SCRIPT_PATH,
        "--managed",
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
      {
        cwd: WORKING_DIR,
        env: {
          ...process.env,
          SUPER_TURTLE_PROJECT_DIR: WORKING_DIR,
          CLAUDE_WORKING_DIR: WORKING_DIR,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      }
    );
    child.unref();
  } catch (error) {
    cmdLog.error({ err: error }, "Failed to launch managed teleport");
    await ctx.reply(
      `❌ Failed to launch teleport: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`
    );
    return;
  }

  await ctx.reply(
    options.dryRun
      ? "🛰️ Starting managed teleport dry-run in the background."
      : "🛰️ Starting managed teleport to the linked SuperTurtle VM."
  );
}

function getCodexUnavailableMessage(): string {
  const reason = getCodexUnavailableReason();
  if (!reason) return "❌ Codex is unavailable.";
  if (!CODEX_USER_ENABLED) {
    return (
      `❌ ${reason}\n` +
      `Run onboarding/setup and enable Codex integration to allow driver switching.`
    );
  }
  if (!CODEX_CLI_AVAILABLE) {
    return `❌ ${reason}`;
  }
  return `❌ ${reason}`;
}

/**
 * Format current model + effort as a display string (e.g. "Sonnet | ⚡ high effort").
 */
export function formatModelInfo(model: string, effort: string): { modelName: string; effortStr: string } {
  const models = getAvailableModels();
  const currentModel = models.find((m) => m.value === model);
  const modelName = currentModel?.displayName || model;
  const effortStr = model.includes("haiku") ? "" : ` | ${EFFORT_DISPLAY[effort as EffortLevel]} effort`;
  return { modelName, effortStr };
}

export function getSettingsOverviewLines(): string[] {
  const { modelName, effortStr } = formatModelInfo(session.model, session.effort);
  const isCodex = session.activeDriver === "codex";
  const driverLabel = isCodex ? "Codex 🟢" : "Claude 🔵";
  const activeModelLine = isCodex
    ? `${escapeHtml(codexSession.model)} | ${escapeHtml(codexSession.reasoningEffort)}`
    : `${modelName}${effortStr}`;

  return [
    `${driverLabel} · ${activeModelLine}`,
  ];
}

export async function buildSessionOverviewLines(title: string): Promise<string[]> {
  const lines: string[] = [`<b>${title}</b>\n`, ...getSettingsOverviewLines(), ""];
  const [usageLines, codexQuotaLines] = await Promise.all([
    getUsageLines(),
    CODEX_ENABLED ? getCodexQuotaLines() : Promise.resolve<string[]>([]),
  ]);
  lines.push(formatUnifiedUsage(usageLines, codexQuotaLines, CODEX_ENABLED), "");
  lines.push(`<b>Commands:</b>`, ...getCommandLines());
  return lines;
}

export type ListedSubTurtle = {
  name: string;
  status: string;
  type: string;
  pid: string;
  timeRemaining: string;
  task: string;
  tunnelUrl: string;
};

export type ClaudeStateSummary = {
  currentTask: string;
  backlogDone: number;
  backlogTotal: number;
  backlogCurrent: string;
};

export type ClaudeBacklogItem = {
  text: string;
  done: boolean;
  current: boolean;
};

function extractMarkdownSection(content: string, headingPattern: string): string {
  const headingRegex = new RegExp(`^#{1,6}\\s*${headingPattern}\\s*$`, "im");
  const headingMatch = headingRegex.exec(content);
  if (!headingMatch) return "";

  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = /\n#{1,6}\s+/.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
  return section.trim();
}

function sanitizeTaskLine(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*\d+\.\s*/, "")
    .replace(/\s*<-\s*current\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

export function parseClaudeBacklogItems(content: string): ClaudeBacklogItem[] {
  const backlogSection = extractMarkdownSection(content, "Backlog");
  if (!backlogSection) return [];

  return backlogSection
    .split("\n")
    .map((line) => line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const rawText = match[2] || "";
      const text = sanitizeTaskLine(rawText);
      return {
        text,
        done: match[1]?.toLowerCase() === "x",
        current: /<-\s*current/i.test(rawText),
      };
    })
    .filter((item) => item.text.length > 0);
}

export function parseClaudeStateSummary(content: string): ClaudeStateSummary {
  const currentTaskSection = extractMarkdownSection(content, "Current\\s+Task");
  const currentTask = currentTaskSection
    .split("\n")
    .map((line) => sanitizeTaskLine(line))
    .find((line) => line.length > 0) || "";

  const backlogItems = parseClaudeBacklogItems(content);

  const currentBacklogItem =
    backlogItems.find((item) => item.current && !item.done)?.text ||
    backlogItems.find((item) => item.current)?.text ||
    backlogItems.find((item) => !item.done)?.text ||
    "";

  return {
    currentTask,
    backlogDone: backlogItems.filter((item) => item.done).length,
    backlogTotal: backlogItems.length,
    backlogCurrent: currentBacklogItem,
  };
}

export async function readClaudeStateSummary(path: string): Promise<ClaudeStateSummary | null> {
  try {
    const content = await Bun.file(path).text();
    return parseClaudeStateSummary(content);
  } catch {
    return null;
  }
}

export async function readClaudeBacklogItems(path: string): Promise<ClaudeBacklogItem[]> {
  try {
    const content = await Bun.file(path).text();
    return parseClaudeBacklogItems(content);
  } catch {
    return [];
  }
}

export function formatBacklogSummary(summary: ClaudeStateSummary): string {
  if (summary.backlogTotal === 0) {
    return "No backlog checklist";
  }

  const progress = `${summary.backlogDone}/${summary.backlogTotal} done`;
  if (!summary.backlogCurrent) return progress;
  return `${progress} • Current: ${summary.backlogCurrent}`;
}

export function parseCtlListOutput(output: string): ListedSubTurtle[] {
  const turtles: ListedSubTurtle[] = [];
  let lastTurtle: ListedSubTurtle | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "No SubTurtles found.") continue;

    // Skip optional table headers/separators from `ctl list`.
    if (/^(name|subturtle)\s+status\b/i.test(line) || /^[-|:\s]+$/.test(line)) {
      continue;
    }
    if (line.startsWith("|") && /status/i.test(line)) {
      continue;
    }

    // Tunnel lines are emitted as: "→ https://..."
    if (line.startsWith("→")) {
      if (lastTurtle) {
        lastTurtle.tunnelUrl = line.replace(/^→\s*/, "");
      }
      continue;
    }

    const baseMatch = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
    if (!baseMatch) continue;

    const name = baseMatch[1] ?? "";
    const status = baseMatch[2] ?? "";
    let remainder = baseMatch[3] ?? "";
    let type = "";
    let pid = "";
    let timeRemaining = "";

    if (status === "running") {
      const typeMatch = remainder.match(/^(yolo-codex-spark|yolo-codex|slow|yolo)\b\s*(.*)$/);
      if (typeMatch) {
        type = typeMatch[1]!;
        remainder = typeMatch[2] || "";
      }

      const pidMatch = remainder.match(/^\(PID\s+(\d+)\)\s*(.*)$/);
      if (pidMatch) {
        pid = pidMatch[1]!;
        remainder = pidMatch[2] || "";
      }

      const overdueMatch = remainder.match(/^OVERDUE\b\s*(.*)$/);
      if (overdueMatch) {
        timeRemaining = "OVERDUE";
        remainder = overdueMatch[1] || "";
      } else {
        const noTimeoutMatch = remainder.match(/^no timeout\b\s*(.*)$/);
        if (noTimeoutMatch) {
          timeRemaining = "no timeout";
          remainder = noTimeoutMatch[1] || "";
        } else {
          const leftMatch = remainder.match(/^(.+?)\s+left\b\s*(.*)$/);
          if (leftMatch) {
            timeRemaining = leftMatch[1]!.trim();
            remainder = leftMatch[2] || "";
          }
        }
      }
    }

    const task = remainder.replace(/\s+\[skills:\s+.*\]$/, "").trim();
    const turtle: ListedSubTurtle = {
      name,
      status,
      type,
      pid,
      timeRemaining,
      task,
      tunnelUrl: "",
    };
    turtles.push(turtle);
    lastTurtle = turtle;
  }

  return turtles;
}

export async function getSubTurtleElapsed(name: string): Promise<string> {
  try {
    const metaPath = `${WORKING_DIR}/.subturtles/${name}/subturtle.meta`;
    const metaText = await Bun.file(metaPath).text();
    const spawnedAtMatch = metaText.match(/^SPAWNED_AT=(\d+)$/m);
    if (!spawnedAtMatch?.[1]) return "unknown";

    const spawnedAt = Number.parseInt(spawnedAtMatch[1], 10);
    if (!Number.isFinite(spawnedAt)) return "unknown";
    const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000) - spawnedAt);

    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  } catch {
    return "unknown";
  }
}

/**
 * /new - Start a fresh session with model info and usage.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await resetAllDriverSessions({ stopRunning: true });

  const lines = await buildSessionOverviewLines("New session");

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export async function resetAllDriverSessions(opts?: { stopRunning?: boolean }): Promise<void> {
  if (opts?.stopRunning) {
    session.stopTyping();
    if (isAnyDriverRunning()) {
      const result = await stopActiveDriverQuery();
      if (result) {
        await Bun.sleep(100);
        session.clearStopRequested();
      }
    }
  }

  await session.kill();
  await codexSession.kill();
  clearPreparedSnapshots();
}


/**
 * /status - Show status. Same screen as /new but without resetting sessions.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines = await buildSessionOverviewLines("Status");

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /looplogs - Show last 50 lines from the main run-loop log.
 */
export async function handleLooplogs(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const result = readMainLoopLogTail();
  if (!result.ok) {
    const reason = truncateText(result.error, 160);
    const tried = result.triedPaths.length > 1
      ? `\nTried: ${result.triedPaths.join(", ")}`
      : "";
    await ctx.reply(
      `❌ Cannot read main loop log at ${result.path}. ` +
        `Start the bot with 'bun run start' and retry.\n${reason}${tried}`
    );
    return;
  }

  if (!result.text) {
    await ctx.reply(`ℹ️ Main loop log is empty: ${result.path}`);
    return;
  }

  for (const chunk of chunkText(result.text)) {
    await ctx.reply(chunk);
  }
}

/**
 * /pinologs - Show inline options for selecting Pino log level.
 */
export async function handlePinologs(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const keyboard = new InlineKeyboard()
    .text("Info", "pinologs:info")
    .text("Warning", "pinologs:warn")
    .text("Errors", "pinologs:error");

  await ctx.reply("Select log level:", { reply_markup: keyboard });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 * Routes to Claude or Codex based on activeDriver.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.activeDriver === "codex" && !CODEX_AVAILABLE) {
    session.activeDriver = "claude";
    await ctx.reply(`${getCodexUnavailableMessage()}\nFalling back to Claude sessions.`);
  }

  const formatResumeButtonLabel = (
    driverEmoji: "🔵" | "🟢",
    savedAt: string,
    title: string
  ): string => {
    const date = new Date(savedAt);
    const dateStr = Number.isNaN(date.getTime())
      ? "-.- --:--"
      : `${date.getDate()}.${date.getMonth() + 1} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const rawTitle = title.trim() || "Untitled";
    const base = `${driverEmoji} ${dateStr} ${rawTitle}`;
    if (base.length <= BUTTON_LABEL_MAX_LENGTH) return base;
    return `${base.slice(0, Math.max(1, BUTTON_LABEL_MAX_LENGTH - 1)).trimEnd()}…`;
  };
  type ResumeOption = {
    session_id: string;
    saved_at: string;
    working_dir: string;
    title: string;
    driverEmoji: "🔵" | "🟢";
    callbackData: string;
  };

  // Gather both drivers so users can switch contexts without using /switch first.
  let claudeSessions: Array<{
    session_id: string;
    saved_at: string;
    working_dir: string;
    title: string;
  }> = session.getSessionList();
  let codexSessions: Array<{
    session_id: string;
    saved_at: string;
    working_dir: string;
    title: string;
  }> = [];

  if (CODEX_AVAILABLE) {
    codexSessions = await codexSession.getSessionListLive(RESUME_SESSIONS_LIMIT);
    if (codexSessions.length === 0) {
      codexSessions = codexSession.getSessionList();
    }
  }

  // Hide only the active driver's current session from the picker.
  // Inactive-driver sessions should remain selectable so users can switch back.
  const currentClaudeSessionId = session.sessionId;
  const currentCodexSessionId = codexSession.getThreadId();
  if (session.activeDriver === "claude" && currentClaudeSessionId) {
    claudeSessions = claudeSessions.filter((s) => s.session_id !== currentClaudeSessionId);
  }
  if (session.activeDriver === "codex" && currentCodexSessionId) {
    codexSessions = codexSessions.filter((s) => s.session_id !== currentCodexSessionId);
  }

  // Keep lists short for Telegram and quick scanning.
  const byNewest = (a: { saved_at: string }, b: { saved_at: string }) =>
    (Date.parse(b.saved_at || "") || 0) - (Date.parse(a.saved_at || "") || 0);
  claudeSessions = claudeSessions.sort(byNewest).slice(0, RESUME_SESSIONS_LIMIT);
  codexSessions = codexSessions.sort(byNewest).slice(0, RESUME_SESSIONS_LIMIT);

  const hasCurrentSession =
    (session.activeDriver === "claude" && Boolean(session.sessionId)) ||
    (session.activeDriver === "codex" && Boolean(codexSession.getThreadId()));

  if (!hasCurrentSession && claudeSessions.length === 0 && codexSessions.length === 0) {
    await ctx.reply("❌ No saved sessions.");
    return;
  }

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  if (hasCurrentSession) {
    const currentDriverName = session.activeDriver === "codex" ? "Codex 🟢" : "Claude 🔵";
    buttons.push([
      {
        text: `▶ Continue current (${currentDriverName})`,
        callback_data: "resume_current",
      },
    ]);
  }

  const mergedSessions: ResumeOption[] = [
    ...claudeSessions.map((s) => ({
      ...s,
      driverEmoji: "🔵" as const,
      callbackData: `resume:${s.session_id}`,
    })),
    ...codexSessions.map((s) => ({
      ...s,
      driverEmoji: "🟢" as const,
      callbackData: `codex_resume:${s.session_id}`,
    })),
  ]
    .sort((a, b) => byNewest(a, b));

  for (const s of mergedSessions) {
    buttons.push([
      {
        text: formatResumeButtonLabel(s.driverEmoji, s.saved_at, s.title),
        callback_data: s.callbackData,
      },
    ]);
  }

  if (buttons.length === 0) {
    await ctx.reply(
      "ℹ️ No other saved sessions to resume. You're already linked to the latest one. Send a message to continue, or use /new for a fresh session."
    );
    return;
  }

  await ctx.reply("📋 <b>Resume Session</b>\n\n🔵 Claude + 🟢 Codex\nSelect a session to continue:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /model - Show current model and let user switch model/effort.
 * Routes to Claude or Codex model selection based on activeDriver.
 */
export async function handleModel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.activeDriver === "codex" && !CODEX_AVAILABLE) {
    session.activeDriver = "claude";
    await ctx.reply(`${getCodexUnavailableMessage()}\nUsing Claude model controls.`);
  }

  // Route based on active driver
  if (session.activeDriver === "codex") {
    return handleCodexModel(ctx);
  }

  const picker = buildClaudeModelPickerMessage();
  await ctx.reply(picker.text, {
    parse_mode: "HTML",
    reply_markup: picker.replyMarkup,
  });
}

/**
 * Codex model selection (for /model when on Codex driver).
 */
async function handleCodexModel(ctx: Context): Promise<void> {
  if (!CODEX_AVAILABLE) {
    await ctx.reply(getCodexUnavailableMessage());
    return;
  }

  const picker = await buildCodexModelPickerMessage();
  await ctx.reply(picker.text, {
    parse_mode: "HTML",
    reply_markup: picker.replyMarkup,
  });
}

type ModelPickerButton = {
  text: string;
  callback_data: string;
};

type ModelPickerMarkup = {
  inline_keyboard: ModelPickerButton[][];
};

export function buildClaudeModelPickerMessage(): {
  text: string;
  replyMarkup: ModelPickerMarkup;
} {
  const models = getAvailableModels();
  const currentModel = models.find((m) => m.value === session.model);
  const currentEffort = EFFORT_DISPLAY[session.effort];

  const modelButtons = models.map((m) => [{
    text: `${m.value === session.model ? "✔ " : ""}${m.displayName}`,
    callback_data: `model:${m.value}`,
  }]);

  const isHaiku = session.model.includes("haiku");
  const effortButtons = isHaiku
    ? []
    : [(Object.entries(EFFORT_DISPLAY) as [EffortLevel, string][]).map(
        ([level, label]) => ({
          text: `${level === session.effort ? "✔ " : ""}${label}`,
          callback_data: `effort:${level}`,
        })
      )];

  const modelName = currentModel?.displayName || session.model;
  const modelDesc = currentModel?.description ? ` — ${currentModel.description}` : "";

  return {
    text:
      `<b>Model:</b> ${modelName}${modelDesc}\n` +
      `<b>Effort:</b> ${currentEffort}\n\n` +
      `Select model or effort level:`,
    replyMarkup: {
      inline_keyboard: [...modelButtons, ...effortButtons],
    },
  };
}

export async function buildCodexModelPickerMessage(): Promise<{
  text: string;
  replyMarkup: ModelPickerMarkup;
}> {
  const { getAvailableCodexModelsLive } = await import("../codex-session");

  const models = await getAvailableCodexModelsLive();
  const currentModel = models.find((m) => m.value === codexSession.model);
  const currentEffort = codexSession.reasoningEffort;

  const modelButtons = models.map((m) => [{
    text: `${m.value === codexSession.model ? "✔ " : ""}${m.displayName}`,
    callback_data: `codex_model:${m.value}`,
  }]);

  const effortLevels: Array<[string, string]> = [
    ["minimal", `Minimal${DEFAULT_CODEX_EFFORT === "minimal" ? " (default)" : ""}`],
    ["low", `Low${DEFAULT_CODEX_EFFORT === "low" ? " (default)" : ""}`],
    ["medium", `Medium${DEFAULT_CODEX_EFFORT === "medium" ? " (default)" : ""}`],
    ["high", `High${DEFAULT_CODEX_EFFORT === "high" ? " (default)" : ""}`],
    ["xhigh", `X-High (deepest)${DEFAULT_CODEX_EFFORT === "xhigh" ? " (default)" : ""}`],
  ];

  const effortButtons = [effortLevels.map(([level, label]) => ({
    text: `${level === currentEffort ? "✔ " : ""}${label}`,
    callback_data: `codex_effort:${level}`,
  }))];

  const modelName = currentModel?.displayName || codexSession.model;
  const modelDesc = currentModel?.description ? ` — ${currentModel.description}` : "";

  return {
    text:
      `<b>Codex Model:</b> ${modelName}${modelDesc}\n` +
      `<b>Reasoning Effort:</b> ${currentEffort}\n\n` +
      `Select model or reasoning effort:`,
    replyMarkup: {
      inline_keyboard: [...modelButtons, ...effortButtons],
    },
  };
}

/**
 * /switch - Switch between Claude Code and Codex drivers.
 */
export async function handleSwitch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Parse command: /switch codex or /switch claude
  const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
  const target = args[0]?.toLowerCase();

  if (!target) {
    // No argument — show options
    const currentDriver = session.activeDriver;
    const driverEmoji = currentDriver === "codex" ? "🟢" : "🔵";
    const codexRow = CODEX_AVAILABLE
      ? [[{
          text: `${currentDriver === "codex" ? "✔ " : ""}Codex 🟢`,
          callback_data: "switch:codex",
        }]]
      : [[{
          text: "Codex unavailable",
          callback_data: "switch:codex_unavailable",
        }]];
    await ctx.reply(`<b>Current driver:</b> ${currentDriver} ${driverEmoji}\n\nSwitch to:`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `${currentDriver === "claude" ? "✔ " : ""}Claude Code 🔵`,
              callback_data: "switch:claude",
            },
          ],
          ...codexRow,
        ],
      },
    });
    return;
  }

  // Direct switch via argument
  if (target === "claude") {
    await resetAllDriverSessions({ stopRunning: true });
    session.activeDriver = "claude";
    const lines = await buildSessionOverviewLines("Switched to Claude Code 🔵");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } else if (target === "codex") {
    if (!CODEX_AVAILABLE) {
      await ctx.reply(getCodexUnavailableMessage());
      return;
    }
    await resetAllDriverSessions({ stopRunning: true });
    try {
      // Fail fast: ensure Codex is available after reset.
      await codexSession.startNewThread();
      session.activeDriver = "codex";
    } catch (error) {
      await ctx.reply(`❌ Failed to switch to Codex: ${String(error).slice(0, 100)}`);
      return;
    }
    const lines = await buildSessionOverviewLines("Switched to Codex 🟢");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } else {
    await ctx.reply(`❌ Unknown driver: ${target}. Use /switch claude or /switch codex`);
  }
}

type JsonObj = Record<string, unknown>;

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getNestedString(obj: JsonObj, path: string[]): string | null {
  let current: unknown = obj;
  for (const part of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as JsonObj)[part];
  }
  return typeof current === "string" && current.trim().length > 0 ? current.trim() : null;
}

function extractTokenFromObject(obj: JsonObj, depth = 0): string | null {
  if (depth > 6) return null;

  const candidatePaths = [
    ["claudeAiOauth", "accessToken"],
    ["claudeAiOauth", "access_token"],
    ["claudeAiOauth", "token"],
    ["oauth", "accessToken"],
    ["oauth", "access_token"],
    ["oauth", "token"],
    ["accessToken"],
    ["access_token"],
    ["token"],
  ];

  for (const path of candidatePaths) {
    const token = getNestedString(obj, path);
    if (token) return token;
  }

  for (const value of Object.values(obj)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = extractTokenFromObject(value as JsonObj, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function extractTokenFromPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      return parsed.trim();
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return extractTokenFromObject(parsed as JsonObj);
    }
  } catch {
    // Not JSON — treat as raw token string.
  }

  return trimmed.length > 0 ? trimmed : null;
}

function readTokenFromCredentialFile(path: string): string | null {
  try {
    const file = Bun.file(path);
    if (file.size <= 0) return null;
    const text = require("fs").readFileSync(path, "utf-8");
    return extractTokenFromPayload(text);
  } catch {
    return null;
  }
}

function isLikelyTestToken(token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "test-claude-token") return true;
  return /^(test|fake|dummy)[-_].*token$/.test(normalized);
}

function shouldRejectToken(token: string): boolean {
  const isTestRuntime = (process.env.TELEGRAM_BOT_TOKEN || "") === "test-token";
  return !isTestRuntime && isLikelyTestToken(token);
}

/**
 * Retrieve Claude Code OAuth access token from platform keychain with file fallback.
 */
function getClaudeAccessToken(): string | null {
  try {
    const user = process.env.USER || "unknown";
    const home = process.env.HOME || "";
    const credPaths = [
      `${home}/.config/claude-code/credentials.json`,
      `${home}/.claude/credentials.json`,
    ];

    if (IS_MACOS) {
      const keychainCommands: string[][] = [
        [
          "security",
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          user,
          "-w",
        ],
        [
          "security",
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ],
      ];

      for (const cmd of keychainCommands) {
        const proc = Bun.spawnSync(cmd);
        if (proc.exitCode !== 0) continue;
        const token = extractTokenFromPayload(proc.stdout.toString());
        if (token && !shouldRejectToken(token)) return token;
      }
    }

    if (IS_LINUX && Bun.which("secret-tool")) {
      const secretToolCommands: string[][] = [
        [
          "secret-tool",
          "lookup",
          "service",
          "Claude Code-credentials",
          "username",
          user,
        ],
        [
          "secret-tool",
          "lookup",
          "service",
          "Claude Code-credentials",
        ],
      ];

      for (const cmd of secretToolCommands) {
        const proc = Bun.spawnSync(cmd);
        if (proc.exitCode !== 0) continue;
        const token = extractTokenFromPayload(proc.stdout.toString());
        if (token && !shouldRejectToken(token)) return token;
      }
    }

    for (const path of credPaths) {
      const token = readTokenFromCredentialFile(path);
      if (token && !shouldRejectToken(token)) return token;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch and format usage info as HTML lines. Returns empty array on failure.
 */
export async function getUsageLines(): Promise<string[]> {
  try {
    const token = getClaudeAccessToken();
    if (!token) return [];

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) {
      if (res.status === 429) {
        return [`<i>${CLAUDE_USAGE_RATE_LIMIT_MESSAGE}</i>`];
      }
      if (res.status === 401 || res.status === 403) {
        return ["<i>Claude credentials were rejected. Re-run Claude login.</i>"];
      }
      return [];
    }

    const data = (await res.json()) as Record<string, unknown>;

    const bar = (pct: number): string => {
      const filled = Math.round(pct / 5);
      const empty = 20 - filled;
      return "\u2588".repeat(filled) + "\u2591".repeat(empty);
    };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const resetStr = (iso: string): string => {
      const d = new Date(iso);
      const timeStr = d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: d.getMinutes() ? "2-digit" : undefined,
        timeZone: tz,
      }).toLowerCase();
      return `Resets ${timeStr} (${tz})`;
    };

    const lines: string[] = [];
    const sections: [string, string][] = [
      ["five_hour", "Session"],
      ["seven_day", "Week (all)"],
      ["seven_day_sonnet", "Week (Sonnet)"],
      ["seven_day_opus", "Week (Opus)"],
    ];

    for (const [key, label] of sections) {
      const entry = data[key];
      if (!entry) continue;
      if (typeof entry !== "object" || Array.isArray(entry)) continue;

      const entryObj = entry as JsonObj;
      const utilizationRaw =
        entryObj.utilization ??
        entryObj.usedPercent ??
        entryObj.used_percent ??
        entryObj.utilizationPercent;
      const resetsRaw = entryObj.resets_at ?? entryObj.resetsAt;

      const utilization = coerceNumber(utilizationRaw);
      if (utilization === null || typeof resetsRaw !== "string" || !resetsRaw.trim()) {
        continue;
      }

      const pctValue = utilization <= 1 ? utilization * 100 : utilization;
      const pct = Math.max(0, Math.min(100, Math.round(pctValue)));
      const reset = resetStr(resetsRaw);
      lines.push(`<code>${bar(pct)}</code> ${pct}% ${label}\n${reset}`);
    }

    return lines;
  } catch {
    return [];
  }
}

/**
 * Parse percentage from Claude usage bar line (e.g., "▓▓░░░░ 45% Session")
 */
function parseClaudePercentage(line: string): number | null {
  const match = line.match(/(\d+)%/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

/**
 * Parse percentage from Codex quota lines (e.g., "<code>████░░░░░░░░░░░░░░░░</code> 85% window")
 */
function parseCodexPercentage(line: string): number | null {
  const match = line.match(/(\d+)%/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

/**
 * Get status emoji based on usage percentage.
 * ✅ Good (<80%), ⚠️ Warning (80-94%), 🔴 Critical (≥95%)
 */
function getStatusEmoji(pct: number | null): string {
  if (pct === null) return "❓";
  if (pct < 80) return "✅";
  if (pct < 95) return "⚠️";
  return "🔴";
}

/**
 * Format unified usage display combining Claude and Codex data.
 */
export function formatUnifiedUsage(
  usageLines: string[],
  codexLines: string[],
  codexEnabled: boolean
): string {
  const sections: string[] = [];

  // Extract Claude usage data
  let claudeStatus = "❓";
  let claudeHighestPct = 0;
  let claudeDataMissing = true;
  const claudeSection: string[] = [];

  if (usageLines.length > 0) {
    for (const line of usageLines) {
      const pct = parseClaudePercentage(line);
      if (pct !== null) {
        claudeDataMissing = false;
        claudeHighestPct = Math.max(claudeHighestPct, pct);
      }
    }
    if (!claudeDataMissing) {
      claudeStatus = getStatusEmoji(claudeHighestPct);
    }
    claudeSection.push(`${claudeStatus} <b>Claude Code</b>`);
    claudeSection.push(...usageLines.map((line) => `   ${line}`));
  } else {
    claudeSection.push(`❓ <b>Claude Code</b>`);
    claudeSection.push(`   <i>No usage data available</i>`);
  }

  sections.push(claudeSection.join("\n"));

  // Extract Codex quota data
  if (codexEnabled) {
    let codexStatus = "❓";
    let codexHighestPct = 0;
    let codexDataMissing = true;
    let codexPlanType = "";
    const codexSection: string[] = [];
    let codexDisplayLines = [...codexLines];

    // Extract plan type from special marker (first line)
    if (codexDisplayLines.length > 0 && codexDisplayLines[0]?.startsWith("__CODEX_PLAN_TYPE__")) {
      codexPlanType = codexDisplayLines[0].replace("__CODEX_PLAN_TYPE__", "");
      codexDisplayLines = codexDisplayLines.slice(1);
    }

    if (codexDisplayLines.length > 0 && !codexDisplayLines[0]?.includes("Failed to fetch")) {
      for (const line of codexDisplayLines) {
        const pct = parseCodexPercentage(line);
        if (pct !== null) {
          codexDataMissing = false;
          codexHighestPct = Math.max(codexHighestPct, pct);
        }
      }
      if (!codexDataMissing) {
        codexStatus = getStatusEmoji(codexHighestPct);
      }
      const codexHeader = `${codexStatus} <b>Codex${codexPlanType ? ` (${escapeHtml(codexPlanType)})` : ""}</b>`;
      codexSection.push(codexHeader);
      codexSection.push(...codexDisplayLines.map((line) => `   ${line}`));
    } else if (codexDisplayLines.length > 0) {
      codexSection.push(`⚠️ <b>Codex</b>`);
      codexSection.push(...codexDisplayLines.map((line) => `   ${line}`));
    } else {
      codexSection.push(`❓ <b>Codex</b>`);
      codexSection.push(`   <i>No quota data available</i>`);
    }

    sections.push(codexSection.join("\n"));

    // Add summary line
    const bothOk = claudeHighestPct < 80 && codexHighestPct < 80;
    const anyWarning = claudeHighestPct >= 80 || codexHighestPct >= 80;
    const anyCritical = claudeHighestPct >= 95 || codexHighestPct >= 95;

    let statusSummary = "";
    if (claudeDataMissing || codexDataMissing) {
      statusSummary = `❓ <b>Status:</b> Partial data — check above`;
    } else if (anyCritical) {
      statusSummary = `🔴 <b>Status:</b> One or more services critical`;
    } else if (anyWarning) {
      statusSummary = `⚠️ <b>Status:</b> One or more services nearing limit`;
    } else if (bothOk) {
      statusSummary = `✅ <b>Status:</b> All services operating normally`;
    } else {
      statusSummary = `❓ <b>Status:</b> Check data above`;
    }
    sections.push(statusSummary);
  } else {
    // Just show Claude status
    let statusSummary = "";
    if (claudeDataMissing) {
      statusSummary = `❓ <b>Status:</b> Claude usage data unavailable`;
    } else if (claudeHighestPct >= 95) {
      statusSummary = `🔴 <b>Status:</b> Claude Code critical`;
    } else if (claudeHighestPct >= 80) {
      statusSummary = `⚠️ <b>Status:</b> Claude Code nearing limit`;
    } else {
      statusSummary = `✅ <b>Status:</b> Claude Code operating normally`;
    }
    sections.push(statusSummary);
  }

  return sections.join("\n\n");
}

/**
 * /usage - Show Claude subscription usage and Codex quota in unified display.
 */
export async function handleUsage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const [usageLines, codexQuotaLines] = await Promise.all([
    getUsageLines(),
    CODEX_ENABLED ? getCodexQuotaLines() : Promise.resolve<string[]>([]),
  ]);

  const hasClaudeData = usageLines.length > 0;
  const hasCodexData = !CODEX_ENABLED || codexQuotaLines.length > 0;

  if (!hasClaudeData && !hasCodexData) {
    await ctx.reply("❌ <b>Failed to fetch usage data</b>\n\nCould not retrieve Claude or Codex quota information.", {
      parse_mode: "HTML",
    });
    return;
  }

  let unifiedOutput = formatUnifiedUsage(usageLines, codexQuotaLines, CODEX_ENABLED);

  // Add Codex token usage from last turn if available
  if (CODEX_ENABLED && codexSession.lastUsage) {
    const usage = codexSession.lastUsage;
    const codexTokenUsage = [
      "",
      "<b>📊 Codex Last Query Tokens</b>",
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`,
    ];
    unifiedOutput += "\n" + codexTokenUsage.join("\n");
  }

  await ctx.reply(unifiedOutput, {
    parse_mode: "HTML",
  });
}

/**
 * Fetch and format Codex quota info via codex app-server JSON-RPC protocol.
 * Returns formatted lines with progress bars and reset times, or empty array on failure.
 */
export async function getCodexQuotaLines(): Promise<string[]> {
  try {
    // Spawn codex app-server process — use PATH-resolved binary, not hardcoded path
    const codexBin = Bun.which("codex") || "codex";
    const proc = Bun.spawn([codexBin, "app-server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    if (!proc.stdin) {
      return [];
    }

    let responseText = "";
    let messageId = 1;
    let initComplete = false;
    let rateLimitsReceived = false;

    // Set up timeout for entire operation (8 seconds max)
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => resolve(), 8000);
    });

    // Helper to send JSON-RPC message
    const send = (msg: Record<string, unknown>) => {
      const line = JSON.stringify(msg) + "\n";
      proc.stdin!.write(line);
    };

    // Initialize: send initialize message
    send({
      jsonrpc: "2.0",
      id: messageId++,
      method: "initialize",
      params: {
        clientInfo: {
          name: "quota-checker",
          version: "1.0.0",
        },
      },
    });

    // Wait for initialization response and rate limits with timeout
    const readLoop = (async () => {
      const reader = proc.stdout!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (!rateLimitsReceived) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines from buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const response = JSON.parse(line) as Record<string, unknown>;

              // Check for initialization response
              if (!initComplete && response.id === 1) {
                initComplete = true;

                // Send initialized notification (no id)
                send({
                  jsonrpc: "2.0",
                  method: "initialized",
                  params: {},
                });

                // Send rate limits request
                send({
                  jsonrpc: "2.0",
                  id: messageId++,
                  method: "account/rateLimits/read",
                  params: {},
                });
              }

              // Check for rate limits response
              if (initComplete && response.result && typeof response.result === "object") {
                const result = response.result as Record<string, unknown>;
                if (result.rateLimits) {
                  rateLimitsReceived = true;
                  responseText = JSON.stringify(response);
                  break;
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }

          if (rateLimitsReceived) break;
        }
      } catch {
        // Ignore read errors
      } finally {
        reader.releaseLock();
      }
    })();

    // Race between read loop and timeout
    await Promise.race([readLoop, timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Close the process
    proc.stdin?.end();
    proc.kill();

    if (!responseText) {
      return [];
    }

    // Parse the response
    const response = JSON.parse(responseText) as {
      result?: {
        rateLimits?: {
          primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
          secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
          planType?: string;
        };
      };
    };

    const rateLimits = response.result?.rateLimits;
    if (!rateLimits) {
      return [];
    }

    const lines: string[] = [];
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Helper function to format progress bar
    const bar = (pct: number): string => {
      const filled = Math.round(pct / 5);
      const empty = 20 - filled;
      return "\u2588".repeat(filled) + "\u2591".repeat(empty);
    };

    // Helper function to format reset time
    const resetStr = (unixSeconds: number): string => {
      const d = new Date(unixSeconds * 1000);
      const now = new Date();

      // If reset is within today, show time
      if (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      ) {
        return d.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: tz,
        });
      }

      // Otherwise show date
      const parts = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: tz,
      }).split(" ");

      return parts.join(" ");
    };

    // Format primary window (5-hour)
    const primary = rateLimits.primary;
    if (primary) {
      const pct = primary.usedPercent ?? 0;
      const windowLabel = primary.windowDurationMins === 300 ? "5h window" : `${primary.windowDurationMins}m window`;
      const resetTime = primary.resetsAt ? resetStr(primary.resetsAt) : "";
      lines.push(`<code>${bar(pct)}</code> ${pct}% ${windowLabel}`);
      if (resetTime) {
        lines.push(`Resets ${resetTime} (${tz})`);
      }
    }

    // Format secondary window (weekly)
    const secondary = rateLimits.secondary;
    if (secondary) {
      const pct = secondary.usedPercent ?? 0;
      const windowLabel = secondary.windowDurationMins === 10080 ? "Weekly" : `${secondary.windowDurationMins}m window`;
      const resetTime = secondary.resetsAt ? resetStr(secondary.resetsAt) : "";
      lines.push(`<code>${bar(pct)}</code> ${pct}% ${windowLabel}`);
      if (resetTime) {
        lines.push(`Resets ${resetTime} (${tz})`);
      }
    }

    // Include plan type as a special marker (first element)
    const planType = rateLimits.planType || "";
    if (planType) {
      lines.unshift(`__CODEX_PLAN_TYPE__${planType}`);
    }

    return lines;
  } catch (error) {
    return [];
  }
}


export function chunkText(text: string, chunkSize = TELEGRAM_SAFE_LIMIT): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function getMainLoopLogPathCandidates(): string[] {
  const configured = process.env.SUPERTURTLE_LOOP_LOG_PATH?.trim();
  const candidates: string[] = [];
  if (configured) {
    candidates.push(configured);
  }
  if (!candidates.includes(MAIN_LOOP_LOG_PATH)) {
    candidates.push(MAIN_LOOP_LOG_PATH);
  }
  // Migration fallback when runtime path is not explicitly configured.
  if (!configured && !candidates.includes(LEGACY_MAIN_LOOP_LOG_PATH)) {
    candidates.push(LEGACY_MAIN_LOOP_LOG_PATH);
  }
  return candidates;
}

export function readMainLoopLogTail():
  | { ok: true; text: string; path: string }
  | { ok: false; error: string; path: string; triedPaths: string[] } {
  const candidates = getMainLoopLogPathCandidates();
  let lastError = "unknown error";

  for (const path of candidates) {
    const proc = Bun.spawnSync(
      ["tail", "-n", String(LOOPLOGS_LINE_COUNT), path],
      { cwd: WORKING_DIR }
    );
    if (proc.exitCode === 0) {
      return { ok: true, text: proc.stdout.toString(), path };
    }
    lastError = proc.stderr.toString().trim() || proc.stdout.toString().trim() || "unknown error";
  }

  return {
    ok: false,
    error: lastError,
    path: candidates[0] ?? MAIN_LOOP_LOG_PATH,
    triedPaths: candidates,
  };
}

function parseMarkdownTable(
  lines: string[],
  startIndex: number
): { headers: string[]; rows: string[][]; nextIndex: number } | null {
  let i = startIndex;
  const tableLines: string[] = [];

  while (i < lines.length && lines[i]!.trim().startsWith("|")) {
    tableLines.push(lines[i]!.trim());
    i++;
  }

  if (tableLines.length < 2) return null;

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const headers = parseRow(tableLines[0]!);
  const rows: string[][] = [];

  for (let rowIdx = 1; rowIdx < tableLines.length; rowIdx++) {
    const row = parseRow(tableLines[rowIdx]!);
    const isSeparator = row.every((cell) => /^-+$/.test(cell));
    if (!isSeparator) {
      rows.push(row);
    }
  }

  return { headers, rows, nextIndex: i };
}

function formatContextRow(headers: string[], row: string[]): string {
  const lowerHeaders = headers.map((h) => h.toLowerCase());
  const tokenIdx = lowerHeaders.findIndex((h) => h.includes("token"));
  const pctIdx = lowerHeaders.findIndex((h) => h.includes("percentage"));

  const labelParts: string[] = [];
  for (let i = 0; i < row.length; i++) {
    if (i !== tokenIdx && i !== pctIdx && row[i]) {
      labelParts.push(row[i]!);
    }
  }

  const label = labelParts.length > 0 ? labelParts.join(" · ") : row[0] || "item";
  let line = `• ${escapeHtml(label)}`;

  if (tokenIdx !== -1 && row[tokenIdx]) {
    line += `: <code>${escapeHtml(row[tokenIdx]!)}</code>`;
  }
  if (pctIdx !== -1 && row[pctIdx]) {
    line += ` (${escapeHtml(row[pctIdx]!)})`;
  }

  return line;
}

function chunkLines(lines: string[], chunkSize = TELEGRAM_SAFE_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > chunkSize && current) {
      chunks.push(current);
      current = line;
    } else if (next.length > chunkSize) {
      chunks.push(...chunkText(line, chunkSize));
      current = "";
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function formatContextForTelegram(markdown: string): string[] {
  const lines = markdown.split("\n");
  const out: string[] = ["📊 <b>Context Usage</b>"];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      i++;
      continue;
    }

    if (line.startsWith("**Model:**")) {
      const model = line.replace("**Model:**", "").trim();
      out.push(`<b>Model:</b> <code>${escapeHtml(model)}</code>`);
      i++;
      continue;
    }

    if (line.startsWith("**Tokens:**")) {
      const tokens = line.replace("**Tokens:**", "").trim();
      out.push(`<b>Tokens:</b> ${escapeHtml(tokens)}`, "");
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      const sectionName = line.replace("###", "").trim();
      out.push(`<b>${escapeHtml(sectionName)}</b>`);

      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;

      if (j < lines.length && lines[j]!.trim().startsWith("|")) {
        const table = parseMarkdownTable(lines, j);
        if (table) {
          for (const row of table.rows) {
            out.push(formatContextRow(table.headers, row));
          }
          out.push("");
          i = table.nextIndex;
          continue;
        }
      }

      out.push("");
      i++;
      continue;
    }

    out.push(escapeHtml(line));
    i++;
  }

  return chunkLines(out.filter((line, idx, arr) => !(line === "" && arr[idx - 1] === "")));
}

/**
 * /context - Show Claude Code context usage for the active session.
 */
export async function handleContext(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.activeDriver === "codex") {
    await ctx.reply("ℹ️ /context is currently available only for Claude sessions.");
    return;
  }

  if (!session.isActive || !session.sessionId) {
    await ctx.reply("❌ No active session. Send a message or use /resume first.");
    return;
  }

  if (session.isRunning) {
    await ctx.reply("⏳ Query is running. Use /stop, then /context.");
    return;
  }

  const progress = await ctx.reply("📊 Fetching context usage...");

  try {
    const result = await getContextReport(session.sessionId, WORKING_DIR);
    if (!result.ok) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }

    const raw = result.markdown.trim();
    const payload = raw.startsWith("## Context Usage") ? raw : `## Context Usage\n\n${raw}`;
    const chunks = formatContextForTelegram(payload);
    if (chunks.length === 0) {
      await ctx.reply("❌ Context output is empty.");
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      await ctx.reply(chunks[i]!, { parse_mode: "HTML" });
    }
  } catch (error) {
    await ctx.reply(`❌ Failed to fetch context: ${String(error).slice(0, 200)}`);
  } finally {
    try {
      await ctx.api.deleteMessage(progress.chat.id, progress.message_id);
    } catch {
      // Ignore failures to remove transient progress messages.
    }
  }
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const inRunLoop = process.env.SUPERTURTLE_RUN_LOOP === "1";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      cmdLog.warn({ err: e, chatId }, "Failed to save restart info");
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // In run-loop mode, just exit; run-loop respawns in the same tmux terminal.
  if (!inRunLoop) {
    // Re-exec this same command so /restart works even when launched directly.
    const botDir = BOT_DIR;
    const child = Bun.spawn(process.argv, {
      cwd: botDir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
  }

  // Exit current process after replacement is spawned.
  process.exit(0);
}


/**
 * /subturtle - List all SubTurtles with status and controls.
 */
export async function handleSubturtle(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Run ctl list command
  const ctlPath = CTL_PATH;
  const proc = Bun.spawnSync([ctlPath, "list"], {
    cwd: WORKING_DIR,
    env: {
      ...process.env,
      SUPER_TURTLE_PROJECT_DIR: WORKING_DIR,
      CLAUDE_WORKING_DIR: WORKING_DIR,
    },
  });
  const output = proc.stdout.toString().trim();

  if (!output || output.includes("No SubTurtles")) {
    await ctx.reply("📋 <b>SubTurtles</b>\n\nNo SubTurtles running", { parse_mode: "HTML" });
    return;
  }

  const turtles = parseCtlListOutput(output);

  if (turtles.length === 0) {
    await ctx.reply("📋 <b>SubTurtles</b>\n\nNo SubTurtles found", { parse_mode: "HTML" });
    return;
  }

  const rootStatePath = `${WORKING_DIR}/CLAUDE.md`;
  const [rootSummary, turtleStateEntries] = await Promise.all([
    readClaudeStateSummary(rootStatePath),
    Promise.all(
      turtles.map(async (turtle) => {
        const statePath = `${WORKING_DIR}/.subturtles/${turtle.name}/CLAUDE.md`;
        const summary = await readClaudeStateSummary(statePath);
        return [turtle.name, summary] as const;
      })
    ),
  ]);
  const turtleStateMap = new Map(turtleStateEntries);

  // Build message and inline keyboard
  const messageLines: string[] = ["🐢 <b>SubTurtles</b>\n"];

  if (rootSummary) {
    const rootTask = rootSummary.currentTask || "No current task in root CLAUDE.md";
    messageLines.push(`🧭 <b>Root</b> • ${escapeHtml(truncateText(rootTask, 110))}`);
    messageLines.push(`   📌 ${escapeHtml(truncateText(formatBacklogSummary(rootSummary), 140))}`);
    messageLines.push("");
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const turtle of turtles) {
    const stateSummary = turtleStateMap.get(turtle.name) || null;

    // Format the turtle info line
    let statusEmoji = turtle.status === "running" ? "🟢" : "⚫";
    let timeStr = "";
    if (turtle.timeRemaining) {
      const suffix = turtle.timeRemaining === "OVERDUE" || turtle.timeRemaining === "no timeout"
        ? ""
        : " left";
      timeStr = ` • ${escapeHtml(turtle.timeRemaining)}${suffix}`;
    }
    const taskSource = stateSummary?.currentTask || turtle.task || "No current task";
    const taskStr = truncateText(taskSource, 120);

    messageLines.push(
      `${statusEmoji} <b>${escapeHtml(turtle.name)}</b>${timeStr}`
    );
    messageLines.push(`   🧩 ${convertMarkdownToHtml(taskStr)}`);

    if (stateSummary) {
      const backlogSummary = formatBacklogSummary(stateSummary);
      messageLines.push(`   📌 ${convertMarkdownToHtml(truncateText(backlogSummary, 140))}`);
    }

    // Add buttons for running turtles
    if (turtle.status === "running") {
      keyboard.push([
        {
          text: "📋 State",
          callback_data: `subturtle_logs:${turtle.name}`,
        },
        {
          text: "🛑 Stop",
          callback_data: `subturtle_stop:${turtle.name}`,
        },
      ]);
    }
    if (turtle.tunnelUrl) {
      messageLines.push(`   🔗 ${escapeHtml(turtle.tunnelUrl)}`);
    }
  }

  await ctx.reply(messageLines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
  });
}

/**
 * /debug - Instant diagnostic snapshot of the bot's internal state.
 *
 * Shows: driver state, session info, message queues, background run status,
 * cron supervision queue, and processing flags.
 *
 * This command bypasses sequentialization (all commands do) so it always
 * responds immediately even when the agent is mid-turn.
 */
export async function handleDebug(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const now = Date.now();
  const lines: string[] = ["🔍 <b>Debug — Internal State</b>\n"];

  // ── Driver / Session ──
  const driverLabel = session.activeDriver === "codex" ? "Codex 🟢" : "Claude 🔵";
  const { modelName, effortStr } = formatModelInfo(session.model, session.effort);
  const claudeRunning = session.isRunning;
  const codexRunning = codexSession.isRunning;
  const anyDriverRunning = isAnyDriverRunning();

  lines.push(`<b>Driver</b>`);
  lines.push(`  Active: ${driverLabel}`);
  lines.push(`  Model: ${escapeHtml(modelName)}${escapeHtml(effortStr)}`);
  lines.push(`  Claude session: ${session.isActive ? `active (${session.sessionId?.slice(0, 8)}…)` : "none"}`);
  lines.push(`  Claude running: ${claudeRunning ? "✅ yes" : "no"}`);
  if (session.queryStarted) {
    const elapsed = Math.round((now - session.queryStarted.getTime()) / 1000);
    lines.push(`  Claude query elapsed: ${elapsed}s`);
  }
  if (session.currentTool) {
    lines.push(`  Claude current tool: <code>${escapeHtml(session.currentTool)}</code>`);
  }
  lines.push(`  Codex session: ${codexSession.isActive ? "active" : "none"}`);
  lines.push(`  Codex running: ${codexRunning ? "✅ yes" : "no"}`);
  if (codexRunning && codexSession.runningSince) {
    const elapsed = Math.round((now - codexSession.runningSince.getTime()) / 1000);
    lines.push(`  Codex query elapsed: ${elapsed}s`);
  }
  lines.push(`  Any driver running: ${anyDriverRunning ? "✅ yes" : "no"}`);
  lines.push("");

  // ── Background runs (cron / snapshots) ──
  const bgActive = isBackgroundRunActive();
  const bgPreempted = wasBackgroundRunPreempted();
  const snapshotQueueSize = getPreparedSnapshotCount();

  lines.push(`<b>Background</b>`);
  lines.push(`  Background run active: ${bgActive ? "✅ yes" : "no"}`);
  lines.push(`  Background preempted: ${bgPreempted ? "⚠️ yes" : "no"}`);
  lines.push(`  Supervision snapshot queue: ${snapshotQueueSize}`);
  lines.push("");

  // ── Deferred queue ──
  const deferredQueues = getAllDeferredQueues();
  let totalDeferred = 0;
  for (const [, items] of deferredQueues) {
    totalDeferred += items.length;
  }

  lines.push(`<b>Deferred Queue</b>`);
  if (totalDeferred === 0) {
    lines.push(`  Empty`);
  } else {
    for (const [chatId, items] of deferredQueues) {
      lines.push(`  Chat ${chatId}: ${items.length} item${items.length === 1 ? "" : "s"}`);
      for (const item of items) {
        const age = Math.round((now - item.enqueuedAt) / 1000);
        if (item.kind === "user_message") {
          const preview = item.text.length > 60 ? item.text.slice(0, 57) + "…" : item.text;
          lines.push(`    • ${escapeHtml(preview)} (${age}s ago, ${item.source})`);
          continue;
        }

        const preview = item.prompt.length > 60 ? item.prompt.slice(0, 57) + "…" : item.prompt;
        lines.push(`    • [cron] ${escapeHtml(preview)} (${age}s ago, ${item.jobType})`);
      }
    }
  }
  lines.push("");

  // ── Last error from loop log ──
  const logResult = readMainLoopLogTail();
  if (logResult.ok && logResult.text) {
    const logLines = logResult.text.split("\n");
    // Find last error/warning line in the log
    const errorLines: string[] = [];
    for (let i = logLines.length - 1; i >= 0 && errorLines.length < 5; i--) {
      const line = logLines[i]!.trim();
      if (!line) continue;
      if (/error|fail|crash|panic|BLOCKED|SIGTERM|SIGKILL|exit/i.test(line)) {
        errorLines.unshift(line);
      }
    }
    if (errorLines.length > 0) {
      lines.push(`<b>Recent Errors (loop log)</b>`);
      for (const errLine of errorLines) {
        const truncated = errLine.length > 120 ? errLine.slice(0, 117) + "…" : errLine;
        lines.push(`  <code>${escapeHtml(truncated)}</code>`);
      }
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /cron - List scheduled cron jobs with cancel buttons.
 */
export async function handleCron(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const jobs = getJobs();

  if (jobs.length === 0) {
    await ctx.reply("⏰ <b>Scheduled Jobs</b>\n\nNo jobs scheduled", { parse_mode: "HTML" });
    return;
  }

  // Build message and inline keyboard
  const messageLines: string[] = ["⏰ <b>Scheduled Jobs</b>\n"];
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const job of jobs) {
    // Format fire_at timestamp: "18/01 10:30" or "in 5 mins" if soon
    const fireDate = new Date(job.fire_at);
    const now = Date.now();
    const timeUntil = job.fire_at - now;

    let timeStr: string;
    if (timeUntil < 60000) {
      // Less than a minute - show "in Xs"
      const seconds = Math.ceil(timeUntil / 1000);
      timeStr = `in ${seconds}s`;
    } else if (timeUntil < 3600000) {
      // Less than an hour - show "in Xm"
      const minutes = Math.ceil(timeUntil / 60000);
      timeStr = `in ${minutes}m`;
    } else {
      // Show absolute time
      const dateStr = fireDate.toLocaleDateString("en-US", {
        day: "2-digit",
        month: "2-digit",
      });
      const timeOfDayStr = fireDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      timeStr = `${dateStr} ${timeOfDayStr}`;
    }

    // Prefer structured supervision metadata over raw prompt text when available.
    const rawPreview = job.job_kind === "subturtle_supervision" && job.worker_name
      ? `SubTurtle ${job.worker_name} (${job.supervision_mode || (job.silent ? "silent" : "unknown")})`
      : job.prompt;
    const promptPreview = rawPreview.length > 40 ? rawPreview.slice(0, 37) + "..." : rawPreview;

    // Build the job line
    const typeEmoji = job.type === "recurring" ? "🔁" : "⏱️";
    messageLines.push(
      `${typeEmoji} <code>${escapeHtml(promptPreview)}</code>\n   🕐 ${timeStr}`
    );

    // Add cancel button
    keyboard.push([
      {
        text: "❌ Cancel",
        callback_data: `cron_cancel:${job.id}`,
      },
    ]);
  }

  await ctx.reply(messageLines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}
