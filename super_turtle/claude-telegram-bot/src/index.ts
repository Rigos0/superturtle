/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import type { Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import {
  WORKING_DIR,
  CTL_PATH,
  ALLOWED_USERS,
  RESTART_FILE,
  CLAUDE_CLI_AVAILABLE,
  CODEX_AVAILABLE,
  CODEX_CLI_AVAILABLE,
  CODEX_USER_ENABLED,
  TOKEN_PREFIX,
  IPC_DIR,
  SUPERTURTLE_DATA_DIR,
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
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";
import { buildSessionOverviewLines } from "./handlers/commands";
import { resetAllDriverSessions } from "./handlers/commands";
import { handlePinologs } from "./handlers/commands";
import { enqueueBusyDeferredCronJob, pruneQueuedDueCronJobIds } from "./cron-deferred-queue";
import { drainDeferredQueue, isCronJobQueued } from "./deferred-queue";
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
import { isStopIntent } from "./utils";
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
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Stop intents bypass queue so they can cancel work immediately
    if (ctx.message?.text && isStopIntent(ctx.message.text)) {
      return undefined;
    }
    // Voice notes bypass queue so they can transcribe/interrupt while a turn is running
    if (ctx.message?.voice) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("new", handleNew);
bot.command("stop", handleStopCommand);
bot.command("status", handleStatus);
bot.command("looplogs", handleLooplogs);
bot.command("pinologs", handlePinologs);
bot.command("usage", handleUsage);
bot.command("context", handleContext);
bot.command("model", handleModel);
bot.command("switch", handleSwitch);
bot.command("resume", handleResume);
bot.command("sub", handleSubturtle);
bot.command("subs", handleSubturtle);
bot.command("subturtle", handleSubturtle);
bot.command("subturtles", handleSubturtle);
bot.command("turtle", handleSubturtle);
bot.command("turtles", handleSubturtle);
bot.command("cron", handleCron);
bot.command("debug", handleDebug);
bot.command("restart", handleRestart);

// ============== Message Handlers ==============

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

botLog.info("=".repeat(50));
botLog.info("Claude Telegram Bot - TypeScript Edition");
botLog.info("=".repeat(50));
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

if (!CLAUDE_CLI_AVAILABLE) {
  botLog.error(
    "Claude CLI is required for the meta-agent runtime. Install Claude Code or set CLAUDE_CLI_PATH."
  );
  process.exit(1);
}

mkdirSync(IPC_DIR, { recursive: true });
const releaseInstanceLock = acquireInstanceLockOrExit();

// Get bot info first
const botInfo = await bot.api.getMe();
botLog.info({ username: botInfo.username }, `Bot started: @${botInfo.username}`);

if (process.env.TURTLE_GREETINGS !== "false" && ALLOWED_USERS.length > 0) {
  startTurtleGreetings(bot, ALLOWED_USERS[0]!);
  botLog.info("Turtle greetings enabled (8am/8pm Europe/Prague)");
}
startDashboardServer();

// Drop any messages that arrived while the bot was offline
await bot.api.deleteWebhook({ drop_pending_updates: true });

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

      // Send startup message with the same standardized overview format (same as /new)
      const lines = await buildSessionOverviewLines("Bot restarted");
      await bot.api.sendMessage(data.chat_id, lines.join("\n"), { parse_mode: "HTML" });
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    botLog.warn({ err: e }, "Failed to update restart message");
    // Attempt cleanup of restart file; ignore if it doesn't exist or unlink fails
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

await runConductorMaintenancePass({ recoverInFlightWakeups: true });

// Start cron timer after boot-time recovery so recurring ticks never race startup maintenance.
startCronTimer();

// Start with concurrent runner (commands work immediately)
// Retry forever on getUpdates failures (e.g. network drop during sleep)
const runner = run(bot, {
  runner: {
    maxRetryTime: Infinity,
    retryInterval: "exponential",
  },
});

// Graceful shutdown
let shutdownInitiated = false;

const stopRunner = () => {
  if (shutdownInitiated) return;
  shutdownInitiated = true;
  if (runner.isRunning()) {
    botLog.info("Stopping bot...");
    runner.stop();
  }
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
