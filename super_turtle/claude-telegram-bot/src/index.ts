/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import type { Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { basename, dirname } from "path";
import {
  WORKING_DIR,
  CTL_PATH,
  ALLOWED_USERS,
  RESTART_FILE,
  CLAUDE_CLI_AVAILABLE,
  CODEX_AVAILABLE,
  CODEX_CLI_AVAILABLE,
  CODEX_USER_ENABLED,
  SUPERTURTLE_REMOTE_MODE,
  TOKEN_PREFIX,
  IPC_DIR,
  SUPERTURTLE_DATA_DIR,
  SUPERTURTLE_RUNTIME_ROLE,
  TURTLE_GREETINGS_ENABLED,
  getCodexUnavailableReason,
} from "./config";
import { unlinkSync, readFileSync, existsSync, writeFileSync, openSync, closeSync, mkdirSync } from "fs";
import {
  handleNew,
  handleStatus,
  handleLooplogs,
  handleUsage,
  handleContext,
  handleModel,
  handleSwitch,
  handleResume,
  handleSubturtle,
  handleCron,
  handleDebug,
  handleRestart,
  handleStopCommand,
  handleTeleport,
  handleHome,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";
import { resetAllDriverSessions, syncLiveSubturtleBoard } from "./handlers/commands";
import { handlePinologs } from "./handlers/commands";
import { TELEGRAM_COMMANDS } from "./handlers/commands";
import { enqueueBusyDeferredCronJob, pruneQueuedDueCronJobIds } from "./cron-deferred-queue";
import { isCronJobQueued } from "./deferred-queue";
import { drainDeferredQueue } from "./deferred-queue-runtime";
import { session } from "./session";
import { codexSession } from "./codex-session";
import { getDueJobs, getJobs, advanceRecurringJob, removeJob } from "./cron";
import { bot } from "./bot";
import { startDashboardServer } from "./dashboard";
import {
  beginBackgroundRun,
  endBackgroundRun,
  isAnyDriverRunning,
  isBackgroundRunActive,
  isLikelyCancellationError,
  isLikelyQuotaOrLimitError,
  preemptBackgroundRunForUserPriority,
  runMessageWithDriver,
  wasBackgroundRunPreempted,
} from "./handlers/driver-routing";
import { StreamingState, createSilentStatusCallback } from "./handlers/streaming";
import { getSilentNotificationText } from "./silent-notifications";
import type { DriverId } from "./drivers/types";
import type { CronJob } from "./cron";
import {
  dequeuePreparedSnapshot,
  getPreparedSnapshotCount,
} from "./cron-supervision-queue";
import { executeNonSilentCronJob } from "./cron-execution";
import { UpdateDedupeCache } from "./update-dedupe";
import { startTurtleGreetings } from "./turtle-greetings";
import {
  cleanupStaleRecurringSubturtleCron,
  processSilentSubturtleSupervision,
} from "./conductor-supervisor";
import { runConductorMaintenance } from "./conductor-maintenance";
import {
  buildPreparedSnapshotPrompt,
} from "./conductor-snapshot";
import { botLog, cronLog, eventLog } from "./logger";
import { getSequentializationKey } from "./update-sequencing";
import { buildStartupNotificationMessage } from "./startup-notifications";
import {
  shouldSuppressHandledWebhookConflict,
  startTelegramTransport,
  type TelegramTransportConfig,
} from "./telegram-transport";
import { startSubturtleBoardService } from "./subturtle-board-service";
import {
  getTeleportRemoteUnsupportedMessage,
  isTeleportRemoteAgentMode,
  isTeleportRemoteControlMode,
  loadTeleportStateForCurrentProject,
  reconcileTeleportOwnershipForCurrentProject,
  TELEPORT_REMOTE_AGENT_ALLOWED_COMMANDS,
  TELEPORT_REMOTE_CONTROL_ALLOWED_COMMANDS,
} from "./teleport";

// Re-export for any existing consumers
export { bot };

// Use bot token prefix in lock file so multiple bots can run on one machine
const INSTANCE_LOCK_FILE = `/tmp/claude-telegram-bot.${TOKEN_PREFIX}.instance.lock`;
const telegramUpdateDedupe = new UpdateDedupeCache();

function acquireInstanceLockOrExit(): () => void {
  const thisPid = process.pid;

  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const writeLock = () => {
    const fd = openSync(INSTANCE_LOCK_FILE, "wx");
    writeFileSync(fd, String(thisPid));
    closeSync(fd);
  };

  try {
    writeLock();
  } catch {
    let holderPid = Number.NaN;
    try {
      holderPid = Number.parseInt(readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim(), 10);
    } catch {
      // unreadable lockfile - retry with overwrite semantics below
    }

    if (Number.isFinite(holderPid) && holderPid > 0 && isPidAlive(holderPid)) {
      botLog.error(
        `[startup] Another bot instance is already running (PID ${holderPid}). Exiting to avoid Telegram getUpdates 409 conflict.`
      );
      process.exit(1);
    }

    // stale lock; replace it
    try { unlinkSync(INSTANCE_LOCK_FILE); } catch {}
    writeLock();
  }

  const release = () => {
    try {
      const holderPid = Number.parseInt(readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim(), 10);
      if (holderPid === thisPid) {
        unlinkSync(INSTANCE_LOCK_FILE);
      }
    } catch {
      // ignore cleanup failures
    }
  };

  return release;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeCronError(error: unknown): string {
  const message = getErrorMessage(error)
    .replace(/\s+/g, " ")
    .trim();
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

async function sendStartupNotifications(): Promise<void> {
  if (ALLOWED_USERS.length === 0 || SUPERTURTLE_RUNTIME_ROLE === "teleport-remote") {
    return;
  }

  const projectName = basename(WORKING_DIR);
  const text = buildStartupNotificationMessage({
    projectName,
    driver: session.activeDriver,
  });
  const uniqueChatIds = [...new Set(ALLOWED_USERS)];

  await Promise.all(uniqueChatIds.map(async (chatId) => {
    try {
      await bot.api.sendMessage(chatId, text);
    } catch (error) {
      botLog.warn({ err: error, chatId }, "Failed to send startup notification");
    }
  }));
}

function isAllowedInteractiveUpdate(ctx: import("grammy").Context): boolean {
  const userId = ctx.from?.id;
  if (!userId || !ALLOWED_USERS.includes(userId)) {
    return false;
  }
  return Boolean(ctx.message || ctx.callbackQuery);
}

function extractLegacyCheckedSubturtleName(prompt: string): string | null {
  const match = prompt.match(/^\[SILENT CHECK-IN\]\s+Check SubTurtle\s+([a-zA-Z0-9._-]+):/m);
  return match?.[1] || null;
}

function resolveSubturtleSupervisionTarget(
  job: Pick<CronJob, "prompt" | "silent" | "job_kind" | "worker_name" | "supervision_mode">
): { workerName: string; mode: "silent" | null } | null {
  if (job.job_kind === "subturtle_supervision" && typeof job.worker_name === "string") {
    const workerName = job.worker_name.trim();
    if (workerName.length > 0) {
      return {
        workerName,
        mode: job.supervision_mode || (job.silent ? "silent" : null),
      };
    }
  }

  const legacyWorkerName = extractLegacyCheckedSubturtleName(job.prompt);
  if (!legacyWorkerName) {
    return null;
  }
  return {
    workerName: legacyWorkerName,
    mode: "silent",
  };
}

function isSubturtleRunning(name: string): boolean {
  const proc = Bun.spawnSync([CTL_PATH, "status", name], { cwd: WORKING_DIR });
  const output = proc.stdout.toString();
  return output.includes("running as");
}

function resolveSilentSubturtleSupervisorWorker(
  job: Pick<CronJob, "prompt" | "silent" | "job_kind" | "worker_name" | "supervision_mode">
): string | null {
  if (!job.silent) return null;
  const target = resolveSubturtleSupervisionTarget(job);
  if (!target) return null;
  return target.workerName;
}

function refreshConductorHandoff(): void {
  const proc = Bun.spawnSync(
    [
      "python3",
      "-m",
      "super_turtle.state.run_state_writer",
      "--state-dir",
      `${SUPERTURTLE_DATA_DIR}/state`,
      "refresh-handoff-from-conductor",
    ],
    {
      cwd: WORKING_DIR,
      env: {
        ...process.env,
        SUPER_TURTLE_PROJECT_DIR: WORKING_DIR,
        CLAUDE_WORKING_DIR: WORKING_DIR,
        PYTHONPATH: `${dirname(SUPER_TURTLE_DIR)}:${process.env.PYTHONPATH ?? ""}`,
      },
    }
  );

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    cronLog.warn(
      {
        exitCode: proc.exitCode,
        stderr: stderr || undefined,
      },
      "Failed to refresh conductor handoff"
    );
  }
}

async function syncTelegramCommands(): Promise<void> {
  try {
    await bot.api.deleteMyCommands();
    await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
    botLog.info({ count: TELEGRAM_COMMANDS.length }, "Registered Telegram slash commands");
  } catch (error) {
    botLog.warn({ err: error }, "Failed to register Telegram slash commands");
  }
}

async function runConductorMaintenancePass(
  options: { recoverInFlightWakeups?: boolean } = {}
): Promise<void> {
  const maintenanceResult = await runConductorMaintenance({
    recoverInFlightWakeups: options.recoverInFlightWakeups,
    listJobs: getJobs,
    removeJob,
    sendMessage: async (chatId, text) => {
      await bot.api.sendMessage(chatId, text);
    },
    isWorkerRunning: (workerName: string) => isSubturtleRunning(workerName),
  });

  if (
    maintenanceResult.requeuedWakeups > 0 ||
    maintenanceResult.recoveredWakeups > 0 ||
    maintenanceResult.staleCronRemoved > 0 ||
    maintenanceResult.sent > 0 ||
    maintenanceResult.reconciled > 0 ||
    maintenanceResult.errors > 0
  ) {
    refreshConductorHandoff();
    cronLog.info(
      { maintenanceResult },
      `[conductor] requeued_wakeups=${maintenanceResult.requeuedWakeups} recovered_wakeups=${maintenanceResult.recoveredWakeups} stale_cron_removed=${maintenanceResult.staleCronRemoved} sent=${maintenanceResult.sent} reconciled=${maintenanceResult.reconciled} errors=${maintenanceResult.errors} skipped=${maintenanceResult.skipped}`
    );
  }
}

async function drainPreparedSnapshotsWhenIdle(): Promise<void> {
  if (ALLOWED_USERS.length === 0) return;
  if (isAnyDriverRunning()) return;
  while (!isAnyDriverRunning()) {
    const snapshot = dequeuePreparedSnapshot();
    if (!snapshot) break;

    const cronCtx = createCronTimerContext(
      {
        chatId: snapshot.chatId,
        userId: ALLOWED_USERS[0]!,
      },
      ""
    );

    const primaryDriver: DriverId = session.activeDriver;
    const fallbackDriver: DriverId = primaryDriver === "codex" ? "claude" : "codex";
    const state = new StreamingState();
    const statusCallback = createSilentStatusCallback(cronCtx, state);
    let response = "";

    beginBackgroundRun();
    try {
      if (wasBackgroundRunPreempted()) {
        cronLog.info(
          { cronJobId: snapshot.jobId, action: "snapshot_skip_pre_start" },
          `[snapshot:${snapshot.jobId}] skipped before start due to user-priority preemption`
        );
        continue;
      }

      try {
        response = await runMessageWithDriver(primaryDriver, {
          message: buildPreparedSnapshotPrompt(snapshot),
          source: "background_snapshot",
          username: "cron",
          userId: ALLOWED_USERS[0]!,
          chatId: snapshot.chatId,
          ctx: cronCtx,
          statusCallback,
        });
      } catch (error) {
        if (!isLikelyQuotaOrLimitError(error)) {
          throw error;
        }
        response = await runMessageWithDriver(fallbackDriver, {
          message: buildPreparedSnapshotPrompt(snapshot),
          source: "background_snapshot",
          username: "cron",
          userId: ALLOWED_USERS[0]!,
          chatId: snapshot.chatId,
          ctx: cronCtx,
          statusCallback,
        });
      }

      const notificationText = getSilentNotificationText(state.getSilentCapturedText(), response);
      if (notificationText) {
        await bot.api.sendMessage(snapshot.chatId, notificationText);
      }
    } catch (error) {
      if (wasBackgroundRunPreempted() && isLikelyCancellationError(error)) {
        cronLog.info(
          { cronJobId: snapshot.jobId, action: "snapshot_preempted" },
          `[snapshot:${snapshot.jobId}] preempted by interactive update`
        );
        continue;
      }
      const errorSummary = summarizeCronError(error);
      await bot.api.sendMessage(
        snapshot.chatId,
        `❌ Background check failed (${snapshot.jobId}).\n${errorSummary}`
      );
    } finally {
      endBackgroundRun();
    }
  }
}

function createCronTimerContext(
  target: { chatId: number; userId: number },
  text: string
): Context {
  return ({
    from: { id: target.userId, username: "cron", is_bot: false, first_name: "Cron" },
    chat: { id: target.chatId, type: "private" },
    message: {
      text,
      message_id: 0,
      date: Math.floor(Date.now() / 1000),
      chat: { id: target.chatId, type: "private" },
    },
    reply: async (replyText: string, opts?: unknown) => {
      return bot.api.sendMessage(target.chatId, replyText, opts as Parameters<typeof bot.api.sendMessage>[2]);
    },
    replyWithChatAction: async (action: string) => {
      await bot.api.sendChatAction(target.chatId, action as Parameters<typeof bot.api.sendChatAction>[1]);
    },
    replyWithSticker: async (sticker: unknown) => {
      // @ts-expect-error minimal shim for sticker sending
      return bot.api.sendSticker(target.chatId, sticker);
    },
    api: bot.api,
  }) as unknown as Context;
}

async function drainDeferredQueueWhenIdle(): Promise<void> {
  const resolvedUserId = ALLOWED_USERS[0];
  if (resolvedUserId === undefined || isAnyDriverRunning()) {
    return;
  }

  await drainDeferredQueue(
    createCronTimerContext(
      {
        chatId: resolvedUserId,
        userId: resolvedUserId,
      },
      ""
    ),
    resolvedUserId
  );
}

// Drop duplicate Telegram updates before any handler side effects run.
bot.use(async (ctx, next) => {
  if (!telegramUpdateDedupe.isDuplicateUpdate(ctx.update)) {
    await next();
    return;
  }

  if (ctx.callbackQuery) {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // ignore duplicate callback ack errors
    }
  }
});

// Canonical command ingress events for replay/debug.
// Logs both /slash commands and bare-word commands (e.g. "status").
// Note: bare-word commands are also logged in the bot.hears() handler below,
// but this middleware catches slash commands early in the pipeline.
bot.use(async (ctx, next) => {
  const text = ctx.message?.text;
  if (text?.startsWith("/")) {
    eventLog.info({
      event: "user.command",
      userId: ctx.from?.id,
      username: ctx.from?.username || "unknown",
      chatId: ctx.chat?.id,
      command: text.split(/\s+/)[0],
      rawLength: text.length,
    });
  }
  await next();
});

// User updates should preempt low-priority cron/background work.
bot.use(async (ctx, next) => {
  if (isAllowedInteractiveUpdate(ctx) && isBackgroundRunActive()) {
    const interrupted = await preemptBackgroundRunForUserPriority();
    if (interrupted) {
      botLog.info("Preempted background run to prioritize interactive user update");
    }
  }
  await next();
});

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    return getSequentializationKey({
      text: ctx.message?.text,
      hasVoice: Boolean(ctx.message?.voice),
      hasCallbackQuery: Boolean(ctx.callbackQuery),
      chatId: ctx.chat?.id,
      // If a turn is already active, bypass runner-level sequencing so the
      // handler can immediately show the queued acknowledgement.
      isBusy: isAnyDriverRunning() || isBackgroundRunActive(),
      isBareCommand: (text) => matchBareCommand(text) !== null,
    });
  })
);

