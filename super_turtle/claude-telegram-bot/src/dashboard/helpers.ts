import { DASHBOARD_AUTH_TOKEN } from "../config";
import type { ClaudeBacklogItem } from "../handlers/commands";

export type DashboardProcessStatus = "running" | "idle" | "queued" | "stopped" | "error";

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

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

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

export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function safeSubstring(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}...`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderJsonPre(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

export function renderBacklogChecklist(backlog: ClaudeBacklogItem[]): string {
  if (backlog.length === 0) {
    return '<p class="empty-state">No backlog items.</p>';
  }

  return `<ul class="backlog-checklist">${backlog
    .map((item) => {
      const classes = ["backlog-item"];
      if (item.done) classes.push("done");
      if (item.current) classes.push("current");

      return `<li class="${classes.join(" ")}">
        <span class="backlog-checkbox" aria-hidden="true">${item.done ? "&#x2611;" : "&#x2610;"}</span>
        <span class="backlog-text">${escapeHtml(item.text)}</span>
        ${item.current ? '<span class="backlog-tag">Current</span>' : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

export function formatTimestamp(value?: string | null): string {
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

export function elapsedFrom(startedAt: Date | null): string {
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

export function queuePressureSummary(totalMessages: number, totalChats: number): string {
  const msgLabel = totalMessages === 1 ? "1 queued msg" : `${totalMessages} queued msgs`;
  const chatLabel = totalChats === 1 ? "1 chat" : `${totalChats} chats`;
  return `${msgLabel} across ${chatLabel}`;
}

export function mapDriverStatus(
  isRunning: boolean,
  hasQueuePressure: boolean,
  isActiveDriver: boolean
): DashboardProcessStatus {
  if (hasQueuePressure && (isRunning || isActiveDriver)) return "queued";
  return isRunning ? "running" : "idle";
}

export function mapSubturtleStatus(rawStatus: string): DashboardProcessStatus {
  const status = rawStatus.trim().toLowerCase();
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "stopped") return "stopped";
  if (status === "error" || status === "failed" || status === "crashed") return "error";
  return "idle";
}

export function buildSubturtleProcessDetail(task: string, rawStatus: string): string {
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

export function humanInterval(ms: number | null): string | null {
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
