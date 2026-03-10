import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const callbackPath = resolve(import.meta.dir, "callback.ts");
const sessionPath = resolve(import.meta.dir, "../session.ts");
const codexPath = resolve(import.meta.dir, "../codex-session.ts");
const marker = "__CALLBACK_PROBE__=";

type ProbeResult<T> = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: T | null;
};

async function runCallbackProbe<T>(
  scriptBody: string,
  opts?: { codexEnabled?: boolean; codexCliAvailable?: boolean }
): Promise<ProbeResult<T>> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
    CODEX_ENABLED: opts?.codexEnabled === false ? "false" : "true",
    CODEX_CLI_AVAILABLE_OVERRIDE: opts?.codexCliAvailable === false ? "false" : "true",
    HOME: process.env.HOME || "/tmp",
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const callbackPath = ${JSON.stringify(callbackPath)};
    const sessionPath = ${JSON.stringify(sessionPath)};
    const codexPath = ${JSON.stringify(codexPath)};
    ${scriptBody}
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as T)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("handleCallback Codex switching and controls", () => {
  it("claude model callback re-renders the picker keyboard after selection", async () => {
    const result = await runCallbackProbe<{
      model: string;
      callbackAnswers: Array<{ text?: string }>;
      editCalls: Array<{
        text: string;
        extra?: {
          parse_mode?: string;
          reply_markup?: {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          };
        };
      }>;
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { session, getAvailableModels } = await import(sessionPath);

      const models = getAvailableModels();
      const targetModel = models[0]?.value || "claude-opus-4-6";

      session.activeDriver = "claude";
      session.model = targetModel;
      session.effort = "medium";

      const callbackAnswers = [];
      const editCalls = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "model:" + targetModel },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async (text, extra) => {
          editCalls.push({ text: String(text), extra: extra || {} });
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        model: session.model,
        callbackAnswers,
        editCalls,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select model or effort level:");
    expect(
      result.payload?.editCalls[0]?.extra?.reply_markup?.inline_keyboard?.flat().map(
        (button) => button.callback_data || ""
      )
    ).toContain("effort:medium");
  });

  it("claude effort callback re-renders the picker keyboard after selection", async () => {
    const result = await runCallbackProbe<{
      effort: string;
      callbackAnswers: Array<{ text?: string }>;
      editCalls: Array<{
        text: string;
        extra?: {
          parse_mode?: string;
          reply_markup?: {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          };
        };
      }>;
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { session } = await import(sessionPath);

      session.activeDriver = "claude";
      session.model = "claude-sonnet-4-6";
      session.effort = "high";

      const callbackAnswers = [];
      const editCalls = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "effort:low" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async (text, extra) => {
          editCalls.push({ text: String(text), extra: extra || {} });
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        effort: session.effort,
        callbackAnswers,
        editCalls,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.effort).toBe("low");
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select model or effort level:");
    expect(
      result.payload?.editCalls[0]?.extra?.reply_markup?.inline_keyboard?.flat().map(
        (button) => button.callback_data || ""
      )
    ).toContain("effort:low");
  });

  it("switch:codex returns unavailable alert and does not switch when Codex is unavailable", async () => {
    const result = await runCallbackProbe<{
      activeDriver: string;
      startNewThreadCalls: number;
      callbackAnswers: Array<{ text?: string; show_alert?: boolean }>;
      editTexts: string[];
    }>(
      `
      const { handleCallback } = await import(callbackPath);
      const { session } = await import(sessionPath);
      const { codexSession } = await import(codexPath);

      let startNewThreadCalls = 0;
      codexSession.startNewThread = async () => {
        startNewThreadCalls += 1;
      };

      const callbackAnswers = [];
      const editTexts = [];
      session.activeDriver = "claude";

      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "switch:codex" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async (text) => {
          editTexts.push(String(text));
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        activeDriver: session.activeDriver,
        startNewThreadCalls,
        callbackAnswers,
        editTexts,
      }));
      `,
      { codexEnabled: false, codexCliAvailable: false }
    );

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.activeDriver).toBe("claude");
    expect(result.payload?.startNewThreadCalls).toBe(0);
    expect(result.payload?.editTexts || []).toHaveLength(0);
    expect(result.payload?.callbackAnswers[0]?.show_alert).toBe(true);
    expect(result.payload?.callbackAnswers[0]?.text || "").toContain("Codex");
  });

  it("switch:codex resets sessions, starts new thread, and updates active driver when Codex is available", async () => {
    const result = await runCallbackProbe<{
      activeDriver: string;
      startNewThreadCalls: number;
      sessionKillCalls: number;
      codexKillCalls: number;
      callbackAnswers: Array<{ text?: string; show_alert?: boolean }>;
      editTexts: string[];
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { session } = await import(sessionPath);
      const { codexSession } = await import(codexPath);

      let startNewThreadCalls = 0;
      let sessionKillCalls = 0;
      let codexKillCalls = 0;
      session.stopTyping = () => {};
      session.kill = async () => {
        sessionKillCalls += 1;
      };
      codexSession.kill = async () => {
        codexKillCalls += 1;
      };
      codexSession.startNewThread = async () => {
        startNewThreadCalls += 1;
      };

      const callbackAnswers = [];
      const editTexts = [];
      session.activeDriver = "claude";

      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "switch:codex" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async (text) => {
          editTexts.push(String(text));
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        activeDriver: session.activeDriver,
        startNewThreadCalls,
        sessionKillCalls,
        codexKillCalls,
        callbackAnswers,
        editTexts,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.activeDriver).toBe("codex");
    expect(result.payload?.startNewThreadCalls).toBe(1);
    expect(result.payload?.sessionKillCalls).toBe(1);
    expect(result.payload?.codexKillCalls).toBe(1);
    expect(result.payload?.callbackAnswers[0]?.text).toBe("Switched to Codex");
    expect(result.payload?.editTexts[0] || "").toContain("Switched to Codex");
  });

  it("codex_model callback with active session preserves the current thread and only updates prefs", async () => {
    const result = await runCallbackProbe<{
      model: string;
      reasoningEffort: string;
      targetModel: string;
      threadId: string | null;
      resumeThreadArgs: Array<[string, string, string]>;
      callbackAnswers: Array<{ text?: string }>;
      editCalls: Array<{
        text: string;
        extra?: {
          parse_mode?: string;
          reply_markup?: {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          };
        };
      }>;
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { codexSession, getAvailableCodexModelsLive } = await import(codexPath);

      const models = await getAvailableCodexModelsLive();
      const targetModel = models[0]?.value || "gpt-5.3-codex";
      const initialModel = models[1]?.value || targetModel;

      codexSession.model = initialModel;
      codexSession.reasoningEffort = "medium";
      codexSession.threadId = "codex-thread-model";
      Object.defineProperty(codexSession, "isActive", {
        configurable: true,
        get: () => true,
      });

      const resumeThreadArgs = [];
      codexSession.resumeThread = async (threadId, model, effort) => {
        resumeThreadArgs.push([String(threadId), String(model), String(effort)]);
      };

      const callbackAnswers = [];
      const editCalls = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "codex_model:" + targetModel },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async (text, extra) => {
          editCalls.push({ text: String(text), extra: extra || {} });
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        model: codexSession.model,
        reasoningEffort: codexSession.reasoningEffort,
        targetModel,
        threadId: codexSession.getThreadId(),
        resumeThreadArgs,
        callbackAnswers,
        editCalls,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.model).toBe(result.payload?.targetModel);
    expect(result.payload?.threadId).toBe("codex-thread-model");
    expect(result.payload?.resumeThreadArgs).toEqual([
      ["codex-thread-model", result.payload?.targetModel || "", "medium"],
    ]);
    expect(result.payload?.callbackAnswers[0]?.text).toBe("Codex model updated for current convo");
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select model or reasoning effort:");
    expect(
      result.payload?.editCalls[0]?.extra?.reply_markup?.inline_keyboard?.flat().map(
        (button) => button.callback_data || ""
      )
    ).toContain("codex_effort:medium");
  });

  it("codex_effort callback with active session preserves the current thread and only updates prefs", async () => {
    const result = await runCallbackProbe<{
      model: string;
      reasoningEffort: string;
      threadId: string | null;
      resumeThreadArgs: Array<[string, string, string]>;
      callbackAnswers: Array<{ text?: string }>;
      editCalls: Array<{
        text: string;
        extra?: {
          parse_mode?: string;
          reply_markup?: {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          };
        };
      }>;
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { codexSession, getAvailableCodexModelsLive } = await import(codexPath);

      const models = await getAvailableCodexModelsLive();
      const modelValue = models[0]?.value || "gpt-5.3-codex";

      codexSession.model = modelValue;
      codexSession.reasoningEffort = "medium";
      codexSession.threadId = "codex-thread-effort";
      Object.defineProperty(codexSession, "isActive", {
        configurable: true,
        get: () => true,
      });

      const resumeThreadArgs = [];
      codexSession.resumeThread = async (threadId, model, effort) => {
        resumeThreadArgs.push([String(threadId), String(model), String(effort)]);
      };

      const callbackAnswers = [];
      const editCalls = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "codex_effort:high" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async (text, extra) => {
          editCalls.push({ text: String(text), extra: extra || {} });
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        model: codexSession.model,
        reasoningEffort: codexSession.reasoningEffort,
        threadId: codexSession.getThreadId(),
        resumeThreadArgs,
        callbackAnswers,
        editCalls,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.reasoningEffort).toBe("high");
    expect(result.payload?.threadId).toBe("codex-thread-effort");
    expect(result.payload?.resumeThreadArgs).toEqual([
      ["codex-thread-effort", result.payload?.model || "", "high"],
    ]);
    expect(result.payload?.callbackAnswers[0]?.text).toBe("Codex effort updated for current convo");
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select model or reasoning effort:");
    expect(
      result.payload?.editCalls[0]?.extra?.reply_markup?.inline_keyboard?.flat().map(
        (button) => button.callback_data || ""
      )
    ).toContain("codex_effort:high");
  });

  it("changing Codex model and effort from the same picker does not replace the linked thread", async () => {
    const result = await runCallbackProbe<{
      threadId: string | null;
      model: string;
      reasoningEffort: string;
      resumeThreadArgs: Array<[string, string, string]>;
      callbackAnswers: Array<{ text?: string }>;
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { codexSession, getAvailableCodexModelsLive } = await import(codexPath);

      const models = await getAvailableCodexModelsLive();
      const targetModel = models[0]?.value || "gpt-5.3-codex";

      codexSession.model = targetModel;
      codexSession.reasoningEffort = "medium";
      codexSession.threadId = "codex-thread-stable";
      Object.defineProperty(codexSession, "isActive", {
        configurable: true,
        get: () => true,
      });

      const resumeThreadArgs = [];
      codexSession.resumeThread = async (threadId, model, effort) => {
        resumeThreadArgs.push([String(threadId), String(model), String(effort)]);
      };

      const callbackAnswers = [];
      const baseCtx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        editMessageText: async () => {},
      };

      await handleCallback({
        ...baseCtx,
        callbackQuery: { data: "codex_model:" + targetModel },
      });
      await handleCallback({
        ...baseCtx,
        callbackQuery: { data: "codex_effort:xhigh" },
      });

      console.log(marker + JSON.stringify({
        threadId: codexSession.getThreadId(),
        model: codexSession.model,
        reasoningEffort: codexSession.reasoningEffort,
        resumeThreadArgs,
        callbackAnswers,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.threadId).toBe("codex-thread-stable");
    expect(result.payload?.model).toBeTruthy();
    expect(result.payload?.reasoningEffort).toBe("xhigh");
    expect(result.payload?.resumeThreadArgs).toEqual([
      ["codex-thread-stable", result.payload?.model || "", "medium"],
      ["codex-thread-stable", result.payload?.model || "", "xhigh"],
    ]);
    expect(result.payload?.callbackAnswers.map((entry) => entry.text)).toEqual([
      "Codex model updated for current convo",
      "Codex effort updated for current convo",
    ]);
  });
});

describe("handleCallback resume_current", () => {
  it("continues the active Claude session", async () => {
    const result = await runCallbackProbe<{
      callbackAnswers: Array<{ text?: string; show_alert?: boolean }>;
      replies: string[];
      editTexts: string[];
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { session } = await import(sessionPath);

      session.activeDriver = "claude";
      session.sessionId = "claude-current-123";
      session.recentMessages = [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
      ];

      const callbackAnswers = [];
      const replies = [];
      const editTexts = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "resume_current" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        reply: async (text) => {
          replies.push(String(text));
        },
        editMessageText: async (text) => {
          editTexts.push(String(text));
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        callbackAnswers,
        replies,
        editTexts,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers[0]?.text).toBe("Continuing current Claude session");
    expect(result.payload?.callbackAnswers[0]?.show_alert).toBeUndefined();
    expect(result.payload?.editTexts[0]).toContain("Continuing current Claude session");
    expect(result.payload?.replies[0]).toContain("📝 Current Claude session");
  });

  it("continues the active Codex session", async () => {
    const result = await runCallbackProbe<{
      callbackAnswers: Array<{ text?: string; show_alert?: boolean }>;
      replies: string[];
      editTexts: string[];
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { session } = await import(sessionPath);
      const { codexSession } = await import(codexPath);

      session.activeDriver = "codex";
      codexSession.getThreadId = () => "codex-thread-123";
      codexSession.recentMessages = [
        { role: "user", text: "continue codex" },
        { role: "assistant", text: "continuing now" },
      ];

      const callbackAnswers = [];
      const replies = [];
      const editTexts = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "resume_current" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        reply: async (text) => {
          replies.push(String(text));
        },
        editMessageText: async (text) => {
          editTexts.push(String(text));
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        callbackAnswers,
        replies,
        editTexts,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers[0]?.text).toBe("Continuing current Codex session");
    expect(result.payload?.callbackAnswers[0]?.show_alert).toBeUndefined();
    expect(result.payload?.editTexts[0]).toContain("Continuing current Codex session");
    expect(result.payload?.replies[0]).toContain("📝 Current Codex session");
  });

  it("shows alert when resume_current has no active session", async () => {
    const result = await runCallbackProbe<{
      callbackAnswers: Array<{ text?: string; show_alert?: boolean }>;
      replies: string[];
      editTexts: string[];
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { session } = await import(sessionPath);

      session.activeDriver = "claude";
      session.sessionId = null;

      const callbackAnswers = [];
      const replies = [];
      const editTexts = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "resume_current" },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        reply: async (text) => {
          replies.push(String(text));
        },
        editMessageText: async (text) => {
          editTexts.push(String(text));
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        callbackAnswers,
        replies,
        editTexts,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers[0]?.show_alert).toBe(true);
    expect(result.payload?.callbackAnswers[0]?.text).toBe("No active Claude session");
    expect(result.payload?.replies).toHaveLength(0);
    expect(result.payload?.editTexts).toHaveLength(0);
  });
});
