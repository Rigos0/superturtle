import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { SUPERTURTLE_DATA_DIR } from "./config";
import type { PreparedSupervisionSnapshot } from "./cron-supervision-queue";
import type {
  WakeupRecord,
  WorkerEventRecord,
  WorkerStateRecord,
} from "./conductor-supervisor";

const DEFAULT_MAX_EVENTS = 8;
const DEFAULT_MAX_WAKEUPS = 6;

interface LoadConductorSnapshotContextOptions {
  stateDir?: string;
  workerName: string;
  maxEvents?: number;
  maxWakeups?: number;
}

interface ConductorSnapshotContext {
  workspacePath: string | null;
  conductorSummary: string;
  workerStateJson: string;
  recentEventsJson: string;
  wakeupsJson: string;
  workerResultJson: string;
  prepErrors: string[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isObjectRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function readJsonlObjects<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return isObjectRecord(parsed) ? [parsed as T] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function stringifyPromptJson(value: unknown, emptyText: string): string {
  if (value === null || value === undefined) return emptyText;
  if (Array.isArray(value) && value.length === 0) return "[]";
  return JSON.stringify(value, null, 2);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortNewestFirst(left: { updated_at?: string | null; created_at?: string | null }, right: { updated_at?: string | null; created_at?: string | null }): number {
  const leftKey = left.updated_at || left.created_at || "";
  const rightKey = right.updated_at || right.created_at || "";
  if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
  return 0;
}

function loadWorkerWakeups(stateDir: string, workerName: string, maxWakeups: number): WakeupRecord[] {
  const wakeupsDir = join(stateDir, "wakeups");
  if (!existsSync(wakeupsDir)) return [];

  return readdirSync(wakeupsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonObject<WakeupRecord>(join(wakeupsDir, name)))
    .filter((record): record is WakeupRecord => record !== null && record.worker_name === workerName)
    .sort(sortNewestFirst)
    .slice(0, maxWakeups);
}

function summarizeCheckpoint(checkpoint: Record<string, unknown> | undefined): string | null {
  if (!checkpoint) return null;
  const iteration = asNumber(checkpoint.iteration);
  const recordedAt = asString(checkpoint.recorded_at);
  const loopType = asString(checkpoint.loop_type);
  const headSha = asString(checkpoint.head_sha);

  const details: string[] = [];
  if (iteration !== null) details.push(`iteration ${iteration}`);
  if (loopType) details.push(loopType);
  if (headSha) details.push(headSha.slice(0, 12));
  if (recordedAt) details.push(`at ${recordedAt}`);

  return details.length > 0 ? details.join(" | ") : null;
}

function summarizeWakeup(wakeup: WakeupRecord): string {
  const payloadKind = asString(wakeup.payload?.kind);
  const parts = [`${wakeup.id}: ${wakeup.category}/${wakeup.delivery_state}`];
  if (payloadKind) parts.push(payloadKind);
  parts.push(wakeup.summary);
  return parts.join(" | ");
}

function supervisorResolvedState(workerState: WorkerStateRecord | null): string | null {
  if (!isObjectRecord(workerState?.metadata)) return null;
  const supervisor = workerState.metadata?.supervisor;
  if (!isObjectRecord(supervisor)) return null;
  return asString(supervisor.resolved_terminal_state);
}

export function loadConductorSnapshotContext(
  options: LoadConductorSnapshotContextOptions
): ConductorSnapshotContext {
  const stateDir = options.stateDir || join(SUPERTURTLE_DATA_DIR, "state");
  const maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS;
  const maxWakeups = options.maxWakeups || DEFAULT_MAX_WAKEUPS;
  const prepErrors: string[] = [];

  const workerStatePath = join(stateDir, "workers", `${options.workerName}.json`);
  const workerState = readJsonObject<WorkerStateRecord>(workerStatePath);
  if (!workerState) {
    prepErrors.push(`canonical worker state missing: ${workerStatePath}`);
  }

  const eventsPath = join(stateDir, "events.jsonl");
  const recentEvents = readJsonlObjects<WorkerEventRecord>(eventsPath)
    .filter((event) => event.worker_name === options.workerName)
    .slice(-maxEvents);

  const wakeups = loadWorkerWakeups(stateDir, options.workerName, maxWakeups);
  const pendingWakeups = wakeups.filter((wakeup) => wakeup.delivery_state === "pending");
  const latestEvent = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1] : null;
  const checkpointSummary = workerState?.checkpoint
    ? summarizeCheckpoint(workerState.checkpoint)
    : null;
  const resolvedState = supervisorResolvedState(workerState);

  const resultPath = join(stateDir, "results", `${options.workerName}.json`);
  const workerResult = readJsonObject<Record<string, unknown>>(resultPath);
  const workerResultSummary = workerResult
    ? (asString(workerResult.summary) || "(no summary)")
    : "(no result file)";

  const summaryLines = [
    `Worker: ${options.workerName}`,
    `Lifecycle state: ${workerState?.lifecycle_state || "(missing)"}`,
    `Run ID: ${workerState?.run_id || "(missing)"}`,
    `Workspace: ${workerState?.workspace || "(missing)"}`,
    `Current task: ${workerState?.current_task || "(missing)"}`,
    `Stop reason: ${workerState?.stop_reason || "(none)"}`,
    `Last event: ${latestEvent ? `${latestEvent.event_type} at ${latestEvent.timestamp}` : "(none)"}`,
    `Last checkpoint: ${checkpointSummary || "(none)"}`,
    `Resolved terminal state: ${resolvedState || "(none)"}`,
    `Pending wakeups: ${pendingWakeups.length > 0 ? pendingWakeups.map(summarizeWakeup).join(" || ") : "(none)"}`,
    `Result: ${workerResultSummary}`,
  ];

  return {
    workspacePath: workerState?.workspace || null,
    conductorSummary: summaryLines.join("\n"),
    workerStateJson: stringifyPromptJson(
      workerState,
      "(missing canonical worker state)"
    ),
    recentEventsJson: stringifyPromptJson(recentEvents, "[]"),
    wakeupsJson: stringifyPromptJson(wakeups, "[]"),
    workerResultJson: stringifyPromptJson(workerResult, "(no result file)"),
    prepErrors,
  };
}

export function buildPreparedSnapshotPrompt(snapshot: PreparedSupervisionSnapshot): string {
  const preparedAt = new Date(snapshot.preparedAtMs).toISOString();
  const prepErrors = snapshot.prepErrors.length > 0
    ? snapshot.prepErrors.map((error) => `- ${error}`).join("\n")
    : "- none";
  const tunnelLine = snapshot.tunnelUrl ? snapshot.tunnelUrl : "(none)";

  return [
    `[SILENT CHECK-IN SNAPSHOT] SubTurtle ${snapshot.subturtleName}`,
    `Snapshot seq: ${snapshot.snapshotSeq}`,
    `Prepared at (UTC): ${preparedAt}`,
    "",
    "Original cron prompt:",
    snapshot.sourcePrompt,
    "",
    "Canonical conductor data (source of truth):",
    "<conductor_summary>",
    snapshot.conductorSummary || "(empty)",
    "</conductor_summary>",
    "",
    "<worker_state_json>",
    snapshot.workerStateJson || "(empty)",
    "</worker_state_json>",
    "",
    "<recent_worker_events_json>",
    snapshot.recentEventsJson || "(empty)",
    "</recent_worker_events_json>",
    "",
    "<worker_wakeups_json>",
    snapshot.wakeupsJson || "(empty)",
    "</worker_wakeups_json>",
    "",
    "<worker_result_json>",
    snapshot.workerResultJson || "(no result file)",
    "</worker_result_json>",
    "",
    "Supporting context (secondary):",
    "<ctl_status>",
    snapshot.statusOutput || "(empty)",
    "</ctl_status>",
    "",
    "<state_excerpt>",
    snapshot.stateExcerpt || "(empty)",
    "</state_excerpt>",
    "",
    "<git_log>",
    snapshot.gitLog || "(empty)",
    "</git_log>",
    "",
    "<tunnel_url>",
    tunnelLine,
    "</tunnel_url>",
    "",
    "<prep_errors>",
    prepErrors,
    "</prep_errors>",
    "",
    "Use canonical conductor records as the source of truth.",
    "If canonical state and supporting context disagree, call out the mismatch and trust the conductor records.",
    "If canonical wakeups already show pending or sent completion/failure/timeout delivery, do not repeat the same lifecycle alert unless you have materially new user-facing information.",
    "Decide if this is notable for the user.",
    "If no notable event, respond exactly: [SILENT]",
    "If notable, include one marker and concise update: 🎉 or ⚠️ or ❌ or 🚀 or 🔗 or 📍.",
  ].join("\n");
}
