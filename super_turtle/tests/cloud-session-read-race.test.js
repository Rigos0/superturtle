const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { resolve } = require("path");

const { readSession, writeSession } = require("../bin/cloud.js");

if (process.platform === "win32" || typeof fs.constants?.O_NOFOLLOW !== "number") {
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-cloud-session-read-race-"));
const sessionPath = resolve(tmpDir, "cloud-session.json");
const redirectedPath = resolve(tmpDir, "redirected.json");
const env = {
  ...process.env,
  SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
};

const originalOpenSync = fs.openSync;
let swapped = false;

try {
  writeSession(
    {
      access_token: "access-abc",
      refresh_token: "refresh-def",
      control_plane: "https://api.superturtle.dev",
    },
    env
  );
  fs.writeFileSync(redirectedPath, "{\"access_token\":\"stolen\"}\n", "utf-8");

  fs.openSync = function patchedOpenSync(path, flags, mode) {
    if (path === sessionPath && !swapped) {
      swapped = true;
      fs.unlinkSync(sessionPath);
      fs.symlinkSync(redirectedPath, sessionPath);
    }
    return originalOpenSync.call(fs, path, flags, mode);
  };

  assert.throws(
    () => readSession(env),
    /Hosted session file at .* must be a regular file/i
  );
  assert.ok(fs.lstatSync(sessionPath).isSymbolicLink(), "expected test to replace the session path with a symlink");
} finally {
  fs.openSync = originalOpenSync;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
