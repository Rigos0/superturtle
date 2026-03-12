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
        access_token: "access-abc",
        refresh_token: "refresh-def",
        expires_at: "2026-03-12T10:00:00Z",
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        instance: { id: "inst_123" },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/cli/session") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
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

  try {
    const login = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(login.code, 0, login.stderr);
    assert.match(login.stdout, /Logged in\./);
    assert.ok(fs.existsSync(sessionPath), "expected cloud session file to exist");

    const whoami = await runCli(["whoami"], env);
    assert.strictEqual(whoami.code, 0, whoami.stderr);
    assert.match(whoami.stdout, /User: user@example.com/);
    assert.match(whoami.stdout, /Plan: managed/);

    const status = await runCli(["cloud", "status"], env);
    assert.strictEqual(status.code, 0, status.stderr);
    assert.match(status.stdout, /State: provisioning/);
    assert.match(status.stdout, /Provisioning: running/);

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
