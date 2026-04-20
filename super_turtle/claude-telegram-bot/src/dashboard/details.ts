import { existsSync, lstatSync, readFileSync, readlinkSync } from "fs";
import { join } from "path";
import { SUPERTURTLE_DATA_DIR, SUPERTURTLE_SUBTURTLES_DIR, WORKING_DIR } from "../config";
import {
  getSubTurtleElapsed,
  readClaudeBacklogItems,
} from "../handlers/commands";
import { getPreparedSnapshotCount } from "../cron-supervision-queue";
import { isBackgroundRunActive, wasBackgroundRunPreempted } from "../handlers/driver-routing";
import type {
  BackgroundExtra,
  DriverExtra,
  JobDetailResponse,
  ProcessDetailResponse,
  ProcessDetailView,
  ProcessView,
  SubturtleDetailResponse,
  SubturtleExtra,
  SubturtleLogsResponse,
  WorkerResultRecord,
} from "../dashboard-types";
import {
  buildCurrentJobs,
  buildDashboardState,
  getDriverProcessStates,
  readSubturtles,
} from "./data";
import {
  computeProgressPct,
  elapsedFrom,
  parseMetaFile,
  readFileOr,
} from "./helpers";

// Detail builders back the drill-down pages and APIs for a single process, job, or SubTurtle.
const CONDUCTOR_STATE_DIR = join(SUPERTURTLE_DATA_DIR, "state");

function loadWorkerEventsForDetail(workerName: string, maxEvents = 20): Array<{
  id: string;
  timestamp: string;
  eventType: string;
  emittedBy: string;
  lifecycleState: string | null;
}> {
  const eventsPath = join(CONDUCTOR_STATE_DIR, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  try {
    return readFileSync(eventsPath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            parsed.worker_name === workerName
          ) {
            return [{
              id: String(parsed.id || ""),
              timestamp: String(parsed.timestamp || ""),
              eventType: String(parsed.event_type || ""),
              emittedBy: String(parsed.emitted_by || ""),
              lifecycleState: parsed.lifecycle_state ? String(parsed.lifecycle_state) : null,
            }];
          }
          return [];
        } catch {
          return [];
        }
      })
      .slice(-maxEvents);
  } catch {
    return [];
  }
}

function readAgentsMdInfo(workspaceDir: string): { exists: boolean; target: string | null } | null {
  const agentsMdPath = join(workspaceDir, "AGENTS.md");
  try {
    const stat = lstatSync(agentsMdPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(agentsMdPath);
      return { exists: true, target };
    }
    return { exists: true, target: null };
  } catch {
    return { exists: false, target: null };
  }
}

function readFullWorkerState(name: string): Record<string, unknown> | null {
  const path = join(CONDUCTOR_STATE_DIR, "workers", `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readWorkerResult(name: string): WorkerResultRecord | null {
  const path = join(CONDUCTOR_STATE_DIR, "results", `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).worker_name === "string"
      ? (parsed as WorkerResultRecord)
      : null;
  } catch {
    return null;
  }
}

export async function buildSubturtleDetail(name: string): Promise<SubturtleDetailResponse | null> {
  const turtles = await readSubturtles();
  const turtle = turtles.find((entry) => entry.name === name);
  if (!turtle) return null;

  const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(name) : "0s";
  const workerState = readFullWorkerState(name);
  const workerResult = readWorkerResult(name);
  const workspaceDir = (workerState?.workspace as string) || `${SUPERTURTLE_SUBTURTLES_DIR}/${name}`;

  const claudeMdPath = join(workspaceDir, "CLAUDE.md");
  const metaPath = join(workspaceDir, "subturtle.meta");
  const tunnelPath = join(workspaceDir, ".tunnel-url");
  const rootClaudeMdPath = `${WORKING_DIR}/CLAUDE.md`;

  const [claudeMd, metaContent, tunnelUrl, rootClaudeMd] = await Promise.all([
    readFileOr(claudeMdPath, ""),
    readFileOr(metaPath, ""),
    readFileOr(tunnelPath, ""),
    readFileOr(rootClaudeMdPath, ""),
  ]);

  const meta = parseMetaFile(metaContent);
  const backlog = await readClaudeBacklogItems(claudeMdPath);
  const backlogDone = backlog.filter((item) => item.done).length;
  const backlogCurrent =
    backlog.find((item) => item.current && !item.done)?.text ||
    backlog.find((item) => !item.done)?.text ||
    "";

  const skills: string[] = [];
  const rawSkills = typeof meta.SKILLS === "string" ? meta.SKILLS : "";
  if (rawSkills) {
    try {
      const parsed = JSON.parse(rawSkills);
      if (Array.isArray(parsed)) {
        for (const skill of parsed) {
          if (typeof skill === "string" && skill.length > 0) skills.push(skill);
        }
      }
    } catch {}
  }

  const conductor = workerState
    ? {
        lifecycleState: String(workerState.lifecycle_state || "unknown"),
        runId: (workerState.run_id as string) || null,
        checkpoint: (workerState.checkpoint as Record<string, unknown>) || null,
        createdAt: (workerState.created_at as string) || null,
        updatedAt: (workerState.updated_at as string) || null,
        stopReason: (workerState.stop_reason as string) || null,
        terminalAt: (workerState.terminal_at as string) || null,
      }
    : null;

  return {
    generatedAt: new Date().toISOString(),
    name,
    status: turtle.status,
    type: turtle.type || "unknown",
    pid: turtle.pid || "",
    elapsed,
    timeRemaining: turtle.timeRemaining || "",
    task: turtle.task || "",
    tunnelUrl: tunnelUrl.trim(),
    claudeMd,
    rootClaudeMd,
    agentsMdInfo: readAgentsMdInfo(workspaceDir),
    skills,
    meta,
    backlog,
    backlogSummary: {
      done: backlogDone,
      total: backlog.length,
      current: backlogCurrent,
      progressPct: computeProgressPct(backlogDone, backlog.length),
    },
    conductor,
    events: loadWorkerEventsForDetail(name),
    workerResult,
  };
}

