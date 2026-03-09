import { existsSync, lstatSync, readFileSync, readlinkSync } from "fs";
import { join, resolve } from "path";
import { WORKING_DIR, DASHBOARD_ENABLED, DASHBOARD_AUTH_TOKEN, DASHBOARD_PORT, DASHBOARD_PUBLIC_BASE_URL, META_PROMPT, SUPER_TURTLE_DIR, SUPERTURTLE_DATA_DIR } from "./config";
import { getJobs } from "./cron";
import {
  getSubTurtleElapsed,
  readClaudeBacklogItems,
} from "./handlers/commands";
import { session, getAvailableModels } from "./session";
import { codexSession } from "./codex-session";
import { getPreparedSnapshotCount } from "./cron-supervision-queue";
import { isBackgroundRunActive, wasBackgroundRunPreempted } from "./handlers/driver-routing";
import { logger } from "./logger";
import {
  type DriverProcessState,
  getSessionObservabilityProvider,
  getSessionObservabilityProviders,
} from "./session-observability";
import type { RecentMessage, SavedSession } from "./types";
import type { ProcessView, DashboardOverviewResponse, SubturtleDetailResponse, SubturtleLogsResponse, CronListResponse, SessionResponse, SessionDriver, SessionListItem, SessionListResponse, SessionMessageView, SessionMetaView, SessionDetailResponse, SessionTurnView, SessionTurnsResponse, ContextResponse, ProcessDetailView, ProcessDetailResponse, DriverExtra, SubturtleExtra, BackgroundExtra, CurrentJobsResponse, JobDetailResponse, QueueResponse } from "./dashboard-types";
import {
  buildConductorResponse,
  buildCronJobView,
  buildCurrentJobs,
  buildDashboardOverviewResponse,
  buildDashboardState,
  buildSubturtleListResponse,
  readSubturtles,
} from "./dashboard/data";
import {
  computeProgressPct,
  elapsedFrom,
  isAuthorized,
  notFoundResponse,
  parseMetaFile,
  readFileOr,
  unauthorizedResponse,
  validateSubturtleName,
  jsonResponse,
} from "./dashboard/helpers";
import {
  renderDashboardHtml,
  renderJobDetailHtml,
  renderProcessDetailHtml,
  renderSessionDetailHtml,
  renderSubturtleDetailHtml,
} from "./dashboard/renderers";

export {
  computeProgressPct,
  isAuthorized,
  jsonResponse,
  notFoundResponse,
  parseMetaFile,
  readFileOr,
  safeSubstring,
  validateSubturtleName,
} from "./dashboard/helpers";
export type { MetaFileData } from "./dashboard/helpers";

const dashboardLog = logger.child({ module: "dashboard" });
const CONDUCTOR_STATE_DIR = join(SUPERTURTLE_DATA_DIR, "state");
const DASHBOARD_OVERVIEW_CACHE_TTL_MS = 1200;

type SessionSnapshot = {
  row: SessionListItem;
  messages: SessionMessageView[];
  meta: SessionMetaView;
};

const dashboardOverviewCache: {
  value: DashboardOverviewResponse | null;
  expiresAt: number;
  promise: Promise<DashboardOverviewResponse> | null;
} = {
  value: null,
  expiresAt: 0,
  promise: null,
};

export function resetDashboardSessionCachesForTests(): void {
  dashboardOverviewCache.value = null;
  dashboardOverviewCache.expiresAt = 0;
  dashboardOverviewCache.promise = null;
}

const SESSION_STATUS_ORDER: Record<SessionListItem["status"], number> = {
  "active-running": 0,
  "active-idle": 1,
  saved: 2,
};

function buildSessionKey(driver: SessionDriver, sessionId: string): string {
  return `${driver}:${sessionId}`;
}

function validateSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length > 256) return false;
  if (sessionId.includes("/") || sessionId.includes("\\")) return false;
  return true;
}

function mapRecentMessages(recentMessages?: RecentMessage[], preview?: string): SessionMessageView[] {
  if (recentMessages && recentMessages.length > 0) {
    return recentMessages.map((msg) => ({
      role: msg.role,
      text: msg.text,
      timestamp: msg.timestamp,
      charCount: msg.text.length,
    }));
  }

  if (!preview) return [];
  const lines = preview
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2);

  const synthetic: SessionMessageView[] = [];
  for (const line of lines) {
    if (line.startsWith("You: ")) {
      const text = line.slice(5).trim();
      synthetic.push({
        role: "user",
        text,
        timestamp: "",
        charCount: text.length,
      });
    } else if (line.startsWith("Assistant: ")) {
      const text = line.slice(11).trim();
      synthetic.push({
        role: "assistant",
        text,
        timestamp: "",
        charCount: text.length,
      });
    }
  }
  return synthetic;
}

