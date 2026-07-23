import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const callbackPath = resolve(import.meta.dir, "callback.ts");
const streamingPath = resolve(import.meta.dir, "streaming.ts");
const driverRoutingPath = resolve(import.meta.dir, "driver-routing.ts");
const configPath = resolve(import.meta.dir, "../config.ts");
const sessionPath = resolve(import.meta.dir, "../session.ts");
const codexPath = resolve(import.meta.dir, "../codex-session.ts");
const stopReplyStatePath = resolve(import.meta.dir, "stop-reply-state.ts");
const utilsPath = resolve(import.meta.dir, "../utils.ts");
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
    const streamingPath = ${JSON.stringify(streamingPath)};
    const driverRoutingPath = ${JSON.stringify(driverRoutingPath)};
    const configPath = ${JSON.stringify(configPath)};
    const sessionPath = ${JSON.stringify(sessionPath)};
    const codexPath = ${JSON.stringify(codexPath)};
    const stopReplyStatePath = ${JSON.stringify(stopReplyStatePath)};
    const utilsPath = ${JSON.stringify(utilsPath)};
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
  it("routes retained progress navigation callbacks to the snapshot viewer", async () => {
    const result = await runCallbackProbe<{
      callbackAnswers: Array<{ text?: string }>;
      lastEdit?: {
        text: string;
        extra?: {
          parse_mode?: string;
          reply_markup?: {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          };
        };
      };
    }>(`
      const { handleCallback } = await import(callbackPath);
      const { StreamingState, createStatusCallback } = await import(streamingPath);

      const callbackAnswers = [];
      const editCalls = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: {
          data: "progress_nav:back",
          message: { message_id: 1 },
        },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        reply: async () => ({
          chat: { id: 123 },
          message_id: 1,
        }),
        api: {
          editMessageText: async (_chatId, _messageId, text, extra) => {
            editCalls.push({ text: String(text), extra: extra || {} });
          },
          deleteMessage: async () => {},
        },
      };

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
      await state.progressUpdateChain;
      await statusCallback("segment_end", "Answer draft 1", 0);
      await statusCallback("segment_end", "Answer draft 2", 1);
      await statusCallback("segment_end", "Answer draft 3", 2);
      await statusCallback("done", "");

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        callbackAnswers,
        lastEdit: editCalls[editCalls.length - 1],
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers).toEqual([{}]);
    expect(result.payload?.lastEdit?.text || "").toContain("2 / 3");
    expect(result.payload?.lastEdit?.text || "").toContain("Answer draft 2");
    expect(
      result.payload?.lastEdit?.extra?.reply_markup?.inline_keyboard?.flat().map(
        (button) => button.callback_data || ""
      )
    ).toEqual(["progress_nav:back", "progress_nav:next"]);
  });

  it("silently answers retained progress navigation at the history boundary", async () => {
    const result = await runCallbackProbe<{
      callbackAnswers: Array<{ text?: string }>;
      editCountBeforeBoundaryTap: number;
      editCountAfterBoundaryTap: number;
      lastEditText?: string;
    }>(`
      const { handleCallback } = await import(callbackPath);
      const {
        StreamingState,
        createStatusCallback,
        navigateRetainedProgressViewer,
      } = await import(streamingPath);

      const callbackAnswers = [];
      const editCalls = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: {
          data: "progress_nav:back",
          message: { message_id: 1 },
        },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
        reply: async () => ({
          chat: { id: 123 },
          message_id: 1,
        }),
        api: {
          editMessageText: async (_chatId, _messageId, text, extra) => {
            editCalls.push({ text: String(text), extra: extra || {} });
          },
          deleteMessage: async () => {},
        },
      };

      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state, { showToolStatus: true });
      await state.progressUpdateChain;
      await statusCallback("segment_end", "Answer draft 1", 0);
      await statusCallback("segment_end", "Answer draft 2", 1);
      await statusCallback("segment_end", "Answer draft 3", 2);
      await statusCallback("done", "");

      await navigateRetainedProgressViewer(ctx, "back");
      await navigateRetainedProgressViewer(ctx, "back");

      const editCountBeforeBoundaryTap = editCalls.length;
      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        callbackAnswers,
        editCountBeforeBoundaryTap,
        editCountAfterBoundaryTap: editCalls.length,
        lastEditText: editCalls[editCalls.length - 1]?.text,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers).toEqual([{}]);
    expect(result.payload?.editCountAfterBoundaryTap).toBe(
      result.payload?.editCountBeforeBoundaryTap
    );
    expect(result.payload?.lastEditText || "").toContain("1 / 3");
    expect(result.payload?.lastEditText || "").toContain("Answer draft 1");
  });

  it("reports missing retained progress history when no viewer is registered", async () => {
    const result = await runCallbackProbe<{
      callbackAnswers: Array<{ text?: string }>;
    }>(`
      const { handleCallback } = await import(callbackPath);

      const callbackAnswers = [];
      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: {
          data: "progress_nav:next",
          message: { message_id: 99 },
        },
        answerCallbackQuery: async (payload) => {
          callbackAnswers.push(payload || {});
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({ callbackAnswers }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.callbackAnswers).toEqual([
      { text: "Progress history unavailable" },
    ]);
  });

  it("retains stopped progress for callback runs cancelled by an explicit stop", async () => {
    const result = await runCallbackProbe<{
      updateStates: string[];
      retainCalls: number;
      teardownCalls: number;
      replies: string[];
    }>(`
      const { mock } = await import("bun:test");
      const { IPC_DIR } = await import(configPath);
      const actualStreaming = await import(streamingPath + "?actual=" + Date.now());
      const actualDriverRouting = await import(driverRoutingPath + "?actual=" + Date.now());
      const actualStopReplyState = await import(stopReplyStatePath + "?actual=" + Date.now());

      const replies = [];
      const updateStates = [];
      let retainCalls = 0;
      let teardownCalls = 0;

      mock.module(utilsPath, () => ({
        auditLog: async () => {},
        auditLogAuth: async () => {},
        auditLogError: async () => {},
        generateRequestId: () => "callback-stop-retain",
        startTypingIndicator: () => ({ stop: () => {} }),
      }));

      mock.module(driverRoutingPath, () => ({
        ...actualDriverRouting,
        isAnyDriverRunning: () => false,
        stopActiveDriverQuery: async () => "stopped",
        runMessageWithActiveDriver: async () => {
          throw new Error("abort");
        },
      }));

      mock.module(stopReplyStatePath, () => ({
        ...actualStopReplyState,
        consumeHandledStopReply: () => false,
      }));

      mock.module(streamingPath, () => ({
        ...actualStreaming,
        StreamingState: class StreamingState {
          awaitingUserAttention = false;
          teardownCompleted = false;
          stopRequestedByUser = true;
        },
        createStatusCallback: () => async () => {},
        navigateRetainedProgressViewer: async () => "missing",
        retainStreamingState: async () => {
          retainCalls += 1;
        },
        teardownStreamingState: async () => {
          teardownCalls += 1;
        },
        updateRetainedProgressState: async (_ctx, _state, progressState) => {
          updateStates.push(String(progressState));
        },
      }));

      await Bun.write(
        \`\${IPC_DIR}/ask-user-req-1.json\`,
        JSON.stringify({
          question: "Continue?",
          options: ["Ship it", "Stop"],
          status: "pending",
        })
      );

      const { handleCallback } = await import(callbackPath);

      const ctx = {
        from: { id: 123, username: "tester" },
        chat: { id: 123, type: "private" },
        callbackQuery: { data: "askuser:req-1:0" },
        answerCallbackQuery: async () => {},
        reply: async (text) => {
          replies.push(String(text));
          return { chat: { id: 123 }, message_id: 1 };
        },
        api: {
          editMessageText: async () => {},
          deleteMessage: async () => {},
        },
      };

      await handleCallback(ctx);

      console.log(marker + JSON.stringify({
        updateStates,
        retainCalls,
        teardownCalls,
        replies,
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.updateStates).toEqual(["Stopped"]);
    expect(result.payload?.retainCalls).toBe(1);
    expect(result.payload?.teardownCalls).toBe(0);
    expect(result.payload?.replies).toEqual([]);
  }, 15000);

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
      const targetModel = models[0]?.value || "claude-opus-4-8";

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
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select driver, model, or effort level:");
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
      session.model = "claude-sonnet-5";
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
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select driver, model, or effort level:");
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
    expect(result.payload?.editTexts[0] || "").toContain("Select driver, model, or reasoning effort:");
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
      const targetModel = models[0]?.value || "gpt-5.6-terra";
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
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select driver, model, or reasoning effort:");
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
      const modelValue = models[0]?.value || "gpt-5.6-terra";

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
    expect(result.payload?.editCalls[0]?.text || "").toContain("Select driver, model, or reasoning effort:");
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
      const targetModel = models[0]?.value || "gpt-5.6-terra";

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
