import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "grammy";
import { codexSession } from "../codex-session";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();
process.env.CODEX_ENABLED ||= "true";
process.env.CODEX_CLI_AVAILABLE_OVERRIDE ||= "true";

const originalSendMessage = codexSession.sendMessage;

async function loadCodexDriverModule() {
  return import(`./codex-driver.ts?test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  codexSession.sendMessage = originalSendMessage;
  mock.restore();
});

describe("CodexDriver", () => {
  it("does not derive reasoning effort from message keywords", async () => {
    mock.module("../handlers/streaming", () => ({
      checkPendingAskUserRequests: async () => false,
      checkPendingBotControlRequests: async () => false,
      checkPendingPinoLogsRequests: async () => false,
      checkPendingSendTurtleRequests: async () => false,
    }));

    const reasoningEfforts: Array<string | undefined> = [];
    codexSession.sendMessage = (async (
      _message,
      _statusCallback,
      _model,
      reasoningEffort
    ) => {
      reasoningEfforts.push(reasoningEffort);
      return "ok";
    }) as typeof codexSession.sendMessage;

    const { CodexDriver } = await loadCodexDriverModule();
    const driver = new CodexDriver();

    const response = await driver.runMessage({
      message: "please ultrathink about this",
      source: "text",
      username: "tester",
      userId: 123,
      chatId: 456,
      ctx: {} as Context,
      statusCallback: async () => {},
    });

    expect(response).toBe("ok");
    expect(reasoningEfforts).toEqual([undefined]);
  });
});
