import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { SUPERTURTLE_DATA_DIR, TOKEN_PREFIX } from "./config";
import type { DriverId } from "./drivers/types";

export const STARTUP_NOTIFICATION_OPENERS = [
  "Listening for messages.",
  "Polling is live.",
  "Runtime is healthy.",
  "Control link is up.",
  "Session restored.",
  "Ready for commands.",
  "Systems look good.",
  "Standing by.",
  "Bot loop is live.",
  "Telegram link is active.",
  "Driver loaded cleanly.",
  "All checks passed.",
  "Ready for the next task.",
  "Console is steady.",
  "The shell is warm.",
  "Work queue is clear.",
  "New boot, same turtle.",
  "Online and reachable.",
  "The line is open.",
  "Ready to continue.",
  "Fresh process, ready to work.",
  "Back in service.",
  "Monitoring started.",
  "Everything is up.",
  "Start sequence complete.",
  "Ready on this repo.",
  "Tools are loaded.",
  "Status is green.",
  "Awaiting input.",
  "Ready on the wire.",
] as const;

const STARTUP_WELCOME_SCHEMA_VERSION = 1;

export const STARTUP_WELCOME_STATE_PATH = `${SUPERTURTLE_DATA_DIR}/startup-welcome.json`;

export interface StartupWelcomeRecord {
  schema_version: number;
  bot_token_prefix: string;
  sent_at: string;
  chat_id: number;
  user_id: number | null;
}

let cachedStartupWelcome: StartupWelcomeRecord | null | undefined;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function parseStartupWelcomeRecord(raw: unknown): StartupWelcomeRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (record.schema_version !== STARTUP_WELCOME_SCHEMA_VERSION) {
    return null;
  }
  if (record.bot_token_prefix !== TOKEN_PREFIX) {
    return null;
  }
  if (!isFiniteInteger(record.chat_id)) {
    return null;
  }
  if (record.user_id !== null && !isFiniteInteger(record.user_id)) {
    return null;
  }
  if (typeof record.sent_at !== "string" || !record.sent_at.trim()) {
    return null;
  }

  return {
    schema_version: STARTUP_WELCOME_SCHEMA_VERSION,
    bot_token_prefix: TOKEN_PREFIX,
    sent_at: record.sent_at,
    chat_id: record.chat_id,
    user_id: record.user_id === null ? null : record.user_id,
  };
}

function writeStartupWelcomeRecord(record: StartupWelcomeRecord): void {
  mkdirSync(dirname(STARTUP_WELCOME_STATE_PATH), { recursive: true });
  const tempPath = `${STARTUP_WELCOME_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  renameSync(tempPath, STARTUP_WELCOME_STATE_PATH);
}

export function clearStartupWelcomeCache(): void {
  cachedStartupWelcome = undefined;
}

export function getStartupWelcomeState(): StartupWelcomeRecord | null {
  if (cachedStartupWelcome !== undefined) {
    return cachedStartupWelcome;
  }

  if (!existsSync(STARTUP_WELCOME_STATE_PATH)) {
    cachedStartupWelcome = null;
    return cachedStartupWelcome;
  }

  try {
    const parsed = JSON.parse(readFileSync(STARTUP_WELCOME_STATE_PATH, "utf-8"));
    cachedStartupWelcome = parseStartupWelcomeRecord(parsed);
    return cachedStartupWelcome;
  } catch {
    cachedStartupWelcome = null;
    return cachedStartupWelcome;
  }
}

export function hasSentStartupWelcome(): boolean {
  return getStartupWelcomeState() !== null;
}

export function markStartupWelcomeSent(
  chatId: number,
  userId: number | null,
  sentAt = new Date().toISOString()
): StartupWelcomeRecord {
  const record: StartupWelcomeRecord = {
    schema_version: STARTUP_WELCOME_SCHEMA_VERSION,
    bot_token_prefix: TOKEN_PREFIX,
    sent_at: sentAt,
    chat_id: chatId,
    user_id: userId,
  };
  writeStartupWelcomeRecord(record);
  cachedStartupWelcome = record;
  return record;
}

export function deleteStartupWelcomeStateForTests(): void {
  clearStartupWelcomeCache();
  try {
    unlinkSync(STARTUP_WELCOME_STATE_PATH);
  } catch {}
}

function getDriverLabel(driver: DriverId | string): string {
  return driver === "codex" ? "Codex" : "Claude";
}

function formatProjectContext(projectName?: string | null): string {
  const normalized = projectName?.trim() || "";
  return normalized ? ` for ${normalized}` : "";
}

export function pickStartupNotificationOpener(randomValue = Math.random()): string {
  const normalized = Number.isFinite(randomValue) ? randomValue : 0;
  const index = Math.max(
    0,
    Math.min(
      STARTUP_NOTIFICATION_OPENERS.length - 1,
      Math.floor(normalized * STARTUP_NOTIFICATION_OPENERS.length)
    )
  );
  return STARTUP_NOTIFICATION_OPENERS[index]!;
}

export function buildStartupNotificationMessage(options: {
  projectName?: string | null;
  driver: DriverId | string;
  randomValue?: number;
}): string {
  const opener = pickStartupNotificationOpener(options.randomValue);
  return `🐢 Turtle process started${formatProjectContext(options.projectName)}. Driver: ${getDriverLabel(options.driver)}. ${opener}`;
}

export function buildWarmWelcomeMessage(options: {
  projectName?: string | null;
  driver: DriverId | string;
}): string {
  const projectLine = options.projectName?.trim() ? ` Working in ${options.projectName.trim()}.` : "";
  return [
    `Welcome, I am your turtle bot!${projectLine}`,
    `I’m online with ${getDriverLabel(options.driver)} and ready to work from Telegram.`,
    "",
    "What I can do:",
    "• edit code, run commands, debug failures, and explain the repo",
    "• handle text, voice, screenshots, photos, documents, and audio",
    "• spin up SubTurtles for longer tasks and report milestones back here",
    "",
    "Useful commands: /usage, /model, /new, /resume, /sub, /stop",
    "Send a task in plain English and I’ll take it from there.",
  ].join("\n");
}
