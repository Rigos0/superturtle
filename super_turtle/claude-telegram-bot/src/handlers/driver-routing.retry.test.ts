import { describe, expect, it } from "bun:test";
import { getDriver } from "../drivers/registry";
import { runMessageWithDriver } from "./driver-routing";

type DriverLike = {
  runMessage: (input: { message: string; source: string; statusCallback: (...args: any[]) => Promise<void> }) => Promise<string>;
  isStallError: (error: unknown) => boolean;
  isCrashError: (error: unknown) => boolean;
  kill: () => Promise<void>;
};

function baseInput(message: string) {
  return {
    message,
    source: "text" as const,
    username: "tester",
    userId: 123,
    chatId: 123,
    ctx: {} as any,
    statusCallback: async () => {},
  };
}

describe("driver routing retry parity", () => {
  it("retries stalled runs with tool activity using recovery prompt", async () => {
    const driver = getDriver("claude") as unknown as DriverLike;
    const original = {
      runMessage: driver.runMessage,
      isStallError: driver.isStallError,
      isCrashError: driver.isCrashError,
      kill: driver.kill,
    };

    const seenMessages: string[] = [];
    let attempts = 0;
    let kills = 0;

    try {
      driver.isStallError = (error) => String(error).toLowerCase().includes("stalled");
      driver.isCrashError = () => false;
      driver.kill = async () => {
        kills += 1;
      };
      driver.runMessage = async (input) => {
        attempts += 1;
        seenMessages.push(input.message);
        if (attempts === 1) {
          await input.statusCallback("tool", "<code>git status</code>");
          throw new Error("Event stream stalled for 120000ms before completion");
        }
        return "ok";
      };

      const result = await runMessageWithDriver("claude", baseInput("please check tunnel"));
      expect(result).toBe("ok");
      expect(attempts).toBe(2);
      expect(kills).toBe(0);
      expect(seenMessages[1]?.includes("Do not blindly repeat side-effecting operations")).toBe(true);
    } finally {
      driver.runMessage = original.runMessage;
      driver.isStallError = original.isStallError;
      driver.isCrashError = original.isCrashError;
      driver.kill = original.kill;
    }
  });

  it("retries stalled runs after spawn orchestration with a safe continuation prompt", async () => {
    const driver = getDriver("claude") as unknown as DriverLike;
    const original = {
      runMessage: driver.runMessage,
      isStallError: driver.isStallError,
      isCrashError: driver.isCrashError,
      kill: driver.kill,
    };

    const seenMessages: string[] = [];
    let attempts = 0;

    try {
      driver.isStallError = (error) => String(error).toLowerCase().includes("stalled");
      driver.isCrashError = () => false;
      driver.kill = async () => {};
      driver.runMessage = async (input) => {
        attempts += 1;
        seenMessages.push(input.message);
        if (attempts === 1) {
          await input.statusCallback(
            "tool",
            "<code>./super_turtle/subturtle/ctl spawn web-ui --prompt 'x'</code>"
          );
          throw new Error("Event stream stalled for 120000ms before completion");
        }
        return "ok";
      };

      const result = await runMessageWithDriver("claude", baseInput("spawn subturtle"));
      expect(result).toBe("ok");
      expect(attempts).toBe(2);
      expect(seenMessages[1]?.includes("/subturtle/ctl list")).toBe(true);
    } finally {
      driver.runMessage = original.runMessage;
      driver.isStallError = original.isStallError;
      driver.isCrashError = original.isCrashError;
      driver.kill = original.kill;
    }
  });
});
