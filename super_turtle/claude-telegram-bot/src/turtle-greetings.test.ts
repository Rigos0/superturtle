import { afterEach, describe, expect, it, mock } from "bun:test";
import { InputFile } from "grammy";
import { getJobs } from "./cron";
import { startTurtleGreetings } from "./turtle-greetings";

describe("turtle greetings sticker delivery", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalFetch = globalThis.fetch;
  const originalMathRandom = Math.random;

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
    Math.random = originalMathRandom;
  });

  it("sends turtle greetings as stickers with turtle.webp filename", async () => {
    const scheduledCallbacks: Array<() => void> = [];

    globalThis.setTimeout = ((handler: unknown) => {
      if (typeof handler === "function") {
        scheduledCallbacks.push(handler as () => void);
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    globalThis.setInterval = (() => {
      return undefined as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    const sendSticker = mock(async (_chatId: number, _sticker: InputFile) => {});
    const sendMessage = mock(async (_chatId: number, _message: string) => {});
    const sendPhoto = mock(async (_chatId: number, _photo: unknown) => {});

    const fetchMock = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "image/webp",
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    Math.random = () => 0;

    const bot = {
      api: {
        sendSticker,
        sendMessage,
        sendPhoto,
      },
    } as any;

    startTurtleGreetings(bot, () => 12345);

    expect(scheduledCallbacks.length).toBe(2);

    // Execute one scheduled greeting path and allow async send to complete.
    scheduledCallbacks[0]!();
    await Bun.sleep(0);

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendSticker).toHaveBeenCalledTimes(1);

    const stickerCall = sendSticker.mock.calls[0];
    expect(stickerCall).toBeDefined();
    if (!stickerCall) {
      throw new Error("Expected sendSticker to have at least one call");
    }

    const [chatId, stickerFile] = stickerCall;
    expect(chatId).toBe(12345);
    expect(stickerFile).toBeInstanceOf(InputFile);
    expect(stickerFile.filename).toBe("turtle.webp");

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not register greeting timers as /cron jobs", async () => {
    const scheduledCallbacks: Array<() => void> = [];

    globalThis.setTimeout = ((handler: unknown) => {
      if (typeof handler === "function") {
        scheduledCallbacks.push(handler as () => void);
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    globalThis.setInterval = (() => {
      return undefined as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    const sendSticker = mock(async (_chatId: number, _sticker: InputFile) => {});
    const sendMessage = mock(async (_chatId: number, _message: string) => {});

    const fetchMock = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "image/webp",
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    Math.random = () => 0;

    const beforeCronJobs = JSON.stringify(getJobs());
    const bot = {
      api: {
        sendSticker,
        sendMessage,
      },
    } as any;

    startTurtleGreetings(bot, () => 12345);
    const afterStartCronJobs = JSON.stringify(getJobs());

    expect(afterStartCronJobs).toBe(beforeCronJobs);
    expect(scheduledCallbacks.length).toBe(2);

    scheduledCallbacks[0]!();
    await Bun.sleep(0);

    const afterFireCronJobs = JSON.stringify(getJobs());
    expect(afterFireCronJobs).toBe(beforeCronJobs);
  });
});
