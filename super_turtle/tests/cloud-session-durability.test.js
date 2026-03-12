const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { dirname, resolve } = require("path");

const { clearSession, writeSession } = require("../bin/cloud.js");

const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-cloud-session-durable-"));
const sessionPath = resolve(tmpDir, "cloud-session.json");
const env = {
  ...process.env,
  SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
};

const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalFsyncSync = fs.fsyncSync;

const openPathsByFd = new Map();
const fsyncTargets = [];

fs.openSync = function patchedOpenSync(path, flags, mode) {
  const fd = originalOpenSync.call(fs, path, flags, mode);
  openPathsByFd.set(fd, path);
  return fd;
};

fs.closeSync = function patchedCloseSync(fd) {
  openPathsByFd.delete(fd);
  return originalCloseSync.call(fs, fd);
};

fs.fsyncSync = function patchedFsyncSync(fd) {
  fsyncTargets.push(openPathsByFd.get(fd) || null);
  return originalFsyncSync.call(fs, fd);
};

try {
  writeSession(
    {
      access_token: "access-abc",
      refresh_token: "refresh-def",
      control_plane: "https://api.superturtle.dev",
    },
    env
  );

  assert.ok(fs.existsSync(sessionPath), "expected writeSession to persist the hosted session file");
  const tempTarget = fsyncTargets.find(
    (target) => typeof target === "string" && target.startsWith(`${sessionPath}.`) && target.endsWith(".tmp")
  );
  assert.ok(tempTarget, "expected writeSession to fsync the temporary hosted session file before rename");
  assert.ok(fsyncTargets.includes(sessionPath), "expected writeSession to fsync the final hosted session file");

  if (process.platform !== "win32") {
    assert.ok(
      fsyncTargets.includes(dirname(sessionPath)),
      "expected writeSession to fsync the parent directory after replacing the hosted session file"
    );
  }

  fsyncTargets.length = 0;
  clearSession(env);
  assert.ok(!fs.existsSync(sessionPath), "expected clearSession to remove the hosted session file");

  if (process.platform !== "win32") {
    assert.ok(
      fsyncTargets.includes(dirname(sessionPath)),
      "expected clearSession to fsync the parent directory after deleting the hosted session file"
    );
  }
} finally {
  fs.openSync = originalOpenSync;
  fs.closeSync = originalCloseSync;
  fs.fsyncSync = originalFsyncSync;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