export async function buildSubturtleLogs(
  name: string,
  lineCount?: number
): Promise<SubturtleLogsResponse | null> {
  const logPath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/subturtle.log`;
  const pidPath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/subturtle.pid`;

  const pidExists = await Bun.file(pidPath).exists();
  const logExists = await Bun.file(logPath).exists();
  if (!pidExists && !logExists) return null;

  const safeLineCount = Math.max(1, Math.min(500, lineCount ?? 100));
  let lines: string[] = [];
  let totalLines = 0;

  if (logExists) {
    const proc = Bun.spawnSync(["tail", "-n", String(safeLineCount), logPath]);
    const output = proc.stdout.toString();
    lines = output ? output.split("\n").filter((line) => line.length > 0) : [];

    const wcProc = Bun.spawnSync(["wc", "-l", logPath]);
    const wcOut = wcProc.stdout.toString().trim();
    totalLines = parseInt(wcOut, 10) || 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    name,
    lines,
    totalLines,
  };
}

function getDriverProcessStateById(processId: string) {
  return getDriverProcessStates().find((state) => state.processId === processId) || null;
}

function addDetailLink(process: ProcessView): ProcessDetailView {
  return { ...process, detailLink: `/api/processes/${encodeURIComponent(process.id)}` };
}

async function buildProcessExtra(p: ProcessView): Promise<DriverExtra | SubturtleExtra | BackgroundExtra> {
  if (p.kind === "driver") {
    const driverState = getDriverProcessStateById(p.id);
    if (driverState) {
      return driverState.extra;
    }
  }
  if (p.kind === "background") {
    return {
      kind: "background",
      runActive: isBackgroundRunActive(),
      runPreempted: wasBackgroundRunPreempted(),
      supervisionQueue: getPreparedSnapshotCount(),
    };
  }

  const name = p.id.replace(/^subturtle-/, "");
  const statePath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/CLAUDE.md`;
  const backlog = await readClaudeBacklogItems(statePath);
  const backlogDone = backlog.filter((item) => item.done).length;
  const backlogCurrent =
    backlog.find((item) => item.current && !item.done)?.text ||
    backlog.find((item) => !item.done)?.text ||
    "";
  return {
    kind: "subturtle",
    backlogSummary: {
      done: backlogDone,
      total: backlog.length,
      current: backlogCurrent,
      progressPct: computeProgressPct(backlogDone, backlog.length),
    },
    logsLink: `/api/subturtles/${encodeURIComponent(name)}/logs`,
    detailLink: `/api/subturtles/${encodeURIComponent(name)}`,
  };
}

export async function buildProcessDetail(id: string): Promise<ProcessDetailResponse | null> {
  const state = await buildDashboardState();
  const process = state.processes.find((entry) => entry.id === id);
  if (!process) return null;

  return {
    generatedAt: new Date().toISOString(),
    process: addDetailLink(process),
    extra: await buildProcessExtra(process),
  };
}

export async function buildCurrentJobDetail(id: string): Promise<JobDetailResponse | null> {
  const jobs = await buildCurrentJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return null;

  const ownerLink = `/api/processes/${encodeURIComponent(job.ownerId)}`;
  let logsLink: string | null = null;
  const extra: JobDetailResponse["extra"] = {};

  if (job.ownerType === "subturtle") {
    const name = job.ownerId.replace(/^subturtle-/, "");
    logsLink = `/api/subturtles/${encodeURIComponent(name)}/logs`;
    const statePath = `${SUPERTURTLE_SUBTURTLES_DIR}/${name}/CLAUDE.md`;
    const backlog = await readClaudeBacklogItems(statePath);
    const backlogDone = backlog.filter((item) => item.done).length;
    const backlogCurrent =
      backlog.find((item) => item.current && !item.done)?.text ||
      backlog.find((item) => !item.done)?.text ||
      "";
    extra.backlogSummary = {
      done: backlogDone,
      total: backlog.length,
      current: backlogCurrent,
      progressPct: computeProgressPct(backlogDone, backlog.length),
    };
    extra.elapsed = await getSubTurtleElapsed(name);
  } else {
    const driverState = getDriverProcessStateById(job.ownerId);
    if (driverState) {
      extra.elapsed = driverState.runningState.isRunning ? elapsedFrom(driverState.runningSince) : "0s";
      extra.currentTool = driverState.extra.currentTool;
      extra.lastTool = driverState.extra.lastTool;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    job,
    ownerLink,
    logsLink,
    extra,
  };
}