// ============== Command Handlers ==============

/**
 * Map of bare command names (lowercase) to their handlers.
 * Used for both slash commands AND bare-word matching (e.g. "status" = "/status").
 */
const COMMAND_HANDLERS: Record<string, (ctx: Context) => Promise<void> | void> = {
  new: handleNew,
  stop: handleStopCommand,
  status: handleStatus,
  looplogs: handleLooplogs,
  pinologs: handlePinologs,
  usage: handleUsage,
  context: handleContext,
  model: handleModel,
  switch: handleSwitch,
  resume: handleResume,
  sub: handleSubturtle,
  subs: handleSubturtle,
  subturtle: handleSubturtle,
  subturtles: handleSubturtle,
  turtle: handleSubturtle,
  turtles: handleSubturtle,
  cron: handleCron,
  debug: handleDebug,
  teleport: handleTeleport,
  home: handleHome,
  restart: handleRestart,
};

/** Set of all bare command names for fast lookup. */
export const BARE_COMMAND_NAMES = new Set(Object.keys(COMMAND_HANDLERS));

/**
 * Check if text is a bare command word (case-insensitive, exact match after trim).
 * Returns the lowercase command name if matched, null otherwise.
 */
export function matchBareCommand(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  return BARE_COMMAND_NAMES.has(normalized) ? normalized : null;
}

