import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type ResumeVisibilityProbe = {
  callbacks: string[];
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

function runProbe(marker: string, scriptBody: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: ResumeVisibilityProbe | null;
} {
  const projectRoot = resolve(import.meta.dir, "../..");
  const script = `
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.SUPER_TURTLE_PROJECT_DIR = process.cwd();
    process.env.CODEX_ENABLED = "true";
    process.env.CODEX_CLI_AVAILABLE_OVERRIDE = "true";
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    ${scriptBody}
  `;

  const proc = Bun.spawnSync(["bun", "--no-env-file", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-token",
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
    payload: extractMarkedJson<ResumeVisibilityProbe>(stdout, marker),
  };
}

describe("/resume visibility", () => {
  it("lists a Claude session after kill persists it during a switch away from Claude", () => {
    const marker = "__RESUME_CLAUDE_KILL_PROBE__=";
    const result = runProbe(marker, `
      const { rmSync } = await import("fs");
      const { SESSION_FILE } = await import("./src/config.ts");
      const { handleResume } = await import("./src/handlers/commands.ts");
      const { session } = await import("./src/session.ts");
      const { codexSession } = await import("./src/codex-session.ts");

      rmSync(SESSION_FILE, { force: true });

      const replies = [];
      const ctx = {
        from: { id: 123 },
        message: { text: "/resume" },
        reply: async (text, extra) => {
          replies.push({ text, extra });
        },
      };

      session.activeDriver = "claude";
      session.sessionId = "claude-saved-123";
      session.conversationTitle = "Claude saved";
      session.lastMessage = "Keep Claude";
      session.lastAssistantMessage = "Claude reply";
      session.recentMessages = [
        { role: "user", text: "Keep Claude", timestamp: "2026-03-07T18:00:00.000Z" },
        { role: "assistant", text: "Claude reply", timestamp: "2026-03-07T18:00:01.000Z" },
      ];

      await session.kill();
      session.activeDriver = "codex";

      codexSession.getThreadId = () => null;
      codexSession.getSessionListLive = async () => [];
      codexSession.getSessionList = () => [];

      await handleResume(ctx);
      const reply = replies.at(-1);
      const buttons = reply?.extra?.reply_markup?.inline_keyboard || [];
      const callbacks = buttons.map((row) => row[0]?.callback_data || "");
      process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ callbacks }));
    `);

    if (result.exitCode !== 0) {
      throw new Error(`Claude kill persistence probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbacks).toContain("resume:claude-saved-123");
  }, 20_000);

  it("lists a Codex session after kill persists it during a switch away from Codex", () => {
    const marker = "__RESUME_CODEX_KILL_PROBE__=";
    const result = runProbe(marker, `
      const { rmSync } = await import("fs");
      const { SESSION_FILE } = await import("./src/config.ts");
      const { handleResume } = await import("./src/handlers/commands.ts");
      const { session } = await import("./src/session.ts");
      const { codexSession } = await import("./src/codex-session.ts");

      const tokenPrefix = (process.env.TELEGRAM_BOT_TOKEN || "test-token").split(":")[0] || "test-token";
      const codexSessionFile = "/tmp/codex-telegram-" + tokenPrefix + "-session.json";
      rmSync(SESSION_FILE, { force: true });
      rmSync(codexSessionFile, { force: true });

      const replies = [];
      const ctx = {
        from: { id: 123 },
        message: { text: "/resume" },
        reply: async (text, extra) => {
          replies.push({ text, extra });
        },
      };

      session.activeDriver = "codex";
      session.sessionId = null;
      codexSession.lastMessage = "Keep Codex";
      codexSession.lastAssistantMessage = "Codex reply";
      codexSession.recentMessages = [
        { role: "user", text: "Keep Codex", timestamp: "2026-03-07T18:05:00.000Z" },
        { role: "assistant", text: "Codex reply", timestamp: "2026-03-07T18:05:01.000Z" },
      ];
      codexSession.threadId = "codex-saved-123";

      await codexSession.kill();
      session.activeDriver = "claude";

      session.getSessionList = () => [];
      codexSession.getSessionListLive = async () => [];

      await handleResume(ctx);
      const reply = replies.at(-1);
      const buttons = reply?.extra?.reply_markup?.inline_keyboard || [];
      const callbacks = buttons.map((row) => row[0]?.callback_data || "");
      process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ callbacks }));
    `);

    if (result.exitCode !== 0) {
      throw new Error(`Codex kill persistence probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbacks).toContain("codex_resume:codex-saved-123");
  }, 20_000);
});
