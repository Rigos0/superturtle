import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CTL_PATH, SUPERTURTLE_DATA_DIR, WORKING_DIR } from "../config";
import { listPendingMetaAgentInboxItems } from "../conductor-inbox";
import { loadPendingWakeups, loadWorkerStates } from "../conductor-supervisor";
import { getPreparedSnapshotCount } from "../cron-supervision-queue";
import { getJobs } from "../cron";
import { getAllDeferredQueues } from "../deferred-queue";
import { isBackgroundRunActive, wasBackgroundRunPreempted } from "../handlers/driver-routing";
import {
  getSubTurtleElapsed,
  parseCtlListOutput,
  readClaudeBacklogItems,
  type ClaudeBacklogItem,
  type ListedSubTurtle,
} from "../handlers/commands";
import {
  getSessionObservabilityProviders,
  type DriverProcessState,
} from "../session-observability";
import type {
  ConductorResponse,
  CronJobView,
  CurrentJobView,
  CurrentJobsResponse,
  DashboardOverviewResponse,
  DashboardState,
  DeferredChatView,
  ProcessView,
  SessionListResponse,
  SubturtleLaneView,
  SubturtleListResponse,
  TurtleView,
} from "../dashboard-types";
import {
  buildSubturtleProcessDetail,
  computeProgressPct,
  elapsedFrom,
  humanInterval,
  isObjectLike,
  mapDriverStatus,
  mapSubturtleStatus,
  parseIsoDate,
  queuePressureSummary,
  safeSubstring,
} from "./helpers";

// Data assembly for dashboard APIs: read runtime state once, then derive dashboard-facing views from it.
const CONDUCTOR_STATE_DIR = join(SUPERTURTLE_DATA_DIR, "state");

type ConductorWorkerLaneState = {
  worker_name: string;
  lifecycle_state?: string | null;
  workspace?: string | null;
  loop_type?: string | null;
  current_task?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type PreparedDashboardTurtle = TurtleView & {
  backlogDone: number;
  backlogTotal: number;
  backlogCurrent: string;
  laneStatus: string;
  laneType: string;
  laneElapsed: string;
  laneTask: string;
};

export async function readSubturtles(): Promise<ListedSubTurtle[]> {
  try {
    const proc = Bun.spawnSync([CTL_PATH, "list"], {
      cwd: WORKING_DIR,
      env: {
        ...process.env,
        SUPER_TURTLE_PROJECT_DIR: WORKING_DIR,
        CLAUDE_WORKING_DIR: WORKING_DIR,
      },
    });
    const output = proc.stdout.toString().trim();
    return parseCtlListOutput(output);
  } catch {
    return [];
  }
}

function readConductorWorkerState(name: string): ConductorWorkerLaneState | null {
  const path = join(CONDUCTOR_STATE_DIR, "workers", `${name}.json`);
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isObjectLike(parsed)) return null;
    return parsed as ConductorWorkerLaneState;
  } catch {
    return null;
  }
}

function isArchivedConductorState(state: ConductorWorkerLaneState | null): boolean {
  if (!state) return false;
  if (state.lifecycle_state === "archived") return true;
  return typeof state.workspace === "string" && state.workspace.includes("/.subturtles/.archive/");
}

export function buildCronJobView(job: ReturnType<typeof getJobs>[number]): CronJobView {
  const promptPreview = job.job_kind === "subturtle_supervision" && job.worker_name
    ? `SubTurtle ${job.worker_name} (${job.supervision_mode || (job.silent ? "silent" : "unknown")})`
    : safeSubstring(job.prompt, 100);

  return {
    id: job.id,
    type: job.type,
    jobKind: job.job_kind,
    workerName: job.worker_name,
    supervisionMode: job.supervision_mode,
    prompt: job.prompt,
    promptPreview,
    fireAt: job.fire_at,
    fireInMs: Math.max(0, job.fire_at - Date.now()),
    intervalMs: job.interval_ms,
    intervalHuman: humanInterval(job.interval_ms),
    silent: job.silent || false,
    createdAt: job.created_at,
  };
}

export function getDriverProcessStates(): DriverProcessState[] {
  return getSessionObservabilityProviders().map((provider) => provider.getDriverProcessState());
}

function hasElapsedValue(turtle: ListedSubTurtle | TurtleView): turtle is TurtleView {
  return typeof (turtle as TurtleView).elapsed === "string";
}

