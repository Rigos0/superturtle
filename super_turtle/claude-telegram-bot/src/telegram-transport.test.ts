import { describe, expect, it } from "bun:test";
import {
  handleTelegramWebhookRequest,
  resolveTelegramTransportConfig,
  shouldSuppressHandledWebhookConflict,
  startTelegramTransport,
  type TelegramTransportConfig,
} from "./telegram-transport";

describe("resolveTelegramTransportConfig", () => {
  it("defaults to polling transport", () => {
    expect(resolveTelegramTransportConfig({})).toEqual({
      mode: "polling",
      clearWebhookOnStart: true,
    });
  });

  it("requires a webhook URL in webhook mode", () => {
    expect(() =>
      resolveTelegramTransportConfig({ TELEGRAM_TRANSPORT: "webhook" })
    ).toThrow("TELEGRAM_WEBHOOK_URL is required");
  });

  it("parses webhook config from env", () => {
    expect(
      resolveTelegramTransportConfig({
        TELEGRAM_TRANSPORT: "webhook",
        TELEGRAM_WEBHOOK_URL: "https://example.test/telegram/webhook",
        TELEGRAM_WEBHOOK_SECRET: "secret-token",
        PORT: "8787",
      })
    ).toEqual({
      mode: "webhook",
      publicUrl: "https://example.test/telegram/webhook",
      path: "/telegram/webhook",
      host: "0.0.0.0",
      port: 8787,
      secretToken: "secret-token",
      healthPath: "/healthz",
      readyPath: "/readyz",
      registerWebhook: true,
    });
  });
});

