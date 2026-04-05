const { afterEach, describe, expect, it } = require("bun:test");

const { __test__ } = require("./superturtle.js");

const originalProcessKill = process.kill;

afterEach(() => {
  process.kill = originalProcessKill;
});

describe("superturtle service runner helpers", () => {
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

  it("collects ancestor pids up to init", () => {
    const tracked = __test__.collectAncestorProcessIds(
      [
        { pid: 1336, ppid: 1332, command: "bun run src/index.ts" },
        { pid: 1332, ppid: 1329, command: "/bin/bash run-loop.sh" },
        { pid: 1329, ppid: 1, command: "bash -lc superturtle service run" },
      ],
      1336
    );

    expect(Array.from(tracked)).toEqual([1336, 1332, 1329]);
  });

  it("discovers tracked runtime pids from service pid and instance lock ancestry", () => {
    const discovery = __test__.discoverTrackedRuntimePids(
      "/workspace/project",
      { TELEGRAM_BOT_TOKEN: "123:test" },
      {
        listProcesses: () => [
          { pid: 1329, ppid: 1, command: "bash -lc superturtle service run" },
          { pid: 1332, ppid: 1329, command: "/bin/bash run-loop.sh" },
          { pid: 1336, ppid: 1332, command: "bun run src/index.ts" },
        ],
        readServicePid: () => null,
        isPidRunning: (pid) => [1329, 1332, 1336].includes(pid),
        inspectInstanceLock: () => ({
          path: "/tmp/claude-telegram-bot.123.instance.lock",
          exists: true,
          pid: 1336,
          alive: true,
        }),
      }
    );

    expect(discovery.lockPidMatchesRuntime).toBe(true);
    expect(discovery.servicePid).toBeNull();
    expect(discovery.instanceLockPath).toBe("/tmp/claude-telegram-bot.123.instance.lock");
    expect(discovery.trackedPids).toEqual([1329, 1332, 1336]);
  });

  it("ignores live instance-lock pids that do not look like the bot runtime", () => {
    const discovery = __test__.discoverTrackedRuntimePids(
      "/workspace/project",
      { TELEGRAM_BOT_TOKEN: "123:test" },
      {
        listProcesses: () => [
          { pid: 7777, ppid: 1, command: "node /tmp/something-else.js" },
        ],
        readServicePid: () => null,
        isPidRunning: (pid) => pid === 7777,
        inspectInstanceLock: () => ({
          path: "/tmp/claude-telegram-bot.123.instance.lock",
          exists: true,
          pid: 7777,
          alive: true,
          valid: true,
        }),
      }
    );

    expect(discovery.lockPidMatchesRuntime).toBe(false);
    expect(discovery.trackedPids).toEqual([]);
  });
});
