import { existsSync } from "fs";
import { resolve } from "path";
import { WORKING_DIR, CTL_PATH, DASHBOARD_ENABLED, DASHBOARD_AUTH_TOKEN, DASHBOARD_BIND_ADDR, DASHBOARD_PORT, META_PROMPT, SUPER_TURTLE_DIR } from "./config";
import { getJobs } from "./cron";
import { parseCtlListOutput, getSubTurtleElapsed, readClaudeBacklogItems, type ListedSubTurtle } from "./handlers/commands";
import { getAllDeferredQueues } from "./deferred-queue";
import { session, getAvailableModels } from "./session";
import { codexSession } from "./codex-session";
import { getPreparedSnapshotCount } from "./cron-supervision-queue";
import { getExecutingDriverId, isBackgroundRunActive, wasBackgroundRunPreempted } from "./handlers/driver-routing";
import { logger } from "./logger";
import { readTurnLogEntries } from "./turn-log";
import { buildExternalSessionHistory, buildSavedSessionHistory, buildTurnLogHistory } from "./session-history";
import type { RecentMessage, SavedSession } from "./types";
import type { TurtleView, ProcessView, DeferredChatView, SubturtleLaneView, DashboardState, SubturtleListResponse, SubturtleDetailResponse, SubturtleLogsResponse, CronListResponse, CronJobView, SessionResponse, SessionDriver, SessionListItem, SessionListResponse, SessionMessageView, SessionMetaView, SessionDetailResponse, SessionTurnView, SessionTurnsResponse, ContextResponse, ProcessDetailView, ProcessDetailResponse, DriverExtra, SubturtleExtra, BackgroundExtra, CurrentJobView, CurrentJobsResponse, JobDetailResponse, QueueResponse } from "./dashboard-types";

const dashboardLog = logger.child({ module: "dashboard" });

/* ── Shared response helpers ────────────────────────────────────────── */

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function notFoundResponse(msg = "Not found"): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/* ── File / meta helpers ────────────────────────────────────────────── */

export async function readFileOr(path: string, fallback: string): Promise<string> {
  try {
    const file = Bun.file(path);
    return await file.text();
  } catch {
    return fallback;
  }
}

export interface MetaFileData {
  spawnedAt: number | null;
  timeoutSeconds: number | null;
  loopType: string | null;
  skills: string[];
  watchdogPid: number | null;
  cronJobId: string | null;
  [key: string]: unknown;
}

export function parseMetaFile(content: string): MetaFileData {
  const result: MetaFileData = {
    spawnedAt: null,
    timeoutSeconds: null,
    loopType: null,
    skills: [],
    watchdogPid: null,
    cronJobId: null,
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    switch (key) {
      case "SPAWNED_AT":
        result.spawnedAt = parseInt(value, 10) || null;
        break;
      case "TIMEOUT_SECONDS":
        result.timeoutSeconds = parseInt(value, 10) || null;
        break;
      case "LOOP_TYPE":
        result.loopType = value || null;
        break;
      case "SKILLS":
        try {
          const parsed = JSON.parse(value);
          result.skills = Array.isArray(parsed) ? parsed : [];
        } catch {
          result.skills = [];
        }
        break;
      case "WATCHDOG_PID":
        result.watchdogPid = parseInt(value, 10) || null;
        break;
      case "CRON_JOB_ID":
        result.cronJobId = value || null;
        break;
      default:
        result[key] = value;
        break;
    }
  }
  return result;
}

/* ── Validation helpers ─────────────────────────────────────────────── */

const INVALID_NAME_RE = /(?:^\.)|[\/\\]|\.\./;

export function validateSubturtleName(name: string): boolean {
  if (!name || name.length > 128) return false;
  return !INVALID_NAME_RE.test(name);
}

export function isAuthorized(request: Request): boolean {
  if (!DASHBOARD_AUTH_TOKEN) return true;
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("token") || "";
  const tokenFromHeader = request.headers.get("x-dashboard-token") || "";
  const authorization = request.headers.get("authorization") || "";
  const tokenFromAuthorization = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : authorization.trim();

  return (
    tokenFromQuery === DASHBOARD_AUTH_TOKEN
    || tokenFromHeader === DASHBOARD_AUTH_TOKEN
    || tokenFromAuthorization === DASHBOARD_AUTH_TOKEN
  );
}