describe("startTelegramTransport", () => {
  it("starts polling mode by clearing any webhook and starting the runner", async () => {
    const deleteWebhookCalls: Array<{ drop_pending_updates: boolean }> = [];
    let runnerStopped = false;

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook(options) {
            deleteWebhookCalls.push(options);
          },
          async getWebhookInfo() {
            return { url: "" };
          },
          async setWebhook() {
            throw new Error("setWebhook should not be called in polling mode");
          },
        },
        async handleUpdate() {},
      },
      { mode: "polling", clearWebhookOnStart: true },
      {
        startPollingRunner() {
          return {
            isRunning() {
              return true;
            },
            stop() {
              runnerStopped = true;
            },
          };
        },
      }
    );

    expect(transport.mode).toBe("polling");
    expect(deleteWebhookCalls).toEqual([{ drop_pending_updates: true }]);
    await transport.stop();
    expect(runnerStopped).toBe(true);
  });

  it("can start polling without deleting an existing webhook", async () => {
    const deleteWebhookCalls: Array<{ drop_pending_updates: boolean }> = [];

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook(options) {
            deleteWebhookCalls.push(options);
          },
          async getWebhookInfo() {
            return { url: "" };
          },
          async setWebhook() {
            throw new Error("setWebhook should not be called in polling mode");
          },
        },
        async handleUpdate() {},
      },
      { mode: "polling", clearWebhookOnStart: false },
      {
        startPollingRunner() {
          return {
            isRunning() {
              return true;
            },
            stop() {},
          };
        },
      }
    );

    expect(deleteWebhookCalls).toEqual([]);
    await transport.stop();
  });

  it("hands polling off to standby after a webhook conflict", async () => {
    const intervalCallbacks: Array<() => void> = [];
    let firstRunnerStopped = false;
    let resumedPollingStarts = 0;
    let standbyOnConflictCalls = 0;
    let taskReject: ((error: unknown) => void) | null = null;

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook() {},
          async getWebhookInfo() {
            return { url: "" };
          },
          async setWebhook() {
            throw new Error("setWebhook should not be called in polling mode");
          },
        },
        async handleUpdate() {},
      },
      {
        mode: "polling",
        clearWebhookOnStart: true,
        standbyOnConflict: async () => {
          standbyOnConflictCalls += 1;
          return {
            mode: "standby",
            expectedRemoteWebhookUrl: "https://remote.test/telegram/webhook",
          };
        },
      },
      {
        startPollingRunner() {
          if (!taskReject) {
            let rejectTask: ((error: unknown) => void) | null = null;
            const taskPromise = new Promise<void>((_, reject) => {
              rejectTask = reject;
            });
            taskReject = rejectTask;
            return {
              isRunning() {
                return true;
              },
              stop() {
                firstRunnerStopped = true;
              },
              task() {
                return taskPromise;
              },
            };
          }

          resumedPollingStarts += 1;
          return {
            isRunning() {
              return true;
            },
            stop() {},
          };
        },
        setInterval(callback: () => void) {
          intervalCallbacks.push(callback);
          return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
      }
    );

    expect(taskReject).not.toBeNull();
    taskReject!({
      error_code: 409,
      description: "Conflict: terminated by setWebhook request",
      message: "Call to 'getUpdates' failed! (409: Conflict: terminated by setWebhook request)",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(standbyOnConflictCalls).toBe(1);
    expect(resumedPollingStarts).toBe(1);
    expect(intervalCallbacks).toHaveLength(0);
    expect(
      shouldSuppressHandledWebhookConflict({
        error_code: 409,
        description: "Conflict: terminated by setWebhook request",
      })
    ).toBe(true);

    await transport.stop();
    expect(firstRunnerStopped).toBe(false);
  });

  it("starts webhook mode and serves updates through Bun HTTP", async () => {
    const handledUpdates: unknown[] = [];
    const served: Array<{ hostname: string; port: number }> = [];
    let setWebhookCall:
      | { url: string; options?: { secret_token?: string } }
      | null = null;
    let serverFetch: ((request: Request) => Response | Promise<Response>) | null = null;
    let serverStopped = false;

    const config: TelegramTransportConfig = {
      mode: "webhook",
      publicUrl: "https://example.test/telegram/webhook",
      path: "/telegram/webhook",
      host: "0.0.0.0",
      port: 8787,
      secretToken: "secret-token",
      healthPath: "/healthz",
      readyPath: "/readyz",
      registerWebhook: true,
    };

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook() {
            throw new Error("deleteWebhook should not be called in webhook mode");
          },
          async getWebhookInfo() {
            return { url: config.publicUrl };
          },
          async setWebhook(url, options) {
            setWebhookCall = { url, options };
          },
        },
        async handleUpdate(update) {
          handledUpdates.push(update);
        },
      },
      config,
      {
        getReadiness() {
          return { ok: true, status: 200, body: "ready" };
        },
        serve({ hostname, port, fetch }) {
          served.push({ hostname, port });
          serverFetch = fetch;
          return {
            stop() {
              serverStopped = true;
            },
          };
        },
      }
    );

    expect(transport.mode).toBe("webhook");
    expect(setWebhookCall).not.toBeNull();
    expect(setWebhookCall!).toEqual({
      url: "https://example.test/telegram/webhook",
      options: { secret_token: "secret-token" },
    });
    expect(served).toEqual([{ hostname: "0.0.0.0", port: 8787 }]);
    expect(serverFetch).not.toBeNull();

    const healthResponse = await serverFetch!(
      new Request("http://127.0.0.1:8787/healthz", { method: "GET" })
    );
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe("ok");
    const readyResponse = await serverFetch!(
      new Request("http://127.0.0.1:8787/readyz", { method: "GET" })
    );
    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.text()).toBe("ready");

    const unauthorizedResponse = await serverFetch!(
      new Request("http://127.0.0.1:8787/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      })
    );
    expect(unauthorizedResponse.status).toBe(401);

    const okResponse = await serverFetch!(
      new Request("http://127.0.0.1:8787/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: JSON.stringify({ update_id: 2 }),
      })
    );
    expect(okResponse.status).toBe(200);
    expect(handledUpdates).toEqual([{ update_id: 2 }]);

    await transport.stop();
    expect(serverStopped).toBe(true);
  });

  it("can serve webhook mode without registering it", async () => {
    let setWebhookCalled = false;
    let serverFetch: ((request: Request) => Response | Promise<Response>) | null = null;

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook() {
            throw new Error("deleteWebhook should not be called in webhook mode");
          },
          async getWebhookInfo() {
            return { url: "https://example.test/telegram/webhook" };
          },
          async setWebhook() {
            setWebhookCalled = true;
          },
        },
        async handleUpdate() {},
      },
      {
        mode: "webhook",
        publicUrl: "https://example.test/telegram/webhook",
        path: "/telegram/webhook",
        host: "0.0.0.0",
        port: 8787,
        secretToken: "secret-token",
        healthPath: "/healthz",
        readyPath: "/readyz",
        registerWebhook: false,
      },
      {
        serve({ fetch }) {
          serverFetch = fetch;
          return {
            stop() {},
          };
        },
      }
    );

    expect(setWebhookCalled).toBe(false);
    expect(serverFetch).not.toBeNull();
    const healthResponse = await serverFetch!(
      new Request("http://127.0.0.1:8787/healthz", { method: "GET" })
    );
    expect(healthResponse.status).toBe(200);
    const readyResponse = await serverFetch!(
      new Request("http://127.0.0.1:8787/readyz", { method: "GET" })
    );
    expect(readyResponse.status).toBe(200);
    await transport.stop();
  });

  it("keeps the local bot alive in standby until the webhook is cleared", async () => {
    const webhookInfos = [
      { url: "https://remote.test/telegram/webhook" },
      { url: "" },
    ];
    const intervalCallbacks: Array<() => void> = [];
    let resumeCalls = 0;
    let pollingStarts = 0;
    let runnerStopped = false;

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook() {
            throw new Error("deleteWebhook should not be called in standby mode");
          },
          async getWebhookInfo() {
            return webhookInfos.shift() ?? { url: "" };
          },
          async setWebhook() {
            throw new Error("setWebhook should not be called in standby mode");
          },
        },
        async handleUpdate() {},
      },
      {
        mode: "standby",
        expectedRemoteWebhookUrl: "https://remote.test/telegram/webhook",
        checkIntervalMs: 1500,
        async onResumePolling() {
          resumeCalls += 1;
        },
      },
      {
        startPollingRunner() {
          pollingStarts += 1;
          return {
            isRunning() {
              return true;
            },
            stop() {
              runnerStopped = true;
            },
          };
        },
        setInterval(callback: () => void) {
          intervalCallbacks.push(callback);
          return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
      }
    );

    expect(transport.mode).toBe("standby");
    expect(pollingStarts).toBe(0);
    expect(resumeCalls).toBe(0);
    expect(intervalCallbacks).toHaveLength(1);

    intervalCallbacks[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resumeCalls).toBe(1);
    expect(pollingStarts).toBe(1);

    await transport.stop();
    expect(runnerStopped).toBe(true);
  });

  it("can re-enter standby after polling resumes and a second webhook cutover happens", async () => {
    const webhookInfos = [
      { url: "https://remote.test/telegram/webhook" },
      { url: "" },
      { url: "https://remote.test/telegram/webhook" },
    ];
    const intervalCallbacks: Array<() => void> = [];
    const taskRejects: Array<(error: unknown) => void> = [];
    let pollingStarts = 0;

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook() {
            throw new Error("deleteWebhook should not be called in standby mode");
          },
          async getWebhookInfo() {
            return webhookInfos.shift() ?? { url: "" };
          },
          async setWebhook() {
            throw new Error("setWebhook should not be called in standby mode");
          },
        },
        async handleUpdate() {},
      },
      {
        mode: "standby",
        expectedRemoteWebhookUrl: "https://remote.test/telegram/webhook",
        checkIntervalMs: 1500,
      },
      {
        startPollingRunner() {
          pollingStarts += 1;
          let rejectTask: ((error: unknown) => void) | null = null;
          const taskPromise = new Promise<void>((_, reject) => {
            rejectTask = reject;
          });
          taskRejects.push(rejectTask!);
          return {
            isRunning() {
              return true;
            },
            stop() {},
            task() {
              return taskPromise;
            },
          };
        },
        setInterval(callback: () => void) {
          intervalCallbacks.push(callback);
          return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
      }
    );

    expect(intervalCallbacks).toHaveLength(1);

    intervalCallbacks[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pollingStarts).toBe(1);

    taskRejects[0]!({
      error_code: 409,
      description: "Conflict: terminated by setWebhook request",
      message: "Call to 'getUpdates' failed! (409: Conflict: terminated by setWebhook request)",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(intervalCallbacks).toHaveLength(2);
    intervalCallbacks[1]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pollingStarts).toBe(1);
    expect(
      shouldSuppressHandledWebhookConflict({
        error_code: 409,
        description: "Conflict: terminated by setWebhook request",
      })
    ).toBe(true);

    await transport.stop();
  });

  it("stays idle in standby when a different webhook owns Telegram", async () => {
    let pollingStarted = false;

    const transport = await startTelegramTransport(
      {
        api: {
          async deleteWebhook() {
            throw new Error("deleteWebhook should not be called in standby mode");
          },
          async getWebhookInfo() {
            return { url: "https://someone-else.test/webhook" };
          },
          async setWebhook() {
            throw new Error("setWebhook should not be called in standby mode");
          },
        },
        async handleUpdate() {},
      },
      {
        mode: "standby",
        expectedRemoteWebhookUrl: "https://remote.test/telegram/webhook",
      },
      {
        startPollingRunner() {
          pollingStarted = true;
          return {
            isRunning() {
              return true;
            },
            stop() {},
          };
        },
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
      }
    );

    expect(transport.mode).toBe("standby");
    expect(pollingStarted).toBe(false);

    await transport.stop();
  });
});

