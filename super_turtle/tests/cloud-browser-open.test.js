const assert = require("assert");
const childProcess = require("child_process");

const cloudModulePath = require.resolve("../bin/cloud.js");
const originalSpawnSync = childProcess.spawnSync;

function loadCloudWithSpawnStub(spawnStub) {
  delete require.cache[cloudModulePath];
  childProcess.spawnSync = spawnStub;
  return require("../bin/cloud.js");
}

try {
  let captured = null;
  let cloud = loadCloudWithSpawnStub((command, args, options) => {
    captured = { command, args, options };
    return { status: 0, error: null };
  });

  const opened = cloud.openBrowser("https://superturtle.dev/login", {
    SUPERTURTLE_CLOUD_BROWSER_TIMEOUT_MS: "1234",
  });
  assert.strictEqual(opened, true);
  assert.ok(captured, "expected browser launch to invoke spawnSync");
  assert.strictEqual(captured.options.timeout, 1234);
  assert.strictEqual(captured.options.stdio, "ignore");

  cloud = loadCloudWithSpawnStub(() => ({ status: null, error: new Error("timed out") }));
  const timedOut = cloud.openBrowser("https://superturtle.dev/login");
  assert.strictEqual(timedOut, false, "expected timed out browser launches to fail closed");

  cloud = loadCloudWithSpawnStub(() => {
    throw new Error("spawnSync should not be called for invalid timeout config");
  });
  assert.throws(
    () => cloud.openBrowser("https://superturtle.dev/login", {
      SUPERTURTLE_CLOUD_BROWSER_TIMEOUT_MS: "0",
    }),
    /Configured hosted browser launch timeout must be a positive number of milliseconds/i
  );
} finally {
  childProcess.spawnSync = originalSpawnSync;
  delete require.cache[cloudModulePath];
}
