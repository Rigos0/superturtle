import { randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { spawnSync } from "bun";
import { ALLOWED_USERS, CTL_PATH, SUPERTURTLE_DATA_DIR, WORKING_DIR } from "./config";
import { ensureMetaAgentInboxItem } from "./conductor-inbox";

export interface WorkerStateRecord {
  kind?: string;
  schema_version?: number;
  worker_name: string;
  run_id?: string | null;
  lifecycle_state: string;
  workspace?: string | null;
  loop_type?: string | null;
  pid?: number | null;
  timeout_seconds?: number | null;
  cron_job_id?: string | null;
  current_task?: string | null;
  stop_reason?: string | null;
  completion_requested_at?: string | null;
  terminal_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
  last_event_id?: string | null;
  last_event_at?: string | null;
  checkpoint?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WakeupDeliveryRecord {
  attempts?: number;
  last_attempt_at?: string | null;
  sent_at?: string | null;
  failed_at?: string | null;
  suppressed_at?: string | null;
}

export interface WakeupRecord {
  kind?: string;
  schema_version?: number;
  id: string;
  worker_name: string;
  run_id?: string | null;
  reason_event_id?: string | null;
  category: string;
  delivery_state: string;
  summary: string;
  created_at?: string | null;
  updated_at?: string | null;
  delivery?: WakeupDeliveryRecord;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WorkerEventRecord {
  kind: "worker_event";
  schema_version: number;
  id: string;
  timestamp: string;
  worker_name: string;
  run_id?: string | null;
  event_type: string;
  emitted_by: "supervisor";
  lifecycle_state?: string | null;
  idempotency_key?: string | null;
  payload: Record<string, unknown>;
}

export interface SupervisorTickResult {
  sent: number;
  skipped: number;
  errors: number;
  reconciled: number;
}

export interface ProcessConductorWakeupsOptions {
  stateDir?: string;
  workingDir?: string;
  ctlPath?: string;
  defaultChatId?: number | null;
  listJobs: () => Array<{ id: string }>;
  removeJob: (id: string) => boolean;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  isWorkerRunning?: (workerName: string) => boolean;
  nowIso?: () => string;
}

export interface ProcessSilentSubturtleSupervisionOptions
  extends ProcessConductorWakeupsOptions {
  workerName: string;
  chatId: number;
}

export interface RecoverPendingWorkerWakeupsOptions {
  stateDir?: string;
  nowIso?: () => string;
}

export interface RecoverPendingWorkerWakeupsResult {
  recoveredWakeups: number;
  reconciled: number;
}

export interface RecoverProcessingWakeupsOptions {
  stateDir?: string;
  nowIso?: () => string;
}

export interface RecoverProcessingWakeupsResult {
  requeuedWakeups: number;
  reconciled: number;
}

export interface CleanupStaleRecurringSubturtleCronOptions {
  stateDir?: string;
  workingDir?: string;
  ctlPath?: string;
  workerName: string;
  jobId: string;
  chatId?: number | null;
  listJobs: () => Array<{ id: string }>;
  removeJob: (id: string) => boolean;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  isWorkerRunning?: (workerName: string) => boolean;
  nowIso?: () => string;
}

export interface CleanupStaleRecurringSubturtleCronResult {
  removed: boolean;
  notified: boolean;
  reconciled: number;
}

const CONDUCTOR_SCHEMA_VERSION = 1;
const EVENT_EMITTED_BY = "supervisor";
const TERMINAL_WAKEUP_KINDS = new Set(["completion_requested", "fatal_error", "timeout"]);
const TERMINAL_LIFECYCLE_STATES = new Set(["completed", "failed", "timed_out", "stopped", "archived"]);

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newRecordId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, path);
}

function atomicWriteJson(path: string, payload: unknown): void {
  atomicWriteText(path, `${JSON.stringify(payload, null, 2)}\n`);
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

function appendJsonl(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload)}\n`, {
    encoding: "utf-8",
    flag: "a",
  });
}

function statePaths(stateDir: string) {
  return {
    baseDir: stateDir,
    eventsPath: join(stateDir, "events.jsonl"),
    workersDir: join(stateDir, "workers"),
    wakeupsDir: join(stateDir, "wakeups"),
  };
}

function loadWakeupsByDeliveryStates(
  stateDir: string,
  deliveryStates: ReadonlySet<string>
): WakeupRecord[] {
  const { wakeupsDir } = statePaths(stateDir);
  if (!existsSync(wakeupsDir)) return [];

  return readdirSync(wakeupsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonObject<WakeupRecord>(join(wakeupsDir, name)))
    .filter((value): value is WakeupRecord =>
      value !== null &&
      typeof value.delivery_state === "string" &&
      deliveryStates.has(value.delivery_state)
    )
    .sort((a, b) => {
      const left = a.created_at || "";
      const right = b.created_at || "";
      if (left !== right) return left.localeCompare(right);
      return a.id.localeCompare(b.id);
    });
}

function loadPendingWakeups(stateDir: string): WakeupRecord[] {
  return loadWakeupsByDeliveryStates(stateDir, new Set(["pending"]));
}

function loadWakeups(stateDir: string): WakeupRecord[] {
  const { wakeupsDir } = statePaths(stateDir);
  if (!existsSync(wakeupsDir)) return [];

  return readdirSync(wakeupsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonObject<WakeupRecord>(join(wakeupsDir, name)))
    .filter((value): value is WakeupRecord => value !== null);
}

function loadWorkerStates(stateDir: string): WorkerStateRecord[] {
  const { workersDir } = statePaths(stateDir);
  if (!existsSync(workersDir)) return [];

  return readdirSync(workersDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonObject<WorkerStateRecord>(join(workersDir, name)))
    .filter((value): value is WorkerStateRecord => value !== null);
}

function loadWorkerEvents(stateDir: string, workerName: string): WorkerEventRecord[] {
  const { eventsPath } = statePaths(stateDir);
  if (!existsSync(eventsPath)) return [];

  return readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return isObjectRecord(parsed) ? (parsed as unknown as WorkerEventRecord) : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is WorkerEventRecord => value !== null && value.worker_name === workerName);
}

function loadWorkerState(stateDir: string, workerName: string): WorkerStateRecord | null {
  const { workersDir } = statePaths(stateDir);
  return readJsonObject<WorkerStateRecord>(join(workersDir, `${workerName}.json`));
}

function writeWorkerState(stateDir: string, workerState: WorkerStateRecord): void {
  const { workersDir } = statePaths(stateDir);
  atomicWriteJson(join(workersDir, `${workerState.worker_name}.json`), workerState);
}

function writeWakeup(stateDir: string, wakeup: WakeupRecord): void {
  const { wakeupsDir } = statePaths(stateDir);
  atomicWriteJson(join(wakeupsDir, `${wakeup.id}.json`), wakeup);
}

function appendWorkerEvent(
  stateDir: string,
  workerState: WorkerStateRecord | null,
  workerName: string,
  eventType: string,
  lifecycleState: string | null,
  payload: Record<string, unknown>,
  timestamp: string,
  runIdOverride?: string | null
): WorkerEventRecord {
  const event: WorkerEventRecord = {
    kind: "worker_event",
    schema_version: CONDUCTOR_SCHEMA_VERSION,
    id: newRecordId("evt"),
    timestamp,
    worker_name: workerName,
    run_id:
      runIdOverride !== undefined ? runIdOverride : workerState?.run_id ?? null,
    event_type: eventType,
    emitted_by: EVENT_EMITTED_BY,
    lifecycle_state: lifecycleState,
    idempotency_key: null,
    payload,
  };
  appendJsonl(statePaths(stateDir).eventsPath, event);
  return event;
}

function makeWakeup(
  workerName: string,
  category: string,
  summary: string,
  options: {
    runId?: string | null;
    reasonEventId?: string | null;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }
): WakeupRecord {
  return {
    kind: "wakeup",
    schema_version: CONDUCTOR_SCHEMA_VERSION,
    id: newRecordId("wake"),
    worker_name: workerName,
    run_id: options.runId ?? null,
    reason_event_id: options.reasonEventId ?? null,
    category,
    delivery_state: "pending",
    summary,
    created_at: options.createdAt,
    updated_at: options.createdAt,
    delivery: {
      attempts: 0,
      last_attempt_at: null,
      sent_at: null,
      failed_at: null,
      suppressed_at: null,
    },
    payload: options.payload || {},
    metadata: options.metadata || {},
  };
}

function parseCompletedBacklogItems(stateText: string): string[] {
  const lines = stateText.split(/\r?\n/);
  const items: string[] = [];
  let inBacklog = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBacklog) {
      if (trimmed.toLowerCase() === "# backlog") {
        inBacklog = true;
      }
      continue;
    }

    if (trimmed.startsWith("#")) {
      break;
    }

    const match = line.match(/^\s*-\s*\[x\]\s+(.*\S)\s*$/i);
    if (!match) continue;
    items.push(match[1]!.replace(/\s*<-\s*current\s*$/i, "").trim());
  }

  return items;
}

function readWorkspaceStateText(workerState: WorkerStateRecord | null): string | null {
  const workspace = workerState?.workspace;
  if (!workspace) return null;
  const statePath = join(workspace, "CLAUDE.md");
  if (!existsSync(statePath)) return null;
  try {
    return readFileSync(statePath, "utf-8");
  } catch {
    return null;
  }
}

function readWorkspaceTunnelUrl(workerState: WorkerStateRecord | null): string | null {
  const workspace = workerState?.workspace;
  if (!workspace) return null;
  const tunnelPath = join(workspace, ".tunnel-url");
  if (!existsSync(tunnelPath)) return null;
  try {
    const value = readFileSync(tunnelPath, "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function checkpointSignature(workerState: WorkerStateRecord | null): string {
  const checkpoint = isObjectRecord(workerState?.checkpoint) ? workerState!.checkpoint! : {};
  const parts = [
    typeof checkpoint.iteration === "number" ? String(checkpoint.iteration) : "",
    typeof checkpoint.head_sha === "string" ? checkpoint.head_sha : "",
    typeof checkpoint.recorded_at === "string" ? checkpoint.recorded_at : "",
    workerState?.current_task?.trim() || "",
  ];
  const normalized = parts.filter((part) => part.length > 0).join("|");
  return normalized || "no-checkpoint";
}

function wakeupKind(wakeup: WakeupRecord): string {
  return typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : "";
}

function isTerminalWakeup(wakeup: WakeupRecord): boolean {
  return TERMINAL_WAKEUP_KINDS.has(wakeupKind(wakeup));
}

function buildNotificationText(
  wakeup: WakeupRecord,
  workerState: WorkerStateRecord | null,
  stateText: string | null
): string {
  const workerName = wakeup.worker_name;
  const currentTask = workerState?.current_task?.trim();
  const payloadKind = typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : "";

  if (payloadKind === "completion_requested") {
    const completedItems = stateText ? parseCompletedBacklogItems(stateText).slice(0, 6) : [];
    const lines = [`🎉 Finished: ${workerName}`];
    if (completedItems.length > 0) {
      lines.push(...completedItems.map((item) => `✓ ${item}`));
    } else if (currentTask) {
      lines.push(`Completed: ${currentTask}`);
    } else {
      lines.push("Work completed and cleanup verified.");
    }
    return lines.join("\n");
  }

  if (payloadKind === "fatal_error") {
    const errorMessage =
      typeof wakeup.payload?.message === "string" ? wakeup.payload.message.trim() : "";
    const lines = [`❌ SubTurtle ${workerName} failed.`];
    if (currentTask) lines.push(`Task: ${currentTask}`);
    if (errorMessage) lines.push(`Error: ${errorMessage}`);
    return lines.join("\n");
  }

  if (payloadKind === "timeout") {
    const lines = [`❌ SubTurtle ${workerName} timed out.`];
    if (currentTask) lines.push(`Task: ${currentTask}`);
    return lines.join("\n");
  }

  if (payloadKind === "milestone_reached") {
    const completedItems = Array.isArray(wakeup.payload?.newly_completed_items)
      ? wakeup.payload!.newly_completed_items.filter((item): item is string => typeof item === "string")
      : [];
    const tunnelUrl =
      typeof wakeup.payload?.tunnel_url === "string" ? wakeup.payload.tunnel_url.trim() : "";
    const lines = [`🚀 SubTurtle ${workerName} reached a milestone.`];
    if (currentTask) lines.push(`Task: ${currentTask}`);
    if (completedItems.length > 0) {
      lines.push(...completedItems.slice(0, 4).map((item) => `✓ ${item}`));
    }
    if (tunnelUrl) lines.push(`🔗 Preview: ${tunnelUrl}`);
    return lines.join("\n");
  }

  if (payloadKind === "worker_stuck") {
    const stalledChecks =
      typeof wakeup.payload?.stalled_checks === "number" ? wakeup.payload.stalled_checks : null;
    const lastProgressAt =
      typeof wakeup.payload?.last_progress_at === "string" ? wakeup.payload.last_progress_at.trim() : "";
    const lines = [`⚠️ SubTurtle ${workerName} looks stuck.`];
    if (currentTask) lines.push(`Task: ${currentTask}`);
    if (stalledChecks !== null) {
      lines.push(`No meaningful progress across ${stalledChecks} supervision checks.`);
    }
    if (lastProgressAt) lines.push(`Last progress: ${lastProgressAt}`);
    return lines.join("\n");
  }

  const marker =
    wakeup.category === "critical"
      ? "❌"
      : wakeup.category === "notable"
        ? "🔔"
        : "ℹ️";
  return `${marker} ${wakeup.summary}`.trim();
}

function buildMetaAgentInboxTitle(
  wakeup: WakeupRecord,
  workerState: WorkerStateRecord | null
): string {
  const workerName = wakeup.worker_name;
  const payloadKind = typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : "";
  if (payloadKind === "completion_requested") {
    return `SubTurtle ${workerName} completed`;
  }
  if (payloadKind === "fatal_error") {
    return `SubTurtle ${workerName} failed`;
  }
  if (payloadKind === "timeout") {
    return `SubTurtle ${workerName} timed out`;
  }
  if (payloadKind === "milestone_reached") {
    return `SubTurtle ${workerName} milestone`;
  }
  if (payloadKind === "worker_stuck") {
    return `SubTurtle ${workerName} stuck`;
  }
  return workerState?.lifecycle_state
    ? `SubTurtle ${workerName} update (${workerState.lifecycle_state})`
    : `SubTurtle ${workerName} update`;
}

function buildMetaAgentInboxText(
  wakeup: WakeupRecord,
  workerState: WorkerStateRecord | null,
  stateText: string | null,
  chatId: number | null
): string {
  const payloadKind = typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : "";
  const lines: string[] = [];

  if (workerState?.lifecycle_state) {
    lines.push(`Lifecycle: ${workerState.lifecycle_state}`);
  }
  if (workerState?.current_task?.trim()) {
    lines.push(`Task: ${workerState.current_task.trim()}`);
  }
  if (payloadKind === "completion_requested") {
    const completedItems = stateText ? parseCompletedBacklogItems(stateText).slice(0, 4) : [];
    if (completedItems.length > 0) {
      lines.push(`Completed items: ${completedItems.join(" | ")}`);
    } else {
      lines.push("Completion was reconciled and cleanup verified.");
    }
  } else if (payloadKind === "fatal_error") {
    const errorMessage =
      typeof wakeup.payload?.message === "string" ? wakeup.payload.message.trim() : "";
    if (errorMessage) {
      lines.push(`Error: ${errorMessage}`);
    }
  } else if (payloadKind === "timeout") {
    lines.push("Worker exceeded its timeout and was reconciled as timed out.");
  } else if (payloadKind === "milestone_reached") {
    const completedItems = Array.isArray(wakeup.payload?.newly_completed_items)
      ? wakeup.payload!.newly_completed_items.filter((item): item is string => typeof item === "string")
      : [];
    if (completedItems.length > 0) {
      lines.push(`Milestone items: ${completedItems.join(" | ")}`);
    } else {
      lines.push("Worker reached a new deterministic milestone.");
    }
    const tunnelUrl =
      typeof wakeup.payload?.tunnel_url === "string" ? wakeup.payload.tunnel_url.trim() : "";
    if (tunnelUrl) lines.push(`Preview: ${tunnelUrl}`);
  } else if (payloadKind === "worker_stuck") {
    const stalledChecks =
      typeof wakeup.payload?.stalled_checks === "number" ? wakeup.payload.stalled_checks : null;
    if (stalledChecks !== null) {
      lines.push(`No meaningful progress across ${stalledChecks} silent checks.`);
    } else {
      lines.push("Worker appears stuck.");
    }
  } else {
    lines.push(wakeup.summary);
  }

  if (chatId !== null) {
    lines.push(`User notification chat: ${chatId}`);
  }
  lines.push(`Wakeup: ${wakeup.id}`);
  return lines.join("\n");
}

function defaultIsWorkerRunning(ctlPath: string, workingDir: string, workerName: string): boolean {
  const proc = spawnSync({
    cmd: [ctlPath, "status", workerName],
    cwd: workingDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout?.toString() || ""}\n${proc.stderr?.toString() || ""}`;
  return output.includes("running as");
}

