import { session } from "../session";
import type { ChatDriver, DriverRunInput, DriverStatusSnapshot } from "./types";
import { claudeLog } from "../logger";

export class ClaudeDriver implements ChatDriver {
  readonly id = "claude" as const;
  readonly displayName = "Claude";
  readonly auditEvent = "TEXT" as const;

  async runMessage(input: DriverRunInput): Promise<string> {
    const startedAt = Date.now();
    const logContext = {
      driver: this.id,
      userId: input.userId,
      username: input.username,
      chatId: input.chatId,
      sessionId: session.sessionId,
    };

    claudeLog.info(logContext, "Starting Claude driver message run");

    try {
      const response = await session.sendMessageStreaming(
        input.message,
        input.username,
        input.userId,
        input.statusCallback,
        input.chatId,
        input.ctx
      );
      claudeLog.info(
        { ...logContext, elapsed: Date.now() - startedAt, sessionId: session.sessionId },
        "Completed Claude driver message run"
      );
      return response;
    } catch (error) {
      claudeLog.error(
        { ...logContext, err: error, elapsed: Date.now() - startedAt },
        "Claude driver message run failed"
      );
      throw error;
    }
  }

  async stop() {
    if (!session.isRunning) {
      claudeLog.info({ driver: this.id }, "Claude stop requested with no active query");
      return false;
    }

    const result = await session.stop();
    if (result === "stopped") {
      await Bun.sleep(100);
      session.clearStopRequested();
    } else if (result === "pending") {
      claudeLog.debug(
        { driver: this.id },
        "Claude stop returned pending; preserving stopRequested for pre-spawn cancellation"
      );
    }
    claudeLog.info({ driver: this.id, stopped: Boolean(result) }, "Claude stop completed");
    return result;
  }

  async kill(): Promise<void> {
    claudeLog.warn({ driver: this.id }, "Killing Claude driver session");
    await session.kill();
  }

  isCrashError(error: unknown): boolean {
    return String(error).includes("exited with code");
  }

  isStallError(error: unknown): boolean {
    return String(error).toLowerCase().includes("event stream stalled");
  }

  isCancellationError(error: unknown): boolean {
    const errorStr = String(error).toLowerCase();
    return errorStr.includes("abort") || errorStr.includes("cancel");
  }

  getStatusSnapshot(): DriverStatusSnapshot {
    return {
      driverName: "Claude",
      isActive: session.isActive,
      sessionId: session.sessionId,
      lastActivity: session.lastActivity,
      lastError: session.lastError,
      lastErrorTime: session.lastErrorTime,
      lastUsage: session.lastUsage
        ? {
            inputTokens: session.lastUsage.input_tokens || 0,
            outputTokens: session.lastUsage.output_tokens || 0,
            cacheReadInputTokens: session.lastUsage.cache_read_input_tokens,
          }
        : null,
    };
  }
}
