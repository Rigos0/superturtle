import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "fs";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const { SESSION_FILE, WORKING_DIR } = await import("./config");
const { appendTurnLogEntry, clearTurnLogFile } = await import("./turn-log");

async function loadSessionModule(tag: string) {
  return import(`./session.ts?resume-history-test=${tag}-${Date.now()}-${Math.random()}`);
}

beforeEach(() => {
  rmSync(SESSION_FILE, { force: true });
  clearTurnLogFile();
});

afterEach(() => {
  rmSync(SESSION_FILE, { force: true });
  clearTurnLogFile();
});

describe("ClaudeSession resume history", () => {
  it("hydrates resumed sessions from turn-log history before saving", async () => {
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({
        sessions: [
          {
            session_id: "resume-history-session",
            saved_at: "2026-03-07T17:00:00.000Z",
            working_dir: WORKING_DIR,
            title: "Resume history session",
          },
        ],
      })
    );

    appendTurnLogEntry({
      driver: "claude",
      source: "text",
      sessionId: "resume-history-session",
      userId: 1,
      username: "tester",
      chatId: 1,
      model: "claude-opus-4-8",
      effort: "high",
      originalMessage: "Older Claude user message",
      effectivePrompt: "[Current date/time: ...]\n\nOlder Claude user message",
      injectedArtifacts: [],
      injections: {
        datePrefixApplied: true,
        metaPromptApplied: false,
        cronScheduledPromptApplied: false,
        backgroundSnapshotPromptApplied: false,
      },
      context: {
        claudeMdLoaded: false,
        metaSharedLoaded: false,
      },
      startedAt: "2026-03-07T17:00:00.000Z",
      completedAt: "2026-03-07T17:00:01.000Z",
      elapsedMs: 1000,
      status: "completed",
      response: "Older Claude assistant message",
      error: null,
      usage: {
        inputTokens: 3,
        outputTokens: 5,
      },
    });

    const { ClaudeSession } = await loadSessionModule("turn-log");
    const claude = new ClaudeSession();

    const [success] = claude.resumeSession("resume-history-session");
    expect(success).toBe(true);
    expect(claude.recentMessages).toEqual([
      {
        role: "user",
        text: "Older Claude user message",
        timestamp: "2026-03-07T17:00:00.000Z",
      },
      {
        role: "assistant",
        text: "Older Claude assistant message",
        timestamp: "2026-03-07T17:00:01.000Z",
      },
    ]);

    await Bun.sleep(10);

    const saved = JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as {
      sessions: Array<{
        session_id: string;
        preview?: string;
        recentMessages?: Array<{ text: string }>;
      }>;
    };
    expect(saved.sessions[0]?.session_id).toBe("resume-history-session");
    expect(saved.sessions[0]?.recentMessages?.map((message) => message.text)).toEqual([
      "Older Claude user message",
      "Older Claude assistant message",
    ]);
    expect(saved.sessions[0]?.preview).toContain("You: Older Claude user message");
    expect(saved.sessions[0]?.preview).toContain("Assistant: Older Claude assistant message");
  });
});
