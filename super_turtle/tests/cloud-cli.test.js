#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { resolve } = require("path");
const { spawn } = require("child_process");

const CLI_PATH = resolve(__dirname, "..", "bin", "superturtle.js");
const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-cloud-cli-"));
const sessionPath = resolve(tmpDir, "cloud-session.json");

let pollCount = 0;
let refreshCount = 0;
let sessionMode = "normal";
let statusMode = "normal";

function runCli(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : null;
    if (req.method === "POST" && req.url === "/v1/cli/login/start") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev-code-123",
        user_code: "USER-123",
        verification_uri: "https://example.com/verify",
        verification_uri_complete: "https://example.com/verify?code=USER-123",
        interval_ms: 10,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/cli/login/poll") {
      assert.strictEqual(body.device_code, "dev-code-123");
      pollCount += 1;
      if (pollCount === 1) {
        res.writeHead(428, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "authorization pending" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        entitlement: { plan: "managed", state: "active" },
        instance: { id: "inst_123" },
        provisioning_job: {
          state: "queued",
          updated_at: "2026-03-12T09:58:00Z",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/cli/session/refresh") {
      assert.strictEqual(body.refresh_token, "refresh-def");
      refreshCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/cli/session") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      if (sessionMode === "network-fail") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        entitlement: { plan: "managed", state: "active" },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/cli/cloud/status") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      if (statusMode === "network-fail") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
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
      }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    SUPERTURTLE_CLOUD_URL: baseUrl,
    SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
  };
  const postLoginEnv = {
    ...env,
    SUPERTURTLE_CLOUD_URL: "http://127.0.0.1:1",
  };

  try {
    const login = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(login.code, 0, login.stderr);
    assert.match(login.stdout, /Logged in\./);
    assert.ok(fs.existsSync(sessionPath), "expected cloud session file to exist");

    const savedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(savedSession.schema_version, 1);
    assert.strictEqual(savedSession.control_plane, baseUrl);
    assert.strictEqual(savedSession.access_token, "expired-access");
    assert.deepStrictEqual(savedSession.entitlement, { plan: "managed", state: "active" });
    assert.deepStrictEqual(savedSession.provisioning_job, {
      state: "queued",
      updated_at: "2026-03-12T09:58:00Z",
    });
    assert.ok(savedSession.identity_sync_at, "expected login to persist an initial identity sync timestamp");
    assert.ok(savedSession.cloud_status_sync_at, "expected login to persist an initial cloud status sync timestamp");
    assert.ok(savedSession.last_sync_at, "expected login to persist an initial sync timestamp");
    const mode = fs.statSync(sessionPath).mode & 0o777;
    assert.strictEqual(mode, 0o600);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ ...savedSession, control_plane: "http://127.0.0.1:1" }, null, 2)}\n`
    );

    const cachedWhoamiFromLogin = await runCli(["whoami"], env);
    assert.strictEqual(cachedWhoamiFromLogin.code, 0, cachedWhoamiFromLogin.stderr);
    assert.match(cachedWhoamiFromLogin.stderr, /using cached identity snapshot/i);
    assert.match(cachedWhoamiFromLogin.stdout, /User: user@example.com/);
    assert.match(cachedWhoamiFromLogin.stdout, /Plan: managed/);

    const cachedStatusFromLogin = await runCli(["cloud", "status"], env);
    assert.strictEqual(cachedStatusFromLogin.code, 0, cachedStatusFromLogin.stderr);
    assert.match(cachedStatusFromLogin.stderr, /using cached cloud status snapshot/i);
    assert.match(cachedStatusFromLogin.stdout, /Instance: inst_123/);
    assert.match(cachedStatusFromLogin.stdout, /Provisioning: queued/);

    fs.writeFileSync(sessionPath, `${JSON.stringify(savedSession, null, 2)}\n`);
    fs.chmodSync(sessionPath, 0o644);

    const whoami = await runCli(["whoami"], postLoginEnv);
    assert.strictEqual(whoami.code, 0, whoami.stderr);
    assert.match(whoami.stdout, new RegExp(`Control plane: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(whoami.stdout, /User: user@example.com/);
    assert.match(whoami.stdout, /Plan: managed/);
    assert.strictEqual(refreshCount, 1, "expected whoami to refresh the expired session");
    assert.strictEqual(fs.statSync(sessionPath).mode & 0o777, 0o600);

    const refreshedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(refreshedSession.access_token, "access-abc");
    assert.strictEqual(refreshedSession.refresh_token, "refresh-ghi");
    assert.deepStrictEqual(refreshedSession.entitlement, { plan: "managed", state: "active" });
    assert.deepStrictEqual(refreshedSession.workspace, { slug: "acme" });
    assert.ok(refreshedSession.identity_sync_at, "expected identity fetch to persist identity_sync_at");

    const status = await runCli(["cloud", "status"], postLoginEnv);
    assert.strictEqual(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Control plane: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(status.stdout, /State: provisioning/);
    assert.match(status.stdout, /Provisioning: running/);

    const statusSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(statusSession.instance, {
      id: "inst_123",
      state: "provisioning",
      region: "us-central1",
      hostname: "managed-123.internal",
    });
    assert.deepStrictEqual(statusSession.provisioning_job, {
      state: "running",
      updated_at: "2026-03-12T09:59:00Z",
    });
    assert.ok(statusSession.cloud_status_sync_at, "expected cloud status fetch to persist cloud_status_sync_at");

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ ...statusSession, control_plane: "http://127.0.0.1:1" }, null, 2)}\n`
    );

    const cachedWhoami = await runCli(["whoami"], env);
    assert.strictEqual(cachedWhoami.code, 0, cachedWhoami.stderr);
    assert.match(cachedWhoami.stderr, /using cached identity snapshot/i);
    assert.match(cachedWhoami.stdout, /User: user@example.com/);
    assert.match(cachedWhoami.stdout, /Plan: managed/);

    const cachedStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(cachedStatus.code, 0, cachedStatus.stderr);
    assert.match(cachedStatus.stderr, /using cached cloud status snapshot/i);
    assert.match(cachedStatus.stdout, /Instance: inst_123/);
    assert.match(cachedStatus.stdout, /Provisioning: running/);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    sessionMode = "network-fail";

    const cachedWhoamiAfterRefresh = await runCli(["whoami"], postLoginEnv);
    assert.strictEqual(cachedWhoamiAfterRefresh.code, 0, cachedWhoamiAfterRefresh.stderr);
    assert.match(cachedWhoamiAfterRefresh.stderr, /using cached identity snapshot/i);
    const refreshedCachedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(refreshedCachedSession.access_token, "access-abc");
    assert.strictEqual(refreshedCachedSession.refresh_token, "refresh-ghi");
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
      }, null, 2)}\n`
    );
    sessionMode = "network-fail";

    const legacyWhoami = await runCli(["whoami"], env);
    assert.strictEqual(legacyWhoami.code, 0, legacyWhoami.stderr);
    assert.match(legacyWhoami.stderr, /using cached identity snapshot/i);
    const migratedLegacySession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(migratedLegacySession.schema_version, 1);
    assert.strictEqual(migratedLegacySession.control_plane, baseUrl);
    assert.strictEqual(migratedLegacySession.refresh_token, "refresh-ghi");
    assert.ok(migratedLegacySession.created_at, "expected legacy session migration to backfill created_at");
    assert.ok(migratedLegacySession.last_sync_at, "expected legacy session migration to backfill last_sync_at");
    assert.ok(
      migratedLegacySession.identity_sync_at,
      "expected legacy session migration to backfill identity_sync_at when cached identity exists"
    );
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        instance: {
          id: "inst_123",
          state: "running",
        },
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    statusMode = "network-fail";

    const legacyStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(legacyStatus.code, 0, legacyStatus.stderr);
    assert.match(legacyStatus.stderr, /using cached cloud status snapshot/i);
    const migratedLegacyStatusSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(migratedLegacyStatusSession.schema_version, 1);
    assert.strictEqual(migratedLegacyStatusSession.control_plane, baseUrl);
    assert.ok(
      migratedLegacyStatusSession.cloud_status_sync_at,
      "expected legacy session migration to backfill cloud_status_sync_at when cached status exists"
    );
    statusMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...migratedLegacyStatusSession,
        schema_version: 99,
      }, null, 2)}\n`
    );

    const futureWhoami = await runCli(["whoami"], env);
    assert.strictEqual(futureWhoami.code, 1);
    assert.match(futureWhoami.stderr, /uses schema_version 99/i);
    assert.match(futureWhoami.stderr, /Upgrade SuperTurtle|superturtle logout/i);
    const futureSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(
      futureSession.schema_version,
      99,
      "expected unsupported future session files to remain untouched"
    );

    fs.writeFileSync(sessionPath, "{not-json\n");
    const corruptWhoami = await runCli(["whoami"], env);
    assert.strictEqual(corruptWhoami.code, 1);
    assert.match(corruptWhoami.stderr, /Hosted session file .* invalid JSON/i);
    assert.match(corruptWhoami.stderr, /superturtle logout/i);

    const logout = await runCli(["logout"], env);
    assert.strictEqual(logout.code, 0, logout.stderr);
    assert.ok(!fs.existsSync(sessionPath), "expected logout to remove session file");
  } finally {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  }
});
