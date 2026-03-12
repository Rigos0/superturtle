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

  assert.throws(
    () =>
      writeSession(
        {
          access_token: 42,
          refresh_token: "refresh-def",
          control_plane: "https://api.superturtle.dev",
        },
        env
      ),
    /Hosted session file .* invalid access_token/i
  );
  assert.ok(
    !fs.existsSync(sessionPath),
    "expected invalid hosted session writes to fail before recreating the session file"
  );

  assert.throws(
    () =>
      writeSession(
        {
          access_token: "access-abc",
          refresh_token: "refresh-def",
          control_plane: "https://api.superturtle.dev",
          user: { id: "user_123", email: "user@example.com" },
          workspace: { slug: "acme" },
          entitlement: { plan: "managed", state: "active" },
          instance: {
            id: "inst_123",
            state: "provisioning",
            region: "us-central1",
            hostname: "managed-123.internal",
          },
          provisioning_job: {
            state: "running",
            updated_at: "2026-03-12T09:59:00Z",
          },
          padding: "x".repeat(4096),
        },
        {
          ...env,
          SUPERTURTLE_CLOUD_SESSION_MAX_BYTES: "512",
        }
      ),
    /Hosted session file .* exceeds the configured size limit of 512 bytes/i
  );
  assert.ok(
    !fs.existsSync(sessionPath),
    "expected oversized hosted session writes to fail before recreating the session file"
  );

  if (process.platform !== "win32" && typeof fs.constants?.O_NOFOLLOW === "number") {
    const redirectedPath = resolve(tmpDir, "redirected.json");
    fs.writeFileSync(redirectedPath, "{\"access_token\":\"stolen\"}\n", "utf-8");
    const redirectedContents = fs.readFileSync(redirectedPath, "utf-8");
    let swappedForFinalSync = false;

    fs.openSync = function patchedFinalSyncOpen(path, flags, mode) {
      if (path === sessionPath && !swappedForFinalSync) {
        swappedForFinalSync = true;
        fs.unlinkSync(sessionPath);
        fs.symlinkSync(redirectedPath, sessionPath);
      }
      const fd = originalOpenSync.call(fs, path, flags, mode);
      openPathsByFd.set(fd, path);
      return fd;
    };

    assert.throws(
      () =>
        writeSession(
          {
            access_token: "access-ghi",
            refresh_token: "refresh-jkl",
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /Hosted session file at .* must be a regular file/i
    );
    assert.ok(swappedForFinalSync, "expected final session fsync test to swap the session path");
    assert.ok(fs.lstatSync(sessionPath).isSymbolicLink(), "expected swapped session path to remain a symlink");
    assert.strictEqual(
      fs.readFileSync(redirectedPath, "utf-8"),
      redirectedContents,
      "expected final session fsync to avoid touching the redirected target"
    );

    fs.unlinkSync(sessionPath);
    fs.openSync = function patchedOpenSync(path, flags, mode) {
      const fd = originalOpenSync.call(fs, path, flags, mode);
      openPathsByFd.set(fd, path);
      return fd;
    };
  }
} finally {
  fs.openSync = originalOpenSync;
  fs.closeSync = originalCloseSync;
  fs.fsyncSync = originalFsyncSync;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
