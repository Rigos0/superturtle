import { existsSync } from "fs";
import { resolve } from "path";
import { META_PROMPT, SUPER_TURTLE_DIR, WORKING_DIR } from "../config";
import { getJobs } from "../cron";
import { getAvailableModels, session } from "../session";
import type {
  ContextResponse,
  CurrentJobsResponse,
  CronListResponse,
  JobDetailResponse,
  ProcessDetailResponse,
  QueueResponse,
  SessionDetailResponse,
  SessionDriver,
  SessionListResponse,
  SessionResponse,
  SessionTurnsResponse,
  SubturtleDetailResponse,
  SubturtleListResponse,
  SubturtleLogsResponse,
} from "../dashboard-types";
import {
  buildConductorResponse,
  buildCronJobView,
  buildCurrentJobs,
  buildDashboardState,
  buildSubturtleListResponse,
} from "./data";
import {
  jsonResponse,
  notFoundResponse,
  readFileOr,
  validateSubturtleName,
} from "./helpers";
import {
  renderDashboardHtml,
  renderJobDetailHtml,
  renderProcessDetailHtml,
  renderSessionDetailHtml,
  renderSubturtleDetailHtml,
} from "./renderers";

export type RouteHandler = (req: Request, url: URL, match: RegExpMatchArray) => Promise<Response>;

export type DashboardRoute = {
  pattern: RegExp;
  handler: RouteHandler;
};

type DashboardRouteDependencies = {
  buildCurrentJobDetail(id: string): Promise<JobDetailResponse | null>;
  buildProcessDetail(id: string): Promise<ProcessDetailResponse | null>;
  buildSessionDetail(driver: SessionDriver, sessionId: string): Promise<SessionDetailResponse | null>;
  buildSessionListResponse(): Promise<SessionListResponse>;
  buildSessionTurns(
    driver: SessionDriver,
    sessionId: string,
    limit?: number,
  ): Promise<SessionTurnsResponse | null>;
  buildSubturtleDetail(name: string): Promise<SubturtleDetailResponse | null>;
  buildSubturtleLogs(name: string, lineCount?: number): Promise<SubturtleLogsResponse | null>;
  getDashboardOverviewResponse(): Promise<unknown>;
  validateSessionId(sessionId: string): boolean;
};

// Route table wiring only; route dependencies keep the module decoupled from implementation details.
export function createDashboardRoutes({
  buildCurrentJobDetail,
  buildProcessDetail,
  buildSessionDetail,
  buildSessionListResponse,
  buildSessionTurns,
  buildSubturtleDetail,
  buildSubturtleLogs,
  getDashboardOverviewResponse,
  validateSessionId,
}: DashboardRouteDependencies): DashboardRoute[] {
  return [
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
        const job = getJobs().find((entry) => entry.id === id);
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
        const currentModel = models.find((model) => model.value === session.model);
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
      pattern: /^\/api\/sessions\/(codex)\/([^/]+)\/turns$/,
      handler: async (_req, url, match) => {
        const driver = decodeURIComponent(match[1] ?? "") as SessionDriver;
        const sessionId = decodeURIComponent(match[2] ?? "");
        if (driver !== "codex" || !validateSessionId(sessionId)) {
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
      pattern: /^\/api\/sessions\/(codex)\/([^/]+)$/,
      handler: async (_req, _url, match) => {
        const driver = decodeURIComponent(match[1] ?? "") as SessionDriver;
        const sessionId = decodeURIComponent(match[2] ?? "");
        if (driver !== "codex" || !validateSessionId(sessionId)) {
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
        return jsonResponse({
          generatedAt: new Date().toISOString(),
          processes: state.processes.map((process) => ({
            ...process,
            detailLink: `/api/processes/${encodeURIComponent(process.id)}`,
          })),
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
        return jsonResponse(await buildDashboardState());
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
      pattern: /^\/dashboard\/sessions\/(codex)\/([^/]+)$/,
      handler: async (_req, url, match) => {
        const driver = decodeURIComponent(match[1] ?? "") as SessionDriver;
        const sessionId = decodeURIComponent(match[2] ?? "");
        if (driver !== "codex" || !validateSessionId(sessionId)) {
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
}
