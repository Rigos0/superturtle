import { afterEach, describe, expect, it } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const { stopAllRunningSubturtles, stopAllRunningWork } = await import("./stop");
const { getDriver } = await import("../drivers/registry");
const { session } = await import("../session");

const originalSpawnSync = Bun.spawnSync;
const originalSessionDriver = session.activeDriver;
const originalStopTyping = session.stopTyping;
const claudeDriver = getDriver("claude");
const codexDriver = getDriver("codex");
const originalClaudeStop = claudeDriver.stop;
const originalCodexStop = codexDriver.stop;

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
  session.activeDriver = originalSessionDriver;
  session.stopTyping = originalStopTyping;
  claudeDriver.stop = originalClaudeStop;
  codexDriver.stop = originalCodexStop;
});

describe("stop handlers", () => {
  it("deduplicates running SubTurtle names and stops each once", () => {
    const commands: string[][] = [];

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      commands.push(args);

      if (args[1] === "list") {
        return {
          stdout: Buffer.from(
            [
              "alpha running yolo-codex (PID 1111) 9m left",
              "→ https://alpha.example",
              "alpha running yolo-codex (PID 1111) 8m left",
              "beta stopped",
            ].join("\n")
          ),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      if (args[1] === "stop" && args[2] === "alpha") {
        return {
          stdout: Buffer.from("stopped"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const result = stopAllRunningSubturtles();

    expect(result).toEqual({
      attempted: ["alpha"],
      stopped: ["alpha"],
      failed: [],
    });
    expect(commands.filter((args) => args[1] === "stop")).toHaveLength(1);
  });

  it("stops typing, stops active driver, and stops listed SubTurtles", async () => {
    let stopTypingCalls = 0;
    let claudeStops = 0;
    let codexStops = 0;

    session.stopTyping = () => {
      stopTypingCalls += 1;
    };
    session.activeDriver = "claude";
    claudeDriver.stop = async () => {
      claudeStops += 1;
      return "stopped";
    };
    codexDriver.stop = async () => {
      codexStops += 1;
      return false;
    };

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));

      if (args[1] === "list") {
        return {
          stdout: Buffer.from(
            [
              "alpha running yolo-codex (PID 1111) 9m left",
              "gamma running yolo (PID 2222) 1m left",
            ].join("\n")
          ),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      if (args[1] === "stop" && args[2] === "alpha") {
        return {
          stdout: Buffer.from("stopped"),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      if (args[1] === "stop" && args[2] === "gamma") {
        return {
          stdout: Buffer.from("failed"),
          stderr: Buffer.from(""),
          success: false,
          exitCode: 1,
        } as ReturnType<typeof Bun.spawnSync>;
      }

      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const result = await stopAllRunningWork();

    expect(result).toEqual({
      driverStopResult: "stopped",
      queueCleared: 0,
      attempted: ["alpha", "gamma"],
      stopped: ["alpha"],
      failed: ["gamma"],
    });
    expect(stopTypingCalls).toBe(1);
    expect(claudeStops).toBe(1);
    expect(codexStops).toBe(0);
  });

  it("does not clear stopRequested when Claude stop returns pending", async () => {
    const restoreProcessing = session.startProcessing();
    session.activeDriver = "claude";
    session.stopTyping = () => {};

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    try {
      const result = await stopAllRunningWork();
      expect(result.driverStopResult).toBe("pending");
      expect(session.isStopRequested).toBe(true);
    } finally {
      session.clearStopRequested();
      restoreProcessing();
    }
  });

  it("clears stopRequested when Claude stop returns stopped", async () => {
    session.activeDriver = "claude";
    session.stopTyping = () => {};

    let clearCalls = 0;
    const originalClearStopRequested = session.clearStopRequested.bind(session);
    session.clearStopRequested = () => {
      clearCalls += 1;
      originalClearStopRequested();
    };

    let killed = false;
    (session as unknown as { isQueryRunning: boolean }).isQueryRunning = true;
    (session as unknown as { activeProcess: { kill: () => void } | null }).activeProcess = {
      kill: () => {
        killed = true;
      },
    };

    Bun.spawnSync = ((cmd: unknown, _opts?: unknown) => {
      if (!Array.isArray(cmd)) {
        return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0]);
      }
      const args = cmd.map((part) => String(part));
      if (args[1] === "list") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("unexpected command"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    try {
      const result = await stopAllRunningWork();
      expect(result.driverStopResult).toBe("stopped");
      expect(killed).toBe(true);
      expect(clearCalls).toBe(1);
      expect(session.isStopRequested).toBe(false);
    } finally {
      session.clearStopRequested = originalClearStopRequested;
      (session as unknown as { isQueryRunning: boolean }).isQueryRunning = false;
      (session as unknown as { activeProcess: null }).activeProcess = null;
      session.clearStopRequested();
    }
  });
});