function deriveChatId(
  wakeup: WakeupRecord,
  defaultChatId: number | null | undefined
): number | null {
  const maybeMetadataChatId = isObjectRecord(wakeup.metadata)
    ? wakeup.metadata.chat_id
    : undefined;
  if (typeof maybeMetadataChatId === "number" && Number.isFinite(maybeMetadataChatId)) {
    return maybeMetadataChatId;
  }
  return typeof defaultChatId === "number" && Number.isFinite(defaultChatId)
    ? defaultChatId
    : null;
}

function supervisorMetadata(workerState: WorkerStateRecord | null): Record<string, unknown> {
  const metadata = isObjectRecord(workerState?.metadata) ? workerState!.metadata! : {};
  return isObjectRecord(metadata.supervisor) ? { ...metadata.supervisor } : {};
}

function mergeMetadata(
  workerState: WorkerStateRecord | null,
  supervisorPatch: Record<string, unknown>
): Record<string, unknown> {
  const metadata = isObjectRecord(workerState?.metadata) ? { ...workerState!.metadata! } : {};
  const existingSupervisor = isObjectRecord(metadata.supervisor)
    ? { ...metadata.supervisor }
    : {};
  metadata.supervisor = { ...existingSupervisor, ...supervisorPatch };
  return metadata;
}

