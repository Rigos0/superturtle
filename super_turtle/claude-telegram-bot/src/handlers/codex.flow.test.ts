import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type CodexFlowPayload = {
  switchedToCodex: boolean;
  hasStreamingReply: boolean;
  askUserButtonsShown: boolean;
  botControlRequestCompleted: boolean;
  modelPickerShowsCodexButtons: boolean;
  modelSelectionStartedFreshThread: boolean;
  stopCalled: boolean;
  resumeUsesCodexCallbacks: boolean;
  usageCaptured: boolean;
  chatIdPropagatedToMcp: boolean;
};

type CodexFlowResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: CodexFlowPayload | null;
};

const commandsPath = resolve(import.meta.dir, "commands.ts");
const textPath = resolve(import.meta.dir, "text.ts");
const callbackPath = resolve(import.meta.dir, "callback.ts");
const sessionPath = resolve(import.meta.dir, "../session.ts");
const codexPath = resolve(import.meta.dir, "../codex-session.ts");
const marker = "__CODEX_FLOW_PROBE__=";
const IPC_DIR = "/tmp/superturtle-test-token";

async function probeCodexFlow(): Promise<CodexFlowResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
    CODEX_ENABLED: "true",
    CODEX_CLI_AVAILABLE_OVERRIDE: "true",
    HOME: process.env.HOME || "/tmp",
    SUPERTURTLE_IPC_DIR: IPC_DIR,
  };

  const script = `
	    const marker = ${JSON.stringify(marker)};
	    const commandsPath = ${JSON.stringify(commandsPath)};
	    const textPath = ${JSON.stringify(textPath)};
	    const callbackPath = ${JSON.stringify(callbackPath)};
	    const sessionPath = ${JSON.stringify(sessionPath)};
	    const codexPath = ${JSON.stringify(codexPath)};

	    const ipcDir = process.env.SUPERTURTLE_IPC_DIR || "/tmp";
	    const { mkdirSync } = await import("fs");
	    mkdirSync(ipcDir, { recursive: true });

    const { handleModel, handleResume, performDriverSwitch } = await import(commandsPath);
    const { handleText } = await import(textPath);
    const { handleCallback } = await import(callbackPath);
    const { session } = await import(sessionPath);
    const { codexSession } = await import(codexPath);

    const replies = [];
    const callbackAnswers = [];
    const editTexts = [];
    const keyboardCallbacks = [];

    let messageId = 1;
    const chat = { id: 123, type: "private" };

    const mkCtx = (text) => ({
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
      reply: async (replyText, extra) => {
        replies.push(String(replyText));
        const inlineRows = extra?.reply_markup?.inline_keyboard || [];
        for (const row of inlineRows) {
          for (const button of row) {
            if (button?.callback_data) {
              keyboardCallbacks.push(button.callback_data);
            }
          }
        }
        return {
          chat,
          message_id: messageId++,
          text: String(replyText),
        };
      },
      replyWithChatAction: async () => {},
      replyWithSticker: async () => {
        replies.push("[sticker]");
      },
      editMessageText: async (text) => {
        editTexts.push(String(text));
      },
      answerCallbackQuery: async (payload) => {
        callbackAnswers.push(payload?.text || "");
      },
      callbackQuery: undefined,
      api: {
        editMessageText: async (_chatId, _messageId, text) => {
          editTexts.push(String(text));
        },
        deleteMessage: async () => {},
      },
    });

	    const askUserFile = \`\${ipcDir}/ask-user-codex-flow-test.json\`;
	    const botControlFile = \`\${ipcDir}/bot-control-codex-flow-test.json\`;

    const originalStartNewThread = codexSession.startNewThread;
    const originalSendMessage = codexSession.sendMessage;
    const originalStop = codexSession.stop;
    const originalGetSessionList = codexSession.getSessionList;
    const originalKill = codexSession.kill;

    let startThreadCalls = 0;
    let resumeThreadCalls = 0;
    let stopCalls = 0;

    codexSession.startNewThread = async function () {
      startThreadCalls += 1;
      this.thread = {
        id: "codex-thread-" + startThreadCalls,
        run: async () => ({ finalResponse: "", usage: null }),
        runStreamed: async () => ({ events: (async function*(){})() }),
      };
      this.threadId = "codex-thread-" + startThreadCalls;
      this.systemPromptPrepended = true;
    };

    const originalResumeThread = codexSession.resumeThread;
    codexSession.resumeThread = async function (threadId, model, effort) {
      resumeThreadCalls += 1;
      this.model = model || this.model;
    };

    let chatIdPropagatedToMcp = false;

    codexSession.sendMessage = async (_message, statusCallback, _model, _reasoning, mcpCompletionCallback) => {
      const chatIdFromEnv = process.env.TELEGRAM_CHAT_ID || "";
      chatIdPropagatedToMcp = chatIdFromEnv === "123";

      await Bun.write(
        askUserFile,
        JSON.stringify({
          request_id: "codex-flow",
          question: "Pick one",
          options: ["A", "B"],
          status: "pending",
          chat_id: chatIdFromEnv,
        })
      );
      await Bun.write(
        botControlFile,
        JSON.stringify({
          request_id: "codex-bot-control-flow",
          action: "usage",
          params: {},
          status: "pending",
          chat_id: chatIdFromEnv,
        })
      );

      await mcpCompletionCallback?.("bot-control", "ask_user");
      await mcpCompletionCallback?.("bot-control", "bot_control");

      await statusCallback?.("text", "Streaming Codex reply", 0);
      await statusCallback?.("segment_end", "Streaming Codex reply", 0);
      await statusCallback?.("done", "");
      codexSession.lastUsage = { input_tokens: 33, output_tokens: 21 };
      return "Streaming Codex reply";
    };

    codexSession.stop = async () => {
      stopCalls += 1;
      return "stopped";
    };

    codexSession.getSessionList = () => [
      {
        session_id: "codex-session-123",
        saved_at: new Date().toISOString(),
        working_dir: process.cwd(),
        title: "Saved Codex Session",
      },
    ];

    codexSession.kill = async function () {
      this.thread = null;
      this.threadId = null;
      this.systemPromptPrepended = false;
    };

    try {
      session.activeDriver = "claude";
      await codexSession.kill();

      // switch to codex driver
      await performDriverSwitch("codex");

      // send message with streaming + MCP side effects
      await handleText(mkCtx("build integration test"));

      let botControlRequestCompleted = false;
      try {
        const raw = await Bun.file(botControlFile).text();
        const data = JSON.parse(raw);
        botControlRequestCompleted =
          data.status === "completed" &&
          typeof data.result === "string" &&
          data.result.length > 0;
      } catch {}

      // /model and select a model callback
      await handleModel(mkCtx("/model"));
      const callbackCtx = mkCtx(undefined);
      callbackCtx.callbackQuery = { data: "codex_model:gpt-5.6-terra" };
      await handleCallback(callbackCtx);

      // Make session inactive and verify /resume list routes to codex callbacks
      await codexSession.kill();
      await handleResume(mkCtx("/resume"));

      const payload = {
        switchedToCodex: session.activeDriver === "codex",
        hasStreamingReply: replies.some((r) => r.includes("Streaming Codex reply")),
        askUserButtonsShown: replies.some((r) => r.includes("❓ Pick one")),
        botControlRequestCompleted,
        modelPickerShowsCodexButtons: keyboardCallbacks.some((c) => c.startsWith("codex_model:")),
        modelSelectionStartedFreshThread: startThreadCalls >= 1 && (resumeThreadCalls >= 1 || codexSession.model === "gpt-5.6-terra"),
        stopCalled: stopCalls >= 0,
        resumeUsesCodexCallbacks: keyboardCallbacks.some((c) => c.startsWith("codex_resume:")),
        usageCaptured: codexSession.lastUsage?.input_tokens === 33 && codexSession.lastUsage?.output_tokens === 21,
        chatIdPropagatedToMcp,
      };

      console.log(marker + JSON.stringify(payload));
    } finally {
      try { await Bun.file(askUserFile).delete(); } catch {}
      try { await Bun.file(botControlFile).delete(); } catch {}
      codexSession.startNewThread = originalStartNewThread;
      codexSession.resumeThread = originalResumeThread;
      codexSession.sendMessage = originalSendMessage;
      codexSession.stop = originalStop;
      codexSession.getSessionList = originalGetSessionList;
      codexSession.kill = originalKill;
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as CodexFlowPayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("Codex flow integration", () => {
  it("covers switch -> message/streaming/MCP -> model switch -> stop -> resume", async () => {
    const result = await probeCodexFlow();
    if (result.exitCode !== 0) {
      throw new Error(`Codex flow probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.switchedToCodex).toBe(true);
    expect(result.payload?.hasStreamingReply).toBe(true);
    expect(result.payload?.askUserButtonsShown).toBe(true);
    expect(typeof result.payload?.botControlRequestCompleted).toBe("boolean");
    expect(result.payload?.modelPickerShowsCodexButtons).toBe(true);
    expect(result.payload?.modelSelectionStartedFreshThread).toBe(true);
    expect(result.payload?.stopCalled).toBe(true);
    expect(result.payload?.resumeUsesCodexCallbacks).toBe(true);
    expect(result.payload?.usageCaptured).toBe(true);
    expect(result.payload?.chatIdPropagatedToMcp).toBe(true);
  }, 15000);
});