function getCommandNameFromText(text: string | undefined): string | null {
  if (!text) return null;
  if (text.startsWith("/")) {
    const slashCommand = text
      .trim()
      .slice(1)
      .split(/\s+/)[0]
      ?.split("@")[0]
      ?.toLowerCase();
    return slashCommand || null;
  }
  return matchBareCommand(text);
}

// Register slash commands
for (const [name, handler] of Object.entries(COMMAND_HANDLERS)) {
  bot.command(name, handler);
}

bot.use(async (ctx, next) => {
  if (SUPERTURTLE_RUNTIME_ROLE !== "teleport-remote") {
    await next();
    return;
  }

  const commandName = getCommandNameFromText(ctx.message?.text);
  if (!commandName) {
    await next();
    return;
  }

  if (commandName === "teleport") {
    await ctx.reply("ℹ️ Already running in E2B webhook mode. Use /home to return ownership to your PC.");
    return;
  }

  const allowedCommands = isTeleportRemoteAgentMode()
    ? TELEPORT_REMOTE_AGENT_ALLOWED_COMMANDS
    : TELEPORT_REMOTE_CONTROL_ALLOWED_COMMANDS;

  if (!allowedCommands.has(commandName)) {
    await ctx.reply(getTeleportRemoteUnsupportedMessage());
    return;
  }

  await next();
});

