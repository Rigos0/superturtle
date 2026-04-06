import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "path";

process.env.SUPER_TURTLE_PROJECT_DIR ||= resolve(import.meta.dir, "../../..");

const { WORKING_DIR } = await import("./config");

const { session } = await import("./session");
const { codexSession } = await import("./codex-session");
const { setExecutingDriverForTests } = await import("./handlers/driver-routing");
const {
  getDashboardDriverRunningState,
  getSessionObservabilityProvider,
} = await import("./session-observability");

describe("session observability providers", () => {
  const originalClaudeState = {
    sessionId: session.sessionId,
    conversationTitle: session.conversationTitle,
    lastActivity: session.lastActivity,
    recentMessages: [...session.recentMessages],
    activeDriver: session.activeDriver,
    currentTool: session.currentTool,
    lastTool: session.lastTool,
  };
  const originalCodexState = {
    getSessionList: codexSession.getSessionList,
    getSessionListLive: codexSession.getSessionListLive,
    getActiveSessionSnapshot: codexSession.getActiveSessionSnapshot,
    getSessionTranscript: codexSession.getSessionTranscript,
    isProcessing: (codexSession as unknown as { _isProcessing: boolean })._isProcessing,
    isQueryRunning: (codexSession as unknown as { isQueryRunning: boolean }).isQueryRunning,
  };

  afterEach(() => {
    session.sessionId = originalClaudeState.sessionId;
    session.conversationTitle = originalClaudeState.conversationTitle;
    session.lastActivity = originalClaudeState.lastActivity;
    session.recentMessages = [...originalClaudeState.recentMessages];
    session.activeDriver = originalClaudeState.activeDriver;
    session.currentTool = originalClaudeState.currentTool;
    session.lastTool = originalClaudeState.lastTool;

    codexSession.getSessionList = originalCodexState.getSessionList;
    codexSession.getSessionListLive = originalCodexState.getSessionListLive;
    codexSession.getActiveSessionSnapshot = originalCodexState.getActiveSessionSnapshot;
    codexSession.getSessionTranscript = originalCodexState.getSessionTranscript;
    (codexSession as unknown as { _isProcessing: boolean })._isProcessing = originalCodexState.isProcessing;
    (codexSession as unknown as { isQueryRunning: boolean }).isQueryRunning = originalCodexState.isQueryRunning;
    setExecutingDriverForTests(null);
  });

  it("builds a Codex active-session snapshot from runtime state", () => {
    codexSession.getActiveSessionSnapshot = () => ({
      session_id: "codex-runtime-session",
      saved_at: "2026-03-07T18:00:00.000Z",
      working_dir: WORKING_DIR,
      title: "Codex runtime title",
      recentMessages: [
        {
          role: "user",
          text: "hello from codex",
          timestamp: "2026-03-07T18:00:00.000Z",
        },
      ],
    });

    const provider = getSessionObservabilityProvider("codex");
    const snapshot = provider.getActiveSessionSnapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      session_id: "codex-runtime-session",
      title: "Codex runtime title",
      working_dir: WORKING_DIR,
    });
  });

  it("builds provider-owned driver process state for Codex", () => {
    const provider = getSessionObservabilityProvider("codex");
    const state = provider.getDriverProcessState();

    expect(state.processId).toBe("driver-codex");
    expect(state.label).toBe("Codex driver");
    expect(state.detail).toBe("idle");
    expect(state.extra.currentTool).toBeNull();
  });

  it("uses the Codex active snapshot as a tracked session source", async () => {
    codexSession.getSessionList = () => [];
    codexSession.getSessionListLive = async () => [];
    codexSession.getActiveSessionSnapshot = () => ({
      session_id: "codex-runtime-session",
      saved_at: "2026-03-07T18:05:00.000Z",
      working_dir: WORKING_DIR,
      title: "Codex runtime title",
      preview: "You: check provider",
    });

    const provider = getSessionObservabilityProvider("codex");
    const sessions = await provider.listTrackedSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: "codex-runtime-session",
      title: "Codex runtime title",
    });
  });

  it("prefers local tracked Codex session metadata over live app-server previews", async () => {
    codexSession.getSessionList = () => [
      {
        session_id: "codex-tracked-session",
        saved_at: "2026-03-07T18:06:00.000Z",
        working_dir: WORKING_DIR,
        title: "Tracked Codex session",
        preview: "You: clean local preview",
        recentMessages: [
          {
            role: "user",
            text: "clean local preview",
            timestamp: "2026-03-07T18:06:00.000Z",
          },
        ],
      },
    ];
    codexSession.getSessionListLive = async () => [
      {
        session_id: "codex-tracked-session",
        saved_at: "2026-03-07T18:07:00.000Z",
        working_dir: WORKING_DIR,
        title: "Richard@host tmux attach ...",
        preview: "Richard@host % ./some shell transcript",
      },
    ];
    codexSession.getActiveSessionSnapshot = () => null;

    const provider = getSessionObservabilityProvider("codex");
    const sessions = await provider.listTrackedSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: "codex-tracked-session",
      title: "Tracked Codex session",
      preview: "You: clean local preview",
    });
  });

  it("prefers the active Codex snapshot when transcript history is stale", async () => {
    codexSession.getActiveSessionSnapshot = () => ({
      session_id: "codex-live-session",
      saved_at: "2026-03-07T18:10:00.000Z",
      working_dir: WORKING_DIR,
      title: "Codex live session",
      recentMessages: [
        {
          role: "user",
          text: "new active user message",
          timestamp: "2026-03-07T18:10:00.000Z",
        },
        {
          role: "assistant",
          text: "new active assistant reply",
          timestamp: "2026-03-07T18:10:01.000Z",
        },
      ],
    });
    codexSession.getSessionTranscript = async () => ({
      sessionId: "codex-live-session",
      path: "/tmp/codex-live-session.jsonl",
      messages: [
        {
          role: "user",
          text: "older transcript user message",
          timestamp: "2026-03-07T18:00:00.000Z",
        },
        {
          role: "assistant",
          text: "older transcript assistant reply",
          timestamp: "2026-03-07T18:00:01.000Z",
        },
      ],
      injectedArtifacts: [],
      metaSharedLoaded: false,
      datePrefixApplied: false,
    });

    const provider = getSessionObservabilityProvider("codex");
    const history = await provider.loadDisplayHistory(
      "codex-live-session",
      {
        session_id: "codex-live-session",
        saved_at: "2026-03-07T18:00:00.000Z",
        working_dir: WORKING_DIR,
        title: "Codex live session",
      },
      codexSession.getActiveSessionSnapshot()
    );

    expect(history?.messages).toEqual([
      {
        role: "user",
        text: "new active user message",
        timestamp: "2026-03-07T18:10:00.000Z",
      },
      {
        role: "assistant",
        text: "new active assistant reply",
        timestamp: "2026-03-07T18:10:01.000Z",
      },
    ]);
  });

  it("attributes the shared processing lock to the active Codex driver when no executing driver is set", () => {
    session.activeDriver = "codex";
    const stopProcessing = session.startProcessing();
    (codexSession as unknown as { _isProcessing: boolean })._isProcessing = true;
    (codexSession as unknown as { isQueryRunning: boolean }).isQueryRunning = false;
    setExecutingDriverForTests(null);

    const runningState = getDashboardDriverRunningState();

    expect(runningState.claude.isRunning).toBe(false);
    expect(runningState.codex.isRunning).toBe(true);

    stopProcessing();
    (codexSession as unknown as { _isProcessing: boolean })._isProcessing = false;
  });
});
