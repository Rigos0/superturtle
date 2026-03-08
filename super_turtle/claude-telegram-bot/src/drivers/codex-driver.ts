import { codexSession } from "../codex-session";
import type { ChatDriver, DriverRunInput, DriverStatusSnapshot } from "./types";
import type { McpCompletionCallback } from "../types";
import { codexLog } from "../logger";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexDriver implements ChatDriver {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly auditEvent = "TEXT_CODEX" as const;

  async runMessage(input: DriverRunInput): Promise<string> {
    const {
      checkPendingAskUserRequests,
      checkPendingBotControlRequests,
      checkPendingPinoLogsRequests,
      checkPendingSendTurtleRequests,
    } = await import("../handlers/streaming");

    process.env.TELEGRAM_CHAT_ID = String(input.chatId);

    // MCP completion callback: fires when an mcp_tool_call completes
    const mcpCompletionCallback: McpCompletionCallback = async (_server, tool) => {
      // Route by tool name, not MCP server, so merged bot-control tools still resolve.
      const normalizedTool = tool.toLowerCase().replace(/-/g, "_");

      // Detect ask-user tool and handle inline
      if (normalizedTool === "ask_user") {
        codexLog.info(
          { driver: this.id, tool: normalizedTool, chatId: input.chatId },
          "Ask-user tool completed, checking for pending requests"
        );
        // Small delay to let MCP server write the file
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Retry a few times in case of timing issues
        for (let attempt = 0; attempt < 3; attempt++) {
          const buttonsSent = await checkPendingAskUserRequests(
            input.ctx,
            input.chatId
          );
          if (buttonsSent) {
            codexLog.info(
              { driver: this.id, tool: normalizedTool, chatId: input.chatId, attempt: attempt + 1 },
              "Ask-user buttons sent, ask_user triggered"
            );
            return true; // Signal to break event loop
          }
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }

      // Detect send-turtle tool and handle inline
      if (normalizedTool === "send_turtle") {
        codexLog.info(
          { driver: this.id, tool: normalizedTool, chatId: input.chatId },
          "Send-turtle tool completed, checking for pending requests"
        );
        // Small delay to let MCP server write the file
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Retry a few times in case of timing issues
        for (let attempt = 0; attempt < 3; attempt++) {
          const photoSent = await checkPendingSendTurtleRequests(
            input.ctx,
            input.chatId
          );
          if (photoSent) break;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }

      // Detect bot-control tool and handle inline
      if (normalizedTool === "bot_control") {
        codexLog.info(
          { driver: this.id, tool: normalizedTool, chatId: input.chatId },
          "Bot-control tool completed, checking for pending requests"
        );
        // Small delay to let MCP server write the file
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Retry a few times in case of timing issues
        for (let attempt = 0; attempt < 3; attempt++) {
          const handled = await checkPendingBotControlRequests(
            codexSession,
            input.chatId
          );
          if (handled) break;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }

      if (normalizedTool === "pino_logs") {
        codexLog.info(
          { driver: this.id, tool: normalizedTool, chatId: input.chatId },
          "Pino-logs tool completed, checking for pending requests"
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        for (let attempt = 0; attempt < 3; attempt++) {
          const handled = await checkPendingPinoLogsRequests(input.chatId);
          if (handled) break;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }

      return false; // Only ask-user triggers event loop break
    };

    let keepPolling = true;
    const pendingPump = (async () => {
      while (keepPolling) {
        try {
          await checkPendingAskUserRequests(input.ctx, input.chatId);
          await checkPendingSendTurtleRequests(input.ctx, input.chatId);
          await checkPendingBotControlRequests(codexSession, input.chatId);
          await checkPendingPinoLogsRequests(input.chatId);
        } catch (error) {
          codexLog.warn(
            { err: error, driver: this.id, chatId: input.chatId },
            "Failed to process pending Codex MCP request"
          );
        }
        if (keepPolling) {
          await wait(100);
        }
      }
    })();

    let response: string;
    try {
      response = await codexSession.sendMessage(
        input.message,
        input.statusCallback,
        undefined,
        undefined,
        mcpCompletionCallback,
        input.source,
        input.userId,
        input.username,
        input.chatId
      );
    } finally {
      keepPolling = false;
      await pendingPump;
    }

    // Final flush for late writes near turn completion.
    // Wait longer (300ms) and retry multiple times in case MCP server is still writing.
    await wait(300);
    for (let attempt = 0; attempt < 3; attempt++) {
      await checkPendingAskUserRequests(input.ctx, input.chatId);
      await checkPendingSendTurtleRequests(input.ctx, input.chatId);
      await checkPendingBotControlRequests(codexSession, input.chatId);
      await checkPendingPinoLogsRequests(input.chatId);
      if (attempt < 2) {
        await wait(100);
      }
    }

    return response;
  }

  async stop() {
    if (!codexSession.isRunning) {
      codexLog.info({ driver: this.id }, "Codex stop requested with no active query");
      return false;
    }

    const result = await codexSession.stop();
    if (result === "stopped") {
      await Bun.sleep(100);
      codexSession.clearStopRequested();
    } else if (result === "pending") {
      codexLog.debug(
        { driver: this.id },
        "Codex stop returned pending; preserving stopRequested for pre-run cancellation"
      );
    }
    codexLog.info({ driver: this.id, stopped: Boolean(result) }, "Codex stop completed");
    return result;
  }

  async kill(): Promise<void> {
    await codexSession.kill();
  }

  isCrashError(error: unknown): boolean {
    const errorStr = String(error).toLowerCase();
    return errorStr.includes("crashed") || errorStr.includes("failed");
  }

  isStallError(error: unknown): boolean {
    const errorStr = String(error).toLowerCase();
    return errorStr.includes("stream stalled") || errorStr.includes("event stream stalled");
  }

  isCancellationError(error: unknown): boolean {
    const errorStr = String(error).toLowerCase();
    return errorStr.includes("abort") || errorStr.includes("cancel");
  }

  getStatusSnapshot(): DriverStatusSnapshot {
    return {
      driverName: "Codex",
      isActive: codexSession.isActive,
      sessionId: codexSession.getThreadId(),
      lastActivity: codexSession.lastActivity,
      lastError: codexSession.lastError,
      lastErrorTime: codexSession.lastErrorTime,
      lastUsage: codexSession.lastUsage
        ? {
            inputTokens: codexSession.lastUsage.input_tokens || 0,
            outputTokens: codexSession.lastUsage.output_tokens || 0,
          }
        : null,
    };
  }
}
