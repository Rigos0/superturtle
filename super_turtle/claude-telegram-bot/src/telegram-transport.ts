import { run } from "@grammyjs/runner";
import { logger } from "./logger";

const transportLog = logger.child({ module: "telegram-transport" });
const HANDLED_WEBHOOK_CONFLICT_GRACE_MS = 30_000;
let lastHandledWebhookConflictAt = 0;

export type TelegramTransportMode = "polling" | "webhook" | "standby";

export type TelegramTransportConfig =
  | {
      mode: "polling";
      clearWebhookOnStart?: boolean;
      standbyOnConflict?:
        | (() =>
            | Promise<Extract<TelegramTransportConfig, { mode: "standby" }> | null>
            | Extract<TelegramTransportConfig, { mode: "standby" }>
            | null)
        | null;
    }
  | {
      mode: "standby";
      expectedRemoteWebhookUrl?: string | null;
      checkIntervalMs?: number;
      onResumePolling?: () => void | Promise<void>;
    }
  | {
      mode: "webhook";
      publicUrl: string;
      path: string;
      host: string;
      port: number;
      secretToken: string | null;
      healthPath: string;
      readyPath: string;
      registerWebhook: boolean;
    };

type TelegramBotLike = {
  api: {
    deleteWebhook(options: { drop_pending_updates: boolean }): Promise<unknown>;
    getWebhookInfo(): Promise<unknown>;
    setWebhook(
      url: string,
      options?: { secret_token?: string }
    ): Promise<unknown>;
  };
  handleUpdate(update: unknown): Promise<unknown>;
};

type PollingRunnerLike = {
  isRunning(): boolean;
  stop(): void;
  task?(): Promise<void> | undefined;
};

type WebhookServerLike = {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
};

type ServeOptions = {
  port: number;
  hostname: string;
  fetch(request: Request): Response | Promise<Response>;
};

type IntervalHandle = unknown;
type SetIntervalLike = (callback: () => void, delay: number) => IntervalHandle;
type ClearIntervalLike = (handle: IntervalHandle) => void;

type StartTelegramTransportDependencies = {
  startPollingRunner?: (bot: TelegramBotLike) => PollingRunnerLike;
  serve?: (options: ServeOptions) => WebhookServerLike;
  setInterval?: SetIntervalLike;
  clearInterval?: ClearIntervalLike;
  getReadiness?: () =>
    | Promise<{ ok: boolean; status?: number; body?: string }>
    | { ok: boolean; status?: number; body?: string };
};

export type TelegramTransportHandle = {
  mode: TelegramTransportMode;
  stop(): void | Promise<void>;
};

