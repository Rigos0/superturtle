/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  OPENAI_API_KEY,
  TRANSCRIPTION_PROMPT,
  TRANSCRIPTION_AVAILABLE,
} from "./config";
import { logger } from "./logger";

const utilsLog = logger.child({ module: "utils" });

export function generateRequestId(prefix = "req"): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    utilsLog.error({ err: error }, "Failed to write audit log");
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = "",
  metadata?: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    Object.assign(event, metadata);
  }
  await writeAuditLog(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean,
  metadata?: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    Object.assign(event, metadata);
  }
  await writeAuditLog(event);
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: toolInput,
    blocked,
  };
  if (blocked && reason) {
    event.reason = reason;
  }
  await writeAuditLog(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = "",
  metadata?: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    Object.assign(event, metadata);
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    Object.assign(event, metadata);
  }
  await writeAuditLog(event);
}

// ============== Voice Transcription ==============

export async function transcribeVoice(
  filePath: string
): Promise<string | null> {
  if (!openaiClient) {
    utilsLog.warn("OpenAI client not available for transcription");
    return null;
  }

  try {
    const file = Bun.file(filePath);
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    utilsLog.error({ err: error }, "Transcription failed");
    return null;
  }
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        utilsLog.debug({ err: error }, "Typing indicator failed");
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

// Import session lazily to avoid circular dependency
let sessionModule: {
  session: {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    stopTyping: () => void;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  };
} | null = null;

export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  // Lazy import to avoid circular dependency
  if (!sessionModule) {
    sessionModule = await import("./session");
  }

  const strippedText = text.slice(1).trimStart();

  if (sessionModule.session.isRunning) {
    utilsLog.info("! prefix - interrupting current query");
    sessionModule.session.stopTyping();
    sessionModule.session.markInterrupt();
    await sessionModule.session.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    sessionModule.session.clearStopRequested();
  }

  return strippedText;
}

const STOP_KEYWORDS = new Set([
  "stop",
  "stopp",
  "stahp",
  "pause",
  "abort",
  "halt",
  "cancel",
]);

const STOP_TAIL_WORDS = new Set([
  "it",
  "now",
  "please",
  "this",
  "that",
  "everything",
  "all",
  "run",
  "runs",
  "query",
  "queries",
  "job",
  "jobs",
  "task",
  "tasks",
  "work",
  "working",
  "process",
  "processes",
  "agent",
  "subturtle",
  "subturtles",
  "current",
  "the",
  "for",
  "right",
  "away",
  "immediately",
  "thanks",
  "thank",
  "you",
  "to",
  "my",
  "your",
  "our",
  "stop",
]);

function normalizeStopIntentText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9!\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isStopIntent(text: string): boolean {
  const normalized = normalizeStopIntentText(text);

  if (!normalized) {
    return false;
  }

  if (normalized === "!") {
    return true;
  }

  if (normalized.startsWith("!")) {
    const bangCommand = normalized.slice(1).trim();
    return bangCommand === "stop";
  }

  const words = normalized.split(" ");
  if (words.length === 0) {
    return false;
  }

  let idx = 0;
  while (words[idx] === "please" || words[idx] === "hey" || words[idx] === "ok" || words[idx] === "okay") {
    idx += 1;
  }

  const helperVerb = words[idx];
  const helperYou = words[idx + 1];
  if (
    (helperVerb === "can" || helperVerb === "could" || helperVerb === "would" || helperVerb === "will") &&
    helperYou === "you"
  ) {
    idx += 2;
    if (words[idx] === "please") {
      idx += 1;
    }
  }

  const keyword = words[idx];
  if (!keyword || !STOP_KEYWORDS.has(keyword)) {
    return false;
  }

  for (const tailWord of words.slice(idx + 1)) {
    if (!STOP_TAIL_WORDS.has(tailWord)) {
      return false;
    }
  }

  return true;
}
