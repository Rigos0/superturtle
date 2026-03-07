/**
 * Shared types for the Super Turtle Dashboard API.
 */

import type { ListedSubTurtle, ClaudeBacklogItem } from "./handlers/commands";
import type { MetaFileData } from "./dashboard";
import type { InjectedArtifact } from "./injected-artifacts";

// ── Existing dashboard views ─────────────────────────────────────────

export type TurtleView = ListedSubTurtle & {
  elapsed: string;
};

export type ProcessView = {
  id: string;
  kind: "driver" | "subturtle" | "background";
  label: string;
  status: "running" | "idle" | "queued" | "stopped" | "error";
  pid: string;
  elapsed: string;
  detail: string;
};

export type DeferredChatView = {
  chatId: number;
  size: number;
  oldestAgeSec: number;
  newestAgeSec: number;
  preview: string[];
};

export type SubturtleLaneView = {
  name: string;
  status: string;
  type: string;
  elapsed: string;
  task: string;
  backlogDone: number;
  backlogTotal: number;
  backlogCurrent: string;
  progressPct: number;
};

export type CronJobView = {
  id: string;
  type: "one-shot" | "recurring";
  prompt: string;
  promptPreview: string;
  fireAt: number;
  fireInMs: number;
  intervalMs: number | null;
  intervalHuman: string | null;
  chatId: number;
  silent: boolean;
  createdAt: string;
};

export type DashboardState = {
  generatedAt: string;
  turtles: TurtleView[];
  processes: ProcessView[];
  lanes: SubturtleLaneView[];
  deferredQueue: {
    totalChats: number;
    totalMessages: number;
    chats: DeferredChatView[];
  };
  background: {
    runActive: boolean;
    runPreempted: boolean;
    supervisionQueue: number;
  };
  cronJobs: CronJobView[];
};

// ── New API response types (Phase 1) ────────────────────────────────

export type SubturtleListResponse = {
  generatedAt: string;
  lanes: SubturtleLaneView[];
};

export type BacklogSummary = {
  done: number;
  total: number;
  current: string;
  progressPct: number;
};

export type SubturtleDetailResponse = {
  generatedAt: string;
  name: string;
  status: string;
  type: string;
  pid: string;
  elapsed: string;
  timeRemaining: string;
  task: string;
  tunnelUrl: string;
  claudeMd: string;
  meta: MetaFileData;
  backlog: ClaudeBacklogItem[];
  backlogSummary: BacklogSummary;
};

export type SubturtleLogsResponse = {
  generatedAt: string;
  name: string;
  lines: string[];
  totalLines: number;
};

export type CronListResponse = {
  generatedAt: string;
  jobs: CronJobView[];
};

export type SessionResponse = {
  generatedAt: string;
  sessionId: string | null;
  model: string;
  modelDisplayName: string;
  effort: string;
  activeDriver: string;
  isRunning: boolean;
  isActive: boolean;
  currentTool: string | null;
  lastTool: string | null;
  lastError: string | null;
  lastErrorTime: string | null;
  conversationTitle: string | null;
  queryStarted: string | null;
  lastActivity: string | null;
};

export type SessionDriver = "claude" | "codex";
export type SessionStatus = "active-running" | "active-idle" | "saved";

export type SessionListItem = {
  id: string; // `${driver}:${sessionId}`
  driver: SessionDriver;
  sessionId: string;
  title: string;
  savedAt: string | null;
  lastActivity: string | null;
  status: SessionStatus;
  messageCount: number;
  workingDir: string | null;
  preview: string | null;
};

export type SessionListResponse = {
  generatedAt: string;
  sessions: SessionListItem[];
};

export type SessionMessageView = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  charCount: number;
};

export type SessionMetaView = {
  model: string;
  effort: string;
  isRunning: boolean;
  queryStarted: string | null;
  lastUsage: Record<string, unknown> | null;
  lastError: string | null;
  lastErrorTime: string | null;
  currentTool: string | null;
  lastTool: string | null;
};

export type SessionDetailResponse = {
  generatedAt: string;
  session: SessionListItem;
  messages: SessionMessageView[];
  meta: SessionMetaView;
};

export type SessionTurnView = {
  id: string;
  driver: SessionDriver;
  source: string;
  sessionId: string | null;
  userId: number;
  username: string;
  chatId: number;
  model: string;
  effort: string;
  originalMessage: string;
  effectivePrompt: string;
  injectedArtifacts: InjectedArtifact[];
  response: string | null;
  error: string | null;
  status: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  usage: Record<string, unknown> | null;
  injections: {
    datePrefixApplied: boolean;
    metaPromptApplied: boolean;
    cronScheduledPromptApplied: boolean;
    backgroundSnapshotPromptApplied: boolean;
  };
  context: {
    claudeMdLoaded: boolean;
    metaSharedLoaded: boolean;
  };
};

export type SessionTurnsResponse = {
  generatedAt: string;
  session: SessionListItem;
  turns: SessionTurnView[];
};

export type ContextResponse = {
  generatedAt: string;
  claudeMd: string;
  claudeMdPath: string;
  claudeMdExists: boolean;
  metaPrompt: string;
  metaPromptSource: string;
  metaPromptExists: boolean;
  agentsMdExists: boolean;
};

export type LogsResponse = {
  generatedAt: string;
  lines: string[];
  totalScanned: number;
  levelFilter: string | null;
};

export type UsageResponse = {
  generatedAt: string;
  driverModel: string;
  effortLevel: string;
};

export type ProcessListResponse = {
  generatedAt: string;
  processes: ProcessView[];
};

export type QueueResponse = {
  generatedAt: string;
  totalChats: number;
  totalMessages: number;
  chats: DeferredChatView[];
};

export type GitResponse = {
  generatedAt: string;
  branch: string;
  commitHash: string;
  commitMessage: string;
  dirty: boolean;
};

export type RunsResponse = {
  generatedAt: string;
  background: {
    runActive: boolean;
    runPreempted: boolean;
    supervisionQueue: number;
  };
};

// ── Process + Job detail API types ──────────────────────────────────

export type ProcessDetailView = ProcessView & {
  detailLink: string;
};

export type ProcessDetailResponse = {
  generatedAt: string;
  process: ProcessDetailView;
  /** Extra context depending on kind */
  extra: DriverExtra | SubturtleExtra | BackgroundExtra;
};

export type DriverExtra = {
  kind: "driver";
  sessionId: string | null;
  model: string;
  effort: string;
  isActive: boolean;
  currentTool: string | null;
  lastTool: string | null;
  lastError: string | null;
  queryStarted: string | null;
  lastActivity: string | null;
};

export type SubturtleExtra = {
  kind: "subturtle";
  backlogSummary: BacklogSummary;
  logsLink: string;
  detailLink: string;
};

export type BackgroundExtra = {
  kind: "background";
  runActive: boolean;
  runPreempted: boolean;
  supervisionQueue: number;
};

export type CurrentJobView = {
  id: string;
  name: string;
  ownerType: "subturtle" | "driver";
  ownerId: string;
  detailLink: string;
};

export type CurrentJobsResponse = {
  generatedAt: string;
  jobs: CurrentJobView[];
};

export type JobDetailResponse = {
  generatedAt: string;
  job: CurrentJobView;
  ownerLink: string;
  logsLink: string | null;
  extra: {
    backlogSummary?: BacklogSummary;
    elapsed?: string;
    currentTool?: string | null;
    lastTool?: string | null;
  };
};
