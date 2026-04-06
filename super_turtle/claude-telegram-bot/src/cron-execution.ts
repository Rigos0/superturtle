import type { Context } from "grammy";
import type { CronJob } from "./cron";
import { bot } from "./bot";
import { buildCronScheduledPrompt } from "./cron-scheduled-prompt";
import type { DriverId } from "./drivers/types";
import {
  beginBackgroundRun,
  endBackgroundRun,
  isLikelyCancellationError,
  isLikelyQuotaOrLimitError,
  runMessageWithDriver,
  wasBackgroundRunPreempted,
} from "./handlers/driver-routing";
import { StreamingState, createStatusCallback } from "./handlers/streaming";
import { cronLog } from "./logger";
import { session } from "./session";

export interface NonSilentCronExecutionJob extends Pick<CronJob, "id" | "prompt"> {}

export interface NonSilentCronExecutionTarget {
  chatId: number;
  userId: number;
}

function createCronContext(
  target: NonSilentCronExecutionTarget,
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
      return bot.api.sendMessage(
        target.chatId,
        replyText,
        opts as Parameters<typeof bot.api.sendMessage>[2]
      );
    },
    replyWithChatAction: async (action: string) => {
      await bot.api.sendChatAction(
        target.chatId,
        action as Parameters<typeof bot.api.sendChatAction>[1]
      );
    },
    replyWithSticker: async (sticker: unknown) => {
      // @ts-expect-error minimal shim for sticker sending
      return bot.api.sendSticker(target.chatId, sticker);
    },
    api: bot.api,
  }) as unknown as Context;
}

export async function executeNonSilentCronJob(
  job: NonSilentCronExecutionJob,
  target: NonSilentCronExecutionTarget
): Promise<void> {
  const injectedPrompt = buildCronScheduledPrompt(job.prompt);
  const cronCtx = createCronContext(target, injectedPrompt);

  beginBackgroundRun();
  try {
    if (wasBackgroundRunPreempted()) {
      cronLog.info(
        { cronJobId: job.id, action: "cron_skip_pre_start" },
        `[cron:${job.id}] skipped before start due to user-priority preemption`
      );
      return;
    }

    const primaryDriver: DriverId = "codex";
    const state = new StreamingState();
    const statusCallback = createStatusCallback(cronCtx, state);

    await runMessageWithDriver(primaryDriver, {
      message: injectedPrompt,
      source: "cron_scheduled",
      username: "cron",
      userId: target.userId,
      chatId: target.chatId,
      ctx: cronCtx,
      statusCallback,
    });
  } catch (error) {
    if (wasBackgroundRunPreempted() && isLikelyCancellationError(error)) {
      cronLog.info(
        { cronJobId: job.id, action: "cron_preempted" },
        `[cron:${job.id}] preempted by interactive update`
      );
      return;
    }
    throw error;
  } finally {
    endBackgroundRun();
  }
}