function buildBacklogSummary(backlogItems: ClaudeBacklogItem[]): {
  backlogDone: number;
  backlogTotal: number;
  backlogCurrent: string;
} {
  const backlogTotal = backlogItems.length;
  const backlogDone = backlogItems.filter((item) => item.done).length;
  const backlogCurrent =
    backlogItems.find((item) => item.current && !item.done)?.text ||
    backlogItems.find((item) => !item.done)?.text ||
    "";

  return {
    backlogDone,
    backlogTotal,
    backlogCurrent,
  };
}

async function prepareDashboardTurtles(
  turtles?: Array<ListedSubTurtle | TurtleView>
): Promise<PreparedDashboardTurtle[]> {
  const sourceTurtles = turtles || await readSubturtles();

  return Promise.all(
    sourceTurtles.map(async (turtle) => {
      const rawConductorState = readConductorWorkerState(turtle.name);
      const conductorState = isArchivedConductorState(rawConductorState) ? null : rawConductorState;
      const workspacePath = conductorState?.workspace || `${WORKING_DIR}/.subturtles/${turtle.name}`;
      const statePath = `${workspacePath}/CLAUDE.md`;
      const [elapsed, backlogItems] = await Promise.all([
        hasElapsedValue(turtle)
          ? Promise.resolve(turtle.elapsed)
          : turtle.status === "running"
            ? getSubTurtleElapsed(turtle.name)
            : Promise.resolve("0s"),
        readClaudeBacklogItems(statePath),
      ]);
      const { backlogDone, backlogTotal, backlogCurrent } = buildBacklogSummary(backlogItems);
      const conductorElapsed = elapsedFrom(
        parseIsoDate(conductorState?.created_at || conductorState?.updated_at)
      );

      return {
        ...turtle,
        elapsed,
        backlogDone,
        backlogTotal,
        backlogCurrent,
        laneStatus: conductorState?.lifecycle_state || turtle.status,
        laneType: conductorState?.loop_type || turtle.type || "unknown",
        laneElapsed: turtle.status === "running" ? elapsed : conductorElapsed,
        laneTask: conductorState?.current_task || turtle.task || "",
      };
    })
  );
}

function buildLaneView(turtle: PreparedDashboardTurtle): SubturtleLaneView {
  return {
    name: turtle.name,
    status: turtle.laneStatus,
    type: turtle.laneType,
    elapsed: turtle.laneElapsed,
    task: turtle.laneTask,
    backlogDone: turtle.backlogDone,
    backlogTotal: turtle.backlogTotal,
    backlogCurrent: turtle.backlogCurrent,
    progressPct: computeProgressPct(turtle.backlogDone, turtle.backlogTotal),
  };
}

function sortSubturtleLanes(lanes: SubturtleLaneView[]): SubturtleLaneView[] {
  return [...lanes].sort((a, b) => {
    if (a.status === b.status) return a.name.localeCompare(b.name);
    if (a.status === "running") return -1;
    if (b.status === "running") return 1;
    return a.name.localeCompare(b.name);
  });
}