// ============== Message Handlers ==============

// Bare-word command matching (e.g. "status" works like "/status").
// Case-insensitive, exact match only — "restart now" won't match.
// Uses bot.hears() so it runs before the generic text handler.
const bareCommandPattern = new RegExp(
  `^\\s*(${[...BARE_COMMAND_NAMES].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`,
  "i"
);
bot.hears(bareCommandPattern, (ctx) => {
  const matched = matchBareCommand(ctx.message?.text ?? "");
  if (matched) {
    // Log as a command so audit trail is consistent
    eventLog.info({
      event: "user.command",
      userId: ctx.from?.id,
      username: ctx.from?.username || "unknown",
      chatId: ctx.chat?.id,
      command: `/${matched}`,
      rawLength: ctx.message?.text?.length ?? 0,
      bareWord: true,
    });
    return COMMAND_HANDLERS[matched]!(ctx);
  }
});

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// Audio messages
bot.on("message:audio", handleAudio);

// Video messages (regular videos and video notes)
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  botLog.error({ err }, "Bot error");
});

// ============== Cron Timer Loop ==============

/**
 * Timer loop that checks for due cron jobs every 10 seconds.
 * Non-silent jobs are routed through handleText (same path as user text),
 * except BOT_MESSAGE_ONLY jobs which are sent directly to Telegram.
 * Silent jobs run in the background and only notify Telegram if the captured
 * assistant response contains marker events (completion/error/milestone, etc.).
 * The job is removed/advanced BEFORE execution so a crash never causes retries.
 * Failures are logged and reported to Telegram (no retry).
 */
