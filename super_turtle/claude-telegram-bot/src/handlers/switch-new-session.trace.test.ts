import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type TraceSnapshot = {
  events: string[];
  activeDriver: "claude" | "codex";
  claudeSessionId: string | null;
  codexThreadId: string | null;
  result?: string;
};

type TracePayload = {
  commandSwitchToCodex: TraceSnapshot;
  commandNew: TraceSnapshot;
  streamNewSession: TraceSnapshot;
};

type TraceResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: TracePayload | null;
};

const commandsPath = resolve(import.meta.dir, "commands.ts");
const callbackPath = resolve(import.meta.dir, "callback.ts");
const streamingPath = resolve(import.meta.dir, "streaming.ts");
const sessionPath = resolve(import.meta.dir, "../session.ts");
const codexPath = resolve(import.meta.dir, "../codex-session.ts");
const botPath = resolve(import.meta.dir, "../bot.ts");
const marker = "__SWITCH_NEW_SESSION_TRACE__=";
const IPC_DIR = "/tmp/superturtle-test-token";

async function runTraceProbe(): Promise<TraceResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    SUPER_TURTLE_PROJECT_DIR: process.cwd(),
    CODEX_ENABLED: "true",
    CODEX_CLI_AVAILABLE_OVERRIDE: "true",
    HOME: process.env.HOME || "/tmp",
    SUPERTURTLE_IPC_DIR: IPC_DIR,
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const ipcDir = ${JSON.stringify(IPC_DIR)};
    const commandsPath = ${JSON.stringify(commandsPath)};
    const callbackPath = ${JSON.stringify(callbackPath)};
    const streamingPath = ${JSON.stringify(streamingPath)};
    const sessionPath = ${JSON.stringify(sessionPath)};
    const codexPath = ${JSON.stringify(codexPath)};
    const botPath = ${JSON.stringify(botPath)};

    const { mkdirSync, rmSync } = await import("fs");
    mkdirSync(ipcDir, { recursive: true });

    const { handleNew, performDriverSwitch } = await import(commandsPath);
    const { checkPendingBotControlRequests } = await import(streamingPath);
    const { session } = await import(sessionPath);
    const { codexSession } = await import(codexPath);
    const { bot } = await import(botPath);

    const chat = { id: 123, type: "private" };
    let messageId = 1;
    const events = [];

    const fakeThread = (id) => ({
      id,
      run: async () => ({ finalResponse: "", usage: null }),
      runStreamed: async () => ({ events: (async function* () {})() }),
    });

    const setActiveSessions = (claudeId, codexId) => {
      session.sessionId = claudeId;
      session.conversationTitle = "Claude trace";
      session.lastActivity = new Date("2026-03-07T18:00:00.000Z");
      session.lastMessage = "Claude trace user";
      session.lastAssistantMessage = "Claude trace reply";
      session.recentMessages = [
        { role: "user", text: "Claude trace user", timestamp: "2026-03-07T18:00:00.000Z" },
        { role: "assistant", text: "Claude trace reply", timestamp: "2026-03-07T18:00:01.000Z" },
      ];

      codexSession.thread = codexId ? fakeThread(codexId) : null;
      codexSession.threadId = codexId;
      codexSession.lastActivity = new Date("2026-03-07T18:05:00.000Z");
      codexSession.lastMessage = "Codex trace user";
      codexSession.lastAssistantMessage = "Codex trace reply";
      codexSession.recentMessages = [
        { role: "user", text: "Codex trace user", timestamp: "2026-03-07T18:05:00.000Z" },
        { role: "assistant", text: "Codex trace reply", timestamp: "2026-03-07T18:05:01.000Z" },
      ];
    };

    const snapshot = (result) => ({
      events: [...events],
      activeDriver: session.activeDriver,
      claudeSessionId: session.sessionId,
      codexThreadId: codexSession.getThreadId(),
      ...(result ? { result } : {}),
    });

    const mkCtx = (text, callbackData) => ({
      from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
      chat,
      message: text
        ? {
            text,
            message_id: messageId++,
            date: Math.floor(Date.now() / 1000),
            chat,
          }
        : undefined,
      callbackQuery: callbackData ? { data: callbackData } : undefined,
      reply: async () => ({
        chat,
        message_id: messageId++,
        text: "",
      }),
      replyWithChatAction: async () => {},
      editMessageText: async () => {},
      answerCallbackQuery: async () => {},
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
    });

    const newRequestFile = \`\${ipcDir}/bot-control-trace-new.json\`;

    const originalSendMessage = bot.api.sendMessage;
    const originalSessionStop = session.stop.bind(session);
    const originalSessionKill = session.kill.bind(session);
    const originalCodexStop = codexSession.stop.bind(codexSession);
    const originalCodexKill = codexSession.kill.bind(codexSession);
    const originalStartNewThread = codexSession.startNewThread.bind(codexSession);

    bot.api.sendMessage = async () => ({ message_id: messageId++ });
    session.stop = async () => {
      events.push("claude.stop");
      return false;
    };
    session.kill = async () => {
      events.push("claude.kill");
      return await originalSessionKill();
    };
    codexSession.stop = async () => {
      events.push("codex.stop");
      return false;
    };
    codexSession.kill = async function () {
      events.push("codex.kill");
      return await originalCodexKill();
    };
    codexSession.startNewThread = async function () {
      events.push("codex.startNewThread");
      this.thread = fakeThread("trace-codex-new");
      this.threadId = "trace-codex-new";
      this.systemPromptPrepended = false;
    };

    try {
      setActiveSessions("claude-command-switch", "codex-command-switch");
      session.activeDriver = "claude";
      events.length = 0;
      await performDriverSwitch("codex");
      const commandSwitchToCodex = snapshot();

      setActiveSessions("claude-command-new", "codex-command-new");
      session.activeDriver = "claude";
      events.length = 0;
      await handleNew(mkCtx("/new"));
      const commandNew = snapshot();

      setActiveSessions("claude-stream-new", "codex-stream-new");
      session.activeDriver = "codex";
      await Bun.write(
        newRequestFile,
        JSON.stringify({
          request_id: "trace-new",
          action: "new_session",
          params: {},
          status: "pending",
          chat_id: "123",
          created_at: new Date().toISOString(),
        })
      );
      events.length = 0;
      await checkPendingBotControlRequests(codexSession, 123);
      const streamNewResult = JSON.parse(await Bun.file(newRequestFile).text()).result;
      const streamNewSession = snapshot(streamNewResult);

      console.log(
        marker +
          JSON.stringify({
            commandSwitchToCodex,
            commandNew,
            streamNewSession,
          })
      );
    } finally {
      bot.api.sendMessage = originalSendMessage;
      session.stop = originalSessionStop;
      session.kill = originalSessionKill;
      codexSession.stop = originalCodexStop;
      codexSession.kill = originalCodexKill;
      codexSession.startNewThread = originalStartNewThread;
      rmSync(newRequestFile, { force: true });
    }
  `;

  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const payloadLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(marker));

  const payload = payloadLine
    ? (JSON.parse(payloadLine.slice(marker.length)) as TracePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("switch/new-session trace", () => {
  it("captures the switch and new-session control flow across commands, callbacks, and bot-control", async () => {
    const result = await runTraceProbe();
    if (result.exitCode !== 0) {
      throw new Error(`Switch/new-session trace probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();

    expect(result.payload?.commandSwitchToCodex.events).toEqual([
      "claude.kill",
      "codex.kill",
      "codex.kill",
      "codex.startNewThread",
    ]);
    expect(result.payload?.commandSwitchToCodex.activeDriver).toBe("codex");
    expect(result.payload?.commandSwitchToCodex.claudeSessionId).toBe("trace-codex-new");
    expect(result.payload?.commandSwitchToCodex.codexThreadId).toBe("trace-codex-new");

    expect(result.payload?.commandNew.events).toEqual([
      "claude.kill",
      "codex.kill",
      "codex.kill",
    ]);
    expect(result.payload?.commandNew.claudeSessionId).toBeNull();
    expect(result.payload?.commandNew.codexThreadId).toBeNull();

    expect(result.payload?.streamNewSession.events).toEqual([
      "codex.stop",
      "codex.kill",
    ]);
    expect(result.payload?.streamNewSession.activeDriver).toBe("codex");
    expect(result.payload?.streamNewSession.result).toBe(
      "Session cleared. Next message will start a fresh session."
    );
    expect(result.payload?.streamNewSession.claudeSessionId).toBe("claude-stream-new");
    expect(result.payload?.streamNewSession.codexThreadId).toBeNull();
  }, 20_000);
});