function mergeWakeupMetadata(
  wakeup: WakeupRecord,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const metadata = isObjectRecord(wakeup.metadata) ? { ...wakeup.metadata } : {};
  return { ...metadata, ...patch };
}

function numericMetadataValue(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringMetadataValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedRunId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function workerRunKey(workerName: string, runId: string | null): string {
  return `${workerName}::${runId || ""}`;
}

function wakeupTargetsWorkerState(
  wakeup: WakeupRecord,
  workerState: WorkerStateRecord | null
): boolean {
  if (!workerState) return false;
  return normalizedRunId(wakeup.run_id) === normalizedRunId(workerState.run_id);
}

function loadWakeupWorkerState(
  stateDir: string,
  wakeup: WakeupRecord
): { workerState: WorkerStateRecord | null; runMismatch: boolean } {
  const workerState = loadWorkerState(stateDir, wakeup.worker_name);
  if (!workerState) {
    return { workerState: null, runMismatch: false };
  }
  if (!wakeupTargetsWorkerState(wakeup, workerState)) {
    return { workerState: null, runMismatch: true };
  }
  return { workerState, runMismatch: false };
}

function existingWakeupKindsByRun(stateDir: string): Map<string, Set<string>> {
  const byWorker = new Map<string, Set<string>>();
  for (const wakeup of loadWakeups(stateDir)) {
    const kind = wakeupKind(wakeup);
    if (!kind) continue;
    const current = byWorker.get(
      workerRunKey(wakeup.worker_name, normalizedRunId(wakeup.run_id))
    ) || new Set<string>();
    current.add(kind);
    byWorker.set(
      workerRunKey(wakeup.worker_name, normalizedRunId(wakeup.run_id)),
      current
    );
  }
  return byWorker;
}

function latestWorkerEvent(
  stateDir: string,
  workerName: string,
  eventType: string
): WorkerEventRecord | null {
  const matching = loadWorkerEvents(stateDir, workerName)
    .filter((event) => event.event_type === eventType)
    .sort((left, right) => {
      const leftKey = left.timestamp || "";
      const rightKey = right.timestamp || "";
      if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
      return right.id.localeCompare(left.id);
    });
  return matching[0] || null;
}

function workerRecoveryChatId(workerState: WorkerStateRecord | null): number | null {
  const supervisor = supervisorMetadata(workerState);
  const chatId = supervisor.last_supervision_chat_id;
  return typeof chatId === "number" && Number.isFinite(chatId) ? chatId : null;
}

function isWakeupReady(
  wakeup: WakeupRecord,
  running: boolean,
  hasMatchingWorkerState: boolean
): boolean {
  if (isTerminalWakeup(wakeup)) {
    return hasMatchingWorkerState ? !running : true;
  }
  return true;
}

function updateWakeupDelivery(
  wakeup: WakeupRecord,
  deliveryState: string,
  now: string,
  options: {
    incrementAttempts?: boolean;
    sentAt?: string | null;
  } = {}
): WakeupRecord {
  const delivery = isObjectRecord(wakeup.delivery) ? { ...wakeup.delivery } : {};
  if (options.incrementAttempts) {
    delivery.attempts = (typeof delivery.attempts === "number" ? delivery.attempts : 0) + 1;
  }
  delivery.last_attempt_at = now;
  if (options.sentAt !== undefined) {
    delivery.sent_at = options.sentAt;
  }

  return {
    ...wakeup,
    delivery_state: deliveryState,
    updated_at: now,
    delivery,
  };
}

export function recoverPendingWorkerWakeups(
  options: RecoverPendingWorkerWakeupsOptions = {}
): RecoverPendingWorkerWakeupsResult {
  const stateDir = options.stateDir || join(SUPERTURTLE_DATA_DIR, "state");
  const nowIso = options.nowIso || utcNowIso;
  const now = nowIso();
  const wakeupKindsByRun = existingWakeupKindsByRun(stateDir);
  let recoveredWakeups = 0;
  let reconciled = 0;

  for (const workerState of loadWorkerStates(stateDir)) {
    const lifecycleState = workerState.lifecycle_state;
    const runKey = workerRunKey(
      workerState.worker_name,
      normalizedRunId(workerState.run_id)
    );
    let recoveryKind = "";
    let eventType = "";
    let category: "critical" | "notable" = "notable";
    let summary = "";
    let payload: Record<string, unknown> = {};

    if (
      lifecycleState === "completion_pending" &&
      !(wakeupKindsByRun.get(runKey)?.has("completion_requested"))
    ) {
      recoveryKind = "completion_requested";
      eventType = "worker.completion_requested";
      category = "notable";
      summary = `SubTurtle ${workerState.worker_name} completed and needs reconciliation.`;
      payload = { kind: "completion_requested" };
    } else if (
      lifecycleState === "failure_pending" &&
      !(wakeupKindsByRun.get(runKey)?.has("fatal_error"))
    ) {
      const fatalErrorEvent = latestWorkerEvent(stateDir, workerState.worker_name, "worker.fatal_error");
      const message =
        typeof fatalErrorEvent?.payload?.message === "string" && fatalErrorEvent.payload.message.trim().length > 0
          ? fatalErrorEvent.payload.message.trim()
          : "Worker entered failure_pending without a recoverable wakeup.";
      recoveryKind = "fatal_error";
      eventType = "worker.fatal_error";
      category = "critical";
      summary = `SubTurtle ${workerState.worker_name} failed and needs reconciliation.`;
      payload = { kind: "fatal_error", message };
    } else if (
      lifecycleState === "timed_out" &&
      !(wakeupKindsByRun.get(runKey)?.has("timeout"))
    ) {
      recoveryKind = "timeout";
      eventType = "worker.timed_out";
      category = "critical";
      summary = `SubTurtle ${workerState.worker_name} timed out and needs reconciliation.`;
      payload = { kind: "timeout" };
    }

    if (!recoveryKind) {
      continue;
    }

    const recoveryEvent = appendWorkerEvent(
      stateDir,
      workerState,
      workerState.worker_name,
      "worker.recovered",
      workerState.lifecycle_state,
      {
        recovery_kind: "recreated_missing_wakeup",
        recreated_wakeup_kind: recoveryKind,
        source_event_type: eventType,
      },
      now
    );

    writeWakeup(
      stateDir,
      makeWakeup(workerState.worker_name, category, summary, {
        runId: workerState.run_id,
        reasonEventId: recoveryEvent.id,
        createdAt: now,
        payload,
        metadata: {
          recovered: true,
          recovery_kind: "recreated_missing_wakeup",
          ...(workerRecoveryChatId(workerState) !== null
            ? { chat_id: workerRecoveryChatId(workerState) }
            : {}),
        },
      })
    );

    const nextKinds = wakeupKindsByRun.get(runKey) || new Set<string>();
    nextKinds.add(recoveryKind);
    wakeupKindsByRun.set(runKey, nextKinds);

    writeWorkerState(stateDir, {
      ...workerState,
      updated_at: now,
      updated_by: EVENT_EMITTED_BY,
      last_event_id: recoveryEvent.id,
      last_event_at: recoveryEvent.timestamp,
      metadata: mergeMetadata(workerState, {
        last_recovered_at: now,
        last_recovery_event_id: recoveryEvent.id,
        last_recreated_wakeup_kind: recoveryKind,
      }),
    });

    recoveredWakeups += 1;
    reconciled += 1;
  }

  return { recoveredWakeups, reconciled };
}

export function recoverProcessingWakeups(
  options: RecoverProcessingWakeupsOptions = {}
): RecoverProcessingWakeupsResult {
  const stateDir = options.stateDir || join(SUPERTURTLE_DATA_DIR, "state");
  const nowIso = options.nowIso || utcNowIso;
  const now = nowIso();
  let requeuedWakeups = 0;
  let reconciled = 0;

  for (const wakeup of loadWakeupsByDeliveryStates(stateDir, new Set(["processing"]))) {
    const { workerState } = loadWakeupWorkerState(stateDir, wakeup);
    const recoveryEvent = appendWorkerEvent(
      stateDir,
      workerState,
      wakeup.worker_name,
      "worker.recovered",
      workerState?.lifecycle_state || null,
      {
        recovery_kind: "requeued_processing_wakeup",
        wakeup_id: wakeup.id,
        wakeup_kind: wakeupKind(wakeup) || null,
        previous_delivery_state: wakeup.delivery_state,
      },
      now,
      normalizedRunId(wakeup.run_id)
    );

    writeWakeup(stateDir, {
      ...wakeup,
      delivery_state: "pending",
      updated_at: now,
      metadata: mergeWakeupMetadata(wakeup, {
        recovered: true,
        recovery_kind: "requeued_processing_wakeup",
        recovery_event_id: recoveryEvent.id,
        last_requeued_at: now,
      }),
    });

    if (workerState) {
      writeWorkerState(stateDir, {
        ...workerState,
        updated_at: now,
        updated_by: EVENT_EMITTED_BY,
        last_event_id: recoveryEvent.id,
        last_event_at: recoveryEvent.timestamp,
        metadata: mergeMetadata(workerState, {
          last_recovered_at: now,
          last_recovery_event_id: recoveryEvent.id,
          last_requeued_wakeup_id: wakeup.id,
          last_requeued_wakeup_kind: wakeupKind(wakeup) || null,
        }),
      });
    }

    requeuedWakeups += 1;
    reconciled += 1;
  }

  return { requeuedWakeups, reconciled };
}

export async function cleanupStaleRecurringSubturtleCron(
  options: CleanupStaleRecurringSubturtleCronOptions
): Promise<CleanupStaleRecurringSubturtleCronResult> {
  const stateDir = options.stateDir || join(SUPERTURTLE_DATA_DIR, "state");
  const workingDir = options.workingDir || WORKING_DIR;
  const ctlPath = options.ctlPath || CTL_PATH;
  const nowIso = options.nowIso || utcNowIso;
  const isWorkerRunning =
    options.isWorkerRunning || ((workerName: string) => defaultIsWorkerRunning(ctlPath, workingDir, workerName));

  if (isWorkerRunning(options.workerName)) {
    return { removed: false, notified: false, reconciled: 0 };
  }

  if (!options.listJobs().some((job) => job.id === options.jobId)) {
    return { removed: false, notified: false, reconciled: 0 };
  }

  if (!options.removeJob(options.jobId)) {
    return { removed: false, notified: false, reconciled: 0 };
  }

  const now = nowIso();
  let reconciled = 0;
  let notified = false;
  const workerState = loadWorkerState(stateDir, options.workerName);
  const supervisor = supervisorMetadata(workerState);
  if (workerState && !supervisor.cron_removed_at) {
    const cronRemovedEvent = appendWorkerEvent(
      stateDir,
      workerState,
      options.workerName,
      "worker.cron_removed",
      workerState.lifecycle_state,
      {
        cron_job_id: options.jobId,
        removal_reason: "stale_recurring_cron_cleanup",
      },
      now
    );
    writeWorkerState(stateDir, {
      ...workerState,
      updated_at: now,
      updated_by: EVENT_EMITTED_BY,
      last_event_id: cronRemovedEvent.id,
      last_event_at: cronRemovedEvent.timestamp,
      metadata: mergeMetadata(workerState, {
        cron_removed_at: now,
        cron_removed_event_id: cronRemovedEvent.id,
        cron_removed_reason: "stale_recurring_cron_cleanup",
      }),
    });
    reconciled += 1;
  }

  if (typeof options.chatId === "number" && Number.isFinite(options.chatId)) {
    await options.sendMessage(
      options.chatId,
      `⚠️ SubTurtle ${options.workerName} is not running but cron ${options.jobId} was still active. I removed that recurring cron to prevent repeat loops.`
    );
    notified = true;
  }

  return { removed: true, notified, reconciled };
}

export async function processSilentSubturtleSupervision(
  options: ProcessSilentSubturtleSupervisionOptions
): Promise<SupervisorTickResult & { createdWakeups: number }> {
  const stateDir = options.stateDir || join(SUPERTURTLE_DATA_DIR, "state");
  const workingDir = options.workingDir || WORKING_DIR;
  const ctlPath = options.ctlPath || CTL_PATH;
  const nowIso = options.nowIso || utcNowIso;
  const isWorkerRunning =
    options.isWorkerRunning || ((workerName: string) => defaultIsWorkerRunning(ctlPath, workingDir, workerName));
  const now = nowIso();
  const workerState = loadWorkerState(stateDir, options.workerName);

  if (!workerState) {
    return { sent: 0, skipped: 1, errors: 0, reconciled: 0, createdWakeups: 0 };
  }

  const running = isWorkerRunning(options.workerName);
  if (!running || TERMINAL_LIFECYCLE_STATES.has(workerState.lifecycle_state)) {
    return { sent: 0, skipped: 1, errors: 0, reconciled: 0, createdWakeups: 0 };
  }

  const supervisor = supervisorMetadata(workerState);
  const stateText = readWorkspaceStateText(workerState);
  const completedItems = stateText ? parseCompletedBacklogItems(stateText) : [];
  const backlogDone = completedItems.length;
  const tunnelUrl = readWorkspaceTunnelUrl(workerState);
  const progressSignature = `${checkpointSignature(workerState)}|done:${backlogDone}|task:${workerState.current_task?.trim() || ""}`;
  const hasBaseline = Boolean(stringMetadataValue(supervisor, "last_progress_signature"));
  const previousProgressSignature = stringMetadataValue(supervisor, "last_progress_signature");
  const previousNotifiedBacklogDone = numericMetadataValue(supervisor, "last_notified_backlog_done");
  const lastProgressAt = stringMetadataValue(supervisor, "last_progress_at");
  const progressObserved = !hasBaseline || previousProgressSignature !== progressSignature;
  const stalledChecks = progressObserved ? 0 : numericMetadataValue(supervisor, "stalled_check_count") + 1;

  let workingState: WorkerStateRecord = {
    ...workerState,
    updated_at: now,
    updated_by: EVENT_EMITTED_BY,
  };

  const supervisionEvent = appendWorkerEvent(
    stateDir,
    workingState,
    options.workerName,
    "worker.supervision_checked",
    workingState.lifecycle_state,
    {
      chat_id: options.chatId,
      progress_observed: progressObserved,
      backlog_done: backlogDone,
      stalled_checks: stalledChecks,
      progress_signature: progressSignature,
    },
    now
  );
  workingState = {
    ...workingState,
    last_event_id: supervisionEvent.id,
    last_event_at: supervisionEvent.timestamp,
    metadata: mergeMetadata(workingState, {
      silent_checks: numericMetadataValue(supervisor, "silent_checks") + 1,
      last_supervision_at: now,
      last_progress_signature: progressSignature,
      last_progress_at: progressObserved ? now : lastProgressAt,
      stalled_check_count: stalledChecks,
      last_observed_backlog_done: backlogDone,
      last_observed_tunnel_url: tunnelUrl,
      last_supervision_chat_id: options.chatId,
      last_notified_backlog_done: hasBaseline ? previousNotifiedBacklogDone : backlogDone,
    }),
  };

  let createdWakeups = 0;

  if (hasBaseline && backlogDone > previousNotifiedBacklogDone) {
    const newlyCompletedItems = completedItems.slice(previousNotifiedBacklogDone, backlogDone);
    const milestoneEvent = appendWorkerEvent(
      stateDir,
      workingState,
      options.workerName,
      "worker.milestone_reached",
      workingState.lifecycle_state,
      {
        backlog_done: backlogDone,
        newly_completed_items: newlyCompletedItems,
        tunnel_url: tunnelUrl,
      },
      now
    );
    writeWakeup(
      stateDir,
      makeWakeup(
        options.workerName,
        "notable",
        `SubTurtle ${options.workerName} reached a new milestone.`,
        {
          runId: workingState.run_id,
          reasonEventId: milestoneEvent.id,
          createdAt: now,
          metadata: { chat_id: options.chatId },
          payload: {
            kind: "milestone_reached",
            backlog_done: backlogDone,
            newly_completed_items: newlyCompletedItems,
            tunnel_url: tunnelUrl,
          },
        }
      )
    );
    workingState = {
      ...workingState,
      last_event_id: milestoneEvent.id,
      last_event_at: milestoneEvent.timestamp,
      metadata: mergeMetadata(workingState, {
        last_milestone_at: now,
        last_notified_backlog_done: backlogDone,
      }),
    };
    createdWakeups += 1;
  }

  if (
    stalledChecks >= 2 &&
    stringMetadataValue(supervisorMetadata(workingState), "last_stuck_signature") !== progressSignature
  ) {
    const stuckEvent = appendWorkerEvent(
      stateDir,
      workingState,
      options.workerName,
      "worker.stuck_detected",
      workingState.lifecycle_state,
      {
        stalled_checks: stalledChecks,
        last_progress_at: lastProgressAt,
        progress_signature: progressSignature,
      },
      now
    );
    writeWakeup(
      stateDir,
      makeWakeup(
        options.workerName,
        "notable",
        `SubTurtle ${options.workerName} appears stuck.`,
        {
          runId: workingState.run_id,
          reasonEventId: stuckEvent.id,
          createdAt: now,
          metadata: { chat_id: options.chatId },
          payload: {
            kind: "worker_stuck",
            stalled_checks: stalledChecks,
            last_progress_at: lastProgressAt,
            progress_signature: progressSignature,
          },
        }
      )
    );
    workingState = {
      ...workingState,
      last_event_id: stuckEvent.id,
      last_event_at: stuckEvent.timestamp,
      metadata: mergeMetadata(workingState, {
        last_stuck_at: now,
        last_stuck_signature: progressSignature,
      }),
    };
    createdWakeups += 1;
  }

  writeWorkerState(stateDir, workingState);

  if (createdWakeups === 0) {
    return { sent: 0, skipped: 0, errors: 0, reconciled: 1, createdWakeups: 0 };
  }

  const deliveryResult = await processPendingConductorWakeups(options);
  return {
    ...deliveryResult,
    reconciled: deliveryResult.reconciled + 1,
    createdWakeups,
  };
}

export async function processPendingConductorWakeups(
  options: ProcessConductorWakeupsOptions
): Promise<SupervisorTickResult> {
  const stateDir = options.stateDir || join(SUPERTURTLE_DATA_DIR, "state");
  const workingDir = options.workingDir || WORKING_DIR;
  const ctlPath = options.ctlPath || CTL_PATH;
  const nowIso = options.nowIso || utcNowIso;
  const isWorkerRunning =
    options.isWorkerRunning || ((workerName: string) => defaultIsWorkerRunning(ctlPath, workingDir, workerName));
  const cronJobIds = new Set(options.listJobs().map((job) => job.id));
  const result: SupervisorTickResult = { sent: 0, skipped: 0, errors: 0, reconciled: 0 };

  for (const wakeup of loadPendingWakeups(stateDir)) {
    const now = nowIso();
    const { workerState, runMismatch } = loadWakeupWorkerState(stateDir, wakeup);
    const running = isWorkerRunning(wakeup.worker_name);
    const wakeupRunId = normalizedRunId(wakeup.run_id);
    if (!isWakeupReady(wakeup, running, workerState !== null)) {
      result.skipped += 1;
      continue;
    }

    let workingState = workerState ? { ...workerState } : null;
    const supervisor = supervisorMetadata(workingState);
    const cronJobId = workingState?.cron_job_id?.trim();
    const hadCron = Boolean(cronJobId && cronJobIds.has(cronJobId));
    const terminalWakeup = isTerminalWakeup(wakeup);

    try {
      if (terminalWakeup && hadCron && !supervisor.cron_removed_at && cronJobId) {
        const removed = options.removeJob(cronJobId);
        if (removed) {
          cronJobIds.delete(cronJobId);
          const cronRemovedEvent = appendWorkerEvent(
            stateDir,
            workingState,
            wakeup.worker_name,
            "worker.cron_removed",
            workingState?.lifecycle_state || null,
            { cron_job_id: cronJobId },
            now,
            wakeupRunId
          );
          if (workingState) {
            workingState = {
              ...workingState,
              updated_at: now,
              updated_by: EVENT_EMITTED_BY,
              last_event_id: cronRemovedEvent.id,
              last_event_at: cronRemovedEvent.timestamp,
              metadata: mergeMetadata(workingState, {
                cron_removed_at: now,
                cron_removed_event_id: cronRemovedEvent.id,
              }),
            };
          }
          result.reconciled += 1;
        }
      }

      const payloadKind = typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : "";
      if (terminalWakeup && workingState && !supervisor.cleanup_verified_at) {
        const cleanupVerifiedEvent = appendWorkerEvent(
          stateDir,
          workingState,
          wakeup.worker_name,
          "worker.cleanup_verified",
          workingState.lifecycle_state,
          {
            running: false,
            cron_removed: !cronJobId || !cronJobIds.has(cronJobId),
            wakeup_id: wakeup.id,
          },
          now,
          wakeupRunId
        );
        workingState = {
          ...workingState,
          updated_at: now,
          updated_by: EVENT_EMITTED_BY,
          last_event_id: cleanupVerifiedEvent.id,
          last_event_at: cleanupVerifiedEvent.timestamp,
          metadata: mergeMetadata(workingState, {
            cleanup_verified_at: now,
            cleanup_verified_event_id: cleanupVerifiedEvent.id,
          }),
        };
        result.reconciled += 1;
      }

      if (workingState && payloadKind === "completion_requested" && supervisor.resolved_terminal_state !== "completed") {
        const completedEvent = appendWorkerEvent(
          stateDir,
          workingState,
          wakeup.worker_name,
          "worker.completed",
          "completed",
          { wakeup_id: wakeup.id },
          now,
          wakeupRunId
        );
        workingState = {
          ...workingState,
          lifecycle_state:
            workingState.lifecycle_state === "archived" ? "archived" : "completed",
          stop_reason: "completed",
          terminal_at: workingState.terminal_at || now,
          updated_at: now,
          updated_by: EVENT_EMITTED_BY,
          last_event_id: completedEvent.id,
          last_event_at: completedEvent.timestamp,
          metadata: mergeMetadata(workingState, {
            resolved_terminal_state: "completed",
            reconciled_at: now,
            resolution_event_id: completedEvent.id,
          }),
        };
        result.reconciled += 1;
      }

      if (workingState && payloadKind === "fatal_error" && supervisor.resolved_terminal_state !== "failed") {
        const failedEvent = appendWorkerEvent(
          stateDir,
          workingState,
          wakeup.worker_name,
          "worker.failed",
          "failed",
          { wakeup_id: wakeup.id, reason: "fatal_error" },
          now,
          wakeupRunId
        );
        workingState = {
          ...workingState,
          lifecycle_state: "failed",
          stop_reason: workingState.stop_reason || "fatal_error",
          terminal_at: workingState.terminal_at || now,
          updated_at: now,
          updated_by: EVENT_EMITTED_BY,
          last_event_id: failedEvent.id,
          last_event_at: failedEvent.timestamp,
          metadata: mergeMetadata(workingState, {
            resolved_terminal_state: "failed",
            reconciled_at: now,
            resolution_event_id: failedEvent.id,
          }),
        };
        result.reconciled += 1;
      }

      if (workingState && payloadKind === "timeout" && supervisor.resolved_terminal_state !== "timed_out") {
        const timedOutEvent = appendWorkerEvent(
          stateDir,
          workingState,
          wakeup.worker_name,
          "worker.timed_out",
          "timed_out",
          { wakeup_id: wakeup.id, reason: "timeout" },
          now,
          wakeupRunId
        );
        workingState = {
          ...workingState,
          lifecycle_state: "timed_out",
          stop_reason: workingState.stop_reason || "timeout",
          terminal_at: workingState.terminal_at || now,
          updated_at: now,
          updated_by: EVENT_EMITTED_BY,
          last_event_id: timedOutEvent.id,
          last_event_at: timedOutEvent.timestamp,
          metadata: mergeMetadata(workingState, {
            resolved_terminal_state: "timed_out",
            reconciled_at: now,
            resolution_event_id: timedOutEvent.id,
          }),
        };
        result.reconciled += 1;
      }

      if (workingState) {
        writeWorkerState(stateDir, workingState);
      }

      const chatId = deriveChatId(wakeup, options.defaultChatId ?? ALLOWED_USERS[0] ?? null);
      const stateText = readWorkspaceStateText(workingState);
      if (wakeup.category !== "silent") {
        const inboxTitle = buildMetaAgentInboxTitle(wakeup, workingState);
        const inboxText = buildMetaAgentInboxText(wakeup, workingState, stateText, chatId);
        const { item: inboxItem, created } = ensureMetaAgentInboxItem({
          stateDir,
          item: {
            id: `inbox_${wakeup.id}`,
            chat_id: chatId,
            worker_name: wakeup.worker_name,
            run_id: workingState?.run_id ?? wakeup.run_id ?? null,
            priority: wakeup.category,
            category: typeof wakeup.payload?.kind === "string" ? wakeup.payload.kind : wakeup.category,
            title: inboxTitle,
            text: inboxText,
            delivery_state: "pending",
            source_event_id: workingState?.last_event_id ?? wakeup.reason_event_id ?? null,
            source_wakeup_id: wakeup.id,
            created_at: now,
            updated_at: now,
            delivery: {},
            metadata: {
              lifecycle_state: workingState?.lifecycle_state ?? null,
              run_mismatch: runMismatch || undefined,
            },
          },
        });
        if (created) {
          const inboxEvent = appendWorkerEvent(
            stateDir,
            workingState,
            wakeup.worker_name,
            "worker.inbox_enqueued",
            workingState?.lifecycle_state || null,
            { inbox_id: inboxItem.id, wakeup_id: wakeup.id, chat_id: chatId },
            now,
            wakeupRunId
          );
          if (workingState) {
            workingState = {
              ...workingState,
              updated_at: now,
              updated_by: EVENT_EMITTED_BY,
              last_event_id: inboxEvent.id,
              last_event_at: inboxEvent.timestamp,
            };
            writeWorkerState(stateDir, workingState);
          }
          result.reconciled += 1;
        }
      }

      if (chatId === null) {
        result.skipped += 1;
        continue;
      }

      const processingWakeup = updateWakeupDelivery(wakeup, "processing", now, {
        incrementAttempts: true,
      });
      writeWakeup(stateDir, processingWakeup);

      const notificationText = buildNotificationText(processingWakeup, workingState, stateText);
      await options.sendMessage(chatId, notificationText);

      const notificationEvent = appendWorkerEvent(
        stateDir,
        workingState,
        wakeup.worker_name,
        "worker.notification_sent",
        workingState?.lifecycle_state || null,
        { wakeup_id: wakeup.id, category: wakeup.category, chat_id: chatId },
        now,
        wakeupRunId
      );
      if (workingState) {
        writeWorkerState(stateDir, {
          ...workingState,
          updated_at: now,
          updated_by: EVENT_EMITTED_BY,
          last_event_id: notificationEvent.id,
          last_event_at: notificationEvent.timestamp,
        });
      }

      writeWakeup(
        stateDir,
        updateWakeupDelivery(processingWakeup, "sent", now, { sentAt: now })
      );
      result.sent += 1;
    } catch {
      writeWakeup(stateDir, updateWakeupDelivery(wakeup, "pending", now, {
        incrementAttempts: true,
      }));
      result.errors += 1;
    }
  }

  return result;
}

export { parseCompletedBacklogItems, buildNotificationText };
