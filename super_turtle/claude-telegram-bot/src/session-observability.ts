import { WORKING_DIR } from "./config";
import { codexSession } from "./codex-session";
import { readClaudeMdSnapshot } from "./injected-artifacts";
import { session } from "./session";
import {
  buildExternalSessionHistory,
  buildSavedSessionHistory,
  buildTurnLogHistory,
  type SessionHistoryView,
} from "./session-history";
import { getExecutingDriverId } from "./handlers/driver-routing";
import { readTurnLogEntries, type TurnLogEntry } from "./turn-log";
import type { SavedSession, RecentMessage } from "./types";
import type { DriverExtra, SessionDriver, SessionMetaView } from "./dashboard-types";

export interface InstructionDeliveryItem {
  label: string;
  description: string;
}

export interface InstructionDeliveryInfo {
  title: string;
  items: InstructionDeliveryItem[];
}

export interface DriverRunningState {
  activeDriverId: SessionDriver;
  executingDriverId: SessionDriver | null;
  isRunning: boolean;
}

export interface DriverProcessState {
  driver: SessionDriver;
  processId: string;
  label: string;
  runningState: DriverRunningState;
  runningSince: Date | null;
  detail: string;
  currentJobName: string | null;
  extra: DriverExtra;
}

export interface SessionObservabilityProvider {
  driver: SessionDriver;
  listTrackedSessions(): Promise<SavedSession[]>;
  getActiveSessionSnapshot(): SavedSession | null;
  getRunningState(): DriverRunningState;
  getDriverProcessState(): DriverProcessState;
  getDefaultMeta(): SessionMetaView;
  getActiveMeta(isRunning: boolean): SessionMetaView;
  loadDurableHistory(sessionId: string, saved: SavedSession | null): Promise<SessionHistoryView | null>;
  loadDisplayHistory(
    sessionId: string,
    saved: SavedSession | null,
    activeSession: SavedSession | null
  ): Promise<SessionHistoryView | null>;
  listTurns(sessionId: string, limit: number): TurnLogEntry[];
  getInstructionDelivery(): InstructionDeliveryInfo;
}

const DRIVER_LABELS: Record<SessionDriver, string> = {
  claude: "Claude driver",
  codex: "Codex driver",
};

const DRIVER_PROCESS_IDS: Record<SessionDriver, string> = {
  claude: "driver-claude",
  codex: "driver-codex",
};

const INSTRUCTION_DELIVERY_TITLE = "How instructions reach this CLI";
const LIVE_SESSION_LIST_TIMEOUT_MS = 750;

type RuntimeMetaSource = {
  model: string;
  effort: string;
  queryStarted: Date | null;
  lastUsage: Record<string, unknown> | null;
  lastError: string | null;
  lastErrorTime: Date | null;
  currentTool: string | null;
  lastTool: string | null;
};

type RuntimeProcessSource = {
  sessionId: string | null;
  model: string;
  effort: string;
  isActive: boolean;
  currentTool: string | null;
  lastTool: string | null;
  lastError: string | null;
  queryStarted: Date | null;
  lastActivity: Date | null;
};

function buildRecentPreview(recentMessages?: RecentMessage[]): string | null {
  if (!recentMessages || recentMessages.length === 0) return null;
  const previewParts = recentMessages.slice(-2).map((message) => {
    const speaker = message.role === "user" ? "You" : "Assistant";
    return `${speaker}: ${message.text}`;
  });
  const preview = previewParts.join("\n");
  return preview.length > 280 ? `${preview.slice(0, 277)}...` : preview;
}

function messageKey(message: { role: "user" | "assistant"; text: string }): string {
  return `${message.role}\u0000${message.text}`;
}