async function readSubturtles(): Promise<ListedSubTurtle[]> {
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

export function safeSubstring(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}...`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderJsonPre(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "n/a";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1);
  const day = String(parsed.getDate());
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  const second = String(parsed.getSeconds()).padStart(2, "0");
  return `${day}.${month}.${year} ${hour}:${minute}:${second}`;
}

export function computeProgressPct(done: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.round((done / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

function elapsedFrom(startedAt: Date | null): string {
  if (!startedAt) return "0s";
  const elapsedMs = Math.max(0, Date.now() - startedAt.getTime());
  const total = Math.floor(elapsedMs / 1000);
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function queuePressureSummary(totalMessages: number, totalChats: number): string {
  const msgLabel = totalMessages === 1 ? "1 queued msg" : `${totalMessages} queued msgs`;
  const chatLabel = totalChats === 1 ? "1 chat" : `${totalChats} chats`;
  return `${msgLabel} across ${chatLabel}`;
}

function mapDriverStatus(
  isRunning: boolean,
  hasQueuePressure: boolean,
  isActiveDriver: boolean
): ProcessView["status"] {
  if (hasQueuePressure && (isRunning || isActiveDriver)) return "queued";
  return isRunning ? "running" : "idle";
}

function mapSubturtleStatus(rawStatus: string): ProcessView["status"] {
  const status = rawStatus.trim().toLowerCase();
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "stopped") return "stopped";
  if (status === "error" || status === "failed" || status === "crashed") return "error";
  return "idle";
}

function buildSubturtleProcessDetail(task: string, rawStatus: string): string {
  const cleanTask = task.trim();
  const status = rawStatus.trim().toLowerCase();
  if (!rawStatus.trim()) return cleanTask;
  if (
    status === "running"
    || status === "idle"
    || status === "queued"
    || status === "stopped"
    || status === "error"
    || status === "failed"
    || status === "crashed"
  ) {
    return cleanTask;
  }
  return cleanTask ? `status=${rawStatus}; ${cleanTask}` : `status=${rawStatus}`;
}

function humanInterval(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `every ${day}d`;
  if (hr > 0) return `every ${hr}h`;
  if (min > 0) return `every ${min}m`;
  return `every ${sec}s`;
}

function buildCronJobView(job: ReturnType<typeof getJobs>[number]): CronJobView {
  return {
    id: job.id,
    type: job.type,
    prompt: job.prompt,
    promptPreview: safeSubstring(job.prompt, 100),
    fireAt: job.fire_at,
    fireInMs: Math.max(0, job.fire_at - Date.now()),
    intervalMs: job.interval_ms,
    intervalHuman: humanInterval(job.interval_ms),
    chatId: job.chat_id || 0,
    silent: job.silent || false,
    createdAt: job.created_at,
  };
}

type SessionSnapshot = {
  row: SessionListItem;
  messages: SessionMessageView[];
  meta: SessionMetaView;
};

export function resetDashboardSessionCachesForTests(): void {
  // No-op; retained for test compatibility.
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

async function loadSessionHistory(driver: SessionDriver, saved: SavedSession | null, sessionId: string) {
  if (driver === "claude") {
    return buildTurnLogHistory("claude", sessionId) || buildSavedSessionHistory(saved);
  }

  const transcript = await codexSession.getSessionTranscript(sessionId);
  const codexHistory = transcript
    ? buildExternalSessionHistory({
        source: "codex-jsonl",
        path: transcript.path,
        messages: transcript.messages,
        injectedArtifacts: transcript.injectedArtifacts,
        context: {
          metaSharedLoaded: transcript.metaSharedLoaded,
          datePrefixApplied: transcript.datePrefixApplied,
        },
      })
    : null;

  return codexHistory
    || buildTurnLogHistory("codex", sessionId)
    || buildSavedSessionHistory(saved);
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

function defaultSessionMeta(driver: SessionDriver): SessionMetaView {
  if (driver === "claude") {
    return {
      model: session.model,
      effort: session.effort,
      isRunning: false,
      queryStarted: null,
      lastUsage: null,
      lastError: null,
      lastErrorTime: null,
      currentTool: null,
      lastTool: null,
    };
  }
  return {
    model: codexSession.model,
    effort: codexSession.reasoningEffort,
    isRunning: false,
    queryStarted: null,
    lastUsage: null,
    lastError: null,
    lastErrorTime: null,
    currentTool: null,
    lastTool: null,
  };
}

function upsertSavedSession(
  snapshots: Map<string, SessionSnapshot>,
  driver: SessionDriver,
  saved: SavedSession
): void {
  if (!validateSessionId(saved.session_id)) return;

  const messages = mapRecentMessages(saved.recentMessages, saved.preview);
  const key = buildSessionKey(driver, saved.session_id);
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
    meta: defaultSessionMeta(driver),
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

async function getDashboardCodexSessions(): Promise<SavedSession[]> {
  const trackedSessionIds = new Set<string>();
  for (const saved of codexSession.getSessionList()) {
    if (validateSessionId(saved.session_id)) {
      trackedSessionIds.add(saved.session_id);
    }
  }
  const activeThreadId = codexSession.getThreadId();
  if (activeThreadId && validateSessionId(activeThreadId)) {
    trackedSessionIds.add(activeThreadId);
  }
  for (const entry of readTurnLogEntries({ driver: "codex", limit: 5000 })) {
    if (entry.sessionId && validateSessionId(entry.sessionId)) {
      trackedSessionIds.add(entry.sessionId);
    }
  }

  if (trackedSessionIds.size === 0) {
    return codexSession.getSessionList();
  }

  const liveSessions = await codexSession.getSessionListLive();
  return liveSessions.filter((saved) => trackedSessionIds.has(saved.session_id));
}

function getDriverRunningState(): {
  activeDriverId: SessionDriver;
  executingDriverId: SessionDriver | null;
  claudeRunning: boolean;
  codexRunning: boolean;
} {
  const executingDriverId = getExecutingDriverId();
  const activeDriverId = executingDriverId || session.activeDriver;
  if (executingDriverId) {
    return {
      activeDriverId,
      executingDriverId,
      claudeRunning: executingDriverId === "claude",
      codexRunning: executingDriverId === "codex",
    };
  }

  return {
    activeDriverId,
    executingDriverId,
    claudeRunning: session.isRunning,
    codexRunning: codexSession.isRunning,
  };
}

async function buildSessionSnapshots(): Promise<Map<string, SessionSnapshot>> {
  const snapshots = new Map<string, SessionSnapshot>();
  const { claudeRunning, codexRunning } = getDriverRunningState();

  for (const saved of session.getSessionList()) {
    upsertSavedSession(snapshots, "claude", saved);
  }
  for (const saved of await getDashboardCodexSessions()) {
    upsertSavedSession(snapshots, "codex", saved);
  }

  const claudeSessionId = session.sessionId;
  if (claudeSessionId && validateSessionId(claudeSessionId)) {
    const key = buildSessionKey("claude", claudeSessionId);
    const existing = snapshots.get(key);
    const messages = mapRecentMessages(
      session.recentMessages,
      existing?.row.preview || undefined
    );
    snapshots.set(key, {
      row: {
        id: key,
        driver: "claude",
        sessionId: claudeSessionId,
        title: session.conversationTitle || existing?.row.title || "Active Claude session",
        savedAt: existing?.row.savedAt || null,
        lastActivity: session.lastActivity?.toISOString() || existing?.row.lastActivity || null,
        status: claudeRunning ? "active-running" : "active-idle",
        messageCount: messages.length,
        workingDir: WORKING_DIR,
        preview: buildMessagePreview(messages, existing?.row.preview || null),
      },
      messages,
      meta: {
        model: session.model,
        effort: session.effort,
        isRunning: claudeRunning,
        queryStarted: session.queryStarted?.toISOString() || null,
        lastUsage: session.lastUsage as Record<string, unknown> | null,
        lastError: session.lastError,
        lastErrorTime: session.lastErrorTime?.toISOString() || null,
        currentTool: session.currentTool,
        lastTool: session.lastTool,
      },
    });
  }

  const codexSessionId = codexSession.getThreadId();
  if (codexSessionId && validateSessionId(codexSessionId)) {
    const key = buildSessionKey("codex", codexSessionId);
    const existing = snapshots.get(key);
    const messages = mapRecentMessages(
      codexSession.recentMessages,
      existing?.row.preview || undefined
    );
    snapshots.set(key, {
      row: {
        id: key,
        driver: "codex",
        sessionId: codexSessionId,
        title: existing?.row.title || "Active Codex session",
        savedAt: existing?.row.savedAt || null,
        lastActivity: codexSession.lastActivity?.toISOString() || existing?.row.lastActivity || null,
        status: codexRunning ? "active-running" : "active-idle",
        messageCount: messages.length,
        workingDir: WORKING_DIR,
        preview: buildMessagePreview(messages, existing?.row.preview || null),
      },
      messages,
      meta: {
        model: codexSession.model,
        effort: codexSession.reasoningEffort,
        isRunning: codexRunning,
        queryStarted: codexSession.runningSince?.toISOString() || null,
        lastUsage: codexSession.lastUsage as Record<string, unknown> | null,
        lastError: codexSession.lastError,
        lastErrorTime: codexSession.lastErrorTime?.toISOString() || null,
        currentTool: null,
        lastTool: null,
      },
    });
  }

  return snapshots;
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
  const key = buildSessionKey(driver, sessionId);
  const snapshot = (await buildSessionSnapshots()).get(key);
  if (!snapshot) return null;
  const history = await loadSessionHistory(driver, {
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
  }, sessionId);
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

  const turns: SessionTurnView[] = readTurnLogEntries({
    driver,
    sessionId,
    limit,
  }).map((entry) => ({
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

async function buildSubturtleLanes(turtles: TurtleView[]): Promise<SubturtleLaneView[]> {
  return Promise.all(
    turtles.map(async (turtle) => {
      const statePath = `${WORKING_DIR}/.subturtles/${turtle.name}/CLAUDE.md`;
      const backlogItems = await readClaudeBacklogItems(statePath);
      const backlogTotal = backlogItems.length;
      const backlogDone = backlogItems.filter((item) => item.done).length;
      const backlogCurrent =
        backlogItems.find((item) => item.current && !item.done)?.text ||
        backlogItems.find((item) => !item.done)?.text ||
        "";

      return {
        name: turtle.name,
        status: turtle.status,
        type: turtle.type || "unknown",
        elapsed: turtle.elapsed,
        task: turtle.task || "",
        backlogDone,
        backlogTotal,
        backlogCurrent,
        progressPct: computeProgressPct(backlogDone, backlogTotal),
      };
    })
  );
}

async function buildDashboardState(): Promise<DashboardState> {
  const turtles = await readSubturtles();
  const elapsedByName = await Promise.all(
    turtles.map(async (turtle) => {
      const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(turtle.name) : "0s";
      return { ...turtle, elapsed };
    })
  );
  const lanes = await buildSubturtleLanes(elapsedByName);

  const allJobs = getJobs();
  const cronJobs = allJobs.map(buildCronJobView);

  const deferredQueues = getAllDeferredQueues();
  const chats: DeferredChatView[] = Array.from(deferredQueues.entries()).map(([chatId, messages]) => {
    const now = Date.now();
    const ages = messages.map((msg) => Math.max(0, Math.floor((now - msg.enqueuedAt) / 1000)));
    return {
      chatId,
      size: messages.length,
      oldestAgeSec: ages.length ? Math.max(...ages) : 0,
      newestAgeSec: ages.length ? Math.min(...ages) : 0,
      preview: messages.slice(0, 2).map((msg) => safeSubstring(msg.text.trim(), 60)),
    };
  }).sort((a, b) => b.size - a.size || b.oldestAgeSec - a.oldestAgeSec);

  let totalMessages = 0;
  for (const [, messages] of deferredQueues) {
    totalMessages += messages.length;
  }
  const hasQueuePressure = totalMessages > 0;
  const queueSummary = queuePressureSummary(totalMessages, chats.length);
  const { activeDriverId, claudeRunning, codexRunning } = getDriverRunningState();
  const claudeStatus = mapDriverStatus(
    claudeRunning,
    hasQueuePressure,
    activeDriverId === "claude"
  );
  const codexStatus = mapDriverStatus(
    codexRunning,
    hasQueuePressure,
    activeDriverId === "codex"
  );
  const claudeBaseDetail = session.currentTool || session.lastTool || "idle";
  const codexBaseDetail = codexSession.isActive ? "thread active" : "idle";

  const processes: ProcessView[] = [
    {
      id: "driver-claude",
      kind: "driver",
      label: "Claude driver",
      status: claudeStatus,
      pid: claudeRunning ? "active" : "-",
      elapsed: claudeRunning ? elapsedFrom(session.queryStarted) : "0s",
      detail: claudeStatus === "queued" ? `${claudeBaseDetail} · ${queueSummary}` : claudeBaseDetail,
    },
    {
      id: "driver-codex",
      kind: "driver",
      label: "Codex driver",
      status: codexStatus,
      pid: codexRunning ? "active" : "-",
      elapsed: codexRunning ? elapsedFrom(codexSession.runningSince) : "0s",
      detail: codexStatus === "queued" ? `${codexBaseDetail} · ${queueSummary}` : codexBaseDetail,
    },
    {
      id: "background-check",
      kind: "background",
      label: "Background checks",
      status: isBackgroundRunActive() ? "running" : "idle",
      pid: "-",
      elapsed: "n/a",
      detail: isBackgroundRunActive() ? "cron snapshot supervision active" : "idle",
    },
    ...elapsedByName.map((turtle) => ({
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
    turtles: elapsedByName,
    processes,
    lanes: lanes.sort((a, b) => {
      if (a.status === b.status) return a.name.localeCompare(b.name);
      if (a.status === "running") return -1;
      if (b.status === "running") return 1;
      return a.name.localeCompare(b.name);
    }),
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

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Super Turtle Dashboard</title>
    <style>
      html, body { height: 100%; }
      :root {
        color-scheme: light;
        --bg: #f4f6fb;
        --panel: #ffffff;
        --line: #d9e1ef;
        --text: #1f2430;
        --muted: #5f697d;
        --chip: #eef3ff;
        --chip-line: #cfdbf8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: var(--bg);
        line-height: 1.45;
        overflow: hidden;
      }
      .page {
        max-width: 1400px;
        margin: 0 auto;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      h1 {
        margin: 0;
      }
      h2 {
        margin: 0;
        font-size: 17px;
      }
      .panel-head {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: 8px;
      }
      .panel-note {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
      }
      a {
        color: #1e5cc8;
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0;
      }
      .badge-row .badge {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border: 1px solid var(--chip-line);
        border-radius: 999px;
        background: var(--chip);
        font-size: 13px;
        color: #2e3a52;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .dashboard-grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        grid-template-rows: auto minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
        align-items: stretch;
        flex: 1;
        min-height: 0;
      }
      .panel-lanes {
        grid-column: span 12;
        grid-row: 1;
      }
      .panel-sessions {
        grid-column: 1 / span 7;
        grid-row: 2;
      }
      .panel-processes {
        grid-column: 8 / span 5;
        grid-row: 2;
      }
      .panel-queue { grid-column: span 6; }
      .panel-jobs { grid-column: span 6; }
      .panel-queue { grid-row: 3; }
      .panel-jobs { grid-row: 3; }
      .panel-cron {
        grid-column: span 12;
        grid-row: 4;
      }
      .table-wrap {
        width: 100%;
        overflow: auto;
        min-height: 0;
        flex: 1;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      tbody tr:hover td {
        background: #fafcff;
      }
      .status-chip {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 12px;
        font-weight: 600;
      }
      .status-running { background: #ecf9f0; color: #166534; border-color: #b7e7c4; }
      .status-queued { background: #fff7e9; color: #9a6700; border-color: #f0d39a; }
      .status-idle { background: #f2f4f8; color: #4a5568; border-color: #d6dce8; }
      .status-error { background: #fdecec; color: #a61b1b; border-color: #f2bcbc; }
      .status-stopped { background: #f7f7f9; color: #636b76; border-color: #d8dce3; }
      .status-muted { background: #f5f6fa; color: #6e7785; border-color: #dde1ea; }
      .lane-list {
        list-style: none;
        padding: 0;
        margin: 0;
        overflow: auto;
        min-height: 0;
        flex: 1;
      }
      .lane-list li {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 8px 10px;
        background: #fcfdff;
      }
      .lane-list li + li { margin-top: 8px; }
      .status-line {
        margin: 0;
        color: #344055;
        font-size: 13px;
      }
      .panel-actions {
        margin-top: 10px;
      }
      .panel-btn {
        display: inline-block;
        border: 1px solid var(--chip-line);
        background: var(--chip);
        color: #2e3a52;
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 13px;
        cursor: pointer;
      }
      .panel-btn:hover {
        background: #e7eeff;
      }
      .panel-btn[hidden] {
        display: none;
      }
      @media (max-width: 1100px) {
        body {
          overflow: auto;
        }
        .page {
          height: auto;
        }
        .dashboard-grid {
          grid-template-rows: auto;
          flex: unset;
        }
        .panel-sessions,
        .panel-lanes,
        .panel-processes,
        .panel-queue,
        .panel-jobs,
        .panel-cron {
          grid-column: span 12;
          grid-row: auto;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <h1>Super Turtle Dashboard</h1>
      <p class="badge-row">
        <span id="updateBadge" class="badge">Loading…</span>
        <span id="sessionBadge" class="badge">Sessions: 0</span>
        <span id="countBadge" class="badge">SubTurtles: 0</span>
        <span id="processBadge" class="badge">Processes: 0</span>
        <span id="queueBadge" class="badge">Queued messages: 0</span>
        <span id="cronBadge" class="badge">Cron jobs: 0</span>
        <span id="bgBadge" class="badge">Background checks: 0</span>
        <span id="jobBadge" class="badge">Current jobs: 0</span>
      </p>
      <div class="dashboard-grid">
      <section class="panel panel-sessions">
        <h2>Sessions</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Session</th><th>Driver</th><th>Status</th><th>Messages</th><th>Last seen</th></tr>
            </thead>
            <tbody id="sessionRows">
              <tr><td colspan="5">No sessions found.</td></tr>
            </tbody>
          </table>
        </div>
        <div class="panel-actions">
          <button id="sessionToggleBtn" class="panel-btn" type="button" hidden>Show more sessions</button>
        </div>
      </section>
      <section class="panel panel-lanes">
        <div class="panel-head">
          <h2>SubTurtle Race Lanes</h2>
        </div>
        <ul id="laneRows" class="lane-list">
          <li>No SubTurtle lanes yet.</li>
        </ul>
      </section>
      <section class="panel panel-processes">
        <div class="panel-head">
          <h2>Running Processes</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Kind</th><th>Status</th><th>Time</th><th>Detail</th></tr>
            </thead>
            <tbody id="processRows">
              <tr><td colspan="5">No processes found.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel panel-queue">
        <div class="panel-head">
          <h2>Queued Messages</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Chat</th><th>Count</th><th>Oldest</th><th>Preview</th></tr>
            </thead>
            <tbody id="queueRows">
              <tr><td colspan="4">No queued messages.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel panel-jobs">
        <div class="panel-head">
          <h2>Current Jobs (Running Now)</h2>
          <p class="panel-note">Actively executing jobs owned by current processes.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Job</th><th>Owner</th><th>Owner type</th></tr>
            </thead>
            <tbody id="jobRows">
              <tr><td colspan="3">No active jobs.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel panel-cron">
        <div class="panel-head">
          <h2>Scheduled Cron Jobs (Upcoming)</h2>
          <p class="panel-note">Pending one-shot and recurring jobs that will fire later.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Type</th><th>Next in</th><th>Prompt</th></tr>
            </thead>
            <tbody id="cronRows">
              <tr><td colspan="3">No jobs scheduled.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      </div>
      <p id="statusLine" class="status-line">Status: waiting for first sync…</p>
    </main>
    <script>
      const laneRows = document.getElementById("laneRows");
      const sessionRows = document.getElementById("sessionRows");
      const processRows = document.getElementById("processRows");
      const queueRows = document.getElementById("queueRows");
      const cronRows = document.getElementById("cronRows");
      const jobRows = document.getElementById("jobRows");
      const updateBadge = document.getElementById("updateBadge");
      const sessionToggleBtn = document.getElementById("sessionToggleBtn");
      const sessionBadge = document.getElementById("sessionBadge");
      const countBadge = document.getElementById("countBadge");
      const processBadge = document.getElementById("processBadge");
      const queueBadge = document.getElementById("queueBadge");
      const cronBadge = document.getElementById("cronBadge");
      const jobBadge = document.getElementById("jobBadge");
      const bgBadge = document.getElementById("bgBadge");
      const statusLine = document.getElementById("statusLine");
      let sessionsExpanded = false;
      let latestSessions = [];

      function setSubturtleBadge(value) {
        countBadge.textContent = "SubTurtles: " + value;
      }

      function setSessionBadge(value) {
        sessionBadge.textContent = "Sessions: " + value;
      }

      function setProcessBadge(value) {
        processBadge.textContent = "Processes: " + value;
      }

      function setQueueBadge(value) {
        queueBadge.textContent = "Queued messages: " + value;
      }

      function setCronBadge(value) {
        cronBadge.textContent = "Cron jobs: " + value;
      }

      function setJobBadge(value) {
        jobBadge.textContent = "Current jobs: " + value;
      }

      function setBackgroundBadge(isActive, queueSize) {
        bgBadge.textContent = "Background checks: " + (isActive ? "running" : "idle") + " (queue " + queueSize + ")";
      }

      function humanMs(ms) {
        if (ms <= 0) return "0s";
        const total = Math.floor(ms / 1000);
        const sec = total % 60;
        const min = Math.floor(total / 60) % 60;
        const hr = Math.floor(total / 3600);
        if (hr > 0) return hr + "h " + min + "m";
        if (min > 0) return min + "m " + sec + "s";
        return sec + "s";
      }

      function statusClass(status) {
        if (status === "running") return "status-running";
        if (status === "queued") return "status-queued";
        if (status === "error") return "status-error";
        if (status === "stopped") return "status-stopped";
        return "status-idle";
      }

      function sessionStatusClass(status) {
        if (status === "active-running") return "status-running";
        if (status === "active-idle") return "status-idle";
        return "status-muted";
      }

      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function formatDateTime(value) {
        if (!value) return "n/a";
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value);
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1);
        const day = String(parsed.getDate());
        const hour = String(parsed.getHours()).padStart(2, "0");
        const minute = String(parsed.getMinutes()).padStart(2, "0");
        const second = String(parsed.getSeconds()).padStart(2, "0");
        return day + "." + month + "." + year + " " + hour + ":" + minute + ":" + second;
      }

      function renderSessionRows(sessions) {
        const list = Array.isArray(sessions) ? sessions : [];
        const visible = sessionsExpanded ? list : list.slice(0, 4);
        if (!visible.length) {
          sessionRows.innerHTML = "<tr><td colspan='5'>No sessions found.</td></tr>";
        } else {
          const rows = visible.map((s) => {
            const shortId = s.sessionId.length > 8 ? s.sessionId.slice(0, 8) + "…" : s.sessionId;
            const title = s.title ? s.title : "(untitled)";
            const lastSeen = formatDateTime(s.lastActivity || s.savedAt);
            return "<tr>" +
              "<td><a href='/dashboard/sessions/" + encodeURIComponent(s.driver) + "/" + encodeURIComponent(s.sessionId) + "'>" +
              escapeHtml(title) +
              " (" + escapeHtml(shortId) + ")" +
              "</a></td>" +
              "<td>" + escapeHtml(s.driver) + "</td>" +
              "<td><span class='status-chip " + sessionStatusClass(s.status) + "'>" + escapeHtml(s.status) + "</span></td>" +
              "<td>" + String(s.messageCount) + "</td>" +
              "<td>" + escapeHtml(lastSeen) + "</td>" +
              "</tr>";
          });
          sessionRows.innerHTML = rows.join("");
        }

        if (!sessionToggleBtn) return;
        if (list.length <= 4) {
          sessionToggleBtn.hidden = true;
          return;
        }
        const hiddenCount = Math.max(0, list.length - 4);
        sessionToggleBtn.hidden = false;
        sessionToggleBtn.textContent = sessionsExpanded
          ? "Show fewer sessions"
          : "Show " + hiddenCount + " more sessions";
      }

      async function loadData() {
        try {
          const [dashboardRes, jobsRes, sessionsRes] = await Promise.all([
            fetch("/api/dashboard", { cache: "no-store" }),
            fetch("/api/jobs/current", { cache: "no-store" }),
            fetch("/api/sessions", { cache: "no-store" }),
          ]);
          if (!dashboardRes.ok) throw new Error("Failed dashboard request");
          if (!jobsRes.ok) throw new Error("Failed jobs request");
          if (!sessionsRes.ok) throw new Error("Failed sessions request");
          const data = await dashboardRes.json();
          const jobsData = await jobsRes.json();
          const sessionsData = await sessionsRes.json();

          updateBadge.textContent = "Updated " + formatDateTime(data.generatedAt);
          setSessionBadge(sessionsData.sessions.length);
          setSubturtleBadge(data.turtles.length);
          setProcessBadge(data.processes.length);
          setQueueBadge(data.deferredQueue.totalMessages);
          setCronBadge(data.cronJobs.length);
          setJobBadge(jobsData.jobs.length);
          setBackgroundBadge(data.background.runActive, data.background.supervisionQueue);

          latestSessions = Array.isArray(sessionsData.sessions) ? sessionsData.sessions : [];
          if (latestSessions.length <= 4) {
            sessionsExpanded = false;
          }
          renderSessionRows(latestSessions);

          if (!data.lanes.length) {
            laneRows.innerHTML = "<li>No SubTurtle lanes yet.</li>";
          } else {
            const rows = data.lanes.map((lane) => {
              const progressLabel = lane.backlogTotal > 0
                ? lane.backlogDone + "/" + lane.backlogTotal + " (" + lane.progressPct + "%)"
                : "No backlog";
              const task = lane.task ? " · Task: " + lane.task : "";
              return "<li>" +
                '<a href="/dashboard/subturtles/' + encodeURIComponent(lane.name) + '">' +
                escapeHtml(lane.name) +
                "</a> " +
                escapeHtml(lane.type) +
                " · " +
                escapeHtml(lane.status) +
                " · " +
                escapeHtml(lane.elapsed) +
                " · " +
                progressLabel +
                (lane.backlogCurrent ? " · Current: " + escapeHtml(lane.backlogCurrent) : "") +
                escapeHtml(task) +
                "</li>";
            });
            laneRows.innerHTML = rows.join("");
          }

          if (!data.processes.length) {
            processRows.innerHTML = "<tr><td colspan='5'>No processes found.</td></tr>";
          } else {
            const rows = data.processes.map((p) => {
              return "<tr>" +
                "<td><a href='/dashboard/processes/" + encodeURIComponent(p.id) + "'>" +
                escapeHtml(p.label) +
                "</a>" +
                (p.pid && p.pid !== "-" ? " (pid " + escapeHtml(p.pid) + ")" : "") +
                "</td>" +
                "<td>" + escapeHtml(p.kind) + "</td>" +
                "<td><span class='status-chip " + statusClass(p.status) + "'>" + escapeHtml(p.status) + "</span></td>" +
                "<td>" + escapeHtml(p.elapsed) + "</td>" +
                "<td>" + escapeHtml(p.detail || "") + "</td>" +
                "</tr>";
            });
            processRows.innerHTML = rows.join("");
          }

          if (!data.deferredQueue.chats.length) {
            queueRows.innerHTML = "<tr><td colspan='4'>No queued messages.</td></tr>";
          } else {
            const rows = data.deferredQueue.chats.map((q) => {
              return "<tr>" +
                "<td>" + q.chatId + "</td>" +
                "<td>" + q.size + "</td>" +
                "<td>" + q.oldestAgeSec + "s</td>" +
                "<td>" + escapeHtml((q.preview || []).join(" | ")) + "</td>" +
                "</tr>";
            });
            queueRows.innerHTML = rows.join("");
          }

          if (!data.cronJobs.length) {
            cronRows.innerHTML = "<tr><td colspan='3'>No jobs scheduled.</td></tr>";
          } else {
            const rows = data.cronJobs.map((j) => {
              return "<tr>" +
                "<td>" + j.type + "</td>" +
                "<td>" + humanMs(j.fireInMs) + "</td>" +
                "<td>" + escapeHtml(j.promptPreview) + "</td>" +
                "</tr>";
            });
            cronRows.innerHTML = rows.join("");
          }

          if (!jobsData.jobs.length) {
            jobRows.innerHTML = "<tr><td colspan='3'>No current jobs.</td></tr>";
          } else {
            const rows = jobsData.jobs.map((job) => {
              const ownerLink = "/dashboard/processes/" + encodeURIComponent(job.ownerId);
              return "<tr>" +
                "<td><a href='/dashboard/jobs/" + encodeURIComponent(job.id) + "'>" +
                escapeHtml(job.id) +
                "</a></td>" +
                "<td><a href='" + ownerLink + "'>" +
                escapeHtml(job.ownerId) +
                "</a></td>" +
                "<td>" + escapeHtml(job.ownerType) + "</td>" +
                "</tr>";
            });
            jobRows.innerHTML = rows.join("");
          }

          statusLine.textContent =
            "Status: " +
            sessionsData.sessions.length +
            " sessions, " +
            data.turtles.length +
            " turtles, " +
            data.processes.length +
            " processes, " +
            data.deferredQueue.totalMessages +
            " queued msgs, " +
            data.cronJobs.length +
            " cron jobs, " +
            jobsData.jobs.length +
            " current jobs";
        } catch (error) {
          statusLine.textContent = "Status: failed to fetch data";
        }
      }

      if (sessionToggleBtn) {
        sessionToggleBtn.addEventListener("click", () => {
          sessionsExpanded = !sessionsExpanded;
          renderSessionRows(latestSessions);
        });
      }

      loadData();
      setInterval(loadData, 5000);
    </script>
  </body>
</html>`;
}

