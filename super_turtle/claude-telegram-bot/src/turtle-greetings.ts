import type { Bot } from "grammy";
import { InputFile } from "grammy";
import turtleCombos from "../send_turtle_mcp/turtle-combos.json";
import { botLog } from "./logger";

const DEFAULT_TIME_ZONE = "Europe/Prague";
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TURTLE_COMBOS = turtleCombos as Record<string, string>;

const MORNING_MESSAGES = [
  "good morning",
  "rise and shine",
  "morning!",
  "new day, new code",
  "wakey wakey",
  "time to build",
  "gm",
  "hope you slept well",
  "coffee time?",
  "let's go",
] as const;

const MORNING_STICKER_CODES = [
  "2615",
  "1f31e",
  "1f60a",
  "1f525",
  "2b50",
  "1f4aa",
  "1f33a",
] as const;

const EVENING_MESSAGES = [
  "have you eaten yet?",
  "had dinner?",
  "are we building anything tonight?",
  "good evening",
  "don't forget to eat",
  "winding down?",
  "how was your day?",
  "time to rest? or time to ship?",
  "evening check-in",
  "still coding?",
] as const;

const EVENING_STICKER_CODES = [
  "1f307",
  "1f30c",
  "1f634",
  "1f355",
  "1f354",
  "1f60e",
  "1f917",
  "1f974",
] as const;

type GreetingType = "morning" | "evening";

interface GreetingDefinition {
  type: GreetingType;
  hour: number;
  messages: readonly string[];
  stickerCodes: readonly string[];
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pickRandom<T>(items: readonly T[]): T {
  const value = items[Math.floor(Math.random() * items.length)];
  if (value === undefined) {
    throw new Error("Cannot pick a random item from an empty array");
  }
  return value;
}

function getZonedParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const valueOf = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) {
      throw new Error(`Missing ${type} when formatting date parts`);
    }
    return Number.parseInt(found.value, 10);
  };

  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    hour: valueOf("hour"),
    minute: valueOf("minute"),
    second: valueOf("second"),
  };
}

function addDays(parts: Pick<ZonedDateParts, "year" | "month" | "day">, days: number) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedDateTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  // Start with a UTC guess, then correct by comparing desired vs rendered zoned parts.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const zonedAtGuess = getZonedParts(new Date(utcGuess), timeZone);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const zonedGuessAsUtc = Date.UTC(
    zonedAtGuess.year,
    zonedAtGuess.month - 1,
    zonedAtGuess.day,
    zonedAtGuess.hour,
    zonedAtGuess.minute,
    zonedAtGuess.second,
  );
  return utcGuess + (desiredAsUtc - zonedGuessAsUtc);
}

function msUntilNextScheduledHour(targetHour: number, timeZone: string, now = new Date()): number {
  const zonedNow = getZonedParts(now, timeZone);
  const needsNextDay =
    zonedNow.hour > targetHour ||
    (zonedNow.hour === targetHour && (zonedNow.minute > 0 || zonedNow.second > 0));

  const targetDay = addDays(zonedNow, needsNextDay ? 1 : 0);
  const targetUtcMs = zonedDateTimeToUtcMs(
    timeZone,
    targetDay.year,
    targetDay.month,
    targetDay.day,
    targetHour,
    0,
    0,
  );

  return Math.max(0, targetUtcMs - now.getTime());
}

async function sendGreeting(bot: Bot<any>, chatId: number, definition: GreetingDefinition): Promise<void> {
  const message = pickRandom(definition.messages);

  try {
    const stickerCode = pickRandom(definition.stickerCodes);
    const stickerUrl = TURTLE_COMBOS[stickerCode];

    if (!stickerUrl) {
      throw new Error(`No turtle sticker URL found for code ${stickerCode}`);
    }

    const response = await fetch(stickerUrl);
    if (!response.ok) {
      throw new Error(`Failed to download turtle sticker (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const sticker = new InputFile(buffer, "turtle.webp");
    await bot.api.sendSticker(chatId, sticker);
  } catch (error) {
    botLog.warn({ err: error, greetingType: definition.type, chatId }, "Turtle greeting sticker send failed");
  }

  try {
    await bot.api.sendMessage(chatId, message);
  } catch (error) {
    botLog.warn({ err: error, greetingType: definition.type, chatId }, "Turtle greeting message send failed");
  }
}

function scheduleGreeting(bot: Bot<any>, chatId: number, definition: GreetingDefinition, timeZone: string): void {
  const initialDelayMs = msUntilNextScheduledHour(definition.hour, timeZone);

  setTimeout(() => {
    void sendGreeting(bot, chatId, definition);

    setInterval(() => {
      void sendGreeting(bot, chatId, definition);
    }, DAILY_INTERVAL_MS);
  }, initialDelayMs);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bot<BotContext> is a superset of Bot<Context>; only bot.api is used here.
export function startTurtleGreetings(bot: Bot<any>, chatId: number, timeZone = DEFAULT_TIME_ZONE): void {
  const definitions: GreetingDefinition[] = [
    {
      type: "morning",
      hour: 8,
      messages: MORNING_MESSAGES,
      stickerCodes: MORNING_STICKER_CODES,
    },
    {
      type: "evening",
      hour: 20,
      messages: EVENING_MESSAGES,
      stickerCodes: EVENING_STICKER_CODES,
    },
  ];

  for (const definition of definitions) {
    scheduleGreeting(bot, chatId, definition, timeZone);
  }
}
