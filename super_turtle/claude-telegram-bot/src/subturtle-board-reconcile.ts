import { bot } from "./bot";
import { syncLiveSubturtleBoard, type LiveSubturtleBoardApi } from "./handlers/commands";
import { botLog } from "./logger";
import { getPrimaryTelegramTarget } from "./telegram-owner";

export async function reconcileLiveSubturtleBoardNow(options: {
  api?: LiveSubturtleBoardApi;
  chatId?: number | null;
  reason?: string;
} = {}) {
  const chatId = options.chatId ?? getPrimaryTelegramTarget()?.chatId ?? null;
  if (chatId === null) {
    return null;
  }

  const result = await syncLiveSubturtleBoard(options.api ?? bot.api, chatId, {
    force: true,
    pin: true,
    disableNotification: true,
  });
  botLog.info(
    { chatId, reason: options.reason ?? "manual", result },
    "Reconciled live SubTurtle board on demand"
  );
  return result;
}

if (import.meta.main) {
  const reason = process.argv[2] ?? "manual";

  try {
    const result = await reconcileLiveSubturtleBoardNow({ reason });
    if (result === null) {
      botLog.info({ reason }, "Skipped on-demand live SubTurtle board reconcile: no allowed chat");
    }
  } catch (error) {
    botLog.error({ err: error, reason }, "Failed on-demand live SubTurtle board reconcile");
    process.exitCode = 1;
  }
}