describe("handleTelegramWebhookRequest", () => {
  it("acknowledges webhook updates before long-running handlers finish", async () => {
    let resolveUpdate: (() => void) | null = null;
    let handled = false;

    const responsePromise = handleTelegramWebhookRequest(
      new Request("http://127.0.0.1:8787/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false, first_name: "Test" },
            text: "hello",
          },
        }),
      }),
      {
        api: {
          async deleteWebhook() {},
          async getWebhookInfo() {
            return { url: "https://example.test/telegram/webhook" };
          },
          async setWebhook() {},
        },
        async handleUpdate() {
          await new Promise<void>((resolve) => {
            resolveUpdate = resolve;
          });
          handled = true;
        },
      },
      {
        mode: "webhook",
        publicUrl: "https://example.test/telegram/webhook",
        path: "/telegram/webhook",
        host: "0.0.0.0",
        port: 8787,
        secretToken: "secret-token",
        healthPath: "/healthz",
        readyPath: "/readyz",
        registerWebhook: true,
      }
    );

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(handled).toBe(false);

    expect(resolveUpdate).not.toBeNull();
    resolveUpdate!();
    await Promise.resolve();
    await Promise.resolve();
    expect(handled).toBe(true);
  });

  it("rejects invalid JSON payloads", async () => {
    const response = await handleTelegramWebhookRequest(
      new Request("http://127.0.0.1:8787/telegram/webhook", {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: "not-json",
      }),
      {
        api: {
          async deleteWebhook() {},
          async getWebhookInfo() {
            return { url: "https://example.test/telegram/webhook" };
          },
          async setWebhook() {},
        },
        async handleUpdate() {},
      },
      {
        mode: "webhook",
        publicUrl: "https://example.test/telegram/webhook",
        path: "/telegram/webhook",
        host: "0.0.0.0",
        port: 8787,
        secretToken: "secret-token",
        healthPath: "/healthz",
        readyPath: "/readyz",
        registerWebhook: true,
      }
    );

    expect(response.status).toBe(400);
  });

  it("reports failed readiness checks with 503", async () => {
    const response = await handleTelegramWebhookRequest(
      new Request("http://127.0.0.1:8787/readyz", {
        method: "GET",
      }),
      {
        api: {
          async deleteWebhook() {},
          async getWebhookInfo() {
            return { url: "https://example.test/telegram/webhook" };
          },
          async setWebhook() {},
        },
        async handleUpdate() {},
      },
      {
        mode: "webhook",
        publicUrl: "https://example.test/telegram/webhook",
        path: "/telegram/webhook",
        host: "0.0.0.0",
        port: 8787,
        secretToken: "secret-token",
        healthPath: "/healthz",
        readyPath: "/readyz",
        registerWebhook: true,
      },
      {
        getReadiness() {
          return {
            ok: false,
            status: 503,
            body: "remote-agent-codex-unavailable",
          };
        },
      }
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("remote-agent-codex-unavailable");
  });
});
