const { afterEach, describe, expect, it } = require("bun:test");

const { __test__ } = require("./superturtle.js");

const originalProcessKill = process.kill;

afterEach(() => {
  process.kill = originalProcessKill;
});

describe("superturtle service runner helpers", () => {
  it("uses the direct run-loop command for macOS tmux starts", () => {
    const command = __test__.buildTmuxStartCommand({
      cwd: "/tmp/project",
      logPath: "/tmp/superturtle-loop.log",
      restartOnCrash: "1",
      platform: "darwin",
      commandExists: (commandName) => commandName === "caffeinate",
    });

    expect(command).toContain('export CLAUDE_WORKING_DIR="/tmp/project"');
    expect(command).toContain('export SUPERTURTLE_RESTART_ON_CRASH="1"');
    expect(command).toContain('exec caffeinate -s ./run-loop.sh 2>&1 | tee -a "/tmp/superturtle-loop.log"');
    expect(command).not.toContain("service run");
  });

  it("keeps the service runner for linux tmux starts", () => {
    const command = __test__.buildTmuxStartCommand({
      cwd: "/tmp/project",
      logPath: "/tmp/superturtle-loop.log",
      restartOnCrash: "1",
      platform: "linux",
    });

    expect(command).toContain("service run");
    expect(command).not.toContain("./run-loop.sh");
  });

  it("spawns the service child detached on non-Windows platforms", () => {
    const opts = __test__.buildServiceChildSpawnOptions({ TEST_ENV: "1" });
    expect(opts.cwd).toContain("/super_turtle/claude-telegram-bot");
    expect(opts.stdio).toBe("inherit");
    expect(opts.detached).toBe(process.platform !== "win32");
  });

  it("falls back to child.kill when process-group termination fails", () => {
    const processKillCalls = [];
    const childKillCalls = [];
    process.kill = (pid, signal) => {
      processKillCalls.push([pid, signal]);
      throw new Error("ESRCH");
    };

    __test__.terminateChildProcessGroup(
      {
        pid: 4321,
        exitCode: null,
        killed: false,
        kill: (signal) => {
          childKillCalls.push(signal);
        },
      },
      "SIGTERM"
    );

    expect(processKillCalls).toEqual([[-4321, "SIGTERM"]]);
    expect(childKillCalls).toEqual(["SIGTERM"]);
  });
});