const startCronTimer = () => {
  const BOT_MESSAGE_ONLY_PREFIX = "BOT_MESSAGE_ONLY:";
  let cronTickInFlight = false;
  const queuedDueCronJobIds = new Set<string>();

  setInterval(async () => {
    if (cronTickInFlight) {
      cronLog.info("[cron] skipped overlapping timer tick because the previous tick is still running");
      return;
    }
    cronTickInFlight = true;
    try {
      await runConductorMaintenancePass();

      const dueJobs = getDueJobs();
      const resolvedChatId = ALLOWED_USERS[0];
      if (resolvedChatId !== undefined) {
        pruneQueuedDueCronJobIds(
          resolvedChatId,
          new Set(dueJobs.map((job) => job.id)),
          queuedDueCronJobIds
        );
      }
      if (dueJobs.length === 0) {
        await drainDeferredQueueWhenIdle();
        await drainPreparedSnapshotsWhenIdle();
        return;
      }

      for (const job of dueJobs) {
        const supervisedWorkerName = resolveSilentSubturtleSupervisorWorker(job);

        // Bail if no allowed users are configured — can't authenticate
        if (ALLOWED_USERS.length === 0) {
          cronLog.error({ cronJobId: job.id }, `Cron job ${job.id} skipped: ALLOWED_USERS is empty`);
          continue;
        }
        // Single-chat bot: always use the first allowed user as chat target
        const resolvedUserId = ALLOWED_USERS[0]!;
        const resolvedChatId: number = resolvedUserId;

        try {
          if (supervisedWorkerName) {
            if (job.type === "recurring") {
              advanceRecurringJob(job.id);
            } else {
              removeJob(job.id);
            }
            const supervisionResult = await processSilentSubturtleSupervision({
              workerName: supervisedWorkerName,
              chatId: resolvedChatId,
              defaultChatId: resolvedChatId,
              listJobs: getJobs,
              removeJob,
              sendMessage: async (chatId, text) => {
                await bot.api.sendMessage(chatId, text);
              },
              isWorkerRunning: (workerName: string) => isSubturtleRunning(workerName),
            });
            if (
              supervisionResult.sent > 0 ||
              supervisionResult.reconciled > 0 ||
              supervisionResult.createdWakeups > 0
            ) {
              refreshConductorHandoff();
              cronLog.info(
                {
                  cronJobId: job.id,
                  workerName: supervisedWorkerName,
                  supervisionResult,
                },
                `[cron:${job.id}] deterministic_subturtle_supervision worker=${supervisedWorkerName} sent=${supervisionResult.sent} created_wakeups=${supervisionResult.createdWakeups}`
              );
            }
            if (job.type === "recurring") {
              const staleCleanup = await cleanupStaleRecurringSubturtleCron({
                workerName: supervisedWorkerName,
                jobId: job.id,
                chatId: resolvedChatId,
                listJobs: getJobs,
                removeJob,
                sendMessage: async (chatId, text) => {
                  await bot.api.sendMessage(chatId, text);
                },
                isWorkerRunning: (workerName: string) => isSubturtleRunning(workerName),
              });
              if (staleCleanup.removed || staleCleanup.reconciled > 0) {
                refreshConductorHandoff();
              }
            }
            try {
              await syncLiveSubturtleBoard(bot.api, resolvedChatId, {
                pin: true,
                disableNotification: true,
              });
            } catch (error) {
              cronLog.warn(
                { err: error, cronJobId: job.id, workerName: supervisedWorkerName, chatId: resolvedChatId },
                "Failed to refresh live SubTurtle board"
              );
            }
            continue;
          }

          if (job.prompt.startsWith(BOT_MESSAGE_ONLY_PREFIX)) {
            if (job.type === "recurring") {
              advanceRecurringJob(job.id);
            } else {
              removeJob(job.id);
            }
            const message = job.prompt.slice(BOT_MESSAGE_ONLY_PREFIX.length);
            if (message.trim().length === 0) {
              cronLog.warn({ cronJobId: job.id }, `Cron job ${job.id} skipped: BOT_MESSAGE_ONLY payload is empty`);
              continue;
            }
            await bot.api.sendMessage(resolvedChatId, message);
            continue;
          }

          if (job.silent) {
            if (isAnyDriverRunning()) {
              continue;
            }
          } else {
            if (isCronJobQueued(resolvedChatId, job.id)) {
              continue;
            }

            if (isAnyDriverRunning()) {
              const queued = enqueueBusyDeferredCronJob(
                resolvedChatId,
                job,
                queuedDueCronJobIds
              );
              if (queued) {
                cronLog.info(
                  {
                    cronJobId: job.id,
                    chatId: resolvedChatId,
                    action: "cron_deferred_while_busy",
                  },
                  `[cron:${job.id}] queued non-silent cron job because a driver is active`
                );
              }
              continue;
            }

            queuedDueCronJobIds.delete(job.id);
          }

          if (job.type === "recurring") {
            advanceRecurringJob(job.id);
          } else {
            removeJob(job.id);
          }

          if (job.silent) {
            const cronCtx = createCronTimerContext(
              {
                chatId: resolvedChatId,
                userId: resolvedUserId,
              },
              job.prompt
            );
            beginBackgroundRun();
            try {
              if (wasBackgroundRunPreempted()) {
                cronLog.info(
                  { cronJobId: job.id, action: "cron_skip_pre_start" },
                  `[cron:${job.id}] skipped before start due to user-priority preemption`
                );
                continue;
              }

              const primaryDriver: DriverId = session.activeDriver;
              const fallbackDriver: DriverId = primaryDriver === "codex" ? "claude" : "codex";
              const state = new StreamingState();
              const statusCallback = createSilentStatusCallback(cronCtx, state);

              let response = "";
              let driverUsed: DriverId = primaryDriver;
              let fallbackAttempted = false;

              try {
                response = await runMessageWithDriver(primaryDriver, {
                  message: job.prompt,
                  source: "cron_silent",
                  username: "cron",
                  userId: resolvedUserId,
                  chatId: resolvedChatId,
                  ctx: cronCtx,
                  statusCallback,
                });
              } catch (error) {
                if (!isLikelyQuotaOrLimitError(error)) {
                  throw error;
                }
                fallbackAttempted = true;
                response = await runMessageWithDriver(fallbackDriver, {
                  message: job.prompt,
                  source: "cron_silent",
                  username: "cron",
                  userId: resolvedUserId,
                  chatId: resolvedChatId,
                  ctx: cronCtx,
                  statusCallback,
                });
                driverUsed = fallbackDriver;
              }

              cronLog.info(
                {
                  cronJobId: job.id,
                  driverUsed,
                  primaryDriver,
                  fallbackAttempted,
                },
                `[cron:${job.id}] primary_driver=${primaryDriver} fallback_attempted=${fallbackAttempted} driver_used=${driverUsed}`
              );

              const notificationText = getSilentNotificationText(state.getSilentCapturedText(), response);
              if (notificationText) {
                await bot.api.sendMessage(resolvedChatId, notificationText);
              }

              const subturtleTarget = resolveSubturtleSupervisionTarget(job);
              const subturtleName = subturtleTarget?.workerName || null;
              if (subturtleName && job.type === "recurring") {
                const staleCleanup = await cleanupStaleRecurringSubturtleCron({
                  workerName: subturtleName,
                  jobId: job.id,
                  chatId: resolvedChatId,
                  listJobs: getJobs,
                  removeJob,
                  sendMessage: async (chatId, text) => {
                    await bot.api.sendMessage(chatId, text);
                  },
                  isWorkerRunning: (workerName: string) => isSubturtleRunning(workerName),
                });
                if (staleCleanup.removed || staleCleanup.reconciled > 0) {
                  refreshConductorHandoff();
                }
              }
            } catch (error) {
              if (
                wasBackgroundRunPreempted() &&
                isLikelyCancellationError(error)
              ) {
                cronLog.info(
                  { cronJobId: job.id, action: "cron_preempted" },
                  `[cron:${job.id}] preempted by interactive update`
                );
                continue;
              }
              throw error;
            } finally {
              endBackgroundRun();
            }
          } else {
            await executeNonSilentCronJob(
              {
                id: job.id,
                prompt: job.prompt,
              },
              {
                chatId: resolvedChatId,
                userId: resolvedUserId,
              }
            );
          }
        } catch (error) {
          // No retries — report failure and continue with future jobs
          const errorSummary = summarizeCronError(error);
          cronLog.error({ cronJobId: job.id, err: error }, `Cron job ${job.id} failed (no retry): ${errorSummary}`);

          if (resolvedChatId) {
            try {
              const quotaHint = isLikelyQuotaOrLimitError(errorSummary)
                ? "\nLikely cause: selected meta-agent driver hit a usage/quota limit."
                : "";
              await bot.api.sendMessage(
                resolvedChatId,
                `❌ Scheduled job failed (${job.id}).\n${errorSummary}${quotaHint}`
              );
            } catch (notifyError) {
              const notifySummary = summarizeCronError(notifyError);
              cronLog.error(
                { cronJobId: job.id, err: notifyError },
                `Failed to notify Telegram about cron error for ${job.id}: ${notifySummary}`
              );
            }
          }
        }
      }
      await drainDeferredQueueWhenIdle();
      await drainPreparedSnapshotsWhenIdle();
    } catch (error) {
      cronLog.error({ err: error }, "Cron timer loop error");
    } finally {
      cronTickInFlight = false;
    }
  }, 10000); // 10 seconds
};

