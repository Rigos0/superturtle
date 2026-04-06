import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type ResumeTracePayload = {
  events: string[];
  activeDriver: "claude" | "codex";
  claudeHistoryIds: string[];
  codexHistoryIds: string[];
  resumeCallbacks: string[];
};

function extractMarkedJson<T>(output: string, marker: string): T | null {
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return null;

  const tail = output.slice(markerIndex + marker.length);
  const start = tail.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < tail.length; i += 1) {
    const ch = tail[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < start) return null;
  return JSON.parse(tail.slice(start, end + 1)) as T;
}

function runTraceProbe(): {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: ResumeTracePayload | null;
} {
  const marker = "__SWITCH_RESUME_VISIBILITY_TRACE__=";
  const projectRoot = resolve(import.meta.dir, "../..");
  const token = "switch-resume-visibility-test-token";
  const tokenPrefix = token.split(":")[0] || token;

  const script = `
    const marker = ${JSON.stringify(marker)};
    const tokenPrefix = ${JSON.stringify(tokenPrefix)};
    const { readFileSync, rmSync } = await import("fs");
    const { handleResume, performDriverSwitch } = await import("./src/handlers/commands.ts");
    const { SESSION_FILE } = await import("./src/config.ts");
    const { session } = await import("./src/session.ts");
    const { codexSession } = await import("./src/codex-session.ts");

    const codexSessionFile = "/tmp/codex-telegram-" + tokenPrefix + "-session.json";
    const replies = [];
    const events = [];

    rmSync(SESSION_FILE, { force: true });
    rmSync(codexSessionFile, { force: true });

    const originalSessionKill = session.kill.bind(session);
    const originalCodexKill = codexSession.kill.bind(codexSession);
    const originalStartNewThread = codexSession.startNewThread.bind(codexSession);
    const originalGetSessionListLive = codexSession.getSessionListLive.bind(codexSession);

    const fakeThread = (id) => ({
      id,
      run: async () => ({ finalResponse: "", usage: null }),
      runStreamed: async () => ({ events: (async function* () {})() }),
    });

    session.activeDriver = "claude";
    session.sessionId = "claude-switch-source";
    session.lastActivity = new Date("2026-03-07T18:00:00.000Z");
    session.conversationTitle = "Claude source";
    session.lastMessage = "Keep this Claude session";
    session.lastAssistantMessage = "Claude reply";
    session.recentMessages = [
      { role: "user", text: "Keep this Claude session", timestamp: "2026-03-07T18:00:00.000Z" },
      { role: "assistant", text: "Claude reply", timestamp: "2026-03-07T18:00:01.000Z" },
    ];

    codexSession.thread = null;
    codexSession.threadId = null;
    codexSession.lastActivity = null;
    codexSession.lastMessage = null;
    codexSession.lastAssistantMessage = null;
    codexSession.recentMessages = [];

    session.kill = async () => {
      events.push("claude.kill");
      return await originalSessionKill();
    };
    codexSession.kill = async function () {
      events.push("codex.kill");
      return await originalCodexKill();
    };
    codexSession.startNewThread = async function () {
      events.push("codex.startNewThread");
      this.thread = fakeThread("codex-switch-current");
      this.threadId = "codex-switch-current";
      this.systemPromptPrepended = false;
      this.lastActivity = new Date("2026-03-07T18:05:00.000Z");
      this.lastMessage = "Fresh Codex thread";
      this.lastAssistantMessage = null;
      this.recentMessages = [
        { role: "user", text: "Fresh Codex thread", timestamp: "2026-03-07T18:05:00.000Z" },
      ];
      this.saveSession("Active Codex session");
    };
    codexSession.getSessionListLive = async () => codexSession.getSessionList();

    try {
      await performDriverSwitch("codex");

      await handleResume({
        from: { id: 123 },
        message: { text: "/resume" },
        reply: async (text, extra) => {
          replies.push({ text, extra });
          return { message_id: 2 };
        },
      });

      const claudeHistory = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
      const codexHistory = JSON.parse(readFileSync(codexSessionFile, "utf-8"));
      const reply = replies.at(-1);
      const buttons = reply?.extra?.reply_markup?.inline_keyboard || [];
      const resumeCallbacks = buttons.flat().map((button) => button?.callback_data || "");

      process.stdout.write(
        marker + JSON.stringify({
          events,
          activeDriver: session.activeDriver,
          claudeHistoryIds: (claudeHistory.sessions || []).map((entry) => entry.session_id),
          codexHistoryIds: (codexHistory.sessions || []).map((entry) => entry.session_id),
          resumeCallbacks,
        })
      );
    } finally {
      session.kill = originalSessionKill;
      codexSession.kill = originalCodexKill;
      codexSession.startNewThread = originalStartNewThread;
      codexSession.getSessionListLive = originalGetSessionListLive;
      rmSync(SESSION_FILE, { force: true });
      rmSync(codexSessionFile, { force: true });
    }
  `;

  const proc = Bun.spawnSync(["bun", "--no-env-file", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ALLOWED_USERS: "123",
      SUPER_TURTLE_PROJECT_DIR: projectRoot,
      CODEX_ENABLED: "true",
      CODEX_CLI_AVAILABLE_OVERRIDE: "true",
    },
  });

  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  return {
    exitCode: proc.exitCode,
    stdout,
    stderr,
    payload: extractMarkedJson<ResumeTracePayload>(stdout, marker),
  };
}

describe("switch/resume visibility trace", () => {
  it("keeps the prior Claude session visible after switching to Codex", () => {
    const result = runTraceProbe();
    if (result.exitCode !== 0) {
      throw new Error(`Switch/resume visibility trace probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.events).toEqual([
      "claude.kill",
      "codex.kill",
      "codex.startNewThread",
    ]);
    expect(result.payload?.activeDriver).toBe("codex");
    expect(result.payload?.claudeHistoryIds).toContain("claude-switch-source");
    expect(result.payload?.codexHistoryIds).toContain("codex-switch-current");
    expect(result.payload?.resumeCallbacks).toEqual([
      "resume_current",
      "resume:claude-switch-source",
    ]);
  }, 20_000);
});
