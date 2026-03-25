import { codexSession } from "../codex-session";
import type { ChatDriver, DriverRunInput, DriverStatusSnapshot } from "./types";
import type { McpCompletionCallback } from "../types";
import { classifyCodexToolCompletionMessage } from "../message-kinds";
import { codexLog } from "../logger";
import {
  buildCodexPendingChecks,
  createCodexPendingOutputCoordinator,
} from "./codex-pending-outputs";

export class CodexDriver implements ChatDriver {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly auditEvent = "TEXT_CODEX" as const;

  async runMessage(input: DriverRunInput): Promise<string> {
    const {
      checkPendingAskUserRequests,
      checkPendingBotControlRequests,
      checkPendingPinoLogsRequests,
      checkPendingSendFileRequests,
      checkPendingSendImageRequests,
      checkPendingSendTurtleRequests,
    } = await import("../handlers/streaming");

    process.env.TELEGRAM_CHAT_ID = String(input.chatId);
    const pendingOutputs = createCodexPendingOutputCoordinator({
      driverId: this.id,
      chatId: input.chatId,
      checks: buildCodexPendingChecks({
        ctx: input.ctx,
        chatId: input.chatId,
        checkPendingAskUserRequests,
        checkPendingSendFileRequests,
        checkPendingSendImageRequests,
        checkPendingSendTurtleRequests,
        checkPendingBotControlRequests,
        checkPendingPinoLogsRequests,
      }),
      outboundMessageKindForTool: (tool) => {
        const kind = classifyCodexToolCompletionMessage(tool);
        return kind ? String(kind) : null;
      },
    });
    const pendingPump = pendingOutputs.startPump();

    const mcpCompletionCallback: McpCompletionCallback = async (_server, tool) => {
      return pendingOutputs.handleToolCompletion(tool);
    };

    const downstreamStatusCallback = input.statusCallback;
    type DeferredDoneArgs = Parameters<NonNullable<typeof downstreamStatusCallback>>;
    let deferredDone: DeferredDoneArgs | null = null;
    const wrappedStatusCallback = downstreamStatusCallback
      ? async (...args: DeferredDoneArgs) => {
          const [statusType] = args;
          if (statusType === "done") {
            deferredDone = args;
            return;
          }
          await downstreamStatusCallback(...args);
        }
      : undefined;

    let response: string | null = null;
    let runError: unknown = null;

    try {
      response = await codexSession.sendMessage(
        input.message,
        wrappedStatusCallback,
        undefined,
        undefined,
        mcpCompletionCallback,
        input.source,
        input.userId,
        input.username,
        input.chatId
      );
    } catch (error) {
      runError = error;
    }

    let cleanupError: unknown = null;
    try {
      try {
        await pendingPump.stop();
      } catch (error) {
        cleanupError = error;
      }

      try {
        await pendingOutputs.flushAfterCompletion();
      } catch (error) {
        cleanupError ??= error;
      }

      if (deferredDone && downstreamStatusCallback) {
        try {
          await downstreamStatusCallback(
            deferredDone[0],
            deferredDone[1],
            deferredDone[2]
          );
        } catch (error) {
          cleanupError ??= error;
        }
      }
    } finally {
      if (runError) {
        if (cleanupError) {
          codexLog.warn(
            { driver: this.id, err: cleanupError, runErr: runError },
            "Codex cleanup failed after run error; preserving original error"
          );
        }
        throw runError;
      }
      if (cleanupError) {
        throw cleanupError;
      }
    }

    return response ?? "";
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
