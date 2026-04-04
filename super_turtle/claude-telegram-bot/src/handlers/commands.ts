/**
 * Command handlers for Claude Telegram Bot.
 */

import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { InlineKeyboard, type Context } from "grammy";
import { session, getAvailableModels, EFFORT_DISPLAY, type EffortLevel } from "../session";
import { codexSession } from "../codex-session";
import {
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
  SELF_UPDATE_STATE_FILE,
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
  SUPERTURTLE_RUNTIME_PROFILE,
  SUPERTURTLE_RUNTIME_UPDATE_DIST_TAG,
  SUPERTURTLE_RUNTIME_UPDATE_PACKAGE,
  SUPERTURTLE_RUNTIME_UPDATE_REGISTRY_URL,
  SUPERTURTLE_DATA_DIR,
  SUPERTURTLE_SUBTURTLES_DIR,
  TELEPORT_DISABLED_MESSAGE,
  getCodexUnavailableReason,
} from "../config";
import { getContextReport } from "../context-command";
import { isAuthorized } from "../security";
import { escapeHtml, convertMarkdownToHtml } from "../formatting";
import { getJobs } from "../cron";
import { isAnyDriverRunning, isBackgroundRunActive, wasBackgroundRunPreempted, stopActiveDriverQuery } from "./driver-routing";
import { handleStop, stopForegroundWork } from "./stop";
import { clearPreparedSnapshots, getPreparedSnapshotCount } from "../cron-supervision-queue";
import { cmdLog } from "../logger";
import type { BotCommand } from "grammy/types";

// Canonical main-loop log written by live.sh (tmux + caffeinate + run-loop).
export const MAIN_LOOP_LOG_PATH = `/tmp/claude-telegram-${TOKEN_PREFIX}-bot-ts.log`;
const LEGACY_MAIN_LOOP_LOG_PATH = "/tmp/claude-telegram-bot-ts.log";
const LOOPLOGS_LINE_COUNT = 50;
const RESUME_SESSIONS_LIMIT = 5;
const LIVE_SUBTURTLE_BOARD_REFRESH_MIN_MS = 90 * 1000;
const LIVE_SUBTURTLE_BOARD_MAX_BUTTONS = 8;
const LIVE_SUBTURTLE_BOARD_LOCK_WAIT_MS = 10_000;
const LIVE_SUBTURTLE_BOARD_LOCK_STALE_MS = 120_000;
const LIVE_SUBTURTLE_BOARD_LOCK_RETRY_MS = 50;
const CLAUDE_USAGE_RATE_LIMIT_MESSAGE =
  "Claude usage is temporarily unavailable due to Anthropic service limits. This comes from Anthropic's usage endpoint, not from Super Turtle.";

const LOCAL_TELEGRAM_COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "stop", description: "Stop current work" },
  { command: "model", description: "Switch driver, model, or effort" },
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

const MANAGED_TELEGRAM_COMMANDS = [
  ...LOCAL_TELEGRAM_COMMANDS,
  { command: "update", description: "Update the managed runtime" },
] as const;
const UPDATE_USAGE_TEXT = "Usage: /update | /update test | /update superturtle@0.2.9-beta.143.1";
const SELF_UPDATE_SERVICE_PID_PATH = join(SUPERTURTLE_DATA_DIR, "service.pid");
const SELF_UPDATE_STALE_MS = 15 * 60 * 1000;

type SelfUpdateState = {
  status: "pending" | "installing" | "starting" | "succeeded" | "failed";
  requested_spec: string;
  current_version: string | null;
  target_version: string | null;
  chat_id: number;
  message_id: number;
  requested_at: string;
  completed_at?: string;
  notified_at?: string;
  error?: string;
  helper_pid?: number | null;
  service_pid?: number | null;
  interrupted_foreground_work?: boolean;
  interrupted_background_run?: boolean;
};

type ParsedSelfUpdateSpec = {
  installSpec: string;
  version: string;
};

type ParsedSelfUpdateRequest =
  | ({ kind: "exact" } & ParsedSelfUpdateSpec)
  | { kind: "dist-tag"; distTag: string };

type ResolvedSelfUpdateTarget = ParsedSelfUpdateSpec & {
  source: "exact" | "dist-tag";
  distTag?: string;
};

type SelfUpdateReplyMessage = {
  message_id?: number;
};

type SelfUpdateReplyFn = (text: string) => Promise<SelfUpdateReplyMessage | null | undefined>;

export function getTelegramCommandsForRuntime(
  runtimeProfile: "local" | "managed" = SUPERTURTLE_RUNTIME_PROFILE
): readonly BotCommand[] {
  return runtimeProfile === "managed"
    ? MANAGED_TELEGRAM_COMMANDS
    : LOCAL_TELEGRAM_COMMANDS;
}

export const TELEGRAM_COMMANDS: readonly BotCommand[] =
  getTelegramCommandsForRuntime();

async function syncTelegramCommandsFromCommand(
  ctx: Context,
  runtimeProfile: "local" | "managed"
): Promise<void> {
  try {
    await ctx.api.setMyCommands([
      ...getTelegramCommandsForRuntime(runtimeProfile),
    ]);
  } catch (error) {
    cmdLog.warn({ err: error, runtimeProfile }, "Failed to refresh Telegram slash commands");
  }
}

/**
 * Shared command list for display in /new and /status, and new_session bot-control.
 */
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
  const { handleStop } = await import("./stop");
  await handleStop(ctx, chatId);
}

