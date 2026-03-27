const assert = require("assert");

const { __test__ } = require("../bin/superturtle.js");

(async () => {
  assert.deepStrictEqual(
    __test__.parseExactRuntimeInstallSpec("superturtle@0.2.9-beta.143.1"),
    {
      installSpec: "superturtle@0.2.9-beta.143.1",
      version: "0.2.9-beta.143.1",
    }
  );
  assert.strictEqual(__test__.parseExactRuntimeInstallSpec("superturtle@managed-codex"), null);
  assert.strictEqual(__test__.parseExactRuntimeInstallSpec("latest"), null);

  assert.deepStrictEqual(
    __test__.parseSelfUpdateRunnerArgs([
      "--cwd",
      "/tmp/project",
      "--spec",
      "superturtle@0.2.9-beta.143.1",
    ]),
    {
      cwd: "/tmp/project",
      installSpec: "superturtle@0.2.9-beta.143.1",
    }
  );

  assert.strictEqual(
    __test__.getInstanceLockPathForEnv({ TELEGRAM_BOT_TOKEN: "12345:abc" }),
    "/tmp/claude-telegram-bot.12345.instance.lock"
  );

  {
    const signalCalls = [];
    let servicePidFile = 100;
    let lockPid = 300;
    const livePids = new Set([200, 300]);
    const result = await __test__.waitForServiceRunnerShutdown(
      "/tmp/project",
      100,
      100,
      {
        projectEnv: { TELEGRAM_BOT_TOKEN: "12345:abc" },
        initialTrackedPids: [100, 200, 300],
        pollIntervalMs: 1,
        softKillAfterMs: 0,
        hardKillAfterMs: 50,
      },
      {
        listProcesses: () => [
          { pid: 200, ppid: 1, command: "/bin/bash run-loop.sh" },
          { pid: 300, ppid: 200, command: "bun run src/index.ts" },
        ],
        isPidRunning: (pid) => livePids.has(pid),
        readServicePid: () => servicePidFile,
        signalPidSet: (pids, signal) => {
          signalCalls.push({ pids: [...pids], signal });
          if (signal === "TERM") {
            livePids.clear();
            servicePidFile = null;
            lockPid = null;
          }
          return [...pids];
        },
        removeStaleInstanceLock: () => ({ removed: false, pid: lockPid }),
        inspectInstanceLock: () => ({
          path: "/tmp/claude-telegram-bot.12345.instance.lock",
          exists: Number.isInteger(lockPid),
          pid: lockPid,
          alive: Number.isInteger(lockPid) && livePids.has(lockPid),
        }),
        sleep: async () => {},
        logger: () => {},
      }
    );

    assert.deepStrictEqual(signalCalls, [
      { pids: [200, 300], signal: "TERM" },
    ]);
    assert.deepStrictEqual(result.trackedPids, [100, 200, 300]);
  }

  {
    const signalCalls = [];
    let servicePidFile = 100;
    const livePids = new Set([1129]);
    const result = await __test__.waitForServiceRunnerShutdown(
      "/tmp/project",
      100,
      100,
      {
        projectEnv: { TELEGRAM_BOT_TOKEN: "12345:abc" },
        initialTrackedPids: [100, 200, 1129, 1136],
        ignoredPids: [1129],
        pollIntervalMs: 1,
        softKillAfterMs: 0,
        hardKillAfterMs: 50,
      },
      {
        listProcesses: () => [
          { pid: 1129, ppid: 1, command: "node superturtle service self-update-runner" },
          { pid: 1136, ppid: 1129, command: "ps -eo pid,ppid,command" },
        ],
        isPidRunning: (pid) => livePids.has(pid),
        readServicePid: () => servicePidFile,
        signalPidSet: (pids, signal) => {
          signalCalls.push({ pids: [...pids], signal });
          return [...pids];
        },
        removeStaleServicePid: () => {
          servicePidFile = null;
          return { removed: true, pid: 100 };
        },
        removeStaleInstanceLock: () => ({ removed: false, pid: null }),
        inspectInstanceLock: () => ({
          path: "/tmp/claude-telegram-bot.12345.instance.lock",
          exists: false,
          pid: null,
          alive: false,
        }),
        sleep: async () => {},
        logger: () => {},
      }
    );

    assert.deepStrictEqual(signalCalls, []);
    assert.deepStrictEqual(result.trackedPids, [100, 200]);
  }

  {
    let tick = 0;
    const replacement = await __test__.waitForReplacementServiceRunner(
      "/tmp/project",
      100,
      100,
      {
        projectEnv: { TELEGRAM_BOT_TOKEN: "12345:abc" },
        pollIntervalMs: 1,
      },
      {
        readServicePid: () => (tick >= 1 ? 980 : null),
        isPidRunning: (pid) => pid === 980 || pid === 1500,
        removeStaleInstanceLock: () => ({ removed: false, pid: null }),
        inspectInstanceLock: () => ({
          path: "/tmp/claude-telegram-bot.12345.instance.lock",
          exists: tick >= 2,
          pid: tick >= 2 ? 1500 : null,
          alive: tick >= 2,
        }),
        sleep: async () => {
          tick += 1;
        },
        logger: () => {},
      }
    );

    assert.deepStrictEqual(replacement, {
      servicePid: 980,
      instanceLockPath: "/tmp/claude-telegram-bot.12345.instance.lock",
      lockPid: 1500,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
