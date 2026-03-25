import { afterEach, describe, expect, it, mock } from "bun:test";

async function loadCommandsModule(e2bApiKey: string) {
  const actualConfig = await import("../config");
  mock.module("../config", () => ({
    ...actualConfig,
    E2B_API_KEY: e2bApiKey,
    TELEPORT_COMMANDS_ENABLED: e2bApiKey.trim().length > 0,
  }));

  return import(`./commands.ts?commands-metadata=${e2bApiKey || "none"}-${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  mock.restore();
});

describe("TELEGRAM_COMMANDS", () => {
  it("publishes the local command set without teleport commands when E2B is not configured", async () => {
    const { TELEGRAM_COMMANDS } = await loadCommandsModule("");
    const names = TELEGRAM_COMMANDS.map((entry: { command: string }) => entry.command);

    expect(names).toEqual([
      "new",
      "stop",
      "model",
      "usage",
      "resume",
      "sub",
      "cron",
      "debug",
      "restart",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(TELEGRAM_COMMANDS.every((entry: { description: string }) => entry.description.trim().length > 0)).toBe(true);
  });

  it("publishes the same local command set when E2B is configured", async () => {
    const { TELEGRAM_COMMANDS } = await loadCommandsModule("test-e2b-key");
    const names = TELEGRAM_COMMANDS.map((entry: { command: string }) => entry.command);

    expect(names).not.toContain("teleport");
    expect(names).not.toContain("home");
    expect(new Set(names).size).toBe(names.length);
    expect(TELEGRAM_COMMANDS.every((entry: { description: string }) => entry.description.trim().length > 0)).toBe(true);
  });
});
