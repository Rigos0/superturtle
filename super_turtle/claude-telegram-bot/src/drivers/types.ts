import type { Context } from "grammy";
import type { StatusCallback } from "../types";

export type DriverId = "claude" | "codex";
export type DriverStopResult = "stopped" | "pending" | false;
export type DriverAuditEvent = "TEXT" | "TEXT_CODEX";
export type DriverRunSource =
  | "text"
  | "voice"
  | "photo"
  | "audio"
  | "video"
  | "document"
  | "archive"
  | "callback"
  | "queue_text"
  | "queue_voice"
  | "cron_silent"
  | "cron_scheduled"
  | "background_snapshot";

export interface DriverUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

export interface DriverStatusSnapshot {
  driverName: string;
  isActive: boolean;
  sessionId: string | null;
  lastActivity: Date | null;
  lastError: string | null;
  lastErrorTime: Date | null;
  lastUsage: DriverUsage | null;
}

export interface DriverRunInput {
  message: string;
  source: DriverRunSource;
  username: string;
  userId: number;
  chatId: number;
  ctx: Context;
  statusCallback: StatusCallback;
}

export interface ChatDriver {
  id: DriverId;
  displayName: string;
  auditEvent: DriverAuditEvent;
  runMessage(input: DriverRunInput): Promise<string>;
  stop(): Promise<DriverStopResult>;
  kill(): Promise<void>;
  isCrashError(error: unknown): boolean;
  isStallError(error: unknown): boolean;
  isCancellationError(error: unknown): boolean;
  getStatusSnapshot(): DriverStatusSnapshot;
}