async function buildSubturtleDetail(name: string): Promise<SubturtleDetailResponse | null> {
  const turtles = await readSubturtles();
  const turtle = turtles.find((t) => t.name === name);
  if (!turtle) return null;

  const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(name) : "0s";

  const claudeMdPath = `${WORKING_DIR}/.subturtles/${name}/CLAUDE.md`;
  const metaPath = `${WORKING_DIR}/.subturtles/${name}/subturtle.meta`;
  const tunnelPath = `${WORKING_DIR}/.subturtles/${name}/.tunnel-url`;

  const [claudeMd, metaContent, tunnelUrl] = await Promise.all([
    readFileOr(claudeMdPath, ""),
    readFileOr(metaPath, ""),
    readFileOr(tunnelPath, ""),
  ]);

  const meta = parseMetaFile(metaContent);
  const backlog = await readClaudeBacklogItems(claudeMdPath);
  const backlogDone = backlog.filter((item) => item.done).length;
  const backlogCurrent =
    backlog.find((item) => item.current && !item.done)?.text ||
    backlog.find((item) => !item.done)?.text ||
    "";

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
    meta,
    backlog,
    backlogSummary: {
      done: backlogDone,
      total: backlog.length,
      current: backlogCurrent,
      progressPct: computeProgressPct(backlogDone, backlog.length),
    },
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
  } else if (job.ownerId === "driver-claude") {
    extra.elapsed = getDriverRunningState().claudeRunning ? elapsedFrom(session.queryStarted) : "0s";
    extra.currentTool = session.currentTool;
    extra.lastTool = session.lastTool;
  } else if (job.ownerId === "driver-codex") {
    extra.elapsed = getDriverRunningState().codexRunning
      ? elapsedFrom(codexSession.runningSince)
      : "0s";
  }

  return {
    generatedAt: new Date().toISOString(),
    job,
    ownerLink,
    logsLink,
    extra,
  };
}