function getCodexUnavailableMessage(): string {
  const reason = getCodexUnavailableReason();
  if (!reason) return "❌ Codex is unavailable.";
  if (!CODEX_USER_ENABLED) {
    return (
      `❌ ${reason}\n` +
      `Run \`superturtle init\` and enable Codex integration to allow driver switching.`
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
  const isSyntheticTestRuntime = (process.env.TELEGRAM_BOT_TOKEN || "") === "test-token";
  const [usageLines, codexQuotaLines] = isSyntheticTestRuntime
    ? [[], []]
    : await Promise.all([
        getUsageLines(),
        CODEX_ENABLED ? getCodexQuotaLines() : Promise.resolve<string[]>([]),
      ]);
  lines.push(formatUnifiedUsage(usageLines, codexQuotaLines, CODEX_ENABLED), "");
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

type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

const SUBTURTLE_MENU_PAGE_SIZE = 3;
const BACKLOG_PAGE_SIZE = 5;
const LOG_LINES_PER_PAGE = 30;
const LIVE_SUBTURTLE_BOARD_DIR = join(
  SUPERTURTLE_DATA_DIR,
  "state",
  "telegram",
  "subturtle-boards"
);

export type LiveSubturtleBoardView =
  | { kind: "board" }
  | { kind: "detail"; name: string }
  | { kind: "backlog"; name: string; page: number }
  | { kind: "logs"; name: string; page: number };

type LiveSubturtleBoardPinState = "established" | "unestablished";

type LiveSubturtleBoardRecord = {
  chat_id: number;
  message_id: number;
  last_render_hash: string;
  last_rendered_at: string;
  created_at: string;
  updated_at: string;
  pin_state?: LiveSubturtleBoardPinState;
  current_view?: LiveSubturtleBoardView;
};

type LiveSubturtleBoardChatMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
  reply_markup?: unknown;
};

export type LiveSubturtleBoardApi = {
  sendMessage: (
    chatId: number,
    text: string,
    extra: {
      parse_mode: "HTML";
      reply_markup?: InlineKeyboardMarkup;
      disable_notification?: boolean;
    }
  ) => Promise<{ message_id?: number; chat?: { id?: number } }>;
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    extra: {
      parse_mode: "HTML";
      reply_markup?: InlineKeyboardMarkup;
    }
  ) => Promise<unknown>;
  pinChatMessage?: (
    chatId: number,
    messageId: number,
    extra?: { disable_notification?: boolean }
  ) => Promise<unknown>;
  unpinChatMessage?: (
    chatId: number,
    messageId?: number
  ) => Promise<unknown>;
  deleteMessage?: (
    chatId: number,
    messageId: number
  ) => Promise<unknown>;
  getChat?: (
    chatId: number
  ) => Promise<{ pinned_message?: LiveSubturtleBoardChatMessage }>;
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

function nowIso(): string {
  return new Date().toISOString();
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, path);
}

export function parseExactSelfUpdateSpec(rawValue: string | undefined): ParsedSelfUpdateSpec | null {
  if (!rawValue) {
    return null;
  }
  const trimmed = rawValue.trim();
  const match = /^superturtle@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(trimmed);
  if (!match?.[1]) {
    return null;
  }
  return {
    installSpec: trimmed,
    version: match[1],
  };
}

function normalizeSelfUpdateDistTag(rawValue: string | undefined): string | null {
  if (!rawValue) {
    return null;
  }
  const trimmed = rawValue.trim();
  return /^[a-z0-9][a-z0-9._-]*$/i.test(trimmed) ? trimmed : null;
}

export function parseSelfUpdateRequest(
  rawValue: string | undefined,
  defaultDistTag: string = SUPERTURTLE_RUNTIME_UPDATE_DIST_TAG
): ParsedSelfUpdateRequest | null {
  const exact = parseExactSelfUpdateSpec(rawValue);
  if (exact) {
    return { kind: "exact", ...exact };
  }

  const trimmed = rawValue?.trim() || "";
  if (!trimmed) {
    const distTag = normalizeSelfUpdateDistTag(defaultDistTag);
    return distTag ? { kind: "dist-tag", distTag } : null;
  }

  const packageTagMatch = /^superturtle@([a-z0-9][a-z0-9._-]*)$/i.exec(trimmed);
  if (packageTagMatch?.[1]) {
    return { kind: "dist-tag", distTag: packageTagMatch[1] };
  }

  const distTag = normalizeSelfUpdateDistTag(trimmed);
  return distTag ? { kind: "dist-tag", distTag } : null;
}

export async function resolveSelfUpdateTarget(
  request: ParsedSelfUpdateRequest,
  options: {
    fetchImpl?: typeof fetch;
    registryUrl?: string;
    packageName?: string;
  } = {}
): Promise<ResolvedSelfUpdateTarget> {
  if (request.kind === "exact") {
    return {
      ...request,
      source: "exact",
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const registryUrl = (options.registryUrl || SUPERTURTLE_RUNTIME_UPDATE_REGISTRY_URL).replace(/\/+$/, "");
  const packageName = options.packageName || SUPERTURTLE_RUNTIME_UPDATE_PACKAGE;
  const endpoint = `${registryUrl}/-/package/${encodeURIComponent(packageName)}/dist-tags`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: "GET" });
  } catch (error) {
    throw new Error(
      `Failed to reach npm registry for dist-tag ${request.distTag}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} while resolving dist-tag ${request.distTag}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `npm registry returned invalid JSON while resolving dist-tag ${request.distTag}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const version =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)[request.distTag]
      : null;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`npm dist-tag ${request.distTag} is not published for ${packageName}.`);
  }

  const installSpec = `${packageName}@${version.trim()}`;
  const exact = parseExactSelfUpdateSpec(installSpec);
  if (!exact) {
    throw new Error(`npm dist-tag ${request.distTag} resolved to unsupported spec ${installSpec}.`);
  }

  return {
    ...exact,
    source: "dist-tag",
    distTag: request.distTag,
  };
}