function assembleDashboardState(preparedTurtles: PreparedDashboardTurtle[]): DashboardState {
  const turtles = preparedTurtles.map((turtle) => ({
    name: turtle.name,
    status: turtle.status,
    type: turtle.type,
    pid: turtle.pid,
    timeRemaining: turtle.timeRemaining,
    task: turtle.task,
    tunnelUrl: turtle.tunnelUrl,
    elapsed: turtle.elapsed,
  }));
  const lanes = preparedTurtles.map(buildLaneView);

  const allJobs = getJobs();
  const cronJobs = allJobs.map(buildCronJobView);

  const deferredQueues = getAllDeferredQueues();
  const chats: DeferredChatView[] = Array.from(deferredQueues.entries()).map(([chatId, items]) => {
    const now = Date.now();
    const ages = items.map((item) => Math.max(0, Math.floor((now - item.enqueuedAt) / 1000)));
    return {
      chatId,
      size: items.length,
      oldestAgeSec: ages.length ? Math.max(...ages) : 0,
      newestAgeSec: ages.length ? Math.min(...ages) : 0,
      preview: items.slice(0, 2).map((item) =>
        item.kind === "user_message"
          ? safeSubstring(item.text.trim(), 60)
          : `[cron] ${safeSubstring(item.prompt.trim(), 53)}`
      ),
    };
  }).sort((a, b) => b.size - a.size || b.oldestAgeSec - a.oldestAgeSec);

  let totalMessages = 0;
  for (const [, items] of deferredQueues) {
    totalMessages += items.length;
  }
  const hasQueuePressure = totalMessages > 0;
  const queueSummary = queuePressureSummary(totalMessages, chats.length);
  const driverProcesses: ProcessView[] = getDriverProcessStates().map((state) => {
    const status = mapDriverStatus(
      state.runningState.isRunning,
      hasQueuePressure,
      state.runningState.activeDriverId === state.driver
    );
    return {
      id: state.processId,
      kind: "driver",
      label: state.label,
      status,
      pid: state.runningState.isRunning ? "active" : "-",
      elapsed: state.runningState.isRunning ? elapsedFrom(state.runningSince) : "0s",
      detail: status === "queued" ? `${state.detail} · ${queueSummary}` : state.detail,
    };
  });

  const processes: ProcessView[] = [
    ...driverProcesses,
    {
      id: "background-check",
      kind: "background",
      label: "Background checks",
      status: isBackgroundRunActive() ? "running" : "idle",
      pid: "-",
      elapsed: "n/a",
      detail: isBackgroundRunActive() ? "cron snapshot supervision active" : "idle",
    },
    ...preparedTurtles.map((turtle) => ({
      id: `subturtle-${turtle.name}`,
      kind: "subturtle" as const,
      label: turtle.name,
      status: mapSubturtleStatus(turtle.status),
      pid: turtle.pid || "-",
      elapsed: turtle.elapsed,
      detail: buildSubturtleProcessDetail(turtle.task || "", turtle.status),
    })),
  ];

  return {
    generatedAt: new Date().toISOString(),
    turtles,
    processes,
    lanes: sortSubturtleLanes(lanes),
    deferredQueue: {
      totalChats: chats.length,
      totalMessages,
      chats,
    },
    background: {
      runActive: isBackgroundRunActive(),
      runPreempted: wasBackgroundRunPreempted(),
      supervisionQueue: getPreparedSnapshotCount(),
    },
    cronJobs,
  };
}

function assembleCurrentJobs(preparedTurtles: PreparedDashboardTurtle[]): CurrentJobView[] {
  const jobs: CurrentJobView[] = [];

  for (const driverState of getDriverProcessStates()) {
    if (!driverState.runningState.isRunning || !driverState.currentJobName) {
      continue;
    }
    jobs.push({
      id: `driver:${driverState.driver}:active`,
      name: driverState.currentJobName,
      ownerType: "driver",
      ownerId: driverState.processId,
      detailLink: `/api/jobs/${encodeURIComponent(`driver:${driverState.driver}:active`)}`,
    });
  }

  for (const turtle of preparedTurtles) {
    if (turtle.status !== "running") continue;
    const current = turtle.backlogCurrent || turtle.laneTask || turtle.task || "";
    if (!current) continue;
    jobs.push({
      id: `subturtle:${turtle.name}:current`,
      name: current,
      ownerType: "subturtle",
      ownerId: `subturtle-${turtle.name}`,
      detailLink: `/api/jobs/${encodeURIComponent(`subturtle:${turtle.name}:current`)}`,
    });
  }

  return jobs;
}

export async function buildSubturtleListResponse(): Promise<SubturtleListResponse> {
  const lanes = (await prepareDashboardTurtles()).map(buildLaneView);
  return {
    generatedAt: new Date().toISOString(),
    lanes: sortSubturtleLanes(lanes),
  };
}

export async function buildDashboardState(): Promise<DashboardState> {
  return assembleDashboardState(await prepareDashboardTurtles());
}

export function buildConductorResponse(): ConductorResponse {
  return {
    generatedAt: new Date().toISOString(),
    workers: loadWorkerStates(CONDUCTOR_STATE_DIR),
    wakeups: loadPendingWakeups(CONDUCTOR_STATE_DIR),
    inbox: listPendingMetaAgentInboxItems({
      stateDir: CONDUCTOR_STATE_DIR,
      limit: Number.MAX_SAFE_INTEGER,
    }),
  };
}

export async function buildCurrentJobs(): Promise<CurrentJobView[]> {
  return assembleCurrentJobs(await prepareDashboardTurtles());
}

export async function buildDashboardOverviewResponse(
  buildSessions: () => Promise<SessionListResponse>
): Promise<DashboardOverviewResponse> {
  const [preparedTurtles, sessions] = await Promise.all([
    prepareDashboardTurtles(),
    buildSessions(),
  ]);
  const dashboard = assembleDashboardState(preparedTurtles);
  const jobs: CurrentJobsResponse = {
    generatedAt: dashboard.generatedAt,
    jobs: assembleCurrentJobs(preparedTurtles),
  };

  return {
    generatedAt: dashboard.generatedAt,
    dashboard,
    sessions,
    jobs,
  };
}
