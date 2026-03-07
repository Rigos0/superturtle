import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { dirname } from "path";
import { TOKEN_PREFIX } from "./token-prefix";
import type { DriverId, DriverRunSource } from "./drivers/types";
import type { InjectedArtifact } from "./injected-artifacts";

export type TurnLogStatus = "completed" | "error" | "cancelled";

export interface TurnLogInjectionFlags {
  datePrefixApplied: boolean;
  metaPromptApplied: boolean;
  cronScheduledPromptApplied: boolean;
  backgroundSnapshotPromptApplied: boolean;
}

export interface TurnLogContextFlags {
  claudeMdLoaded: boolean;
  metaSharedLoaded: boolean;
}

export interface TurnLogUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreateInputTokens?: number;
}

export interface TurnLogEntry {
  id: string;
  loggedAt: string;
  driver: DriverId;
  source: DriverRunSource;
  sessionId: string | null;
  userId: number;
  username: string;
  chatId: number;
  model: string;
  effort: string;
  originalMessage: string;
  effectivePrompt: string;
  injectedArtifacts: InjectedArtifact[];
  injections: TurnLogInjectionFlags;
  context: TurnLogContextFlags;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  status: TurnLogStatus;
  response: string | null;
  error: string | null;
  usage: TurnLogUsage | null;
}

type TurnLogEntryInput = Omit<TurnLogEntry, "id" | "loggedAt">;

const TURN_LOG_FILE = `/tmp/claude-telegram-${TOKEN_PREFIX}-turns.jsonl`;

function makeTurnId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getTurnLogPath(): string {
  return TURN_LOG_FILE;
}

export function appendTurnLogEntry(input: TurnLogEntryInput): TurnLogEntry {
  const entry: TurnLogEntry = {
    ...input,
    id: makeTurnId(),
    loggedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(dirname(TURN_LOG_FILE), { recursive: true });
    appendFileSync(TURN_LOG_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Turn logging is best-effort; runtime message handling must continue.
  }

  return entry;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEntry(line: string): TurnLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.driver !== "string" ||
    typeof parsed.source !== "string" ||
    typeof parsed.startedAt !== "string" ||
    typeof parsed.status !== "string"
  ) {
    return null;
  }
  const entry = parsed as unknown as TurnLogEntry;
  if (!Array.isArray(entry.injectedArtifacts)) {
    entry.injectedArtifacts = [];
  }
  return entry;
}

export function readTurnLogEntries(params?: {
  driver?: DriverId;
  sessionId?: string;
  limit?: number;
}): TurnLogEntry[] {
  if (!existsSync(TURN_LOG_FILE)) return [];

  let raw = "";
  try {
    raw = readFileSync(TURN_LOG_FILE, "utf-8");
  } catch {
    return [];
  }

  const entries: TurnLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseEntry(trimmed);
    if (!entry) continue;
    entries.push(entry);
  }

  const filtered = entries.filter((entry) => {
    if (params?.driver && entry.driver !== params.driver) return false;
    if (params?.sessionId && entry.sessionId !== params.sessionId) return false;
    return true;
  });

  if (!params?.limit || params.limit <= 0 || filtered.length <= params.limit) {
    return filtered;
  }
  return filtered.slice(-params.limit);
}

export function clearTurnLogFile(): void {
  try {
    rmSync(TURN_LOG_FILE, { force: true });
  } catch {
    // no-op
  }
}