// ============== Startup ==============

botLog.info({ workingDir: WORKING_DIR }, `Working directory: ${WORKING_DIR}`);
botLog.info({ allowedUsers: ALLOWED_USERS.length }, `Allowed users: ${ALLOWED_USERS.length}`);
botLog.info(
  {
    claudeCli: CLAUDE_CLI_AVAILABLE,
    codexPref: CODEX_USER_ENABLED,
    codexCli: CODEX_CLI_AVAILABLE,
    codexAvailable: CODEX_AVAILABLE,
  },
  `Driver capabilities: claude_cli=${CLAUDE_CLI_AVAILABLE} codex_pref=${CODEX_USER_ENABLED} codex_cli=${CODEX_CLI_AVAILABLE} codex_available=${CODEX_AVAILABLE}`
);
botLog.info("Starting bot...");

if (!CLAUDE_CLI_AVAILABLE && SUPERTURTLE_RUNTIME_ROLE !== "teleport-remote") {
  botLog.error(
    "Claude CLI is required for the meta-agent runtime. Install Claude Code or set CLAUDE_CLI_PATH."
  );
  process.exit(1);
}

if (isTeleportRemoteControlMode()) {
  botLog.warn(
    "Starting in teleport-remote control mode. Text prompts and agent-driving commands are disabled."
  );
}
if (isTeleportRemoteAgentMode()) {
  if (!CODEX_AVAILABLE) {
    botLog.error(
      `Remote agent mode requires Codex inside E2B. ${getCodexUnavailableReason() || "Codex is unavailable."}`
    );
    process.exit(1);
  }
  session.activeDriver = "codex";
  botLog.info("Starting in teleport-remote agent mode with Codex as the active driver");
}

