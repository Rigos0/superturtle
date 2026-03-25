import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { ALLOWED_USERS, SUPERTURTLE_DATA_DIR, TOKEN_PREFIX } from "./config";
import { botLog } from "./logger";

const TELEGRAM_OWNER_SCHEMA_VERSION = 1;

export const TELEGRAM_OWNER_STATE_PATH = `${SUPERTURTLE_DATA_DIR}/telegram-owner.json`;

export interface TelegramOwnerRecord {
  schema_version: number;
  bot_token_prefix: string;
  owner_user_id: number;
  owner_chat_id: number;
  claimed_at: string;
  claim_source: string;
}

export interface TelegramTarget {
  userId: number;
  chatId: number;
  source: "persisted_owner" | "legacy_env";
}

let cachedTelegramOwner: TelegramOwnerRecord | null | undefined;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function parseTelegramOwnerRecord(raw: unknown): TelegramOwnerRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (record.schema_version !== TELEGRAM_OWNER_SCHEMA_VERSION) {
    return null;
  }
  if (record.bot_token_prefix !== TOKEN_PREFIX) {
    return null;
  }
  if (!isFiniteInteger(record.owner_user_id) || !isFiniteInteger(record.owner_chat_id)) {
    return null;
  }
  if (typeof record.claimed_at !== "string" || !record.claimed_at.trim()) {
    return null;
  }
  if (typeof record.claim_source !== "string" || !record.claim_source.trim()) {
    return null;
  }

  return {
    schema_version: TELEGRAM_OWNER_SCHEMA_VERSION,
    bot_token_prefix: TOKEN_PREFIX,
    owner_user_id: record.owner_user_id,
    owner_chat_id: record.owner_chat_id,
    claimed_at: record.claimed_at,
    claim_source: record.claim_source,
  };
}

function writeTelegramOwnerRecord(record: TelegramOwnerRecord): void {
  mkdirSync(dirname(TELEGRAM_OWNER_STATE_PATH), { recursive: true });
  const tempPath = `${TELEGRAM_OWNER_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  renameSync(tempPath, TELEGRAM_OWNER_STATE_PATH);
}

export function clearTelegramOwnerCache(): void {
  cachedTelegramOwner = undefined;
}

export function getPersistedTelegramOwner(): TelegramOwnerRecord | null {
  if (cachedTelegramOwner !== undefined) {
    return cachedTelegramOwner;
  }

  if (!existsSync(TELEGRAM_OWNER_STATE_PATH)) {
    cachedTelegramOwner = null;
    return cachedTelegramOwner;
  }

  try {
    const parsed = JSON.parse(readFileSync(TELEGRAM_OWNER_STATE_PATH, "utf-8"));
    cachedTelegramOwner = parseTelegramOwnerRecord(parsed);
    if (cachedTelegramOwner) {
      return cachedTelegramOwner;
    }
    botLog.warn({ path: TELEGRAM_OWNER_STATE_PATH }, "Ignoring invalid or mismatched Telegram owner state");
  } catch (error) {
    botLog.warn({ err: error, path: TELEGRAM_OWNER_STATE_PATH }, "Failed to read Telegram owner state");
  }

  cachedTelegramOwner = null;
  return cachedTelegramOwner;
}

export function getAuthorizedTelegramUserIds(
  fallbackAllowedUsers: number[] = ALLOWED_USERS
): number[] {
  const owner = getPersistedTelegramOwner();
  if (owner) {
    return [owner.owner_user_id];
  }
  return fallbackAllowedUsers;
}

export function getPrimaryTelegramTarget(
  fallbackAllowedUsers: number[] = ALLOWED_USERS
): TelegramTarget | null {
  const owner = getPersistedTelegramOwner();
  if (owner) {
    return {
      userId: owner.owner_user_id,
      chatId: owner.owner_chat_id,
      source: "persisted_owner",
    };
  }

  if (fallbackAllowedUsers.length === 1) {
    return {
      userId: fallbackAllowedUsers[0]!,
      chatId: fallbackAllowedUsers[0]!,
      source: "legacy_env",
    };
  }

  return null;
}

export function persistTelegramOwner(
  userId: number,
  chatId: number,
  claimSource: string,
  claimedAt = new Date().toISOString()
): TelegramOwnerRecord {
  const record: TelegramOwnerRecord = {
    schema_version: TELEGRAM_OWNER_SCHEMA_VERSION,
    bot_token_prefix: TOKEN_PREFIX,
    owner_user_id: userId,
    owner_chat_id: chatId,
    claimed_at: claimedAt,
    claim_source: claimSource,
  };
  writeTelegramOwnerRecord(record);
  cachedTelegramOwner = record;
  return record;
}

export function claimTelegramOwnerIfUnclaimed(
  userId: number,
  chatId: number,
  claimSource: string
): { claimed: boolean; owner: TelegramOwnerRecord } {
  const existingOwner = getPersistedTelegramOwner();
  if (existingOwner) {
    return { claimed: false, owner: existingOwner };
  }

  return {
    claimed: true,
    owner: persistTelegramOwner(userId, chatId, claimSource),
  };
}

export function deleteTelegramOwnerStateForTests(): void {
  clearTelegramOwnerCache();
  try {
    unlinkSync(TELEGRAM_OWNER_STATE_PATH);
  } catch {}
}
