import { afterEach, describe, expect, it } from "bun:test";
import { createCodexPendingOutputCoordinator } from "./codex-pending-outputs";

const originalPendingRequestTimeoutMs =
  process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  if (originalPendingRequestTimeoutMs === undefined) {
    delete process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS;
    return;
  }
  process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS =
    originalPendingRequestTimeoutMs;
});

describe("createCodexPendingOutputCoordinator().handleToolCompletion()", () => {
  it("treats ask_user as handled when delivery completes during the grace window", async () => {
    process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS = "20";

    let askUserCalls = 0;
    const coordinator = createCodexPendingOutputCoordinator({
      driverId: "codex",
      chatId: 123,
      checks: {
        ask_user: async () => {
          askUserCalls += 1;
          await wait(35);
          return true;
        },
        send_file: async () => false,
        send_image: async () => false,
        send_turtle: async () => false,
        bot_control: async () => false,
        pino_logs: async () => false,
      },
      outboundMessageKindForTool: () => null,
    });

    const handled = await coordinator.handleToolCompletion("ask_user");

    expect(handled).toBe(true);
    expect(askUserCalls).toBe(1);
  });

  it("does not apply the grace window to non-ask_user tools", async () => {
    process.env.CODEX_PENDING_REQUEST_TIMEOUT_MS = "20";

    let sendImageCalls = 0;
    const coordinator = createCodexPendingOutputCoordinator({
      driverId: "codex",
      chatId: 123,
      checks: {
        ask_user: async () => false,
        send_file: async () => false,
        send_image: async () => {
          sendImageCalls += 1;
          await wait(35);
          return true;
        },
        send_turtle: async () => false,
        bot_control: async () => false,
        pino_logs: async () => false,
      },
      outboundMessageKindForTool: () => null,
    });

    const handled = await coordinator.handleToolCompletion("send_image");

    expect(handled).toBe(false);
    expect(sendImageCalls).toBe(3);
  });
});