function buildMessagePreview(messages: SessionMessageView[], fallback?: string | null): string | null {
  if (messages.length === 0) return fallback || null;
  const first = messages[0]!;
  const second = messages[1];
  const left = `${first.role === "user" ? "You" : "Assistant"}: ${first.text}`;
  const right = second
    ? `\n${second.role === "user" ? "You" : "Assistant"}: ${second.text}`
    : "";
  const combined = `${left}${right}`;
  return combined.length > 280 ? `${combined.slice(0, 277)}...` : combined;
}

function upsertSavedSession(
  snapshots: Map<string, SessionSnapshot>,
  driver: SessionDriver,
  saved: SavedSession
): void {
  if (!validateSessionId(saved.session_id)) return;

  const messages = mapRecentMessages(saved.recentMessages, saved.preview);
  const key = buildSessionKey(driver, saved.session_id);
  const provider = getSessionObservabilityProvider(driver);
  snapshots.set(key, {
    row: {
      id: key,
      driver,
      sessionId: saved.session_id,
      title: saved.title || `${driver} session`,
      savedAt: saved.saved_at || null,
      lastActivity: null,
      status: "saved",
      messageCount: messages.length,
      workingDir: saved.working_dir || null,
      preview: buildMessagePreview(messages, saved.preview || null),
    },
    messages,
    meta: provider.getDefaultMeta(),
  });
}

function sortSessionRows(rows: SessionListItem[]): SessionListItem[] {
  return [...rows].sort((a, b) => {
    const rankDiff = SESSION_STATUS_ORDER[a.status] - SESSION_STATUS_ORDER[b.status];
    if (rankDiff !== 0) return rankDiff;
    const left = Date.parse(a.lastActivity || a.savedAt || "") || 0;
    const right = Date.parse(b.lastActivity || b.savedAt || "") || 0;
    if (left !== right) return right - left;
    return a.title.localeCompare(b.title);
  });
}

function getDriverProcessStates(): DriverProcessState[] {
  return getSessionObservabilityProviders().map((provider) => provider.getDriverProcessState());
}

function getDriverProcessStateById(processId: string): DriverProcessState | null {
  return getDriverProcessStates().find((state) => state.processId === processId) || null;
}

async function buildSessionSnapshotsForProviders(
  providers: ReturnType<typeof getSessionObservabilityProviders>
): Promise<Map<string, SessionSnapshot>> {
  const snapshots = new Map<string, SessionSnapshot>();
  const driverStates = new Map(
    providers.map((provider) =>
      [provider.driver, provider.getDriverProcessState()] satisfies [SessionDriver, DriverProcessState]
    )
  );

  for (const provider of providers) {
    for (const saved of await provider.listTrackedSessions()) {
      upsertSavedSession(snapshots, provider.driver, saved);
    }

    const activeSession = provider.getActiveSessionSnapshot();
    if (!activeSession || !validateSessionId(activeSession.session_id)) {
      continue;
    }

    const key = buildSessionKey(provider.driver, activeSession.session_id);
    const existing = snapshots.get(key);
    const messages = mapRecentMessages(
      activeSession.recentMessages,
      activeSession.preview || existing?.row.preview || undefined
    );
    const isRunning = driverStates.get(provider.driver)?.runningState.isRunning || false;

    snapshots.set(key, {
      row: {
        id: key,
        driver: provider.driver,
        sessionId: activeSession.session_id,
        title: activeSession.title || existing?.row.title || `Active ${provider.driver} session`,
        savedAt: activeSession.saved_at || existing?.row.savedAt || null,
        lastActivity: activeSession.saved_at || existing?.row.lastActivity || null,
        status: isRunning ? "active-running" : "active-idle",
        messageCount: messages.length,
        workingDir: activeSession.working_dir || WORKING_DIR,
        preview: buildMessagePreview(messages, activeSession.preview || existing?.row.preview || null),
      },
      messages,
      meta: provider.getActiveMeta(isRunning),
    });
  }

  return snapshots;
}

