/**
 * Pino log reading utilities.
 *
 * Extracted from streaming.ts so they can be reused by the dashboard
 * and any other module that needs to read/filter/format pino log entries.
 */

import { PINO_LOG_PATH, streamLog } from "./logger";

export type PinoLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export const PINO_LEVELS: Record<PinoLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const PINO_LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function formatPinoTimestamp(value: unknown): string {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return "";
  return new Date(asNumber).toISOString().replace("T", " ").replace("Z", "Z");
}

export function formatPinoEntry(entry: Record<string, unknown>): string {
  const time = formatPinoTimestamp(entry.time);
  const levelValue = Number(entry.level);
  const level = PINO_LEVEL_LABELS[levelValue] || "INFO";
  const module = entry.module ? String(entry.module) : "unknown";
  const msg = entry.msg ? String(entry.msg) : "";
  const err = entry.err as Record<string, unknown> | undefined;
  const errMessage = err?.message ? String(err.message) : "";
  const suffix = errMessage ? ` (${errMessage})` : "";
  return `${time} ${level} [${module}] ${msg}${suffix}`.trim();
}

export async function readPinoLogLines(scanLines: number): Promise<string[]> {
  try {
    const file = Bun.file(PINO_LOG_PATH);
    if (!(await file.exists())) return [];

    const result = Bun.spawnSync({
      cmd: ["tail", "-n", String(scanLines), PINO_LOG_PATH],
    });
    const text = result.stdout.toString().trim();
    if (!text) return [];
    return text.split("\n").filter(Boolean);
  } catch (error) {
    streamLog.warn({ err: error }, "Failed to read pino log file");
    return [];
  }
}

export function buildLevelFilter(level?: string, levels?: string[]): Set<number> | null {
  if (levels && levels.length > 0) {
    const exact = new Set<number>();
    for (const item of levels) {
      const value = (PINO_LEVELS as Record<string, number>)[item] ?? null;
      if (value !== null) exact.add(value);
    }
    return exact.size > 0 ? exact : null;
  }

  if (!level || level === "all") return null;
  const normalizedLevel = level in PINO_LEVELS ? (level as PinoLevel) : "error";
  const min = PINO_LEVELS[normalizedLevel];
  const minSet = new Set<number>();
  for (const value of Object.values(PINO_LEVELS)) {
    if (value >= min) minSet.add(value);
  }
  return minSet;
}