function renderSubturtleDetailHtml(detail: SubturtleDetailResponse, logs: SubturtleLogsResponse | null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SubTurtle ${escapeHtml(detail.name)} detail</title>
  </head>
  <body>
    <h1>SubTurtle ${escapeHtml(detail.name)} detail</h1>
    <p><a href="/dashboard">← Back to dashboard</a></p>
    <h2>Core fields</h2>
    <ul>
      <li>Status: ${escapeHtml(detail.status)}</li>
      <li>Type: ${escapeHtml(detail.type)}</li>
      <li>PID: ${escapeHtml(detail.pid || "n/a")}</li>
      <li>Elapsed: ${escapeHtml(detail.elapsed)}</li>
      <li>Task: ${escapeHtml(detail.task || "none")}</li>
      <li>Backlog: ${detail.backlogSummary.done}/${detail.backlogSummary.total} (${detail.backlogSummary.progressPct}%)</li>
      <li>Current backlog item: ${escapeHtml(detail.backlogSummary.current || "none")}</li>
    </ul>
    <h2>Backlog (JSON)</h2>
    ${renderJsonPre(detail.backlog)}
    <h2>subturtle.meta (JSON)</h2>
    ${renderJsonPre(detail.meta)}
    <h2>Claude.md</h2>
    <pre>${escapeHtml(detail.claudeMd || "(empty)")}</pre>
    <h2>Logs</h2>
    <pre>${escapeHtml(logs?.lines.join("\\n") || "No logs")}</pre>
  </body>
</html>`;
}

function renderSessionDetailHtml(
  detail: SessionDetailResponse,
  turns: SessionTurnView[]
): string {
  type InjectedArtifactView = {
    id: string;
    label: string;
    order: number;
    exactText: string;
    preview: string;
  };

  type ConversationRow = {
    role: "system" | "user" | "assistant";
    timestamp: string;
    text: string;
    html?: string;
    turn?: SessionTurnView;
  };

  const buildPreview = (text: string): string => {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return "(empty)";
    const preview = lines.slice(0, 2).join(" ");
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  };

  const countWords = (text: string): number => {
    const matches = text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return matches?.length || 0;
  };
  const instructionTooltipHtml = detail.session.driver === "claude"
    ? "<div class=\"info-popover\"><p><strong>How instructions reach this CLI</strong></p>" +
      "<ul class=\"info-list\">" +
      "<li><strong>Project instructions</strong>: Claude Code runs from the repo root with --setting-sources user,project, so project instructions are loaded by the CLI.</li>" +
      "<li><strong>META prompt</strong>: The wrapper passes META_SHARED.md via --system-prompt on each query.</li>" +
      "<li><strong>Date/time prefix</strong>: The wrapper prepends the date/time prefix when starting a new session.</li>" +
      "</ul></div>"
    : "<div class=\"info-popover\"><p><strong>How instructions reach this CLI</strong></p>" +
      "<ul class=\"info-list\">" +
      "<li><strong>Project instructions</strong>: Codex runs with workingDirectory set to the repo root, so repo-root AGENTS.md / project instructions are loaded by the CLI.</li>" +
      "<li><strong>META prompt</strong>: The wrapper wraps META_SHARED.md in &lt;system-instructions&gt; and prepends it to the first message of a thread only.</li>" +
      "<li><strong>Date/time prefix</strong>: The wrapper prepends the date/time prefix on the first message of a thread.</li>" +
      "</ul></div>";

  const injectedHeadingHtml =
    "<div class=\"injected-heading\">" +
    "<p><strong>Injected context</strong></p>" +
    "<button class=\"info-btn\" type=\"button\" aria-label=\"How instructions are passed to this CLI\">" +
    "i" +
    instructionTooltipHtml +
    "</button>" +
    "</div>";

  const pushArtifact = (
    items: InjectedArtifactView[],
    id: string,
    label: string,
    order: number,
    exactText: string
  ): void => {
    items.push({
      id,
      label,
      order,
      exactText,
      preview: buildPreview(exactText),
    });
  };

  const hasTurns = turns.length > 0;
  const firstTurn = turns[0];
  const history = detail.history || null;
  const sourceArtifacts = hasTurns
    ? firstTurn?.injectedArtifacts || []
    : history?.injectedArtifacts || [];
  const injectedArtifacts: InjectedArtifactView[] = sourceArtifacts.map((artifact) => {
    const fallbackOrder = artifact.id === "claude-md"
      ? 10
      : artifact.id === "meta-prompt"
        ? 20
        : artifact.id === "date-prefix"
          ? 30
          : artifact.id === "cron-scheduled"
            ? 40
            : artifact.id === "background-snapshot"
              ? 50
              : 999;
    return {
      id: artifact.id,
      label: artifact.label,
      order: Number.isFinite(artifact.order) ? artifact.order : fallbackOrder,
      exactText: artifact.text || "",
      preview: buildPreview(artifact.text || ""),
    };
  });
  if (firstTurn && injectedArtifacts.length === 0) {
    pushArtifact(
      injectedArtifacts,
      "legacy",
      "Legacy turn log",
      999,
      "No captured injected artifacts for this turn (legacy log entry)."
    );
  }
  injectedArtifacts.sort((a, b) => a.order - b.order);

  const injectedListHtml = injectedArtifacts.length > 0
    ? injectedHeadingHtml + "<ol class=\"injected-list\">" + injectedArtifacts.map((artifact) => {
      const wordCount = countWords(artifact.exactText);
      const wordLabel = wordCount === 1 ? "word" : "words";
      return "<li><details>" +
        "<summary>" +
        escapeHtml(`${artifact.label} (${wordCount} ${wordLabel})`) +
        "</summary>" +
        "<pre>" + escapeHtml(artifact.exactText) + "</pre>" +
        "</details></li>";
    }).join("") + "</ol>"
    : injectedHeadingHtml + "<p>No captured injections for this session.</p>";

  const conversationRows: ConversationRow[] = [
    {
      role: "system",
      timestamp: formatTimestamp(firstTurn?.startedAt || history?.messages[0]?.timestamp || detail.messages[0]?.timestamp || null),
      text: "",
      html: injectedListHtml,
    },
  ];

  if (hasTurns) {
    for (const turn of turns) {
      conversationRows.push({
        role: "user",
        timestamp: formatTimestamp(turn.startedAt),
        text: turn.originalMessage || "",
        turn,
      });
      const assistantText =
        turn.response && turn.response.trim().length > 0
          ? turn.response
          : turn.status === "completed"
            ? "(No assistant response captured.)"
            : `(No assistant response captured; status: ${turn.status})`;
      conversationRows.push({
        role: "assistant",
        timestamp: formatTimestamp(turn.completedAt || turn.startedAt),
        text: assistantText,
        turn,
      });
    }
  } else {
    for (const msg of history?.messages || detail.messages) {
      conversationRows.push({
        role: msg.role,
        timestamp: formatTimestamp(msg.timestamp),
        text: msg.text,
      });
    }
  }

  const conversationBody = conversationRows.length > 0
    ? conversationRows.map((row) => {
        const turn = row.turn;
        const injectedFlags = turn
          ? [
              turn.injections.datePrefixApplied ? "date-prefix" : "",
              turn.injections.metaPromptApplied ? "meta-prompt" : "",
              turn.injections.cronScheduledPromptApplied ? "cron-scheduled" : "",
              turn.injections.backgroundSnapshotPromptApplied ? "background-snapshot" : "",
            ].filter((value) => value.length > 0).join(", ") || "none"
          : "none";
        const debugDetails = turn && row.role === "assistant"
          ? "<details><summary>Debug details</summary>" +
            "<pre>" + escapeHtml([
              `Source: ${turn.source}`,
              `Status: ${turn.status}`,
              `Model: ${turn.model}`,
              `Effort: ${turn.effort}`,
              `Elapsed: ${turn.elapsedMs}ms`,
              `Injected flags: ${injectedFlags}`,
              `Context flags: CLAUDE.md=${turn.context.claudeMdLoaded ? "loaded" : "missing"}, META=${turn.context.metaSharedLoaded ? "loaded" : "missing"}`,
              `Effective prompt follows:`,
              turn.effectivePrompt || "(none)",
              `Error: ${turn.error || "none"}`,
            ].join("\n")) + "</pre>" +
            "<p>Usage</p>" +
            renderJsonPre(turn.usage) +
            "</details>"
          : "";
        return "<tr>" +
          "<td><span class=\"role-pill\">" + escapeHtml(row.role) + "</span></td>" +
          "<td>" + escapeHtml(row.timestamp) + "</td>" +
          "<td>" + (row.html || ("<pre>" + escapeHtml(row.text || "") + "</pre>")) + debugDetails + "</td>" +
          "</tr>";
      }).join("")
    : "<tr><td colspan='3'>No messages available.</td></tr>";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Session ${escapeHtml(detail.session.sessionId)} detail</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fc;
        --panel: #ffffff;
        --line: #dfe3ee;
        --text: #1f2430;
        --muted: #5d6475;
        --code: #f3f5fb;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.45;
      }
      .page {
        max-width: 1400px;
        margin: 0 auto;
      }
      h1, h2 {
        margin: 0 0 12px 0;
      }
      h2 { margin-top: 20px; }
      a { color: #1c5fd3; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
      }
      .conversation {
        margin-top: 12px;
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 10px 12px;
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .col-role { width: 90px; }
      .col-time { width: 230px; }
      .role-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #f6f8ff;
        font-size: 12px;
      }
      details {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 10px;
        background: #fff;
      }
      details + details { margin-top: 8px; }
      summary {
        cursor: pointer;
        color: var(--text);
      }
      pre {
        margin: 8px 0 0 0;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: var(--code);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        max-width: 100%;
      }
      .injected-heading {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .injected-heading p {
        margin: 0;
      }
      .info-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel);
        color: var(--muted);
        font: inherit;
        font-weight: 700;
        cursor: help;
      }
      .info-popover {
        position: absolute;
        top: calc(100% + 10px);
        right: 0;
        display: none;
        width: min(420px, 70vw);
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #172033;
        color: #f7f8fc;
        text-align: left;
        box-shadow: 0 20px 40px rgba(23, 32, 51, 0.18);
        z-index: 10;
      }
      .info-btn:hover .info-popover,
      .info-btn:focus-visible .info-popover {
        display: block;
      }
      .info-popover p {
        margin: 0 0 8px 0;
      }
      .info-list {
        margin: 0;
        padding-left: 18px;
      }
      .info-list li + li {
        margin-top: 6px;
      }
      .injected-list {
        margin: 8px 0 0 20px;
        padding: 0;
      }
      .injected-list li + li { margin-top: 8px; }
      .meta-sections {
        margin-top: 14px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 12px;
      }
      .meta-sections details > ul {
        margin: 8px 0 0 0;
        padding-left: 18px;
      }
      .meta-sections details > p {
        margin: 10px 0 4px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="page">
      <h1>Session detail</h1>
      <p><a href="/dashboard">← Back to dashboard</a></p>
      <h2>Conversation</h2>
      <section class="card conversation">
        <table>
          <thead>
            <tr><th class="col-role">Role</th><th class="col-time">Timestamp</th><th>Text</th></tr>
          </thead>
          <tbody>
            ${conversationBody}
          </tbody>
        </table>
      </section>
      <section class="meta-sections">
        <details>
          <summary>Session overview</summary>
          <ul>
            <li>Driver: ${escapeHtml(detail.session.driver)}</li>
            <li>Session ID: ${escapeHtml(detail.session.sessionId)}</li>
            <li>Title: ${escapeHtml(detail.session.title)}</li>
            <li>Status: ${escapeHtml(detail.session.status)}</li>
            <li>Saved at: ${escapeHtml(formatTimestamp(detail.session.savedAt))}</li>
            <li>Last activity: ${escapeHtml(formatTimestamp(detail.session.lastActivity))}</li>
            <li>Messages: ${detail.session.messageCount}</li>
          </ul>
        </details>
        <details>
          <summary>Runtime meta</summary>
          <ul>
            <li>Model: ${escapeHtml(detail.meta.model)}</li>
            <li>Effort: ${escapeHtml(detail.meta.effort)}</li>
            <li>Running: ${detail.meta.isRunning ? "yes" : "no"}</li>
            <li>Query started: ${escapeHtml(formatTimestamp(detail.meta.queryStarted))}</li>
            <li>Current tool: ${escapeHtml(detail.meta.currentTool || "n/a")}</li>
            <li>Last tool: ${escapeHtml(detail.meta.lastTool || "n/a")}</li>
            <li>Last error: ${escapeHtml(detail.meta.lastError || "n/a")}</li>
            <li>Last error time: ${escapeHtml(formatTimestamp(detail.meta.lastErrorTime))}</li>
          </ul>
          <p>Last usage</p>
          ${renderJsonPre(detail.meta.lastUsage)}
        </details>
      </section>
    </main>
  </body>
</html>`;
}