async function buildSessionSnapshots(): Promise<Map<string, SessionSnapshot>> {
  return buildSessionSnapshotsForProviders(getSessionObservabilityProviders());
}

async function buildSessionListResponse(): Promise<SessionListResponse> {
  const snapshots = await buildSessionSnapshots();
  const sessions = sortSessionRows(Array.from(snapshots.values()).map((snapshot) => snapshot.row));
  return {
    generatedAt: new Date().toISOString(),
    sessions,
  };
}

async function buildSessionDetail(
  driver: SessionDriver,
  sessionId: string
): Promise<SessionDetailResponse | null> {
  if (!validateSessionId(sessionId)) return null;
  const provider = getSessionObservabilityProvider(driver);
  const key = buildSessionKey(driver, sessionId);
  const snapshot = (await buildSessionSnapshotsForProviders([provider])).get(key);
  if (!snapshot) return null;
  const savedSession: SavedSession = {
    session_id: snapshot.row.sessionId,
    saved_at: snapshot.row.savedAt || "",
    working_dir: snapshot.row.workingDir || WORKING_DIR,
    title: snapshot.row.title,
    ...(snapshot.row.preview ? { preview: snapshot.row.preview } : {}),
    ...(snapshot.messages.length > 0
      ? {
          recentMessages: snapshot.messages.map((message) => ({
            role: message.role,
            text: message.text,
            timestamp: message.timestamp,
          })),
        }
      : {}),
  };
  const activeSession = provider.getActiveSessionSnapshot();
  const history = await provider.loadDisplayHistory(
    sessionId,
    savedSession,
    activeSession && activeSession.session_id === sessionId ? activeSession : null
  );
  const messages =
    history && history.messages.length > 0
      ? history.messages.map((message) => ({
          role: message.role,
          text: message.text,
          timestamp: message.timestamp,
          charCount: message.text.length,
        }))
      : snapshot.messages;

  return {
    generatedAt: new Date().toISOString(),
    session: snapshot.row,
    messages,
    meta: snapshot.meta,
    history,
  };
}

async function buildSessionTurns(
  driver: SessionDriver,
  sessionId: string,
  limit = 200
): Promise<SessionTurnsResponse | null> {
  const detail = await buildSessionDetail(driver, sessionId);
  if (!detail) return null;
  const provider = getSessionObservabilityProvider(driver);

  const turns: SessionTurnView[] = provider.listTurns(sessionId, limit).map((entry) => ({
    id: entry.id,
    driver: entry.driver,
    source: entry.source,
    sessionId: entry.sessionId,
    userId: entry.userId,
    username: entry.username,
    chatId: entry.chatId,
    model: entry.model,
    effort: entry.effort,
    originalMessage: entry.originalMessage,
    effectivePrompt: entry.effectivePrompt,
    injectedArtifacts: entry.injectedArtifacts || [],
    response: entry.response,
    error: entry.error,
    status: entry.status,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    elapsedMs: entry.elapsedMs,
    usage: entry.usage as Record<string, unknown> | null,
    injections: entry.injections,
    context: entry.context,
  }));

  return {
    generatedAt: new Date().toISOString(),
    session: detail.session,
    turns,
  };
}

async function getDashboardOverviewResponse(): Promise<DashboardOverviewResponse> {
  const now = Date.now();
  if (dashboardOverviewCache.value && dashboardOverviewCache.expiresAt > now) {
    return dashboardOverviewCache.value;
  }
  if (dashboardOverviewCache.promise) {
    return dashboardOverviewCache.promise;
  }

  const promise = buildDashboardOverviewResponse(buildSessionListResponse)
    .then((value) => {
      dashboardOverviewCache.value = value;
      dashboardOverviewCache.expiresAt = Date.now() + DASHBOARD_OVERVIEW_CACHE_TTL_MS;
      return value;
    })
    .finally(() => {
      dashboardOverviewCache.promise = null;
    });

  dashboardOverviewCache.promise = promise;
  return promise;
}

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