export function getCurrentRuntimeVersion(): string | null {
  try {
    const raw = readFileSync(join(BOT_DIR, "..", "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

export async function startRemoteSelfUpdate(options: {
  chatId: number | null | undefined;
  reply: SelfUpdateReplyFn;
  request: ParsedSelfUpdateRequest;
}): Promise<string> {
  if (SUPERTURTLE_RUNTIME_PROFILE !== "managed") {
    const text = "ℹ️ Self-update is only supported inside the managed E2B runtime.";
    await options.reply(text);
    return text;
  }

  let resolvedTarget: ResolvedSelfUpdateTarget;
  try {
    resolvedTarget = await resolveSelfUpdateTarget(options.request);
  } catch (error) {
    const text =
      `⚠️ Failed to resolve the managed runtime target.\n${error instanceof Error ? error.message : String(error)}`;
    await options.reply(text);
    return text;
  }

  if (listSubturtles().some((turtle) => turtle.status === "running")) {
    const text = "⚠️ Stop running SubTurtles before updating the managed runtime.";
    await options.reply(text);
    return text;
  }

  const existingState = readSelfUpdateState();
  if (isSelfUpdateInProgress(existingState)) {
    const text =
      `ℹ️ A runtime update is already in progress${existingState?.requested_spec ? ` (${existingState.requested_spec})` : ""}.`;
    await options.reply(text);
    return text;
  }

  const servicePid = discoverServiceRunnerPid();
  if (!servicePid) {
    const text = "⚠️ Could not find the remote service runner. Try /restart first, then retry /update.";
    await options.reply(text);
    return text;
  }

  const interruptedForegroundWork = isAnyDriverRunning();
  const interruptedBackgroundRun = isBackgroundRunActive();
  if (interruptedForegroundWork) {
    await stopForegroundWork(options.chatId ?? undefined);
  }

  const currentVersion = getCurrentRuntimeVersion();
  if (currentVersion && resolvedTarget.version === currentVersion) {
    const text =
      resolvedTarget.source === "dist-tag"
        ? `ℹ️ The managed runtime is already on ${resolvedTarget.installSpec} (current ${resolvedTarget.distTag} target).`
        : `ℹ️ The managed runtime is already on ${resolvedTarget.installSpec}.`;
    await options.reply(text);
    return text;
  }

  const sourceLine =
    resolvedTarget.source === "dist-tag"
      ? `\n• Resolved from npm dist-tag \`${resolvedTarget.distTag}\` to ${resolvedTarget.installSpec}.`
      : "";
  const interruptionLine =
    interruptedForegroundWork || interruptedBackgroundRun
      ? "\n• I may interrupt the current reply while I restart. If that happens, resend your last message after I come back."
      : "";
  const kickoffText =
    `⬆️ Updating managed runtime to ${resolvedTarget.installSpec}...${sourceLine}\n• The turtle will restart after the new package is installed.${interruptionLine}`;
  const message = await options.reply(kickoffText);

  if (!options.chatId || !message?.message_id) {
    const text = "⚠️ Could not persist update state because Telegram did not return message metadata.";
    await options.reply(text);
    return text;
  }

  const updateState: SelfUpdateState = {
    status: "pending",
    requested_spec: resolvedTarget.installSpec,
    current_version: currentVersion,
    target_version: resolvedTarget.version,
    chat_id: options.chatId,
    message_id: message.message_id,
    requested_at: nowIso(),
    service_pid: servicePid,
    helper_pid: null,
    interrupted_foreground_work: interruptedForegroundWork,
    interrupted_background_run: interruptedBackgroundRun,
  };
  writeSelfUpdateState(updateState);

  const nodeExec = Bun.which("node") || process.execPath;
  const helperScriptPath = join(BOT_DIR, "..", "bin", "superturtle.js");

  try {
    const helper = Bun.spawn(
      [
        nodeExec,
        helperScriptPath,
        "service",
        "self-update-runner",
        "--cwd",
        WORKING_DIR,
        "--spec",
        resolvedTarget.installSpec,
      ],
      {
        cwd: WORKING_DIR,
        env: {
          ...process.env,
          CLAUDE_WORKING_DIR: WORKING_DIR,
          SUPER_TURTLE_DIR: join(BOT_DIR, ".."),
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      }
    );
    helper.unref();
    writeSelfUpdateState({
      ...updateState,
      helper_pid: typeof helper.pid === "number" ? helper.pid : null,
    });
  } catch (error) {
    writeSelfUpdateState({
      ...updateState,
      status: "failed",
      completed_at: nowIso(),
      error: error instanceof Error ? error.message : String(error),
    });
    const text = "⚠️ Failed to launch the runtime updater. The current bot process is still running.";
    await options.reply(text);
    return text;
  }

  await Bun.sleep(500);
  return kickoffText;
}

function readSelfUpdateState(): SelfUpdateState | null {
  if (!existsSync(SELF_UPDATE_STATE_FILE)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(SELF_UPDATE_STATE_FILE, "utf-8"));
    if (
      typeof parsed?.status === "string" &&
      typeof parsed?.requested_spec === "string" &&
      typeof parsed?.requested_at === "string" &&
      typeof parsed?.chat_id === "number" &&
      typeof parsed?.message_id === "number"
    ) {
      return parsed as SelfUpdateState;
    }
  } catch {}
  return null;
}

function writeSelfUpdateState(state: SelfUpdateState): void {
  atomicWriteText(SELF_UPDATE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const proc = Bun.spawnSync(["kill", "-0", String(pid)], {
    cwd: WORKING_DIR,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

function isSelfUpdateInProgress(state: SelfUpdateState | null, nowMs: number = Date.now()): boolean {
  if (!state) {
    return false;
  }
  if (!["pending", "installing", "starting"].includes(state.status)) {
    return false;
  }
  if (typeof state.helper_pid === "number" && isPidRunning(state.helper_pid)) {
    return true;
  }
  const requestedAtMs = Date.parse(state.requested_at);
  return Number.isFinite(requestedAtMs) && nowMs - requestedAtMs >= 0 && nowMs - requestedAtMs <= SELF_UPDATE_STALE_MS;
}

function readServiceRunnerPid(): number | null {
  if (!existsSync(SELF_UPDATE_SERVICE_PID_PATH)) {
    return null;
  }
  const raw = readFileSync(SELF_UPDATE_SERVICE_PID_PATH, "utf-8").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

type ProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

function readProcessInfo(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const proc = Bun.spawnSync(["ps", "-o", "ppid=", "-o", "command=", "-p", String(pid)], {
    cwd: WORKING_DIR,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) {
    return null;
  }

  const output = proc.stdout.toString().trim();
  if (!output) {
    return null;
  }

  const match = output.match(/^(\d+)\s+(.*)$/s);
  if (!match) {
    return null;
  }

  const ppid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(ppid) || ppid < 0) {
    return null;
  }

  return {
    pid,
    ppid,
    command: (match[2] ?? "").trim(),
  };
}

function isServiceRunnerCommand(command: string): boolean {
  if (!command) {
    return false;
  }

  const normalized = command.toLowerCase();
  if (
    normalized.includes(" service run") &&
    (normalized.includes("superturtle") || normalized.includes("superturtle.js"))
  ) {
    return true;
  }

  return (
    normalized.includes("systemd-inhibit") &&
    normalized.includes("run-loop.sh") &&
    normalized.includes("superturtle")
  );
}

function findAncestorServiceRunnerPid(startPid: number = process.pid): number | null {
  let currentPid = startPid;

  for (let depth = 0; depth < 12; depth += 1) {
    const info = readProcessInfo(currentPid);
    if (!info) {
      return null;
    }
    if (isServiceRunnerCommand(info.command) && isPidRunning(info.pid)) {
      return info.pid;
    }
    if (!Number.isInteger(info.ppid) || info.ppid <= 1 || info.ppid === currentPid) {
      return null;
    }
    currentPid = info.ppid;
  }

  return null;
}

function discoverServiceRunnerPid(): number | null {
  const fromPidFile = readServiceRunnerPid();
  if (fromPidFile && isPidRunning(fromPidFile)) {
    return fromPidFile;
  }
  return findAncestorServiceRunnerPid();
}

function readCommandArgumentText(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return "";
  }
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) {
    return "";
  }
  return trimmed.slice(firstSpace + 1).trim();
}

function liveSubturtleBoardPath(chatId: number): string {
  return join(LIVE_SUBTURTLE_BOARD_DIR, `${String(chatId).replace(/^-/, "neg-")}.json`);
}

function liveSubturtleBoardLockPath(chatId: number): string {
  return `${liveSubturtleBoardPath(chatId)}.lock`;
}

async function withLiveSubturtleBoardLock<T>(
  chatId: number,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = liveSubturtleBoardLockPath(chatId);
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, acquired_at: nowIso() }) + "\n",
        "utf-8"
      );
      try {
        return await operation();
      } finally {
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(lockPath);
        } catch {}
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        try {
          const stats = statSync(lockPath);
          if (Date.now() - stats.mtimeMs > LIVE_SUBTURTLE_BOARD_LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {}

        if (Date.now() - startedAt >= LIVE_SUBTURTLE_BOARD_LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for live SubTurtle board lock: ${lockPath}`);
        }

        await Bun.sleep(LIVE_SUBTURTLE_BOARD_LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
}

function isSafeSubturtleName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..") && !value.startsWith(".");
}

function normalizeBoardPage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const page = Math.floor(value);
  return page >= 0 && page <= 1000 ? page : 0;
}

function normalizeLiveSubturtleBoardView(value: unknown): LiveSubturtleBoardView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "board" };
  }

  const kind = (value as { kind?: unknown }).kind;
  if (kind === "detail" && isSafeSubturtleName((value as { name?: unknown }).name)) {
    return { kind, name: (value as { name: string }).name };
  }
  if (kind === "backlog" && isSafeSubturtleName((value as { name?: unknown }).name)) {
    return {
      kind,
      name: (value as { name: string }).name,
      page: normalizeBoardPage((value as { page?: unknown }).page),
    };
  }
  if (kind === "logs" && isSafeSubturtleName((value as { name?: unknown }).name)) {
    return {
      kind,
      name: (value as { name: string }).name,
      page: normalizeBoardPage((value as { page?: unknown }).page),
    };
  }
  return { kind: "board" };
}

function normalizeLiveSubturtleBoardPinState(value: unknown): LiveSubturtleBoardPinState {
  return value === "unestablished" ? "unestablished" : "established";
}

function readLiveSubturtleBoardRecord(chatId: number): LiveSubturtleBoardRecord | null {
  const path = liveSubturtleBoardPath(chatId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof parsed?.chat_id === "number" &&
      Number.isFinite(parsed.chat_id) &&
      typeof parsed?.message_id === "number" &&
      Number.isFinite(parsed.message_id) &&
      typeof parsed?.last_render_hash === "string" &&
      typeof parsed?.last_rendered_at === "string" &&
      typeof parsed?.created_at === "string" &&
      typeof parsed?.updated_at === "string"
    ) {
      return {
        ...(parsed as LiveSubturtleBoardRecord),
        pin_state: normalizeLiveSubturtleBoardPinState(parsed?.pin_state),
        current_view: normalizeLiveSubturtleBoardView(parsed?.current_view),
      };
    }
  } catch {}
  return null;
}

function writeLiveSubturtleBoardRecord(record: LiveSubturtleBoardRecord): void {
  atomicWriteText(
    liveSubturtleBoardPath(record.chat_id),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function deleteLiveSubturtleBoardRecord(chatId: number): void {
  try {
    unlinkSync(liveSubturtleBoardPath(chatId));
  } catch {}
}

function summarizeBoardReplyMarkup(replyMarkup?: InlineKeyboardMarkup): string {
  if (!replyMarkup) return "";
  return JSON.stringify(replyMarkup.inline_keyboard);
}

function computeLiveSubturtleBoardHash(
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): string {
  return createHash("sha1")
    .update(text)
    .update("\n")
    .update(summarizeBoardReplyMarkup(replyMarkup))
    .digest("hex");
}

function shouldIgnoreUnchangedMessageError(error: unknown): boolean {
  return String(error).toLowerCase().includes("message is not modified");
}

function shouldRecreateLiveBoard(error: unknown): boolean {
  const summary = String(error).toLowerCase();
  return (
    summary.includes("message to edit not found") ||
    summary.includes("message can't be edited") ||
    summary.includes("message identifier is not specified")
  );
}

function liveSubturtleBoardCallbackData(
  replyMarkup?: LiveSubturtleBoardChatMessage["reply_markup"]
): string[] {
  if (!replyMarkup || typeof replyMarkup !== "object" || Array.isArray(replyMarkup)) {
    return [];
  }

  const inlineKeyboard = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(inlineKeyboard)) {
    return [];
  }

  return inlineKeyboard.flatMap((row) =>
    Array.isArray(row)
      ? row
          .map((button) =>
            typeof button === "object" &&
            button !== null &&
            typeof (button as { callback_data?: unknown }).callback_data === "string"
              ? (button as { callback_data: string }).callback_data
              : ""
          )
          .filter((callbackData) => callbackData.length > 0)
      : []
  );
}

function recoverLiveSubturtleBoardView(
  message: LiveSubturtleBoardChatMessage
): LiveSubturtleBoardView | null {
  const callbackData = liveSubturtleBoardCallbackData(message.reply_markup);
  const text = [message.text, message.caption]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() || "";

  if (!callbackData.some((value) => value.startsWith("sub_board_"))) {
    return text.startsWith("🐢 SubTurtles") ? { kind: "board" } : null;
  }

  const backlogMatch = /^📝\s+Tasks\s+for\s+([^\n]+)\n[^\n]*page\s+(\d+)\/\d+/m.exec(text);
  if (backlogMatch && isSafeSubturtleName(backlogMatch[1]?.trim())) {
    return {
      kind: "backlog",
      name: backlogMatch[1]!.trim(),
      page: normalizeBoardPage(Number(backlogMatch[2]) - 1),
    };
  }

  const logsMatch = /^📜\s+Logs\s+for\s+([^\n]+)\s+[-—]\s+page\s+(\d+)\/\d+/m.exec(text);
  if (logsMatch && isSafeSubturtleName(logsMatch[1]?.trim())) {
    return {
      kind: "logs",
      name: logsMatch[1]!.trim(),
      page: normalizeBoardPage(Number(logsMatch[2]) - 1),
    };
  }

  if (callbackData.includes("sub_board_home")) {
    const detailName = callbackData
      .map((value) => {
        const stopMatch = /^sub_board_stop:([^:]+)$/.exec(value);
        if (stopMatch?.[1] && isSafeSubturtleName(stopMatch[1])) {
          return stopMatch[1];
        }
        const backlogButtonMatch = /^sub_board_bl:([^:]+):\d+$/.exec(value);
        if (backlogButtonMatch?.[1] && isSafeSubturtleName(backlogButtonMatch[1])) {
          return backlogButtonMatch[1];
        }
        const logsButtonMatch = /^sub_board_lg:([^:]+):\d+$/.exec(value);
        if (logsButtonMatch?.[1] && isSafeSubturtleName(logsButtonMatch[1])) {
          return logsButtonMatch[1];
        }
        return null;
      })
      .find((value): value is string => typeof value === "string");

    if (detailName) {
      return { kind: "detail", name: detailName };
    }
  }

  return { kind: "board" };
}

async function recoverPinnedLiveSubturtleBoard(
  api: LiveSubturtleBoardApi,
  chatId: number
): Promise<{ messageId: number; view: LiveSubturtleBoardView } | null> {
  if (!api.getChat) {
    return null;
  }

  try {
    const chat = await api.getChat(chatId);
    const pinnedMessage = chat?.pinned_message;
    if (
      !pinnedMessage ||
      typeof pinnedMessage.message_id !== "number" ||
      !Number.isFinite(pinnedMessage.message_id)
    ) {
      return null;
    }

    const view = recoverLiveSubturtleBoardView(pinnedMessage);
    if (!view) {
      return null;
    }

    return { messageId: pinnedMessage.message_id, view };
  } catch {
    return null;
  }
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

function noSubturtlesMessage(): { text: string; replyMarkup?: InlineKeyboardMarkup } {
  return {
    text: "🐢 <b>SubTurtles</b>\n\nNo SubTurtles running",
  };
}

function subturtleStatusEmoji(status: ListedSubTurtle["status"]): string {
  return status === "running" ? "🟢" : "⚫";
}

function formatSubturtleTimeout(turtle: ListedSubTurtle): string | null {
  if (!turtle.timeRemaining) {
    return null;
  }

  const suffix = turtle.timeRemaining === "OVERDUE" || turtle.timeRemaining === "no timeout"
    ? ""
    : " left";
  return `${escapeHtml(turtle.timeRemaining)}${suffix}`;
}

function findListedSubturtle(name: string): ListedSubTurtle | null {
  return listSubturtles().find((turtle) => turtle.name === name) || null;
}

function formatLiveBoardMetaLine(
  turtle: ListedSubTurtle,
  summary: ClaudeStateSummary | null,
  options: { includeTimeout?: boolean } = {}
): string | null {
  const parts: string[] = [];

  if (turtle.type) {
    parts.push(escapeHtml(turtle.type));
  }

  if (summary && summary.backlogTotal > 0) {
    parts.push(`${summary.backlogDone}/${summary.backlogTotal} done`);
  }

  if (options.includeTimeout) {
    const timeout = formatSubturtleTimeout(turtle);
    if (timeout) {
      parts.push(timeout);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(" • ");
}

async function buildLiveSubturtleBoardHomeLines(turtles: ListedSubTurtle[]): Promise<string[]> {
  const runningTurtles = turtles.filter((turtle) => turtle.status === "running");
  const turtleStateEntries = await Promise.all(
    runningTurtles.map(async (turtle) => {
      const statePath = `${SUPERTURTLE_SUBTURTLES_DIR}/${turtle.name}/CLAUDE.md`;
      const summary = await readClaudeStateSummary(statePath);
      return [turtle.name, summary] as const;
    })
  );
  const turtleStateMap = new Map(turtleStateEntries);

  const messageLines: string[] = ["🐢 <b>SubTurtles</b>"];

  for (const turtle of runningTurtles) {
    const summary = turtleStateMap.get(turtle.name) || null;
    const taskSource = summary?.currentTask || turtle.task || "No current task";
    const taskLine = truncateText(taskSource, 120);
    const metaLine = formatLiveBoardMetaLine(turtle, summary);

    messageLines.push("");
    messageLines.push(`${subturtleStatusEmoji(turtle.status)} <b>${escapeHtml(turtle.name)}</b>`);
    messageLines.push(convertMarkdownToHtml(taskLine));
    if (metaLine) {
      messageLines.push(metaLine);
    }
  }

  return messageLines;
}

export function listSubturtles(): ListedSubTurtle[] {
  const proc = Bun.spawnSync([CTL_PATH, "list"], {
    cwd: WORKING_DIR,
    env: {
      ...process.env,
      SUPER_TURTLE_PROJECT_DIR: WORKING_DIR,
      CLAUDE_WORKING_DIR: WORKING_DIR,
    },
  });
  const output = proc.stdout.toString().trim();
  if (!output || output.includes("No SubTurtles")) {
    return [];
  }
  return parseCtlListOutput(output);
}

export async function getSubTurtleElapsed(name: string): Promise<string> {
  try {
    const metaPath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/subturtle.meta`;
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
  lines.push(
    "",
    `<b>Runtime:</b> ${escapeHtml(SUPERTURTLE_RUNTIME_PROFILE)} · driver ${escapeHtml(session.activeDriver)}`,
    "<b>Teleport:</b> disabled in this branch"
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export async function handleTeleport(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await ctx.reply(`ℹ️ ${TELEPORT_DISABLED_MESSAGE}`);
}

export async function handleHome(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await ctx.reply(`ℹ️ ${TELEPORT_DISABLED_MESSAGE}`);
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
        `Start the bot with 'superturtle start' (or 'node super_turtle/bin/superturtle.js start' in this repo) and retry.\n${reason}${tried}`
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

  // Support direct driver switch: /model claude or /model codex
  const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
  const target = args[0]?.toLowerCase();

  if (target === "claude" || target === "codex") {
    const error = await performDriverSwitch(target);
    if (error) {
      await ctx.reply(error);
      return;
    }
    // Show the model picker for the new driver
    if (target === "codex") {
      return handleCodexModel(ctx);
    }
    const picker = buildClaudeModelPickerMessage();
    await ctx.reply(picker.text, {
      parse_mode: "HTML",
      reply_markup: picker.replyMarkup,
    });
    return;
  }

  if (target) {
    await ctx.reply(`❌ Unknown driver: ${target}. Use /model claude or /model codex`);
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
 * /switch - Legacy redirect to /model.
 */
export async function handleSwitch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await ctx.reply("/switch has been merged into /model. Use /model to change your driver, model, or effort level.");
}

/**
 * Perform a driver switch. Returns null on success, error message on failure.
 */
export async function performDriverSwitch(
  driver: "claude" | "codex"
): Promise<string | null> {
  if (driver === "codex" && !CODEX_AVAILABLE) {
    return getCodexUnavailableMessage();
  }
  await resetAllDriverSessions({ stopRunning: true });
  if (driver === "codex") {
    try {
      await codexSession.startNewThread();
    } catch (error) {
      return `❌ Failed to switch to Codex: ${String(error).slice(0, 100)}`;
    }
  }
  session.activeDriver = driver;
  return null;
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

function buildDriverRow(): ModelPickerButton[][] {
  const codexButton = CODEX_AVAILABLE
    ? {
        text: `${session.activeDriver === "codex" ? "✔ " : ""}Codex 🟢`,
        callback_data: "switch:codex",
      }
    : {
        text: "Codex (unavailable)",
        callback_data: "switch:codex_unavailable",
      };
  return [[
    {
      text: `${session.activeDriver === "claude" ? "✔ " : ""}Claude Code 🔵`,
      callback_data: "switch:claude",
    },
    codexButton,
  ]];
}

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
  const driverRow = buildDriverRow();

  return {
    text:
      `<b>Driver:</b> Claude Code 🔵\n` +
      `<b>Model:</b> ${modelName}${modelDesc}\n` +
      `<b>Effort:</b> ${currentEffort}\n\n` +
      `Select driver, model, or effort level:`,
    replyMarkup: {
      inline_keyboard: [...driverRow, ...modelButtons, ...effortButtons],
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
  const driverRow = buildDriverRow();

  return {
    text:
      `<b>Driver:</b> Codex 🟢\n` +
      `<b>Codex Model:</b> ${modelName}${modelDesc}\n` +
      `<b>Reasoning Effort:</b> ${currentEffort}\n\n` +
      `Select driver, model, or reasoning effort:`,
    replyMarkup: {
      inline_keyboard: [...driverRow, ...modelButtons, ...effortButtons],
    },
  };
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
    const result = await getContextReport(session.sessionId, WORKING_DIR, session.model);
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
 * /update - Install an exact SuperTurtle package version inside the remote sandbox.
 */
export async function handleUpdate(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (SUPERTURTLE_RUNTIME_PROFILE !== "managed") {
    await ctx.reply("ℹ️ Self-update is only supported inside the managed E2B runtime.");
    return;
  }

  const request = parseSelfUpdateRequest(readCommandArgumentText(ctx.message?.text));
  if (!request) {
    await ctx.reply(
      `⚠️ ${UPDATE_USAGE_TEXT}\nDefault update channel: ${SUPERTURTLE_RUNTIME_UPDATE_DIST_TAG}.`
    );
    return;
  }

  await startRemoteSelfUpdate({
    chatId,
    request,
    reply: async (text) => ctx.reply(text),
  });
}


/**
 * /subturtle - List all SubTurtles with status and controls.
 */
async function buildSubturtleOverviewLines(
  turtles: ListedSubTurtle[],
  options: { includeRunningPicker?: boolean; page?: number } = {}
): Promise<string[]> {
  const includeRunningPicker = options.includeRunningPicker ?? true;
  const page = options.page ?? 0;
  const runningTurtles = turtles.filter((t) => t.status === "running");
  const rootStatePath = `${WORKING_DIR}/CLAUDE.md`;
  const [rootSummary, turtleStateEntries] = await Promise.all([
    readClaudeStateSummary(rootStatePath),
    Promise.all(
      turtles.map(async (turtle) => {
        const statePath = `${SUPERTURTLE_SUBTURTLES_DIR}/${turtle.name}/CLAUDE.md`;
        const summary = await readClaudeStateSummary(statePath);
        return [turtle.name, summary] as const;
      })
    ),
  ]);
  const turtleStateMap = new Map(turtleStateEntries);

  const messageLines: string[] = ["🐢 <b>SubTurtles</b>\n"];

  if (rootSummary) {
    const rootTask = rootSummary.currentTask || "No current task in root CLAUDE.md";
    messageLines.push(`🧭 <b>Root</b> • ${escapeHtml(truncateText(rootTask, 110))}`);
    messageLines.push(`   📌 ${escapeHtml(truncateText(formatBacklogSummary(rootSummary), 140))}`);
    messageLines.push("");
  }

  for (const turtle of turtles) {
    const stateSummary = turtleStateMap.get(turtle.name) || null;

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

    if (turtle.tunnelUrl) {
      messageLines.push(`   🔗 ${escapeHtml(turtle.tunnelUrl)}`);
    }
  }

  if (includeRunningPicker && runningTurtles.length > 0) {
    const totalPages = Math.ceil(runningTurtles.length / SUBTURTLE_MENU_PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    if (totalPages > 1) {
      messageLines.push("");
      messageLines.push(
        `📚 <b>Running picker:</b> page ${safePage + 1}/${totalPages} (${runningTurtles.length} running)`
      );
    }
  }

  return messageLines;
}

function buildSubturtleDetailMessage(
  turtle: ListedSubTurtle,
  options: {
    stopCallbackData?: string;
    backlogCallbackData?: string;
    logsCallbackData?: string;
    backButton?: InlineKeyboardButton | null;
  } = {}
): Promise<{ text: string; replyMarkup: InlineKeyboardMarkup }> {
  const stopCallbackData = options.stopCallbackData || `subturtle_stop:${turtle.name}`;
  const backlogCallbackData = options.backlogCallbackData || `sub_bl:${turtle.name}:0`;
  const logsCallbackData = options.logsCallbackData || `sub_lg:${turtle.name}:0`;
  return (async () => {
    const statePath = `${SUPERTURTLE_SUBTURTLES_DIR}/${turtle.name}/CLAUDE.md`;
    const summary = await readClaudeStateSummary(statePath);

    const taskSource = summary?.currentTask || turtle.task || "No current task";
    const metaLine = formatLiveBoardMetaLine(turtle, summary, { includeTimeout: true });
    const lines: string[] = [
      `${subturtleStatusEmoji(turtle.status)} <b>${escapeHtml(turtle.name)}</b>`,
      "",
      convertMarkdownToHtml(taskSource),
    ];

    if (metaLine) {
      lines.push("", metaLine);
    }

    if (turtle.tunnelUrl) {
      lines.push("", escapeHtml(turtle.tunnelUrl));
    }

    const keyboard: InlineKeyboardButton[][] = [
      [
        { text: "📝 Tasks", callback_data: backlogCallbackData },
        { text: "📜 Logs", callback_data: logsCallbackData },
      ],
      [{ text: "🛑 Stop", callback_data: stopCallbackData }],
    ];

    if (options.backButton) {
      keyboard.push([options.backButton]);
    }

    return {
      text: lines.join("\n"),
      replyMarkup: { inline_keyboard: keyboard },
    };
  })();
}

export async function buildSubturtleBacklogMessage(
  name: string,
  page: number,
  options: {
    callbackPrefix?: string;
    backButton?: InlineKeyboardButton | null;
  } = {}
): Promise<{ text: string; replyMarkup: InlineKeyboardMarkup } | null> {
  const callbackPrefix = options.callbackPrefix || "sub_bl:";
  const statePath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/CLAUDE.md`;
  const [summary, backlog] = await Promise.all([
    readClaudeStateSummary(statePath),
    readClaudeBacklogItems(statePath),
  ]);
  const turtle = findListedSubturtle(name);

  if (!summary || backlog.length === 0) {
    return null;
  }

  const totalPages = Math.ceil(backlog.length / BACKLOG_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * BACKLOG_PAGE_SIZE;
  const pageItems = backlog.slice(start, start + BACKLOG_PAGE_SIZE);
  const doneCount = backlog.filter((item) => item.done).length;
  const lines: string[] = [
    `📝 <b>Tasks for ${escapeHtml(name)}</b>`,
    `${doneCount}/${backlog.length} done — page ${safePage + 1}/${totalPages}`,
  ];
  const timeout = turtle ? formatSubturtleTimeout(turtle) : null;
  if (timeout) {
    lines.push(`⏱️ Timeout: ${timeout}`);
  }
  lines.push("");

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i]!;
    const status = item.done ? "✅" : "⬜";
    const currentTag = item.current ? " ← current" : "";
    const idx = start + i + 1;
    lines.push(`${idx}. ${status} ${convertMarkdownToHtml(item.text)}${currentTag}`);
  }

  const keyboard: InlineKeyboardButton[][] = [];
  const navButtons: InlineKeyboardButton[] = [];
  if (safePage > 0) {
    navButtons.push({ text: "◀ Prev", callback_data: `${callbackPrefix}${name}:${safePage - 1}` });
  }
  if (safePage < totalPages - 1) {
    navButtons.push({ text: "▶ Next", callback_data: `${callbackPrefix}${name}:${safePage + 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  if (options.backButton) {
    keyboard.push([options.backButton]);
  }

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: keyboard },
  };
}

export async function buildSubturtleLogMessage(
  name: string,
  page: number,
  options: {
    callbackPrefix?: string;
    backButton?: InlineKeyboardButton | null;
  } = {}
): Promise<{ text: string; replyMarkup: InlineKeyboardMarkup } | null> {
  const callbackPrefix = options.callbackPrefix || "sub_lg:";
  const logPath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/subturtle.log`;
  const turtle = findListedSubturtle(name);
  const logFile = Bun.file(logPath);
  if (!(await logFile.exists())) {
    return null;
  }

  const content = await logFile.text();
  const allLines = content.split("\n").filter((line) => line.trim().length > 0);
  if (allLines.length === 0) {
    return null;
  }

  const reversed = [...allLines].reverse();
  const totalPages = Math.ceil(reversed.length / LOG_LINES_PER_PAGE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * LOG_LINES_PER_PAGE;
  const pageLines = reversed.slice(start, start + LOG_LINES_PER_PAGE);
  pageLines.reverse();

  const timeout = turtle ? formatSubturtleTimeout(turtle) : null;
  const headerLines = [`📜 <b>Logs for ${escapeHtml(name)}</b> — page ${safePage + 1}/${totalPages}`];
  if (timeout) {
    headerLines.push(`⏱️ Timeout: ${timeout}`);
  }
  const header = `${headerLines.join("\n")}\n`;
  const logText = pageLines.map((line) => escapeHtml(line)).join("\n");
  const maxLogLength = 4000 - header.length - 100;
  const truncatedLog = logText.length > maxLogLength
    ? `${logText.slice(0, maxLogLength)}\n...`
    : logText;
  const body = `${header}<pre>${truncatedLog}</pre>`;

  const keyboard: InlineKeyboardButton[][] = [];
  const navButtons: InlineKeyboardButton[] = [];
  if (safePage < totalPages - 1) {
    navButtons.push({ text: "◀ Older", callback_data: `${callbackPrefix}${name}:${safePage + 1}` });
  }
  if (safePage > 0) {
    navButtons.push({ text: "▶ Newer", callback_data: `${callbackPrefix}${name}:${safePage - 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  if (options.backButton) {
    keyboard.push([options.backButton]);
  }

  return {
    text: body,
    replyMarkup: { inline_keyboard: keyboard },
  };
}

async function buildLiveSubturtleBoardPayload(
  turtles: ListedSubTurtle[],
  view: LiveSubturtleBoardView
): Promise<{ text: string; replyMarkup?: InlineKeyboardMarkup; view: LiveSubturtleBoardView }> {
  if (view.kind === "detail") {
    const turtle = turtles.find((item) => item.name === view.name);
    if (turtle) {
      const payload = await buildSubturtleDetailMessage(turtle, {
        stopCallbackData: `sub_board_stop:${view.name}`,
        backlogCallbackData: `sub_board_bl:${view.name}:0`,
        logsCallbackData: `sub_board_lg:${view.name}:0`,
        backButton: { text: "Back", callback_data: "sub_board_home" },
      });
      return { ...payload, view };
    }
  }

  if (view.kind === "backlog") {
    const payload = await buildSubturtleBacklogMessage(view.name, view.page, {
      callbackPrefix: "sub_board_bl:",
      backButton: { text: "Back", callback_data: `sub_board_pick:${view.name}` },
    });
    if (payload) {
      return { ...payload, view };
    }
  }

  if (view.kind === "logs") {
    const payload = await buildSubturtleLogMessage(view.name, view.page, {
      callbackPrefix: "sub_board_lg:",
      backButton: { text: "Back", callback_data: `sub_board_pick:${view.name}` },
    });
    if (payload) {
      return { ...payload, view };
    }
  }

  if (turtles.length === 0) {
    return { ...noSubturtlesMessage(), view: { kind: "board" } };
  }

  const runningTurtles = turtles.filter((t) => t.status === "running");
  if (runningTurtles.length === 0) {
    return { ...noSubturtlesMessage(), view: { kind: "board" } };
  }

  const messageLines = await buildLiveSubturtleBoardHomeLines(turtles);
  const keyboard: InlineKeyboardButton[][] = [];

  if (runningTurtles.length === 1) {
    const turtle = runningTurtles[0]!;
    keyboard.push([
      { text: "📝 Tasks", callback_data: `sub_board_bl:${turtle.name}:0` },
      { text: "📜 Logs", callback_data: `sub_board_lg:${turtle.name}:0` },
    ]);
    keyboard.push([{ text: "🛑 Stop", callback_data: `sub_board_stop:${turtle.name}` }]);
  } else {
    for (const turtle of runningTurtles.slice(0, LIVE_SUBTURTLE_BOARD_MAX_BUTTONS)) {
      keyboard.push([
        { text: `🐢 ${turtle.name}`, callback_data: `sub_board_pick:${turtle.name}` },
      ]);
    }
  }

  if (runningTurtles.length > LIVE_SUBTURTLE_BOARD_MAX_BUTTONS) {
    messageLines.push("");
    messageLines.push(
      `…and ${runningTurtles.length - LIVE_SUBTURTLE_BOARD_MAX_BUTTONS} more running workers. Use /sub for the full picker.`
    );
  }

  return {
    text: messageLines.join("\n"),
    replyMarkup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    view: { kind: "board" },
  };
}

export async function buildLiveSubturtleBoardMessage(
  turtles: ListedSubTurtle[]
): Promise<{ text: string; replyMarkup?: InlineKeyboardMarkup }> {
  const payload = await buildLiveSubturtleBoardPayload(turtles, { kind: "board" });
  return { text: payload.text, replyMarkup: payload.replyMarkup };
}

type LiveSubturtleBoardSyncResult = {
  status: "created" | "updated" | "unchanged" | "skipped" | "unestablished";
  messageId: number | null;
  view: LiveSubturtleBoardView;
};

export async function syncLiveSubturtleBoard(
  api: LiveSubturtleBoardApi,
  chatId: number,
  options: {
    force?: boolean;
    pin?: boolean;
    disableNotification?: boolean;
    view?: LiveSubturtleBoardView;
    createIfMissing?: boolean;
    targetMessageId?: number;
    allowCreateOnEditFailure?: boolean;
  } = {}
): Promise<LiveSubturtleBoardSyncResult> {
  return withLiveSubturtleBoardLock<LiveSubturtleBoardSyncResult>(chatId, async () => {
    const turtles = listSubturtles();
    const hasActiveWorkers = turtles.some((turtle) => turtle.status === "running");
    const record = readLiveSubturtleBoardRecord(chatId);
    const shouldCreateIfMissing = options.createIfMissing ?? hasActiveWorkers;
    const targetMessageId =
      typeof options.targetMessageId === "number" && Number.isFinite(options.targetMessageId)
        ? options.targetMessageId
        : null;
    const allowCreateOnEditFailure = options.allowCreateOnEditFailure ?? true;
    let recoveredPinnedBoard: { messageId: number; view: LiveSubturtleBoardView } | null | undefined;

    const loadRecoveredPinnedBoard = async () => {
      if (typeof recoveredPinnedBoard !== "undefined") {
        return recoveredPinnedBoard;
      }
      recoveredPinnedBoard = await recoverPinnedLiveSubturtleBoard(api, chatId);
      return recoveredPinnedBoard;
    };

    if (!record && !shouldCreateIfMissing) {
      return { status: "skipped", messageId: null, view: { kind: "board" } };
    }

    if (targetMessageId === null && !record) {
      await loadRecoveredPinnedBoard();
    }

    const targetView = normalizeLiveSubturtleBoardView(
      options.view || record?.current_view || recoveredPinnedBoard?.view || { kind: "board" }
    );
    const payload = await buildLiveSubturtleBoardPayload(turtles, targetView);
    const renderHash = computeLiveSubturtleBoardHash(payload.text, payload.replyMarkup);
    const now = nowIso();

    const saveRecord = (
      messageId: number,
      createdAt?: string,
      pinState: LiveSubturtleBoardPinState = "established"
    ) => {
      writeLiveSubturtleBoardRecord({
        chat_id: chatId,
        message_id: messageId,
        last_render_hash: renderHash,
        last_rendered_at: now,
        created_at: createdAt || record?.created_at || now,
        updated_at: now,
        pin_state: pinState,
        current_view: payload.view,
      });
    };
    const clearRecord = () => {
      deleteLiveSubturtleBoardRecord(chatId);
    };

    const pinMessage = async (messageId: number): Promise<LiveSubturtleBoardPinState> => {
      if (!options.pin || !api.pinChatMessage) return "established";
      try {
        await api.pinChatMessage(chatId, messageId, {
          disable_notification: options.disableNotification ?? true,
        });
        return "established";
      } catch (error) {
        const summary = String(error).toLowerCase();
        if (
          summary.includes("message is already pinned") ||
          summary.includes("chat not modified")
        ) {
          return "established";
        }
        if (summary.includes("not enough rights")) {
          return "unestablished";
        }
        throw error;
      }
    };

    const unpinMessage = async (messageId: number) => {
      if (!api.unpinChatMessage) return;
      try {
        await api.unpinChatMessage(chatId, messageId);
      } catch (error) {
        const summary = String(error).toLowerCase();
        if (
          !summary.includes("message to unpin not found") &&
          !summary.includes("message is not pinned") &&
          !summary.includes("chat not modified") &&
          !summary.includes("not enough rights")
        ) {
          throw error;
        }
      }
    };

    const deleteMessage = async (messageId: number) => {
      if (!api.deleteMessage) return;
      try {
        await api.deleteMessage(chatId, messageId);
      } catch (error) {
        const summary = String(error).toLowerCase();
        if (
          !summary.includes("message to delete not found") &&
          !summary.includes("message can't be deleted") &&
          !summary.includes("message identifier is not specified")
        ) {
          throw error;
        }
      }
    };

    const cleanupSupersededMessages = async (messageIds: Array<number | null | undefined>) => {
      const uniqueIds = Array.from(
        new Set(
          messageIds.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        )
      );
      for (const messageId of uniqueIds) {
        await unpinMessage(messageId);
        await deleteMessage(messageId);
      }
    };

    const finalizeExistingBoardMessage = async (
      messageId: number,
      status: "updated" | "unchanged",
      supersededMessageIds: Array<number | null | undefined> = []
    ): Promise<LiveSubturtleBoardSyncResult> => {
      if (hasActiveWorkers) {
        const pinState = await pinMessage(messageId);
        saveRecord(messageId, undefined, pinState);
        await cleanupSupersededMessages(supersededMessageIds);
        return {
          status: pinState === "established" ? status : "unestablished",
          messageId,
          view: payload.view,
        };
      } else {
        await unpinMessage(messageId);
        clearRecord();
      }
      await cleanupSupersededMessages(supersededMessageIds);
      return { status, messageId, view: payload.view };
    };

    const editExistingBoardMessage = async (
      messageId: number,
      supersededMessageIds: Array<number | null | undefined> = []
    ): Promise<LiveSubturtleBoardSyncResult> => {
      try {
        await api.editMessageText(chatId, messageId, payload.text, {
          parse_mode: "HTML",
          reply_markup: payload.replyMarkup,
        });
        return await finalizeExistingBoardMessage(messageId, "updated", supersededMessageIds);
      } catch (error) {
        if (shouldIgnoreUnchangedMessageError(error)) {
          return await finalizeExistingBoardMessage(messageId, "unchanged", supersededMessageIds);
        }
        throw error;
      }
    };

    if (record && !options.force) {
      const ageMs = Date.now() - Date.parse(record.updated_at);
      if (
        record.last_render_hash === renderHash &&
        Number.isFinite(ageMs) &&
        ageMs < LIVE_SUBTURTLE_BOARD_REFRESH_MIN_MS
      ) {
        if (hasActiveWorkers) {
          const pinState = await pinMessage(record.message_id);
          saveRecord(record.message_id, undefined, pinState);
          return {
            status: pinState === "established" ? "unchanged" : "unestablished",
            messageId: record.message_id,
            view: record.current_view || payload.view,
          };
        } else {
          await unpinMessage(record.message_id);
          clearRecord();
        }
        return {
          status: "unchanged",
          messageId: record.message_id,
          view: record.current_view || payload.view,
        };
      }
    }

    const editMessageId = targetMessageId ?? record?.message_id ?? recoveredPinnedBoard?.messageId ?? null;

    if (editMessageId !== null) {
      const supersededMessageIds =
        record && record.message_id !== editMessageId ? [record.message_id] : [];
      try {
        return await editExistingBoardMessage(editMessageId, supersededMessageIds);
      } catch (error) {
        if (!allowCreateOnEditFailure || !shouldRecreateLiveBoard(error)) {
          throw error;
        }
        if (targetMessageId === null) {
          const recoveredBoard = await loadRecoveredPinnedBoard();
          if (recoveredBoard && recoveredBoard.messageId !== editMessageId) {
            try {
              return await editExistingBoardMessage(recoveredBoard.messageId, [
                record?.message_id,
              ]);
            } catch (recoveredError) {
              if (!allowCreateOnEditFailure || !shouldRecreateLiveBoard(recoveredError)) {
                throw recoveredError;
              }
              await cleanupSupersededMessages([
                record?.message_id,
                editMessageId,
                recoveredBoard.messageId,
              ]);
            }
          } else {
            await cleanupSupersededMessages([
              record?.message_id,
              editMessageId,
            ]);
          }
        } else {
          await cleanupSupersededMessages([
            record?.message_id,
            editMessageId !== record?.message_id ? editMessageId : null,
          ]);
        }
      }
    }

    const message = await api.sendMessage(chatId, payload.text, {
      parse_mode: "HTML",
      reply_markup: payload.replyMarkup,
      disable_notification: options.disableNotification ?? true,
    });
    const messageId = typeof message.message_id === "number" ? message.message_id : null;
    if (messageId === null) {
      return { status: "created", messageId: null, view: payload.view };
    }
    if (hasActiveWorkers) {
      const pinState = await pinMessage(messageId);
      saveRecord(messageId, now, pinState);
      return {
        status: pinState === "established" ? "created" : "unestablished",
        messageId,
        view: payload.view,
      };
    } else {
      await unpinMessage(messageId);
      clearRecord();
    }
    return { status: "created", messageId, view: payload.view };
  });
}

export async function handleSubturtle(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if a specific SubTurtle name was given (e.g. "/sub texting-page")
  const messageText = ctx.message?.text || "";
  const argName = messageText.split(/\s+/).slice(1).join(" ").trim();
  const turtles = listSubturtles();

  if (turtles.length === 0) {
    if (chatId) {
      await syncLiveSubturtleBoard(ctx.api, chatId, {
        force: true,
        pin: true,
        createIfMissing: true,
      });
      return;
    }
    const empty = noSubturtlesMessage();
    await ctx.reply(empty.text, { parse_mode: "HTML", reply_markup: empty.replyMarkup });
    return;
  }

  // If a specific name was given, show that SubTurtle's detail view directly
  if (argName) {
    const match = turtles.find((t) => t.name === argName);
    if (!match) {
      await ctx.reply(`❌ SubTurtle <b>${escapeHtml(argName)}</b> not found`, { parse_mode: "HTML" });
      return;
    }
    await replySubturtleDetail(ctx, match, false);
    return;
  }

  if (!chatId) {
    const menu = await buildSubturtleMenuMessage(turtles);
    await ctx.reply(menu.text, {
      parse_mode: "HTML",
      reply_markup: menu.replyMarkup,
    });
    return;
  }

  const result = await syncLiveSubturtleBoard(ctx.api, chatId, {
    force: true,
    pin: true,
    disableNotification: false,
    createIfMissing: true,
  });

  if (result.status === "updated" || result.status === "unchanged") {
    await ctx.reply("📌 SubTurtle board refreshed.");
    return;
  }

  if (result.status === "unestablished") {
    await ctx.reply("⚠️ SubTurtle board updated, but Telegram did not allow pinning it.");
  }
}

export async function buildSubturtleMenuMessage(
  turtles: ListedSubTurtle[],
  page = 0
): Promise<{ text: string; replyMarkup?: InlineKeyboardMarkup }> {
  const runningTurtles = turtles.filter((t) => t.status === "running");
  const messageLines = await buildSubturtleOverviewLines(turtles, {
    includeRunningPicker: true,
    page,
  });

  const keyboard: InlineKeyboardButton[][] = [];

  if (runningTurtles.length > 0) {
    const totalPages = Math.ceil(runningTurtles.length / SUBTURTLE_MENU_PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * SUBTURTLE_MENU_PAGE_SIZE;
    const pageTurtles = runningTurtles.slice(start, start + SUBTURTLE_MENU_PAGE_SIZE);

    for (const turtle of pageTurtles) {
      keyboard.push([
        { text: `🐢 ${turtle.name}`, callback_data: `sub_pick:${turtle.name}:${safePage}` },
      ]);
    }

    if (totalPages > 1) {
      const navButtons: InlineKeyboardButton[] = [];
      if (safePage > 0) {
        navButtons.push({ text: "◀ Prev", callback_data: `sub_menu:${safePage - 1}` });
      }
      if (safePage < totalPages - 1) {
        navButtons.push({ text: "▶ Next", callback_data: `sub_menu:${safePage + 1}` });
      }
      if (navButtons.length > 0) {
        keyboard.push(navButtons);
      }
    }
  }

  return {
    text: messageLines.join("\n"),
    replyMarkup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
  };
}

/**
 * Show a single SubTurtle's detail view with action buttons.
 * Used by /sub <name> and sub_pick:{name} callback.
 * showMenu: whether to show the "↩ Menu" button (true when picking from multiple).
 */
export async function replySubturtleDetail(
  ctx: Context,
  turtle: ListedSubTurtle,
  showMenu: boolean,
  mode: "reply" | "edit" = "reply",
  menuPage = 0
): Promise<void> {
  const message = await buildSubturtleDetailMessage(turtle, {
    backButton: showMenu ? { text: "↩ Menu", callback_data: `sub_menu:${menuPage}` } : null,
  });
  const payload = {
    parse_mode: "HTML" as const,
    reply_markup: message.replyMarkup,
  };

  if (mode === "edit") {
    await ctx.editMessageText(message.text, payload);
    return;
  }

  await ctx.reply(message.text, payload);
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
  const { getAllDeferredQueues } = await import("../deferred-queue");
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