function parsePort(rawPort: string | undefined): number {
  if (!rawPort || rawPort.trim() === "") {
    return 3000;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid webhook port "${rawPort}".`);
  }
  return port;
}

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

export function resolveTelegramTransportConfig(
  env: Record<string, string | undefined> = process.env
): TelegramTransportConfig {
  const rawMode = env.TELEGRAM_TRANSPORT?.trim().toLowerCase() || "polling";
  if (rawMode === "polling") {
    return {
      mode: "polling",
      clearWebhookOnStart: true,
    };
  }

  if (rawMode !== "webhook") {
    throw new Error(
      `Invalid TELEGRAM_TRANSPORT="${env.TELEGRAM_TRANSPORT}". Expected "polling" or "webhook".`
    );
  }

  const webhookUrl = env.TELEGRAM_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error(
      "TELEGRAM_WEBHOOK_URL is required when TELEGRAM_TRANSPORT=webhook."
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    throw new Error(`Invalid TELEGRAM_WEBHOOK_URL="${webhookUrl}".`);
  }

  return {
    mode: "webhook",
    publicUrl: parsedUrl.toString(),
    path: parsedUrl.pathname || "/",
    host: env.TELEGRAM_WEBHOOK_HOST?.trim() || "0.0.0.0",
    port: parsePort(env.PORT || env.TELEGRAM_WEBHOOK_PORT),
    secretToken: env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
    healthPath: env.TELEGRAM_WEBHOOK_HEALTH_PATH?.trim() || "/healthz",
    readyPath: env.TELEGRAM_WEBHOOK_READY_PATH?.trim() || "/readyz",
    registerWebhook: parseBoolean(env.TELEGRAM_WEBHOOK_REGISTER, true),
  };
}

export async function handleTelegramWebhookRequest(
  request: Request,
  bot: TelegramBotLike,
  config: Extract<TelegramTransportConfig, { mode: "webhook" }>,
  dependencies: Pick<StartTelegramTransportDependencies, "getReadiness"> = {}
): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === "GET" && pathname === config.healthPath) {
    return new Response("ok", { status: 200 });
  }

  if (request.method === "GET" && pathname === config.readyPath) {
    const readiness = dependencies.getReadiness
      ? await dependencies.getReadiness()
      : { ok: true, status: 200, body: "ok" };
    return new Response(readiness.body || (readiness.ok ? "ok" : "not ready"), {
      status: readiness.ok ? readiness.status || 200 : readiness.status || 503,
    });
  }

  if (pathname !== config.path) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  if (config.secretToken) {
    const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (providedSecret !== config.secretToken) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Acknowledge webhook delivery immediately so long-running turns do not keep
  // Telegram or the public ingress waiting on the full bot execution path.
  void Promise.resolve()
    .then(() => bot.handleUpdate(update))
    .catch((error) => {
      transportLog.error({ err: error }, "Failed to process Telegram webhook update");
    });

  return new Response("OK", { status: 200 });
}

function defaultStartPollingRunner(bot: TelegramBotLike): PollingRunnerLike {
  return run(bot as never, {
    runner: {
      maxRetryTime: Infinity,
      retryInterval: "exponential",
      silent: true,
    },
  });
}

function defaultServe(options: ServeOptions): WebhookServerLike {
  return Bun.serve(options);
}

function defaultSetInterval(callback: () => void, delay: number): IntervalHandle {
  return setInterval(callback, delay);
}

function defaultClearInterval(handle: IntervalHandle): void {
  clearInterval(handle as Parameters<typeof clearInterval>[0]);
}

function normalizeWebhookUrl(info: unknown): string {
  if (!info || typeof info !== "object") {
    return "";
  }

  const record = info as { url?: unknown; result?: { url?: unknown } };
  if (typeof record.url === "string") {
    return record.url;
  }
  if (record.result && typeof record.result.url === "string") {
    return record.result.url;
  }
  return "";
}

function isTelegramWebhookConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    error_code?: unknown;
    description?: unknown;
    message?: unknown;
  };
  const code = maybeError.error_code;
  const description =
    typeof maybeError.description === "string"
      ? maybeError.description
      : typeof maybeError.message === "string"
        ? maybeError.message
        : "";

  return code === 409 && description.toLowerCase().includes("setwebhook");
}

export function shouldSuppressHandledWebhookConflict(error: unknown): boolean {
  if (!isTelegramWebhookConflict(error)) {
    return false;
  }
  return Date.now() - lastHandledWebhookConflictAt <= HANDLED_WEBHOOK_CONFLICT_GRACE_MS;
}

function rethrowTransportError(error: unknown): void {
  queueMicrotask(() => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

async function createStandbyTransport(
  bot: TelegramBotLike,
  config: Extract<TelegramTransportConfig, { mode: "standby" }>,
  dependencies: StartTelegramTransportDependencies = {}
): Promise<TelegramTransportHandle> {
  transportLog.debug(
    {
      expectedRemoteWebhookUrl: config.expectedRemoteWebhookUrl || null,
      checkIntervalMs: config.checkIntervalMs ?? 5000,
    },
    "Starting Telegram standby transport"
  );

  const startPollingRunner = dependencies.startPollingRunner || defaultStartPollingRunner;
  const setIntervalFn = dependencies.setInterval || defaultSetInterval;
  const clearIntervalFn = dependencies.clearInterval || defaultClearInterval;
  const intervalMs = Math.max(1000, config.checkIntervalMs ?? 5000);
  let runner: PollingRunnerLike | null = null;
  let stopped = false;
  let checkPromise: Promise<void> | null = null;
  let intervalHandle: IntervalHandle | null = null;

  const ensureWatching = () => {
    if (stopped || runner || intervalHandle !== null) {
      return;
    }
    intervalHandle = setIntervalFn(() => {
      void checkWebhookOwnership().catch((error) => {
        transportLog.warn({ err: error }, "Failed to reconcile Telegram standby ownership");
      });
    }, intervalMs);
  };

  const beginPolling = async () => {
    if (stopped || runner) {
      return;
    }
    await config.onResumePolling?.();
    runner = startPollingRunner(bot);
    const runnerTask = runner.task?.();
    if (runnerTask) {
      void runnerTask.catch(async (error) => {
        if (!isTelegramWebhookConflict(error)) {
          rethrowTransportError(error);
          return;
        }

        lastHandledWebhookConflictAt = Date.now();
        transportLog.debug(
          "Telegram standby transport handed polling back to standby after webhook cutover"
        );
        runner = null;
        ensureWatching();
      });
    }
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
    transportLog.debug("Telegram standby transport resumed polling");
  };

  const checkWebhookOwnership = async () => {
    if (stopped || runner || checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      const currentUrl = normalizeWebhookUrl(await bot.api.getWebhookInfo());
      if (!currentUrl) {
        await beginPolling();
        return;
      }

      if (
        config.expectedRemoteWebhookUrl &&
        currentUrl !== config.expectedRemoteWebhookUrl
      ) {
        transportLog.debug(
          {
            currentUrl,
            expectedRemoteWebhookUrl: config.expectedRemoteWebhookUrl,
          },
          "Telegram standby transport saw unexpected webhook owner; staying idle"
        );
      }
    })();

    try {
      await checkPromise;
    } finally {
      checkPromise = null;
    }
  };

  try {
    await checkWebhookOwnership();
  } catch (error) {
    transportLog.warn({ err: error }, "Initial standby ownership check failed; continuing to watch");
  }

  ensureWatching();

  return {
    mode: "standby",
    stop() {
      stopped = true;
      if (intervalHandle !== null) {
        clearIntervalFn(intervalHandle);
        intervalHandle = null;
      }
      if (runner?.isRunning()) {
        runner.stop();
      }
    },
  };
}

export async function startTelegramTransport(
  bot: TelegramBotLike,
  config: TelegramTransportConfig = resolveTelegramTransportConfig(),
  dependencies: StartTelegramTransportDependencies = {}
): Promise<TelegramTransportHandle> {
  if (config.mode === "polling") {
    transportLog.info("Starting Telegram polling transport");
    if (config.clearWebhookOnStart !== false) {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    }

    const runner = (dependencies.startPollingRunner || defaultStartPollingRunner)(bot);
    let fallbackTransport: TelegramTransportHandle | null = null;
    const runnerTask = runner.task?.();
    if (runnerTask) {
      void runnerTask.catch(async (error) => {
        if (!config.standbyOnConflict || !isTelegramWebhookConflict(error)) {
          rethrowTransportError(error);
          return;
        }

        try {
          const standbyConfig = await config.standbyOnConflict();
          if (!standbyConfig) {
            rethrowTransportError(error);
            return;
          }

          transportLog.debug("Telegram polling transport handed off to standby after webhook cutover");
          lastHandledWebhookConflictAt = Date.now();
          fallbackTransport = await createStandbyTransport(bot, standbyConfig, dependencies);
        } catch (standbyError) {
          rethrowTransportError(standbyError);
        }
      });
    }

    return {
      mode: "polling",
      stop() {
        if (fallbackTransport) {
          return fallbackTransport.stop();
        }
        if (runner.isRunning()) {
          runner.stop();
        }
      },
    };
  }

  if (config.mode === "standby") {
    return createStandbyTransport(bot, config, dependencies);
  }

  transportLog.info("Starting Telegram webhook transport");
  transportLog.debug(
    {
      publicUrl: config.publicUrl,
      host: config.host,
      port: config.port,
      path: config.path,
    },
    "Telegram webhook transport details"
  );

  if (config.registerWebhook) {
    const webhookOptions = config.secretToken
      ? { secret_token: config.secretToken }
      : undefined;
    await bot.api.setWebhook(config.publicUrl, webhookOptions);
  }

  const server = (dependencies.serve || defaultServe)({
    port: config.port,
    hostname: config.host,
    fetch(request) {
      return handleTelegramWebhookRequest(request, bot, config, {
        getReadiness: dependencies.getReadiness,
      });
    },
  });

  return {
    mode: "webhook",
    stop() {
      return server.stop(true);
    },
  };
}
