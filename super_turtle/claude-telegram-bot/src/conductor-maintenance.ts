import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { CTL_PATH, SUPERTURTLE_DATA_DIR, WORKING_DIR } from "./config";
import type { CronJob } from "./cron";
import {
  cleanupStaleRecurringSubturtleCron,
  processPendingConductorWakeups,
  recoverProcessingWakeups,
  recoverPendingWorkerWakeups,
  type CleanupStaleRecurringSubturtleCronResult,
  type RecoverProcessingWakeupsResult,
  type SupervisorTickResult,
} from "./conductor-supervisor";

interface ConductorMaintenanceJob extends Pick<CronJob, "id" | "type" | "job_kind" | "worker_name" | "chat_id"> {}

export interface RunConductorMaintenanceOptions {
  stateDir?: string;
  workingDir?: string;
  ctlPath?: string;
  defaultChatId?: number | null;
  recoverInFlightWakeups?: boolean;
  listJobs: () => ConductorMaintenanceJob[];
  removeJob: (id: string) => boolean;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  isWorkerRunning?: (workerName: string) => boolean;
  nowIso?: () => string;
}

export interface ConductorMaintenanceResult extends SupervisorTickResult {
  recoveredWakeups: number;
  requeuedWakeups: number;
  staleCronRemoved: number;
  staleCronNotified: number;
}

function isStructuredRecurringSubturtleJob(job: ConductorMaintenanceJob): boolean {
  return (
    job.type === "recurring" &&
    job.job_kind === "subturtle_supervision" &&
    typeof job.worker_name === "string" &&
    job.worker_name.trim().length > 0
  );
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

function loadOutstandingWakeups(stateDir: string): Array<{
  worker_name: string;
  delivery_state?: string;
  payload?: Record<string, unknown>;
}> {
  const wakeupsDir = join(stateDir, "wakeups");
  if (!existsSync(wakeupsDir)) return [];
  return readdirSync(wakeupsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      readJsonObject<{ worker_name: string; delivery_state?: string; payload?: Record<string, unknown> }>(
        join(wakeupsDir, name)
      )
    )
    .filter(
      (
        value
      ): value is { worker_name: string; delivery_state?: string; payload?: Record<string, unknown> } =>
        value !== null &&
        (value.delivery_state === "pending" || value.delivery_state === "processing") &&
        typeof value.worker_name === "string"
    );
}

function loadWorkerState(stateDir: string, workerName: string): { lifecycle_state?: string } | null {
  return readJsonObject<{ lifecycle_state?: string }>(join(stateDir, "workers", `${workerName}.json`));
}

function shouldSkipStaleCleanupForWorker(stateDir: string, workerName: string): boolean {
  const outstandingWakeups = loadOutstandingWakeups(stateDir).filter((wakeup) => wakeup.worker_name === workerName);
  for (const wakeup of outstandingWakeups) {
    const kind = typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : "";
    if (kind === "completion_requested" || kind === "fatal_error" || kind === "timeout") {
      return true;
    }
  }
  const workerState = loadWorkerState(stateDir, workerName);
  const lifecycleState = workerState?.lifecycle_state || "";
  return lifecycleState === "completion_pending" || lifecycleState === "failure_pending" || lifecycleState === "timed_out";
}

export async function runConductorMaintenance(
  options: RunConductorMaintenanceOptions
): Promise<ConductorMaintenanceResult> {
  const stateDir = options.stateDir || `${SUPERTURTLE_DATA_DIR}/state`;
  const workingDir = options.workingDir || WORKING_DIR;
  const ctlPath = options.ctlPath || CTL_PATH;
  const requeueState: RecoverProcessingWakeupsResult = options.recoverInFlightWakeups
    ? recoverProcessingWakeups({
        stateDir,
        nowIso: options.nowIso,
      })
    : { requeuedWakeups: 0, reconciled: 0 };

  const recoveredState = recoverPendingWorkerWakeups({
    stateDir,
    nowIso: options.nowIso,
  });

  let staleCronRemoved = 0;
  let staleCronNotified = 0;
  let staleCronReconciled = 0;
  const jobs = options.listJobs();
  const seenJobIds = new Set<string>();

  for (const job of jobs) {
    if (!isStructuredRecurringSubturtleJob(job)) continue;
    if (seenJobIds.has(job.id)) continue;
    seenJobIds.add(job.id);
    const workerName = job.worker_name!.trim();
    if (shouldSkipStaleCleanupForWorker(stateDir, workerName)) {
      continue;
    }
    const cleanup: CleanupStaleRecurringSubturtleCronResult =
      await cleanupStaleRecurringSubturtleCron({
        stateDir,
        workingDir,
        ctlPath,
        workerName,
        jobId: job.id,
        chatId:
          typeof job.chat_id === "number" && Number.isFinite(job.chat_id)
            ? job.chat_id
            : options.defaultChatId ?? null,
        listJobs: options.listJobs,
        removeJob: options.removeJob,
        sendMessage: options.sendMessage,
        isWorkerRunning: options.isWorkerRunning,
        nowIso: options.nowIso,
      });
    if (cleanup.removed) staleCronRemoved += 1;
    if (cleanup.notified) staleCronNotified += 1;
    staleCronReconciled += cleanup.reconciled;
  }

  const supervisorTick = await processPendingConductorWakeups({
    stateDir,
    workingDir,
    ctlPath,
    defaultChatId: options.defaultChatId,
    listJobs: options.listJobs,
    removeJob: options.removeJob,
    sendMessage: options.sendMessage,
    isWorkerRunning: options.isWorkerRunning,
    nowIso: options.nowIso,
  });

  return {
    sent: supervisorTick.sent,
    skipped: supervisorTick.skipped,
    errors: supervisorTick.errors,
    reconciled:
      supervisorTick.reconciled +
      requeueState.reconciled +
      recoveredState.reconciled +
      staleCronReconciled,
    recoveredWakeups: recoveredState.recoveredWakeups,
    requeuedWakeups: requeueState.requeuedWakeups,
    staleCronRemoved,
    staleCronNotified,
  };
}