function renderProcessDetailHtml(detail: ProcessDetailResponse, logs: SubturtleLogsResponse | null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Process ${escapeHtml(detail.process.id)} detail</title>
  </head>
  <body>
    <h1>Process ${escapeHtml(detail.process.id)} detail</h1>
    <p><a href="/dashboard">← Back to dashboard</a></p>
    <h2>Core fields</h2>
    <ul>
      <li>Name: ${escapeHtml(detail.process.label)}</li>
      <li>Kind: ${escapeHtml(detail.process.kind)}</li>
      <li>Status: ${escapeHtml(detail.process.status)}</li>
      <li>PID: ${escapeHtml(detail.process.pid)}</li>
      <li>Elapsed: ${escapeHtml(detail.process.elapsed)}</li>
      <li>Detail: ${escapeHtml(detail.process.detail || "n/a")}</li>
    </ul>
    <h2>Detail JSON</h2>
    ${renderJsonPre(detail)}
    ${logs ? `<h2>Logs</h2><pre>${escapeHtml(logs.lines.join("\\n") || "No logs")}</pre>` : ""}
  </body>
</html>`;
}

function renderJobDetailHtml(detail: JobDetailResponse, logs: SubturtleLogsResponse | null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Job ${escapeHtml(detail.job.id)} detail</title>
  </head>
  <body>
    <h1>Job ${escapeHtml(detail.job.id)} detail</h1>
    <p><a href="/dashboard">← Back to dashboard</a></p>
    <h2>Core fields</h2>
    <ul>
      <li>Name: ${escapeHtml(detail.job.name)}</li>
      <li>Owner: <a href="/dashboard/processes/${encodeURIComponent(detail.job.ownerId)}">${escapeHtml(detail.job.ownerId)}</a></li>
      <li>Owner API link: <a href="${escapeHtml(detail.ownerLink)}">${escapeHtml(detail.ownerLink)}</a></li>
      <li>Owner type: ${escapeHtml(detail.job.ownerType)}</li>
      <li>Elapsed: ${escapeHtml(detail.extra.elapsed || "n/a")}</li>
    </ul>
    <h2>Detail JSON</h2>
    ${renderJsonPre(detail)}
    ${logs ? `<h2>Logs</h2><pre>${escapeHtml(logs.lines.join("\\n") || "No logs")}</pre>` : ""}
  </body>
</html>`;
}

