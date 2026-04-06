import type { Context } from "grammy";
import { codexSession } from "../codex-session";
import { codexLog } from "../logger";

const DEFAULT_PENDING_REQUEST_TIMEOUT_MS = 1500;
const DEFAULT_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS = 2000;
const ASK_USER_TIMEOUT_GRACE_MS = 300;
const MCP_WRITE_SETTLE_MS = 200;
const MCP_RETRY_DELAY_MS = 100;
const MCP_RETRY_ATTEMPTS = 3;
const FINAL_FLUSH_SETTLE_MS = 300;
const FINAL_FLUSH_ATTEMPTS = 3;

type PendingCheckName =
  | "ask_user"
  | "send_file"
  | "send_image"
  | "send_turtle"
  | "bot_control"
  | "pino_logs";

type PendingCheckSet = Record<PendingCheckName, () => Promise<boolean>>;

type ToolCompletionConfig = {
  checkName: PendingCheckName;
  logMessage: string;
  breakOnHandled?: boolean;
  handledLogMessage?: string;
};

type PendingCheckResult = {
  handled: boolean;
  timedOut: boolean;
  completion: Promise<boolean>;
};

const TOOL_COMPLETION_CONFIG: Partial<Record<string, ToolCompletionConfig>> = {
  ask_user: {
    checkName: "ask_user",
    logMessage: "Ask-user tool completed, checking for pending requests",
    breakOnHandled: true,
    handledLogMessage: "Ask-user buttons sent, ask_user triggered",
  },
  send_turtle: {
    checkName: "send_turtle",
    logMessage: "Send-turtle tool completed, checking for pending requests",
  },
  send_file: {
    checkName: "send_file",
    logMessage: "Send-file tool completed, checking for pending requests",
  },
  send_image: {
    checkName: "send_image",
    logMessage: "Send-image tool completed, checking for pending requests",
  },
  bot_control: {
    checkName: "bot_control",
    logMessage: "Bot-control tool completed, checking for pending requests",
  },
  pino_logs: {
    checkName: "pino_logs",
    logMessage: "Pino-logs tool completed, checking for pending requests",
  },
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimeoutMs(envName: string, fallback: number): number {
  const raw = process.env[envName];
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 10 ? Math.floor(parsed) : fallback;
}

export function createCodexPendingOutputCoordinator(options: {
  driverId: "codex";
  chatId: number;
  checks: PendingCheckSet;
  outboundMessageKindForTool: (tool: string) => string | null;
}) {
  const pendingRequestTimeoutMs = getTimeoutMs(
    "CODEX_PENDING_REQUEST_TIMEOUT_MS",
    DEFAULT_PENDING_REQUEST_TIMEOUT_MS
  );
  const pendingPumpShutdownTimeoutMs = getTimeoutMs(
    "CODEX_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS",
    DEFAULT_PENDING_PUMP_SHUTDOWN_TIMEOUT_MS
  );

  const runPendingCheck = async (
    checkName: PendingCheckName,
    phase: string
  ): Promise<PendingCheckResult> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const completion = options.checks[checkName]().catch((error) => {
      codexLog.warn(
        { err: error, driver: options.driverId, chatId: options.chatId, checkName, phase },
        "Pending Codex output check failed"
      );
      return false;
    });

    try {
      return await Promise.race([
        completion.then((handled) => ({
          handled,
          timedOut: false,
          completion,
        })),
        new Promise<PendingCheckResult>((resolve) => {
          timeoutId = setTimeout(() => {
            codexLog.warn(
              {
                driver: options.driverId,
                chatId: options.chatId,
                checkName,
                phase,
                timeoutMs: pendingRequestTimeoutMs,
              },
              "Pending Codex output check timed out"
            );
            resolve({
              handled: false,
              timedOut: true,
              completion,
            });
          }, pendingRequestTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const flushPendingOutputs = async (phase: string): Promise<void> => {
    await Promise.all(
      (Object.keys(options.checks) as PendingCheckName[]).map((checkName) =>
        runPendingCheck(checkName, phase)
      )
    );
  };

  const waitForAskUserGraceWindow = async (
    completion: Promise<boolean>
  ): Promise<boolean> =>
    Promise.race([
      completion,
      wait(ASK_USER_TIMEOUT_GRACE_MS).then(() => false),
    ]);

  const handleToolCompletion = async (tool: string): Promise<boolean> => {
    const normalizedTool = tool.toLowerCase().replace(/-/g, "_");
    const config = TOOL_COMPLETION_CONFIG[normalizedTool];

    if (!config) {
      return false;
    }

    codexLog.info(
      {
        driver: options.driverId,
        tool: normalizedTool,
        chatId: options.chatId,
        outboundMessageKind: options.outboundMessageKindForTool(normalizedTool),
      },
      config.logMessage
    );

    await wait(MCP_WRITE_SETTLE_MS);

    for (let attempt = 0; attempt < MCP_RETRY_ATTEMPTS; attempt++) {
      const result = await runPendingCheck(
        config.checkName,
        `mcp:${normalizedTool}`
      );
      let handled = result.handled;

      if (!handled && result.timedOut && config.breakOnHandled === true) {
        handled = await waitForAskUserGraceWindow(result.completion);
        if (handled) {
          codexLog.info(
            {
              driver: options.driverId,
              tool: normalizedTool,
              chatId: options.chatId,
              attempt: attempt + 1,
              graceMs: ASK_USER_TIMEOUT_GRACE_MS,
            },
            "Ask-user pending check completed during grace window"
          );
        }
      }

      if (handled) {
        if (config.handledLogMessage) {
          codexLog.info(
            {
              driver: options.driverId,
              tool: normalizedTool,
              chatId: options.chatId,
              attempt: attempt + 1,
            },
            config.handledLogMessage
          );
        }
        return config.breakOnHandled === true;
      }

      if (attempt < MCP_RETRY_ATTEMPTS - 1) {
        await wait(MCP_RETRY_DELAY_MS);
      }
    }

    return false;
  };

  const startPump = () => {
    let keepPolling = true;
    const pendingPump = (async () => {
      while (keepPolling) {
        try {
          await flushPendingOutputs("poll");
        } catch (error) {
          codexLog.warn(
            { err: error, driver: options.driverId, chatId: options.chatId },
            "Failed to process pending Codex MCP request"
          );
        }
        if (keepPolling) {
          await wait(MCP_RETRY_DELAY_MS);
        }
      }
    })();

    return {
      stop: async (): Promise<void> => {
        keepPolling = false;
        const pendingPumpStopped = await Promise.race([
          pendingPump.then(() => true),
          wait(pendingPumpShutdownTimeoutMs).then(() => false),
        ]);
        if (!pendingPumpStopped) {
          codexLog.warn(
            {
              driver: options.driverId,
              chatId: options.chatId,
              timeoutMs: pendingPumpShutdownTimeoutMs,
            },
            "Pending Codex output pump did not stop before timeout"
          );
        }
      },
    };
  };

  const flushAfterCompletion = async (): Promise<void> => {
    await wait(FINAL_FLUSH_SETTLE_MS);
    for (let attempt = 0; attempt < FINAL_FLUSH_ATTEMPTS; attempt++) {
      await flushPendingOutputs("final_flush");
      if (attempt < FINAL_FLUSH_ATTEMPTS - 1) {
        await wait(MCP_RETRY_DELAY_MS);
      }
    }
  };

  return {
    flushAfterCompletion,
    handleToolCompletion,
    startPump,
  };
}

export function buildCodexPendingChecks(input: {
  ctx: Context;
  chatId: number;
  checkPendingAskUserRequests: (ctx: Context, chatId: number) => Promise<boolean>;
  checkPendingSendFileRequests: (ctx: Context, chatId: number) => Promise<boolean>;
  checkPendingSendImageRequests: (ctx: Context, chatId: number) => Promise<boolean>;
  checkPendingSendTurtleRequests: (ctx: Context, chatId: number) => Promise<boolean>;
  checkPendingBotControlRequests: (sessionObj: typeof codexSession, chatId: number) => Promise<boolean>;
  checkPendingPinoLogsRequests: (chatId: number) => Promise<boolean>;
}): PendingCheckSet {
  return {
    ask_user: () => input.checkPendingAskUserRequests(input.ctx, input.chatId),
    send_file: () => input.checkPendingSendFileRequests(input.ctx, input.chatId),
    send_image: () => input.checkPendingSendImageRequests(input.ctx, input.chatId),
    send_turtle: () => input.checkPendingSendTurtleRequests(input.ctx, input.chatId),
    bot_control: () => input.checkPendingBotControlRequests(codexSession, input.chatId),
    pino_logs: () => input.checkPendingPinoLogsRequests(input.chatId),
  };
}
