import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { SUPERTURTLE_DATA_DIR } from "./config";
import { botLog } from "./logger";

export const PENDING_CONNECTION_NOTIFICATION_SCHEMA_VERSION = 1;
export const PENDING_CONNECTION_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_CONNECTION_NOTIFICATIONS_DIR = join(
  SUPERTURTLE_DATA_DIR,
  "pending-connection-notifications"
);

export type PendingConnectionChangeNotification = {
  action: "updated" | "revoked";
  id: string;
  label: string;
  requested_at: string;
  source: "token-vault" | "connector.github" | "connector.notion";
  version: typeof PENDING_CONNECTION_NOTIFICATION_SCHEMA_VERSION;
};

type StoredPendingConnectionChangeNotification = {
  filePath: string;
  notification: PendingConnectionChangeNotification;
};

export function buildPendingConnectionChangeSuccessText(
  notification: Pick<PendingConnectionChangeNotification, "action" | "label">
) {
  if (notification.action === "revoked") {
    return `✅ Your ${notification.label} was revoked.`;
  }

  return `✅ Your ${notification.label} change is now live.`;
}

export function parsePendingConnectionChangeNotification(
  raw: unknown
): PendingConnectionChangeNotification | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (value.version !== PENDING_CONNECTION_NOTIFICATION_SCHEMA_VERSION) {
    return null;
  }
  if (value.action !== "updated" && value.action !== "revoked") {
    return null;
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    return null;
  }
  if (typeof value.label !== "string" || !value.label.trim()) {
    return null;
  }
  if (typeof value.requested_at !== "string" || !value.requested_at.trim()) {
    return null;
  }
  if (
    value.source !== "token-vault" &&
    value.source !== "connector.github" &&
    value.source !== "connector.notion"
  ) {
    return null;
  }

  return {
    action: value.action,
    id: value.id,
    label: value.label,
    requested_at: value.requested_at,
    source: value.source,
    version: PENDING_CONNECTION_NOTIFICATION_SCHEMA_VERSION,
  };
}

export async function drainPendingConnectionChangeNotifications(options: {
  chatId: number | null;
  directory?: string;
  now?: () => number;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  ttlMs?: number;
}) {
  const directory = options.directory || PENDING_CONNECTION_NOTIFICATIONS_DIR;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PENDING_CONNECTION_NOTIFICATION_TTL_MS;
  const notifications = listPendingConnectionChangeNotifications(directory);
  let sent = 0;

  for (const entry of notifications) {
    if (isExpiredPendingConnectionChangeNotification(entry.notification, now(), ttlMs)) {
      rmSync(entry.filePath, { force: true });
      continue;
    }

    if (!options.chatId) {
      continue;
    }

    try {
      await options.sendMessage(
        options.chatId,
        buildPendingConnectionChangeSuccessText(entry.notification)
      );
      rmSync(entry.filePath, { force: true });
      sent += 1;
    } catch (error) {
      botLog.warn(
        {
          err: error,
          filePath: entry.filePath,
          source: entry.notification.source,
        },
        "Failed to send pending connection change notification"
      );
    }
  }

  return { sent };
}

function listPendingConnectionChangeNotifications(directory: string) {
  if (!existsSync(directory)) {
    return [] satisfies StoredPendingConnectionChangeNotification[];
  }

  const notifications: StoredPendingConnectionChangeNotification[] = [];

  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const filePath = join(directory, entry);
    const notification = readPendingConnectionChangeNotification(filePath);
    if (!notification) {
      rmSync(filePath, { force: true });
      continue;
    }
    notifications.push({
      filePath,
      notification,
    });
  }

  notifications.sort((left, right) => {
    const leftTime = Date.parse(left.notification.requested_at);
    const rightTime = Date.parse(right.notification.requested_at);
    const leftValue = Number.isFinite(leftTime) ? leftTime : 0;
    const rightValue = Number.isFinite(rightTime) ? rightTime : 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
    return left.filePath.localeCompare(right.filePath);
  });

  return notifications;
}

function readPendingConnectionChangeNotification(filePath: string) {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return parsePendingConnectionChangeNotification(raw);
  } catch {
    return null;
  }
}

function isExpiredPendingConnectionChangeNotification(
  notification: PendingConnectionChangeNotification,
  nowMs: number,
  ttlMs: number
) {
  const requestedAtMs = Date.parse(notification.requested_at);
  if (!Number.isFinite(requestedAtMs)) {
    return true;
  }
  return nowMs - requestedAtMs > ttlMs;
}
