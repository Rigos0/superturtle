const assert = require("assert");

const { __test__ } = require("../bin/superturtle.js");

(() => {
  const darwinCommand = __test__.buildPlatformServiceCommand({
    cwd: "/tmp/project",
    logPath: "/tmp/superturtle-loop.log",
    restartOnCrash: "1",
    platform: "darwin",
    commandExists: (commandName) => commandName === "caffeinate",
  });

  assert.strictEqual(darwinCommand.keepAwakeCommand, "caffeinate -s");
  assert.match(darwinCommand.serviceCommand, /export SUPER_TURTLE_PROJECT_DIR="\/tmp\/project"/);
  assert.match(darwinCommand.serviceCommand, /export SUPERTURTLE_RESTART_ON_CRASH="1"/);
  assert.match(
    darwinCommand.serviceCommand,
    /exec caffeinate -s \.\/run-loop\.sh 2>&1 \| tee -a "\/tmp\/superturtle-loop\.log"/
  );

  const linuxCommand = __test__.buildPlatformServiceCommand({
    cwd: "/tmp/project",
    logPath: "/tmp/superturtle-loop.log",
    restartOnCrash: "1",
    platform: "linux",
    commandExists: (commandName) => commandName === "systemd-inhibit",
  });

  assert.strictEqual(
    linuxCommand.keepAwakeCommand,
    "systemd-inhibit --what=idle --who=superturtle --why='Bot running' --mode=block"
  );
  assert.match(linuxCommand.serviceCommand, /exec systemd-inhibit .* \.\/run-loop\.sh 2>&1 \| tee -a/);

  const noWrapperCommand = __test__.buildPlatformServiceCommand({
    cwd: "/tmp/project",
    logPath: "/tmp/superturtle-loop.log",
    restartOnCrash: "1",
    platform: "darwin",
    commandExists: () => false,
  });

  assert.strictEqual(noWrapperCommand.keepAwakeCommand, "");
  assert.doesNotMatch(noWrapperCommand.serviceCommand, /caffeinate|systemd-inhibit/);
})();