/* ── Process + Job detail helpers ──────────────────────────────────── */

function addDetailLink(p: ProcessView): ProcessDetailView {
  return { ...p, detailLink: `/api/processes/${encodeURIComponent(p.id)}` };
}

async function buildProcessExtra(p: ProcessView): Promise<DriverExtra | SubturtleExtra | BackgroundExtra> {
  if (p.kind === "driver" && p.id === "driver-claude") {
    return {
      kind: "driver",
      sessionId: session.sessionId,
      model: session.model,
      effort: session.effort,
      isActive: session.isActive,
      currentTool: session.currentTool,
      lastTool: session.lastTool,
      lastError: session.lastError,
      queryStarted: session.queryStarted?.toISOString() || null,
      lastActivity: session.lastActivity?.toISOString() || null,
    };
  }
  if (p.kind === "driver" && p.id === "driver-codex") {
    return {
      kind: "driver",
      sessionId: null,
      model: "codex",
      effort: "n/a",
      isActive: codexSession.isActive,
      currentTool: null,
      lastTool: null,
      lastError: null,
      queryStarted: codexSession.runningSince?.toISOString() || null,
      lastActivity: null,
    };
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

async function buildCurrentJobs(): Promise<CurrentJobView[]> {
  const jobs: CurrentJobView[] = [];
  const { claudeRunning, codexRunning } = getDriverRunningState();

  // Driver activity
  if (claudeRunning) {
    jobs.push({
      id: "driver:claude:active",
      name: session.currentTool || session.lastTool || "query running",
      ownerType: "driver",
      ownerId: "driver-claude",
      detailLink: "/api/jobs/driver:claude:active",
    });
  }
  if (codexRunning) {
    jobs.push({
      id: "driver:codex:active",
      name: "codex query running",
      ownerType: "driver",
      ownerId: "driver-codex",
      detailLink: "/api/jobs/driver:codex:active",
    });
  }

  // SubTurtle current items
  const turtles = await readSubturtles();
  for (const turtle of turtles) {
    if (turtle.status !== "running") continue;
    const statePath = `${WORKING_DIR}/.subturtles/${turtle.name}/CLAUDE.md`;
    const backlog = await readClaudeBacklogItems(statePath);
    const current =
      backlog.find((item) => item.current && !item.done)?.text ||
      backlog.find((item) => !item.done)?.text ||
      turtle.task ||
      "";
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

/* ── Route table ──────────────────────────────────────────────────── */

type RouteHandler = (req: Request, url: URL, match: RegExpMatchArray) => Promise<Response>;

export const routes: Array<{ pattern: RegExp; handler: RouteHandler }> = [
  {
    pattern: /^\/api\/subturtles$/,
    handler: async () => {
      const turtles = await readSubturtles();
      const elapsedByName = await Promise.all(
        turtles.map(async (turtle) => {
          const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(turtle.name) : "0s";
          return { ...turtle, elapsed };
        })
      );
      const lanes = await buildSubturtleLanes(elapsedByName);
      const response: SubturtleListResponse = {
        generatedAt: new Date().toISOString(),
        lanes: lanes.sort((a, b) => {
          if (a.status === b.status) return a.name.localeCompare(b.name);
          if (a.status === "running") return -1;
          if (b.status === "running") return 1;
          return a.name.localeCompare(b.name);
        }),
      };
      return jsonResponse(response);
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
    pattern: /^\/api\/dashboard$/,
    handler: async () => {
      const data = await buildDashboardState();
      return jsonResponse(data);
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

  if (!DASHBOARD_AUTH_TOKEN) {
    dashboardLog.info(
      { host: DASHBOARD_BIND_ADDR, port: DASHBOARD_PORT, authEnabled: false },
      `Starting dashboard on http://${DASHBOARD_BIND_ADDR}:${DASHBOARD_PORT}/dashboard`
    );
  } else {
    dashboardLog.info(
      { host: DASHBOARD_BIND_ADDR, port: DASHBOARD_PORT, authEnabled: true },
      `Starting dashboard on http://${DASHBOARD_BIND_ADDR}:${DASHBOARD_PORT}/dashboard?token=<redacted>`
    );
  }

  Bun.serve({
    port: DASHBOARD_PORT,
    hostname: DASHBOARD_BIND_ADDR,
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