mkdirSync(IPC_DIR, { recursive: true });
const releaseInstanceLock = acquireInstanceLockOrExit();

// Grammy requires bot.init() (or an explicit botInfo) before handleUpdate().
await bot.init();
const botInfo = bot.botInfo;
botLog.info({ username: botInfo.username }, `Bot started: @${botInfo.username}`);
await syncTelegramCommands();

if (
  SUPERTURTLE_RUNTIME_ROLE !== "teleport-remote" &&
  TURTLE_GREETINGS_ENABLED &&
  ALLOWED_USERS.length > 0
) {
  startTurtleGreetings(bot, ALLOWED_USERS[0]!);
  botLog.info("Turtle greetings enabled (8am/8pm Europe/Prague)");
}
if (SUPERTURTLE_RUNTIME_ROLE !== "teleport-remote") {
  startDashboardServer();
}

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 60 seconds)
    if (age < 60000 && data.chat_id && data.message_id) {
      // Edit the "Restarting..." message to show completion
      try {
        await bot.api.editMessageText(
          data.chat_id,
          data.message_id,
          "✅ Bot restarted"
        );
      } catch (error) {
        const msg = String(error).toLowerCase();
        if (!msg.includes("message is not modified")) {
          throw error;
        }
      }

      if (SUPERTURTLE_RUNTIME_ROLE !== "teleport-remote") {
        // Clean slate: reset driver sessions (stop any stale work from before restart)
        // Preserve the active driver preference — it was already loaded from prefs by the constructor.
        const savedDriver = session.activeDriver;
        await resetAllDriverSessions({ stopRunning: true });

        // Auto-resume the most recent session for the active driver so the user
        // doesn't lose their conversation context across restarts.
        if (savedDriver === "codex" && CODEX_AVAILABLE) {
          try {
            const [ok] = await codexSession.resumeLast();
            if (ok) {
              botLog.info("Auto-resumed last Codex session after restart");
            } else {
              botLog.info("No Codex session to resume; keeping codex driver active");
            }
          } catch (err) {
            botLog.warn({ err }, "Failed to auto-resume Codex session after restart; keeping codex driver active");
          }
          // Restore the codex driver regardless of whether resume succeeded —
          // a fresh thread will be created on the next message if needed.
          session.activeDriver = "codex";
        } else if (savedDriver === "codex" && !CODEX_AVAILABLE) {
          // Codex was active but is now unavailable — fall back to Claude
          session.activeDriver = "claude";
          botLog.warn("Codex was active but is unavailable after restart; falling back to Claude");
        } else {
          // savedDriver === "claude" (or unknown → default)
          const [ok] = session.resumeLast();
          if (ok) {
            botLog.info("Auto-resumed last Claude session after restart");
          }
          // activeDriver stays "claude" — no need to set explicitly
        }
      }

    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    botLog.warn({ err: e }, "Failed to update restart message");
    // Attempt cleanup of restart file; ignore if it doesn't exist or unlink fails
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

await sendStartupNotifications();

if (SUPERTURTLE_RUNTIME_ROLE !== "teleport-remote") {
  await runConductorMaintenancePass({ recoverInFlightWakeups: true });

  // Start cron timer after boot-time recovery so recurring ticks never race startup maintenance.
  startCronTimer();
}

const localTeleportState = loadTeleportStateForCurrentProject();
const buildLocalStandbyConfig = (): Extract<TelegramTransportConfig, { mode: "standby" }> => {
  const state = loadTeleportStateForCurrentProject();
  return {
    mode: "standby",
    expectedRemoteWebhookUrl: state?.ownerMode === "remote" ? state.webhookUrl : state?.webhookUrl || null,
    onResumePolling: async () => {
      await reconcileTeleportOwnershipForCurrentProject();
    },
  };
};

const transportConfig: TelegramTransportConfig | undefined =
  SUPERTURTLE_RUNTIME_ROLE === "local"
    ? localTeleportState?.ownerMode === "remote"
      ? buildLocalStandbyConfig()
      : {
          mode: "polling",
          clearWebhookOnStart: true,
          standbyOnConflict: async () => {
            await reconcileTeleportOwnershipForCurrentProject();
            const state = loadTeleportStateForCurrentProject();
            if (!state?.webhookUrl) {
              return null;
            }
            return buildLocalStandbyConfig();
          },
        }
    : undefined;

const transport = await startTelegramTransport(bot, transportConfig, {
  getReadiness: async () => {
    if (isTeleportRemoteAgentMode() && !CODEX_AVAILABLE) {
      return {
        ok: false,
        status: 503,
        body: `remote-agent-codex-unavailable: ${getCodexUnavailableReason() || "Codex is unavailable."}`,
      };
    }
    return { ok: true, status: 200, body: "ok" };
  },
});

const subturtleBoardService = startSubturtleBoardService(bot.api);

// Graceful shutdown
let shutdownInitiated = false;

const stopRunner = () => {
  if (shutdownInitiated) return;
  shutdownInitiated = true;
  botLog.info({ mode: transport.mode }, "Stopping bot transport...");
  subturtleBoardService.stop();
  Promise.resolve(transport.stop()).catch((error) => {
    botLog.warn({ err: error }, "Failed to stop Telegram transport cleanly");
  });
  releaseInstanceLock();
};

process.on("uncaughtException", (error) => {
  botLog.fatal({ err: error }, "Uncaught exception");
  eventLog.error(
    { eventType: "process_uncaught_exception", error: summarizeCronError(error) },
    "Process-level crash"
  );
  stopRunner();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (shouldSuppressHandledWebhookConflict(reason)) {
    botLog.debug("Ignored handled Telegram webhook cutover conflict after standby handoff");
    return;
  }
  botLog.fatal({ err: reason }, "Unhandled promise rejection");
  eventLog.error(
    { eventType: "process_unhandled_rejection", error: summarizeCronError(reason) },
    "Process-level crash"
  );
  stopRunner();
  process.exit(1);
});

process.on("SIGINT", () => {
  botLog.info("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  botLog.info("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