async function buildSubturtleDetail(name: string): Promise<SubturtleDetailResponse | null> {
  const turtles = await readSubturtles();
  const turtle = turtles.find((t) => t.name === name);
  if (!turtle) return null;

  const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(name) : "0s";

  // Use conductor state to find correct workspace (handles archived SubTurtles)
  const workerState = readFullWorkerState(name);
  const workspaceDir = (workerState?.workspace as string) || `${WORKING_DIR}/.subturtles/${name}`;

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

  // Extract skills from meta
  const skills: string[] = [];
  const rawSkills = typeof meta.SKILLS === "string" ? meta.SKILLS : "";
  if (rawSkills) {
    try {
      const parsed = JSON.parse(rawSkills);
      if (Array.isArray(parsed)) {
        for (const s of parsed) {
          if (typeof s === "string" && s.length > 0) skills.push(s);
        }
      }
    } catch { /* ignore */ }
  }

  // Build conductor view
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

  // Load events and AGENTS.md info
  const events = loadWorkerEventsForDetail(name);
  const agentsMdInfo = readAgentsMdInfo(workspaceDir);

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
    agentsMdInfo,
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
    events,
  };
}

async function buildSubturtleLogs(name: string, lineCount?: number): Promise<SubturtleLogsResponse | null> {
  const logPath = `${WORKING_DIR}/.subturtles/${name}/subturtle.log`;
  const pidPath = `${WORKING_DIR}/.subturtles/${name}/subturtle.pid`;

  const pidExists = await Bun.file(pidPath).exists();
  const logExists = await Bun.file(logPath).exists();
  if (!pidExists && !logExists) return null;

  const safeLineCount = Math.max(1, Math.min(500, lineCount ?? 100));
  let lines: string[] = [];
  let totalLines = 0;

  if (logExists) {
    const proc = Bun.spawnSync(["tail", "-n", String(safeLineCount), logPath]);
    const output = proc.stdout.toString();
    lines = output ? output.split("\n").filter((l) => l.length > 0) : [];

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

async function buildProcessDetail(id: string): Promise<ProcessDetailResponse | null> {
  const state = await buildDashboardState();
  const process = state.processes.find((p) => p.id === id);
  if (!process) return null;

  const extra = await buildProcessExtra(process);
  return {
    generatedAt: new Date().toISOString(),
    process: addDetailLink(process),
    extra,
  };
}

async function buildCurrentJobDetail(id: string): Promise<JobDetailResponse | null> {
  const jobs = await buildCurrentJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;

  const ownerLink = `/api/processes/${encodeURIComponent(job.ownerId)}`;
  let logsLink: string | null = null;
  const extra: JobDetailResponse["extra"] = {};

  if (job.ownerType === "subturtle") {
    const name = job.ownerId.replace(/^subturtle-/, "");
    logsLink = `/api/subturtles/${encodeURIComponent(name)}/logs`;
    const statePath = `${WORKING_DIR}/.subturtles/${name}/CLAUDE.md`;
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

/* ── Process + Job detail helpers ──────────────────────────────────── */

function addDetailLink(p: ProcessView): ProcessDetailView {
  return { ...p, detailLink: `/api/processes/${encodeURIComponent(p.id)}` };
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
  // subturtle
  const name = p.id.replace(/^subturtle-/, "");
  const statePath = `${WORKING_DIR}/.subturtles/${name}/CLAUDE.md`;
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

/* ── Route table ──────────────────────────────────────────────────── */

type RouteHandler = (req: Request, url: URL, match: RegExpMatchArray) => Promise<Response>;

export const routes: Array<{ pattern: RegExp; handler: RouteHandler }> = [
  {
    pattern: /^\/api\/subturtles$/,
    handler: async () => {
      return jsonResponse(await buildSubturtleListResponse());
    },
  },
  {
    pattern: /^\/api\/subturtles\/([^/]+)\/logs$/,
    handler: async (_req, url, match) => {
      const name = decodeURIComponent(match[1] ?? "");
      if (!validateSubturtleName(name)) return notFoundResponse("Invalid SubTurtle name");
      const linesParam = url.searchParams.get("lines");
      const lineCount = Math.max(1, Math.min(500, parseInt(linesParam || "100", 10) || 100));
      const response = await buildSubturtleLogs(name, lineCount);
      if (!response) return notFoundResponse("SubTurtle not found");
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/subturtles\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const name = decodeURIComponent(match[1] ?? "");
      if (!validateSubturtleName(name)) return notFoundResponse("Invalid SubTurtle name");
      const response = await buildSubturtleDetail(name);
      if (!response) return notFoundResponse("SubTurtle not found");
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/cron\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const id = decodeURIComponent(match[1] ?? "");
      const job = getJobs().find((j) => j.id === id);
      if (!job) return notFoundResponse("Cron job not found");
      return jsonResponse(buildCronJobView(job));
    },
  },
  {
    pattern: /^\/api\/cron$/,
    handler: async () => {
      const jobs = getJobs().map(buildCronJobView);
      const response: CronListResponse = {
        generatedAt: new Date().toISOString(),
        jobs,
      };
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/session$/,
    handler: async () => {
      const models = getAvailableModels();
      const currentModel = models.find((m) => m.value === session.model);
      const response: SessionResponse = {
        generatedAt: new Date().toISOString(),
        sessionId: session.sessionId,
        model: session.model,
        modelDisplayName: currentModel?.displayName || session.model,
        effort: session.effort,
        activeDriver: session.activeDriver,
        isRunning: session.isRunning,
        isActive: session.isActive,
        currentTool: session.currentTool,
        lastTool: session.lastTool,
        lastError: session.lastError,
        lastErrorTime: session.lastErrorTime?.toISOString() || null,
        conversationTitle: session.conversationTitle,
        queryStarted: session.queryStarted?.toISOString() || null,
        lastActivity: session.lastActivity?.toISOString() || null,
      };
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/sessions$/,
    handler: async () => {
      return jsonResponse(await buildSessionListResponse());
    },
  },
  {
    pattern: /^\/api\/sessions\/(claude|codex)\/([^/]+)\/turns$/,
    handler: async (_req, url, match) => {
      const driver = decodeURIComponent(match[1] ?? "") as SessionDriver;
      const sessionId = decodeURIComponent(match[2] ?? "");
      if ((driver !== "claude" && driver !== "codex") || !validateSessionId(sessionId)) {
        return notFoundResponse("Invalid session identifier");
      }
      const rawLimit = parseInt(url.searchParams.get("limit") || "200", 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(5000, rawLimit))
        : 200;
      const turns = await buildSessionTurns(driver, sessionId, limit);
      if (!turns) return notFoundResponse("Session not found");
      return jsonResponse(turns);
    },
  },
  {
    pattern: /^\/api\/sessions\/(claude|codex)\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const driver = decodeURIComponent(match[1] ?? "") as SessionDriver;
      const sessionId = decodeURIComponent(match[2] ?? "");
      if ((driver !== "claude" && driver !== "codex") || !validateSessionId(sessionId)) {
        return notFoundResponse("Invalid session identifier");
      }
      const detail = await buildSessionDetail(driver, sessionId);
      if (!detail) return notFoundResponse("Session not found");
      return jsonResponse(detail);
    },
  },
  {
    pattern: /^\/api\/context$/,
    handler: async () => {
      const claudeMdPath = `${WORKING_DIR}/CLAUDE.md`;
      const metaPromptPath = resolve(SUPER_TURTLE_DIR, "meta/META_SHARED.md");
      const agentsMdPath = `${WORKING_DIR}/AGENTS.md`;

      const claudeMd = await readFileOr(claudeMdPath, "");
      const response: ContextResponse = {
        generatedAt: new Date().toISOString(),
        claudeMd,
        claudeMdPath,
        claudeMdExists: claudeMd.length > 0,
        metaPrompt: META_PROMPT,
        metaPromptSource: metaPromptPath,
        metaPromptExists: META_PROMPT.length > 0,
        agentsMdExists: existsSync(agentsMdPath),
      };
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/processes$/,
    handler: async () => {
      const state = await buildDashboardState();
      const processes = state.processes.map(addDetailLink);
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        processes,
      });
    },
  },
  {
    pattern: /^\/api\/queue$/,
    handler: async () => {
      const state = await buildDashboardState();
      const response: QueueResponse = {
        generatedAt: new Date().toISOString(),
        ...state.deferredQueue,
      };
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/processes\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const id = decodeURIComponent(match[1] ?? "");
      if (!id) return notFoundResponse("Invalid process ID");
      const response = await buildProcessDetail(id);
      if (!response) return notFoundResponse("Process not found");
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/jobs\/current$/,
    handler: async () => {
      const jobs = await buildCurrentJobs();
      const response: CurrentJobsResponse = {
        generatedAt: new Date().toISOString(),
        jobs,
      };
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/jobs\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const id = decodeURIComponent(match[1] ?? "");
      if (!id) return notFoundResponse("Invalid job ID");
      const response = await buildCurrentJobDetail(id);
      if (!response) return notFoundResponse("Job not found");
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/dashboard\/overview$/,
    handler: async () => {
      return jsonResponse(await getDashboardOverviewResponse());
    },
  },
  {
    pattern: /^\/api\/dashboard$/,
    handler: async () => {
      const data = await buildDashboardState();
      return jsonResponse(data);
    },
  },
  {
    pattern: /^\/api\/conductor$/,
    handler: async () => {
      return jsonResponse(buildConductorResponse());
    },
  },
  {
    pattern: /^\/dashboard\/subturtles\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const name = decodeURIComponent(match[1] ?? "");
      if (!validateSubturtleName(name)) return notFoundResponse("Invalid SubTurtle name");
      const detail = await buildSubturtleDetail(name);
      if (!detail) return notFoundResponse("SubTurtle not found");
      const logs = await buildSubturtleLogs(name, 200);
      return new Response(renderSubturtleDetailHtml(detail, logs), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  {
    pattern: /^\/dashboard\/sessions\/(claude|codex)\/([^/]+)$/,
    handler: async (_req, url, match) => {
      const driver = decodeURIComponent(match[1] ?? "") as SessionDriver;
      const sessionId = decodeURIComponent(match[2] ?? "");
      if ((driver !== "claude" && driver !== "codex") || !validateSessionId(sessionId)) {
        return notFoundResponse("Invalid session identifier");
      }
      const detail = await buildSessionDetail(driver, sessionId);
      if (!detail) return notFoundResponse("Session not found");
      const rawLimit = parseInt(url.searchParams.get("limit") || "200", 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(5000, rawLimit))
        : 200;
      const turns = (await buildSessionTurns(driver, sessionId, limit))?.turns || [];
      return new Response(renderSessionDetailHtml(detail, turns), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  {
    pattern: /^\/dashboard\/processes\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const id = decodeURIComponent(match[1] ?? "");
      const detail = await buildProcessDetail(id);
      if (!detail) return notFoundResponse("Process not found");
      const logs = detail.process.kind === "subturtle"
        ? await buildSubturtleLogs(detail.process.id.replace(/^subturtle-/, ""), 200)
        : null;
      return new Response(renderProcessDetailHtml(detail, logs), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  {
    pattern: /^\/dashboard\/jobs\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const id = decodeURIComponent(match[1] ?? "");
      const detail = await buildCurrentJobDetail(id);
      if (!detail) return notFoundResponse("Job not found");
      const logs = detail.logsLink && detail.logsLink.startsWith("/api/subturtles/")
        ? await buildSubturtleLogs(detail.logsLink.split("/")[3]!, 200)
        : null;
      return new Response(renderJobDetailHtml(detail, logs), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  {
    pattern: /^(?:\/|\/dashboard|\/index\.html)$/,
    handler: async () => {
      return new Response(renderDashboardHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
];

export function startDashboardServer(): void {
  if (!DASHBOARD_ENABLED) {
    return;
  }

  const publicDashboardUrl = `${DASHBOARD_PUBLIC_BASE_URL}/dashboard`;
  const openDashboardUrl = DASHBOARD_AUTH_TOKEN
    ? `${publicDashboardUrl}?token=${encodeURIComponent(DASHBOARD_AUTH_TOKEN)}`
    : publicDashboardUrl;

  if (!DASHBOARD_AUTH_TOKEN) {
    dashboardLog.info(
        {
        bindHost: "127.0.0.1",
        port: DASHBOARD_PORT,
        publicUrl: publicDashboardUrl,
        openUrl: openDashboardUrl,
        authEnabled: false,
      },
      `Starting dashboard on ${openDashboardUrl}`
    );
  } else {
    dashboardLog.info(
        {
        bindHost: "127.0.0.1",
        port: DASHBOARD_PORT,
        publicUrl: publicDashboardUrl,
        openUrl: openDashboardUrl,
        authEnabled: true,
      },
      `Starting dashboard on ${openDashboardUrl}`
    );
  }

  Bun.serve({
    port: DASHBOARD_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!isAuthorized(req)) return unauthorizedResponse();

      const url = new URL(req.url);
      for (const route of routes) {
        const match = url.pathname.match(route.pattern);
        if (match) return route.handler(req, url, match);
      }

      return notFoundResponse();
    },
  });
}