function buildInstructionDelivery(items: InstructionDeliveryItem[]): InstructionDeliveryInfo {
  return {
    title: INSTRUCTION_DELIVERY_TITLE,
    items,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildDriverExtra(source: RuntimeProcessSource): DriverExtra {
  return {
    kind: "driver",
    sessionId: source.sessionId,
    model: source.model,
    effort: source.effort,
    isActive: source.isActive,
    currentTool: source.currentTool,
    lastTool: source.lastTool,
    lastError: source.lastError,
    queryStarted: source.queryStarted?.toISOString() || null,
    lastActivity: source.lastActivity?.toISOString() || null,
  };
}

function buildDefaultMetaView(source: Pick<RuntimeMetaSource, "model" | "effort">): SessionMetaView {
  return {
    model: source.model,
    effort: source.effort,
    isRunning: false,
    queryStarted: null,
    lastUsage: null,
    lastError: null,
    lastErrorTime: null,
    currentTool: null,
    lastTool: null,
  };
}

function buildActiveMetaView(source: RuntimeMetaSource, isRunning: boolean): SessionMetaView {
  return {
    model: source.model,
    effort: source.effort,
    isRunning,
    queryStarted: source.queryStarted?.toISOString() || null,
    lastUsage: source.lastUsage,
    lastError: source.lastError,
    lastErrorTime: source.lastErrorTime?.toISOString() || null,
    currentTool: source.currentTool,
    lastTool: source.lastTool,
  };
}

function withCurrentClaudeMdArtifact(history: SessionHistoryView | null): SessionHistoryView | null {
  if (!history) return null;

  const claudeMdSnapshot = readClaudeMdSnapshot(WORKING_DIR);
  if (!claudeMdSnapshot.loaded) {
    return history;
  }

  const existingArtifact = history.injectedArtifacts.find((artifact) => artifact.id === "claude-md");
  const injectedArtifacts = existingArtifact
    ? history.injectedArtifacts.map((artifact) =>
        artifact.id === "claude-md" && !artifact.text && claudeMdSnapshot.text
          ? { ...artifact, text: claudeMdSnapshot.text }
          : artifact
      )
    : [
        {
          id: "claude-md" as const,
          label: "CLAUDE.md context",
          order: 10,
          text: claudeMdSnapshot.text,
          applied: true,
        },
        ...history.injectedArtifacts,
      ].sort((left, right) => left.order - right.order);

  return {
    ...history,
    injectedArtifacts,
    context: {
      ...history.context,
      claudeMdLoaded: history.context.claudeMdLoaded ?? true,
    },
  };
}

function buildDriverProcessState(
  driver: SessionDriver,
  runningState: DriverRunningState,
  runningSince: Date | null,
  detail: string,
  currentJobName: string | null,
  extraSource: RuntimeProcessSource
): DriverProcessState {
  return {
    driver,
    processId: DRIVER_PROCESS_IDS[driver],
    label: DRIVER_LABELS[driver],
    runningState,
    runningSince,
    detail,
    currentJobName,
    extra: buildDriverExtra(extraSource),
  };
}

function mergeActiveHistory(
  durableHistory: SessionHistoryView | null,
  activeHistory: SessionHistoryView | null
): SessionHistoryView | null {
  if (!activeHistory) return durableHistory;
  if (!durableHistory) return activeHistory;
  if (activeHistory.messages.length === 0) return durableHistory;
  if (durableHistory.messages.length === 0) {
    return {
      ...activeHistory,
      injectedArtifacts: durableHistory.injectedArtifacts.length > 0
        ? durableHistory.injectedArtifacts
        : activeHistory.injectedArtifacts,
      context: {
        claudeMdLoaded: activeHistory.context.claudeMdLoaded ?? durableHistory.context.claudeMdLoaded,
        metaSharedLoaded: activeHistory.context.metaSharedLoaded ?? durableHistory.context.metaSharedLoaded,
        datePrefixApplied: activeHistory.context.datePrefixApplied ?? durableHistory.context.datePrefixApplied,
      },
    };
  }

  const durableKeys = durableHistory.messages.map(messageKey);
  const activeKeys = activeHistory.messages.map(messageKey);
  let overlap = 0;
  const maxOverlap = Math.min(durableKeys.length, activeKeys.length);
  for (let count = maxOverlap; count >= 1; count--) {
    const durableTail = durableKeys.slice(-count);
    const activeHead = activeKeys.slice(0, count);
    if (durableTail.every((key, index) => key === activeHead[index])) {
      overlap = count;
      break;
    }
  }

  const mergedMessages = overlap > 0
    ? [...durableHistory.messages, ...activeHistory.messages.slice(overlap)]
    : activeHistory.messages;

  return {
    ...durableHistory,
    messages: mergedMessages,
    injectedArtifacts: durableHistory.injectedArtifacts.length > 0
      ? durableHistory.injectedArtifacts
      : activeHistory.injectedArtifacts,
    context: {
      claudeMdLoaded: durableHistory.context.claudeMdLoaded ?? activeHistory.context.claudeMdLoaded,
      metaSharedLoaded: durableHistory.context.metaSharedLoaded ?? activeHistory.context.metaSharedLoaded,
      datePrefixApplied: durableHistory.context.datePrefixApplied ?? activeHistory.context.datePrefixApplied,
    },
  };
}

function mergeTrackedSession(
  existing: SavedSession | null,
  incoming: SavedSession
): SavedSession {
  if (!existing) return incoming;
  const existingMessages = existing.recentMessages || [];
  const incomingMessages = incoming.recentMessages || [];
  const savedAt = [existing.saved_at, incoming.saved_at]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => (Date.parse(right) || 0) - (Date.parse(left) || 0))[0] || "";

  return {
    session_id: existing.session_id || incoming.session_id,
    saved_at: savedAt,
    working_dir: existing.working_dir || incoming.working_dir,
    title: existing.title || incoming.title,
    ...(existing.preview || incoming.preview
      ? { preview: existing.preview || incoming.preview }
      : {}),
    ...((existingMessages.length > 0 || incomingMessages.length > 0)
      ? { recentMessages: existingMessages.length > 0 ? existingMessages : incomingMessages }
      : {}),
  };
}

function getDriverRunningSnapshot(driver: SessionDriver): DriverRunningState {
  const executingDriverId = getExecutingDriverId();
  const activeDriverId = (executingDriverId || "codex") as SessionDriver;
  if (executingDriverId) {
    return {
      activeDriverId,
      executingDriverId,
      isRunning: driver === "codex" && executingDriverId === "codex",
    };
  }

  const codexRunning = codexSession.isRunning;
  return {
    activeDriverId: "codex",
    executingDriverId,
    isRunning: driver === "codex" && codexRunning,
  };
}

const codexProvider: SessionObservabilityProvider = {
  driver: "codex",

  async listTrackedSessions(): Promise<SavedSession[]> {
    const localSessions = codexSession.getSessionList();
    const activeSession = codexSession.getActiveSessionSnapshot();
    const trackedSessionIds = new Set<string>();
    for (const saved of localSessions) {
      trackedSessionIds.add(saved.session_id);
    }
    if (activeSession) {
      trackedSessionIds.add(activeSession.session_id);
    }
    for (const entry of readTurnLogEntries({ driver: "codex", limit: 5000 })) {
      if (entry.sessionId) {
        trackedSessionIds.add(entry.sessionId);
      }
    }

    if (trackedSessionIds.size === 0) {
      return activeSession ? [activeSession] : localSessions;
    }

    const liveSessions = await withTimeout(
      codexSession.getSessionListLive(),
      LIVE_SESSION_LIST_TIMEOUT_MS,
      [] as SavedSession[]
    );
    const mergedById = new Map<string, SavedSession>();
    for (const saved of localSessions) {
      mergedById.set(saved.session_id, saved);
    }
    for (const saved of liveSessions) {
      if (!trackedSessionIds.has(saved.session_id)) continue;
      mergedById.set(saved.session_id, mergeTrackedSession(mergedById.get(saved.session_id) || null, saved));
    }
    if (activeSession) {
      mergedById.set(
        activeSession.session_id,
        mergeTrackedSession(mergedById.get(activeSession.session_id) || null, activeSession)
      );
    }
    return [...mergedById.values()].sort((left, right) => {
      const leftTime = Date.parse(left.saved_at || "") || 0;
      const rightTime = Date.parse(right.saved_at || "") || 0;
      return rightTime - leftTime;
    });
  },

  getActiveSessionSnapshot(): SavedSession | null {
    return codexSession.getActiveSessionSnapshot();
  },

  getRunningState(): DriverRunningState {
    return getDriverRunningSnapshot("codex");
  },

  getDriverProcessState(): DriverProcessState {
    const runningState = this.getRunningState();
    return buildDriverProcessState(
      "codex",
      runningState,
      codexSession.runningSince,
      codexSession.isActive ? "thread active" : "idle",
      runningState.isRunning ? "query running" : null,
      {
        sessionId: codexSession.getThreadId(),
        model: codexSession.model,
        effort: codexSession.reasoningEffort,
        isActive: codexSession.isActive,
        currentTool: null,
        lastTool: null,
        lastError: codexSession.lastError,
        queryStarted: codexSession.runningSince,
        lastActivity: codexSession.lastActivity,
      }
    );
  },

  getDefaultMeta(): SessionMetaView {
    return buildDefaultMetaView({
      model: codexSession.model,
      effort: codexSession.reasoningEffort,
    });
  },

  getActiveMeta(isRunning: boolean): SessionMetaView {
    return buildActiveMetaView({
      model: codexSession.model,
      effort: codexSession.reasoningEffort,
      lastUsage: codexSession.lastUsage as Record<string, unknown> | null,
      lastError: codexSession.lastError,
      lastErrorTime: codexSession.lastErrorTime,
      currentTool: null,
      lastTool: null,
      queryStarted: codexSession.runningSince,
    }, isRunning);
  },

  async loadDurableHistory(sessionId: string, saved: SavedSession | null): Promise<SessionHistoryView | null> {
    const transcript = await codexSession.getSessionTranscript(sessionId);
    const transcriptHistory = transcript
      ? withCurrentClaudeMdArtifact(buildExternalSessionHistory({
          source: "codex-jsonl",
          path: transcript.path,
          messages: transcript.messages,
          injectedArtifacts: transcript.injectedArtifacts,
          context: {
            metaSharedLoaded: transcript.metaSharedLoaded,
            datePrefixApplied: transcript.datePrefixApplied,
          },
        }))
      : null;

    return transcriptHistory
      || buildTurnLogHistory("codex", sessionId)
      || withCurrentClaudeMdArtifact(buildSavedSessionHistory(saved));
  },

  async loadDisplayHistory(
    sessionId: string,
    saved: SavedSession | null,
    activeSession: SavedSession | null
  ): Promise<SessionHistoryView | null> {
    const durableHistory = await this.loadDurableHistory(sessionId, saved);
    if (!activeSession || activeSession.session_id !== sessionId) {
      return durableHistory;
    }
    return mergeActiveHistory(durableHistory, buildSavedSessionHistory(activeSession));
  },

  listTurns(sessionId: string, limit: number): TurnLogEntry[] {
    return readTurnLogEntries({ driver: "codex", sessionId, limit });
  },

  getInstructionDelivery(): InstructionDeliveryInfo {
    return buildInstructionDelivery([
      {
        label: "Project instructions",
        description: "Codex runs with workingDirectory set to the repo root, so repo-root AGENTS.md / project instructions are loaded by the CLI.",
      },
      {
        label: "Codex bootstrap prompt",
        description: "The Telegram wrapper prepends CODEX_TELEGRAM_BOOTSTRAP.md inside <system-instructions> on new-thread bootstrap turns.",
      },
      {
        label: "Date/time prefix",
        description: "The wrapper prepends the date/time prefix on Codex bootstrap turns.",
      },
    ]);
  },
};

export function getSessionObservabilityProvider(driver: SessionDriver): SessionObservabilityProvider {
  return codexProvider;
}

export function getSessionObservabilityProviders(): SessionObservabilityProvider[] {
  return [codexProvider];
}

export function getDashboardDriverRunningState(): Record<SessionDriver, DriverRunningState> {
  const codex = codexProvider.getRunningState();
  return {
    claude: {
      activeDriverId: "codex",
      executingDriverId: null,
      isRunning: false,
    },
    codex,
  };
}
