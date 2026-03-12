import { describe, expect, it } from "bun:test";
import { TELEGRAM_COMMANDS } from "./commands";

describe("TELEGRAM_COMMANDS", () => {
  it("publishes unique canonical slash commands for Telegram autocomplete", () => {
    const names = TELEGRAM_COMMANDS.map((entry) => entry.command);

    expect(names).toEqual([
      "new",
      "stop",
      "teleport",
      "model",
      "switch",
      "usage",
      "context",
      "status",
      "looplogs",
      "pinologs",
      "resume",
      "sub",
      "cron",
      "debug",
      "restart",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(TELEGRAM_COMMANDS.every((entry) => entry.description.trim().length > 0)).toBe(true);
  });
});
