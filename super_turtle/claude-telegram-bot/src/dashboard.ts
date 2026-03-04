import { existsSync } from "fs";
import { resolve } from "path";
import { WORKING_DIR, CTL_PATH, DASHBOARD_ENABLED, DASHBOARD_AUTH_TOKEN, DASHBOARD_BIND_ADDR, DASHBOARD_PORT, META_PROMPT, SUPER_TURTLE_DIR } from "./config";
import { getJobs } from "./cron";
import { parseCtlListOutput, getSubTurtleElapsed, readClaudeBacklogItems, type ListedSubTurtle } from "./handlers/commands";
import { getAllDeferredQueues } from "./deferred-queue";
import { session, getAvailableModels } from "./session";
import { codexSession } from "./codex-session";
import { getPreparedSnapshotCount } from "./cron-supervision-queue";
import { isBackgroundRunActive, wasBackgroundRunPreempted } from "./handlers/driver-routing";
import { logger } from "./logger";
import type { TurtleView, ProcessView, DeferredChatView, SubturtleLaneView, DashboardState, SubturtleListResponse, SubturtleDetailResponse, SubturtleLogsResponse, CronListResponse, CronJobView, SessionResponse, ContextResponse, ProcessDetailView, ProcessDetailResponse, DriverExtra, SubturtleExtra, BackgroundExtra, CurrentJobView, CurrentJobsResponse, JobDetailResponse } from "./dashboard-types";

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
    const proc = Bun.spawnSync([CTL_PATH, "list"], { cwd: WORKING_DIR });
    const output = proc.stdout.toString().trim();
    return parseCtlListOutput(output);
  } catch {
    return [];
  }
}

