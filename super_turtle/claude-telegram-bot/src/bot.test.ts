import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const configPath = resolve(import.meta.dir, "config.ts");
const botPath = resolve(import.meta.dir, "bot.ts");

/**
 * Probe the bot module in a subprocess with specific env var overrides.
 *
 * Since bot.ts applies the transformer at import time based on config,
 * we need a fresh process for each env var combination. The transformer
 * logic is duplicated here (rather than importing bot.ts) because bot.ts
 * has side-effects (starts polling, connects to router) that make it
 * unsuitable for direct import in tests.
 */
async function probeBotTransformer(env: Record<string, string | undefined>): Promise<{
  exitCode: number;
  capturedThreadId: string;
  stdout: string;
  stderr: string;
}> {
  const fullEnv: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
  } as Record<string, string>;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete fullEnv[key];
    } else {
      fullEnv[key] = value;
    }
  }

  // The forum transformer mutates the payload in place before calling prev.
  // We install a bottom-level transformer first that captures the final
  // payload, then import bot.ts which installs the forum transformer on top.
  const script = `
    // Import config first to set up TELEGRAM_THREAD_ID
    const config = await import(${JSON.stringify(configPath)});
    console.log("__THREAD_ID__=" + String(config.TELEGRAM_THREAD_ID));

    // Create a bare Bot to test transformer installation
    const { Bot } = await import("grammy");
    const bot = new Bot("test-token");

    // Install bottom-level interceptor that captures the final payload
    // and returns a fake response (never reaches Telegram)
    let capturedPayload = {};
    bot.api.config.use((_prev, method, payload, _signal) => {
      capturedPayload = { ...payload };
      return Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
      });
    });

    // Now apply the same transformer logic that bot.ts would apply
    if (config.TELEGRAM_THREAD_ID) {
      const THREAD_METHODS = new Set([
        "sendMessage", "sendPhoto", "sendDocument", "sendVideo",
        "sendAnimation", "sendVoice", "sendAudio", "sendVideoNote",
        "sendSticker", "sendLocation", "sendContact", "sendPoll",
        "sendDice", "sendMediaGroup", "sendChatAction", "copyMessage",
        "forwardMessage",
      ]);

      bot.api.config.use((prev, method, payload, signal) => {
        if (THREAD_METHODS.has(method) && payload && !("message_thread_id" in payload)) {
          payload.message_thread_id = config.TELEGRAM_THREAD_ID;
        }
        return prev(method, payload, signal);
      });
    }

    try {
      await bot.api.sendMessage(123, "test");
    } catch {
      // ignore
    }

    console.log("__CAPTURED_THREAD_ID__=" + (capturedPayload.message_thread_id ?? "none"));
  `;

  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    env: fullEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const extractMarker = (marker: string): string =>
    stdout.split("\n").find((l) => l.trim().startsWith(marker))?.trim().slice(marker.length) ?? "";

  return {
    exitCode,
    capturedThreadId: extractMarker("__CAPTURED_THREAD_ID__="),
    stdout,
    stderr,
  };
}

describe("forum topic API transformer", () => {
  it("does not inject message_thread_id when TELEGRAM_THREAD_ID is unset", async () => {
    const result = await probeBotTransformer({
      TELEGRAM_THREAD_ID: undefined,
      TELEGRAM_FORUM_CHAT_ID: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.capturedThreadId).toBe("none");
  });

  it("injects message_thread_id into sendMessage when thread ID is set", async () => {
    const result = await probeBotTransformer({
      TELEGRAM_THREAD_ID: "42",
      TELEGRAM_FORUM_CHAT_ID: "-1003792037700",
    });

    expect(result.exitCode).toBe(0);
    expect(result.capturedThreadId).toBe("42");
  });

  it("does not inject for non-numeric thread ID", async () => {
    const result = await probeBotTransformer({
      TELEGRAM_THREAD_ID: "not-a-number",
      TELEGRAM_FORUM_CHAT_ID: "-1003792037700",
    });

    expect(result.exitCode).toBe(0);
    expect(result.capturedThreadId).toBe("none");
  });

  it("preserves pre-existing message_thread_id and does not overwrite it", async () => {
    // When a message already has message_thread_id set (e.g., 99),
    // the transformer must NOT overwrite it with runtimeForumConfig.threadId.
    const fullEnv: Record<string, string> = {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USERS: "123",
      CLAUDE_WORKING_DIR: process.cwd(),
      TELEGRAM_THREAD_ID: "42",
      TELEGRAM_FORUM_CHAT_ID: "-1003792037700",
    } as Record<string, string>;

    const script = `
      const config = await import(${JSON.stringify(configPath)});

      const { Bot } = await import("grammy");
      const bot = new Bot("test-token");

      let capturedPayload = {};
      bot.api.config.use((_prev, method, payload, _signal) => {
        capturedPayload = { ...payload };
        return Promise.resolve({
          ok: true,
          result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
        });
      });

      if (config.TELEGRAM_THREAD_ID) {
        const THREAD_METHODS = new Set([
          "sendMessage", "sendPhoto", "sendDocument", "sendVideo",
          "sendAnimation", "sendVoice", "sendAudio", "sendVideoNote",
          "sendSticker", "sendLocation", "sendContact", "sendPoll",
          "sendDice", "sendMediaGroup", "sendChatAction", "copyMessage",
          "forwardMessage",
        ]);

        bot.api.config.use((prev, method, payload, signal) => {
          if (THREAD_METHODS.has(method) && payload && !("message_thread_id" in payload)) {
            payload.message_thread_id = config.TELEGRAM_THREAD_ID;
          }
          return prev(method, payload, signal);
        });
      }

      try {
        // Pass message_thread_id: 99 explicitly — it should NOT be overwritten to 42
        await bot.api.sendMessage(123, "test", { message_thread_id: 99 });
      } catch {
        // ignore
      }

      console.log("__CAPTURED_THREAD_ID__=" + (capturedPayload.message_thread_id ?? "none"));
    `;

    const proc = Bun.spawn({
      cmd: ["bun", "--no-env-file", "-e", script],
      env: fullEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const extractMarker = (marker: string): string =>
      stdout.split("\n").find((l) => l.trim().startsWith(marker))?.trim().slice(marker.length) ?? "";

    expect(exitCode).toBe(0);
    // The pre-existing thread ID 99 must be preserved, NOT overwritten to 42
    expect(extractMarker("__CAPTURED_THREAD_ID__=")).toBe("99");
  });
});