export function safeSubstring(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}...`;
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
      const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(turtle.name) : "0";
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

  const processes: ProcessView[] = [
    {
      id: "driver-claude",
      kind: "driver",
      label: "Claude driver",
      status: session.isRunning ? "running" : "idle",
      pid: session.isRunning ? "active" : "-",
      elapsed: session.isRunning ? elapsedFrom(session.queryStarted) : "0s",
      detail: session.currentTool || session.lastTool || "idle",
    },
    {
      id: "driver-codex",
      kind: "driver",
      label: "Codex driver",
      status: codexSession.isRunning ? "running" : "idle",
      pid: codexSession.isRunning ? "active" : "-",
      elapsed: codexSession.isRunning ? elapsedFrom(codexSession.runningSince) : "0s",
      detail: codexSession.isActive ? "thread active" : "idle",
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
      status: (turtle.status === "running" ? "running" : "idle") as ProcessView["status"],
      pid: turtle.pid || "-",
      elapsed: turtle.elapsed,
      detail: turtle.task || "",
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
      :root {
        --bg: #0b1220;
        --panel: #111a2d;
        --edge: rgba(255, 255, 255, 0.12);
        --text: #e6eefb;
        --muted: #9bb0d1;
        --good: #5bd18b;
        --warn: #f1c05a;
        --bad: #e77777;
        --lane: #1c2840;
      }
      html, body {
        margin: 0;
        font-family: "Trebuchet MS", "Verdana", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 10% 15%, #17305f, var(--bg));
        color: var(--text);
      }
      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 24px;
      }
      h1 {
        margin: 0 0 12px;
        letter-spacing: 0.02em;
        animation: title-pop 260ms cubic-bezier(0.2, 1, 0.3, 1);
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 14px;
        align-items: center;
      }
      .pill {
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--panel);
        border: 1px solid var(--edge);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 12px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--edge);
        border-radius: 14px;
        padding: 14px;
        min-height: 180px;
        animation: slide-up 260ms cubic-bezier(0.2, 1, 0.3, 1);
      }
      .lane-card {
        margin-bottom: 12px;
      }
      .lane-row {
        margin: 10px 0;
        border: 1px solid var(--edge);
        border-radius: 10px;
        padding: 10px;
        background: rgba(255, 255, 255, 0.02);
      }
      .lane-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        margin-bottom: 6px;
      }
      .lane-title {
        font-size: 14px;
      }
      .lane-sub {
        color: var(--muted);
        font-size: 12px;
      }
      .track {
        width: 100%;
        background: var(--lane);
        border-radius: 999px;
        height: 10px;
        overflow: hidden;
      }
      .bar {
        height: 100%;
        background: linear-gradient(90deg, #53c987, #8ce6a8);
        transition: width 240ms ease;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      thead th {
        font-size: 12px;
        color: var(--muted);
        text-align: left;
        border-bottom: 1px dashed var(--edge);
        padding-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      td {
        padding: 10px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        vertical-align: top;
        font-size: 14px;
      }
      .dot {
        font-size: 10px;
      }
      .dot-ok { color: var(--good); }
      .dot-bad { color: var(--bad); }
      .dot-warn { color: var(--warn); }
      .small {
        color: var(--muted);
        font-size: 12px;
      }
      .status-running { color: var(--good); }
      .status-queued { color: var(--warn); }
      .status-idle { color: var(--muted); }
      a { color: #92c4ff; }
      .empty {
        color: var(--muted);
        text-align: center;
        padding: 20px 0;
      }
      .status {
        margin-top: 14px;
        color: var(--muted);
        font-size: 12px;
      }
      @keyframes title-pop {
        from { transform: translateY(-4px); opacity: .8; }
        to { transform: translateY(0); opacity: 1; }
      }
      @keyframes slide-up {
        from { transform: translateY(6px); opacity: .8; }
        to { transform: translateY(0); opacity: 1; }
      }
      @media (max-width: 700px) {
        .wrap { padding: 16px; }
        h1 { font-size: 24px; }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <h1>Super Turtle Dashboard</h1>
      <div class="row">
        <span class="pill" id="updateBadge">Loading…</span>
        <span class="pill" id="countBadge">SubTurtles: 0</span>
        <span class="pill" id="processBadge">Processes: 0</span>
        <span class="pill" id="queueBadge">Queued messages: 0</span>
        <span class="pill" id="cronBadge">Cron jobs: 0</span>
        <span class="pill" id="bgBadge">Background checks: 0</span>
      </div>
      <section class="card lane-card">
        <h2>SubTurtle Race Lanes</h2>
        <div id="laneRows">
          <p class="empty">No SubTurtle lanes yet.</p>
        </div>
      </section>
      <div class="grid">
        <section class="card">
          <h2>Running Processes</h2>
          <table>
            <thead>
              <tr><th>Name</th><th>Kind</th><th>Status</th><th>Time</th><th>Detail</th></tr>
            </thead>
            <tbody id="processRows">
              <tr><td class="empty" colspan="5">No processes found.</td></tr>
            </tbody>
          </table>
        </section>
        <section class="card">
          <h2>Queued Messages</h2>
          <table>
            <thead>
              <tr><th>Chat</th><th>Count</th><th>Oldest</th><th>Preview</th></tr>
            </thead>
            <tbody id="queueRows">
              <tr><td class="empty" colspan="4">No queued messages.</td></tr>
            </tbody>
          </table>
        </section>
        <section class="card">
          <h2>Upcoming Cron Jobs</h2>
          <table>
            <thead>
              <tr><th>Type</th><th>Next in</th><th>Prompt</th></tr>
            </thead>
            <tbody id="cronRows">
              <tr><td class="empty" colspan="3">No jobs scheduled.</td></tr>
            </tbody>
          </table>
        </section>
      </div>
      <p class="status" id="statusLine">Status: waiting for first sync…</p>
    </main>
    <script>
      const laneRows = document.getElementById("laneRows");
      const processRows = document.getElementById("processRows");
      const queueRows = document.getElementById("queueRows");
      const cronRows = document.getElementById("cronRows");
      const updateBadge = document.getElementById("updateBadge");
      const countBadge = document.getElementById("countBadge");
      const processBadge = document.getElementById("processBadge");
      const queueBadge = document.getElementById("queueBadge");
      const cronBadge = document.getElementById("cronBadge");
      const bgBadge = document.getElementById("bgBadge");
      const statusLine = document.getElementById("statusLine");

      function setSubturtleBadge(value) {
        countBadge.textContent = "SubTurtles: " + value;
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
        return "status-idle";
      }

      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      async function loadData() {
        try {
          const res = await fetch("/api/dashboard", { cache: "no-store" });
          if (!res.ok) throw new Error("Failed request");
          const data = await res.json();

          updateBadge.textContent = "Updated " + new Date(data.generatedAt).toLocaleTimeString();
          setSubturtleBadge(data.turtles.length);
          setProcessBadge(data.processes.length);
          setQueueBadge(data.deferredQueue.totalMessages);
          setCronBadge(data.cronJobs.length);
          setBackgroundBadge(data.background.runActive, data.background.supervisionQueue);

          if (!data.lanes.length) {
            laneRows.innerHTML = '<p class="empty">No SubTurtle lanes yet.</p>';
          } else {
            laneRows.innerHTML = "";
            for (const lane of data.lanes) {
              const row = document.createElement("div");
              row.className = "lane-row";
              const progressLabel = lane.backlogTotal > 0
                ? (lane.backlogDone + "/" + lane.backlogTotal + " (" + lane.progressPct + "%)")
                : "No backlog";
              row.innerHTML =
                '<div class="lane-head">' +
                '<div class="lane-title">' + escapeHtml(lane.name) + " · " + escapeHtml(lane.type) + '</div>' +
                '<div class="lane-sub">' + escapeHtml(lane.status) + " · " + escapeHtml(lane.elapsed) + '</div>' +
                "</div>" +
                '<div class="track"><div class="bar" style="width:' + lane.progressPct + '%;"></div></div>' +
                '<div class="lane-sub">' + escapeHtml(progressLabel) + (lane.backlogCurrent ? " · Current: " + escapeHtml(lane.backlogCurrent) : "") + '</div>' +
                (lane.task ? '<div class="lane-sub">Task: ' + escapeHtml(lane.task) + "</div>" : "");
              laneRows.appendChild(row);
            }
          }

          if (!data.processes.length) {
            processRows.innerHTML = '<tr><td class="empty" colspan="5">No processes found.</td></tr>';
          } else {
            processRows.innerHTML = "";
            for (const p of data.processes) {
              const tr = document.createElement("tr");
              tr.innerHTML =
                "<td>" + escapeHtml(p.label) + (p.pid && p.pid !== "-" ? ' <span class="small">(pid ' + escapeHtml(p.pid) + ")</span>" : "") + "</td>" +
                "<td>" + escapeHtml(p.kind) + "</td>" +
                '<td><span class="' + statusClass(p.status) + '">' + escapeHtml(p.status) + "</span></td>" +
                "<td>" + escapeHtml(p.elapsed) + "</td>" +
                "<td>" + escapeHtml(p.detail || "") + "</td>";
              processRows.appendChild(tr);
            }
          }

          if (!data.deferredQueue.chats.length) {
            queueRows.innerHTML = '<tr><td class="empty" colspan="4">No queued messages.</td></tr>';
          } else {
            queueRows.innerHTML = "";
            for (const q of data.deferredQueue.chats) {
              const tr = document.createElement("tr");
              tr.innerHTML =
                "<td>" + q.chatId + "</td>" +
                "<td>" + q.size + "</td>" +
                "<td>" + q.oldestAgeSec + "s</td>" +
                "<td>" + escapeHtml((q.preview || []).join(" | ")) + "</td>";
              queueRows.appendChild(tr);
            }
          }

          if (!data.cronJobs.length) {
            cronRows.innerHTML = '<tr><td class="empty" colspan="3">No jobs scheduled.</td></tr>';
          } else {
            cronRows.innerHTML = "";
            for (const j of data.cronJobs) {
              const tr = document.createElement("tr");
              tr.innerHTML =
                "<td>" + j.type + "</td>" +
                "<td>" + humanMs(j.fireInMs) + "</td>" +
                "<td>" + j.promptPreview + "</td>";
              cronRows.appendChild(tr);
            }
          }

          statusLine.textContent =
            "Status: " +
            data.turtles.length +
            " turtles, " +
            data.processes.length +
            " processes, " +
            data.deferredQueue.totalMessages +
            " queued msgs, " +
            data.cronJobs.length +
            " cron jobs";
        } catch (error) {
          statusLine.textContent = "Status: failed to fetch data";
        }
      }

      loadData();
      setInterval(loadData, 5000);
    </script>
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

  // Driver activity
  if (session.isRunning) {
    jobs.push({
      id: "driver:claude:active",
      name: session.currentTool || session.lastTool || "query running",
      ownerType: "driver",
      ownerId: "driver-claude",
      detailLink: "/api/jobs/driver:claude:active",
    });
  }
  if (codexSession.isRunning) {
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
          const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(turtle.name) : "0";
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

      const logPath = `${WORKING_DIR}/.subturtles/${name}/subturtle.log`;
      const pidPath = `${WORKING_DIR}/.subturtles/${name}/subturtle.pid`;

      // Check existence via pid or log file
      const pidExists = await Bun.file(pidPath).exists();
      const logExists = await Bun.file(logPath).exists();
      if (!pidExists && !logExists) return notFoundResponse("SubTurtle not found");

      const linesParam = url.searchParams.get("lines");
      const lineCount = Math.max(1, Math.min(500, parseInt(linesParam || "100", 10) || 100));

      let lines: string[] = [];
      let totalLines = 0;
      if (logExists) {
        const proc = Bun.spawnSync(["tail", "-n", String(lineCount), logPath]);
        const output = proc.stdout.toString();
        lines = output ? output.split("\n").filter((l) => l.length > 0) : [];

        // Approximate total lines via wc -l
        const wcProc = Bun.spawnSync(["wc", "-l", logPath]);
        const wcOut = wcProc.stdout.toString().trim();
        totalLines = parseInt(wcOut, 10) || 0;
      }

      const response: SubturtleLogsResponse = {
        generatedAt: new Date().toISOString(),
        name,
        lines,
        totalLines,
      };
      return jsonResponse(response);
    },
  },
  {
    pattern: /^\/api\/subturtles\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const name = decodeURIComponent(match[1] ?? "");
      if (!validateSubturtleName(name)) return notFoundResponse("Invalid SubTurtle name");

      // Find this turtle in the ctl list output
      const turtles = await readSubturtles();
      const turtle = turtles.find((t) => t.name === name);
      if (!turtle) return notFoundResponse("SubTurtle not found");

      const elapsed = turtle.status === "running" ? await getSubTurtleElapsed(name) : "0";

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

      const response: SubturtleDetailResponse = {
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
    pattern: /^\/api\/processes\/([^/]+)$/,
    handler: async (_req, _url, match) => {
      const id = decodeURIComponent(match[1] ?? "");
      if (!id) return notFoundResponse("Invalid process ID");
      const state = await buildDashboardState();
      const process = state.processes.find((p) => p.id === id);
      if (!process) return notFoundResponse("Process not found");
      const extra = await buildProcessExtra(process);
      const response: ProcessDetailResponse = {
        generatedAt: new Date().toISOString(),
        process: addDetailLink(process),
        extra,
      };
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
      const jobs = await buildCurrentJobs();
      const job = jobs.find((j) => j.id === id);
      if (!job) return notFoundResponse("Job not found");

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
        const elapsed = await getSubTurtleElapsed(name);
        extra.elapsed = elapsed;
      } else if (job.ownerId === "driver-claude") {
        extra.elapsed = session.isRunning ? elapsedFrom(session.queryStarted) : "0s";
        extra.currentTool = session.currentTool;
        extra.lastTool = session.lastTool;
      } else if (job.ownerId === "driver-codex") {
        extra.elapsed = codexSession.isRunning ? elapsedFrom(codexSession.runningSince) : "0s";
      }

      const response: JobDetailResponse = {
        generatedAt: new Date().toISOString(),
        job,
        ownerLink,
        logsLink,
        extra,
      };
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
