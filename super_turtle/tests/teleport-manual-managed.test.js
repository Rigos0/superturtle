#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { resolve } = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "super_turtle", "scripts", "teleport-manual.sh");
const TELEPORT_CONTEXT_PATH = resolve(REPO_ROOT, ".superturtle", "teleport", "context.json");

function seedTeleportContext() {
  fs.mkdirSync(resolve(REPO_ROOT, ".superturtle", "teleport"), { recursive: true });
  fs.writeFileSync(
    TELEPORT_CONTEXT_PATH,
    `${JSON.stringify(
      {
        token_prefix: "test-token",
        active_driver: "claude",
      },
      null,
      2
    )}\n`
  );
}

function runScript(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("bash", [SCRIPT_PATH, "--managed", "--dry-run"], {
      cwd: REPO_ROOT,
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

function writeExecutable(path, body) {
  fs.writeFileSync(path, body, { mode: 0o755 });
}

function createBaseEnvironment(tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  seedTeleportContext();
  const realTmpDir = fs.realpathSync(tmpDir);
  const fakeBinDir = resolve(realTmpDir, "bin");
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const sshLogPath = resolve(realTmpDir, "ssh.log");
  const rsyncLogPath = resolve(realTmpDir, "rsync.log");
  const sessionPath = resolve(realTmpDir, "cloud-session.json");

  writeExecutable(
    resolve(fakeBinDir, "ssh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(sshLogPath)}
cat >/dev/null
`
  );
  writeExecutable(
    resolve(fakeBinDir, "rsync"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(rsyncLogPath)}
`
  );
  writeExecutable(
    resolve(fakeBinDir, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`
  );

  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        control_plane: "http://127.0.0.1:1",
        access_token: "access-abc",
        refresh_token: "refresh-abc",
        expires_at: "2999-03-13T00:00:00Z",
        created_at: "2026-03-12T00:00:00Z",
        last_sync_at: "2026-03-12T00:00:00Z",
      },
      null,
      2
    )}\n`
  );

  return { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath };
}

function pointSessionAtBaseUrl(sessionPath, baseUrl) {
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
  session.control_plane = baseUrl;
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
}

async function testManagedTeleportWaitsForResume(tmpDir) {
  const { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath } = createBaseEnvironment(tmpDir);

  let resumeCalls = 0;
  let statusCalls = 0;
  let targetCalls = 0;

  const server = http.createServer((req, res) => {
    const authorize = req.headers.authorization;
    assert.strictEqual(authorize, "Bearer access-abc");

    if (req.method === "GET" && req.url === "/v1/cli/teleport/target") {
      targetCalls += 1;
      res.writeHead(targetCalls >= 2 ? 200 : 409, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          targetCalls >= 2
            ? {
                instance: {
                  id: "inst_123",
                  provider: "gcp",
                  state: "running",
                  region: "us-central1",
                  zone: "us-central1-b",
                  hostname: "vm-ready.managed.superturtle.internal",
                  vm_name: "vm-ready",
                  machine_token_id: "machine-token-123",
                  last_seen_at: "2026-03-12T10:00:00Z",
                  resume_requested_at: "2026-03-12T09:58:00Z",
                },
                ssh_target: "superturtle@vm-ready.managed.superturtle.internal",
                remote_root: "/srv/superturtle",
                audit_log: [],
              }
            : { error: "managed_instance_not_running" }
        )
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1/cli/cloud/instance/resume") {
      resumeCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "gcp",
            state: "provisioning",
            region: "us-central1",
            zone: "us-central1-b",
            hostname: null,
            vm_name: "vm-ready",
            machine_token_id: null,
            last_seen_at: null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_123",
            kind: "resume",
            state: "queued",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: null,
            updated_at: "2026-03-12T09:58:00Z",
            completed_at: null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/v1/cli/cloud/status") {
      statusCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "gcp",
            state: statusCalls >= 2 ? "running" : "provisioning",
            region: "us-central1",
            zone: "us-central1-b",
            hostname: statusCalls >= 2 ? "vm-ready.managed.superturtle.internal" : null,
            vm_name: "vm-ready",
            machine_token_id: statusCalls >= 2 ? "machine-token-123" : null,
            last_seen_at: statusCalls >= 2 ? "2026-03-12T10:00:00Z" : null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_123",
            kind: "resume",
            state: statusCalls >= 2 ? "succeeded" : "running",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: "2026-03-12T09:58:10Z",
            updated_at: "2026-03-12T09:58:20Z",
            completed_at: statusCalls >= 2 ? "2026-03-12T09:58:30Z" : null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  pointSessionAtBaseUrl(sessionPath, baseUrl);

  try {
    const result = await runScript({
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_INSTANCE_READY_TIMEOUT_MS: "5000",
      SUPERTURTLE_TELEPORT_INSTANCE_READY_POLL_INTERVAL_MS: "10",
    });

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[teleport\] ssh target: superturtle@vm-ready\.managed\.superturtle\.internal/);
    assert.match(result.stdout, /\[teleport\] remote root: \/srv\/superturtle/);
    assert.match(result.stdout, /\[teleport\] dry-run complete/);
    assert.match(result.stderr, /managed runtime is not ready; requesting resume/i);
    assert.match(result.stderr, /waiting for managed instance to become ready/i);
    assert.strictEqual(resumeCalls, 1);
    assert.ok(statusCalls >= 2, `expected at least two status polls but saw ${statusCalls}`);
    assert.strictEqual(targetCalls, 2);
    assert.match(fs.readFileSync(sshLogPath, "utf-8"), /superturtle@vm-ready\.managed\.superturtle\.internal/);
    assert.match(fs.readFileSync(rsyncLogPath, "utf-8"), /superturtle@vm-ready\.managed\.superturtle\.internal:\/srv\/superturtle\//);
  } finally {
    server.close();
  }
}

async function testManagedTeleportRetriesTransientStatusFailure(tmpDir) {
  const { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath } = createBaseEnvironment(tmpDir);

  let resumeCalls = 0;
  let statusCalls = 0;
  let targetCalls = 0;

  const server = http.createServer((req, res) => {
    const authorize = req.headers.authorization;
    assert.strictEqual(authorize, "Bearer access-abc");

    if (req.method === "GET" && req.url === "/v1/cli/teleport/target") {
      targetCalls += 1;
      res.writeHead(targetCalls >= 2 ? 200 : 409, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          targetCalls >= 2
            ? {
                instance: {
                  id: "inst_retry",
                  provider: "gcp",
                  state: "running",
                  region: "us-central1",
                  zone: "us-central1-b",
                  hostname: "vm-retry.managed.superturtle.internal",
                  vm_name: "vm-retry",
                  machine_token_id: "machine-token-retry",
                  last_seen_at: "2026-03-12T10:00:00Z",
                  resume_requested_at: "2026-03-12T09:58:00Z",
                },
                ssh_target: "superturtle@vm-retry.managed.superturtle.internal",
                remote_root: "/srv/superturtle",
                audit_log: [],
              }
            : { error: "managed_instance_not_running" }
        )
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1/cli/cloud/instance/resume") {
      resumeCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_retry",
            provider: "gcp",
            state: "provisioning",
            region: "us-central1",
            zone: "us-central1-b",
            hostname: null,
            vm_name: "vm-retry",
            machine_token_id: null,
            last_seen_at: null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_retry",
            kind: "resume",
            state: "queued",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: null,
            updated_at: "2026-03-12T09:58:00Z",
            completed_at: null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/v1/cli/cloud/status") {
      statusCalls += 1;
      if (statusCalls === 1) {
        res.writeHead(503, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        res.end(JSON.stringify({ error: "control_plane_temporarily_unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_retry",
            provider: "gcp",
            state: statusCalls >= 3 ? "running" : "provisioning",
            region: "us-central1",
            zone: "us-central1-b",
            hostname: statusCalls >= 3 ? "vm-retry.managed.superturtle.internal" : null,
            vm_name: "vm-retry",
            machine_token_id: statusCalls >= 3 ? "machine-token-retry" : null,
            last_seen_at: statusCalls >= 3 ? "2026-03-12T10:00:00Z" : null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_retry",
            kind: "resume",
            state: statusCalls >= 3 ? "succeeded" : "running",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: "2026-03-12T09:58:10Z",
            updated_at: "2026-03-12T09:58:20Z",
            completed_at: statusCalls >= 3 ? "2026-03-12T09:58:30Z" : null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  pointSessionAtBaseUrl(sessionPath, `http://127.0.0.1:${address.port}`);

  try {
    const result = await runScript({
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_INSTANCE_READY_TIMEOUT_MS: "5000",
      SUPERTURTLE_TELEPORT_INSTANCE_READY_POLL_INTERVAL_MS: "10",
    });

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      /transient control-plane error during managed runtime status polling; retrying: status 503, control_plane_temporarily_unavailable/
    );
    assert.match(result.stdout, /\[teleport\] ssh target: superturtle@vm-retry\.managed\.superturtle\.internal/);
    assert.match(result.stdout, /\[teleport\] dry-run complete/);
    assert.strictEqual(resumeCalls, 1);
    assert.strictEqual(targetCalls, 2);
    assert.ok(statusCalls >= 3, `expected status polling retries but saw ${statusCalls}`);
    assert.match(fs.readFileSync(sshLogPath, "utf-8"), /superturtle@vm-retry\.managed\.superturtle\.internal/);
    assert.match(fs.readFileSync(rsyncLogPath, "utf-8"), /superturtle@vm-retry\.managed\.superturtle\.internal:\/srv\/superturtle\//);
  } finally {
    server.close();
  }
}

async function testManagedTeleportSurfacesProvisioningFailure(tmpDir) {
  const { fakeBinDir, sessionPath } = createBaseEnvironment(tmpDir);

  let resumeCalls = 0;
  let statusCalls = 0;

  const server = http.createServer((req, res) => {
    const authorize = req.headers.authorization;
    assert.strictEqual(authorize, "Bearer access-abc");

    if (req.method === "GET" && req.url === "/v1/cli/teleport/target") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "managed_instance_not_running" }));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/cli/cloud/instance/resume") {
      resumeCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_failed",
            provider: "gcp",
            state: "provisioning",
            region: "us-central1",
            zone: "us-central1-b",
            hostname: null,
            vm_name: "vm-failed",
            machine_token_id: null,
            last_seen_at: null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_failed",
            kind: "resume",
            state: "queued",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: null,
            updated_at: "2026-03-12T09:58:00Z",
            completed_at: null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/v1/cli/cloud/status") {
      statusCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_failed",
            provider: "gcp",
            state: "failed",
            region: "us-central1",
            zone: "us-central1-b",
            hostname: null,
            vm_name: "vm-failed",
            machine_token_id: null,
            last_seen_at: null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_failed",
            kind: "resume",
            state: "failed",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: "2026-03-12T09:58:10Z",
            updated_at: "2026-03-12T09:58:20Z",
            completed_at: "2026-03-12T09:58:30Z",
            error_code: "startup_script_failed",
            error_message: "Machine registration did not complete.",
          },
          audit_log: [],
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  pointSessionAtBaseUrl(sessionPath, `http://127.0.0.1:${address.port}`);

  try {
    const result = await runScript({
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_INSTANCE_READY_TIMEOUT_MS: "5000",
      SUPERTURTLE_TELEPORT_INSTANCE_READY_POLL_INTERVAL_MS: "10",
    });

    assert.strictEqual(result.code, 1, `expected failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.strictEqual(resumeCalls, 1);
    assert.strictEqual(statusCalls, 1);
    assert.match(
      result.stderr,
      /Managed instance became unavailable while waiting for teleport readiness: instance state failed, job resume failed, error code startup_script_failed, error Machine registration did not complete\./
    );
  } finally {
    server.close();
  }
}

async function testManagedTeleportTimesOutWithSandboxWordingForE2BRuntime(tmpDir) {
  const { fakeBinDir, sessionPath } = createBaseEnvironment(tmpDir);

  let resumeCalls = 0;
  let statusCalls = 0;

  const server = http.createServer((req, res) => {
    const authorize = req.headers.authorization;
    assert.strictEqual(authorize, "Bearer access-abc");

    if (req.method === "GET" && req.url === "/v1/cli/teleport/target") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "managed_instance_not_running" }));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/cli/cloud/instance/resume") {
      resumeCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_e2b_wait",
            provider: "e2b",
            state: "provisioning",
            sandbox_id: "sandbox_waiting",
            template_id: "template_teleport_v1",
            machine_token_id: null,
            last_seen_at: null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_e2b_wait",
            kind: "resume",
            state: "queued",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: null,
            updated_at: "2026-03-12T09:58:00Z",
            completed_at: null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/v1/cli/cloud/status") {
      statusCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_e2b_wait",
            provider: "e2b",
            state: "provisioning",
            sandbox_id: "sandbox_waiting",
            template_id: "template_teleport_v1",
            machine_token_id: null,
            last_seen_at: null,
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          provisioning_job: {
            id: "job_e2b_wait",
            kind: "resume",
            state: "running",
            attempt: 1,
            created_at: "2026-03-12T09:58:00Z",
            started_at: "2026-03-12T09:58:10Z",
            updated_at: "2026-03-12T09:58:20Z",
            completed_at: null,
            error_code: null,
            error_message: null,
          },
          audit_log: [],
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  pointSessionAtBaseUrl(sessionPath, `http://127.0.0.1:${address.port}`);

  try {
    const result = await runScript({
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_INSTANCE_READY_TIMEOUT_MS: "100",
      SUPERTURTLE_TELEPORT_INSTANCE_READY_POLL_INTERVAL_MS: "10",
    });

    assert.strictEqual(result.code, 1, `expected failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.strictEqual(resumeCalls, 1);
    assert.ok(statusCalls >= 1, `expected at least one status poll but saw ${statusCalls}`);
    assert.match(result.stderr, /managed runtime is not ready; requesting resume/i);
    assert.match(result.stderr, /waiting for managed sandbox to become ready/i);
    assert.match(
      result.stderr,
      /Timed out waiting for the managed sandbox to become ready after 100ms \(instance state provisioning, job resume running\)\./
    );
  } finally {
    server.close();
  }
}

async function testManagedTeleportRejectsE2BTargetUntilSandboxCutoverExists(tmpDir) {
  const { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath } = createBaseEnvironment(tmpDir);

  const server = http.createServer((req, res) => {
    const authorize = req.headers.authorization;
    assert.strictEqual(authorize, "Bearer access-abc");

    if (req.method === "GET" && req.url === "/v1/cli/teleport/target") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_e2b",
            provider: "e2b",
            state: "running",
            sandbox_id: "sandbox_123",
            template_id: "template_teleport_v1",
            machine_token_id: "machine-token-123",
            last_seen_at: "2026-03-12T10:00:00Z",
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          transport: "e2b",
          sandbox_id: "sandbox_123",
          template_id: "template_teleport_v1",
          project_root: "/home/user/agentic",
          sandbox_metadata: {
            account_id: "acct_123",
            sandbox_role: "managed_runtime",
          },
          audit_log: [],
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  pointSessionAtBaseUrl(sessionPath, `http://127.0.0.1:${address.port}`);

  try {
    const result = await runScript({
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
    });

    assert.strictEqual(result.code, 1, `expected failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(
      result.stderr,
      /Managed teleport target uses E2B sandbox transport, but teleport-manual\.sh still only supports SSH cutover\./
    );
    assert.match(result.stderr, /\[teleport\] managed target transport: e2b/);
    assert.match(result.stderr, /\[teleport\] sandbox_id: sandbox_123/);
    assert.ok(!fs.existsSync(sshLogPath), "expected SSH not to run for an E2B target");
    assert.ok(!fs.existsSync(rsyncLogPath), "expected rsync not to run for an E2B target");
  } finally {
    server.close();
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-teleport-managed-"));
  try {
    await testManagedTeleportWaitsForResume(resolve(tmpDir, "resume"));
    await testManagedTeleportRetriesTransientStatusFailure(resolve(tmpDir, "retry-status"));
    await testManagedTeleportSurfacesProvisioningFailure(resolve(tmpDir, "failure"));
    await testManagedTeleportTimesOutWithSandboxWordingForE2BRuntime(resolve(tmpDir, "e2b-timeout"));
    await testManagedTeleportRejectsE2BTargetUntilSandboxCutoverExists(resolve(tmpDir, "e2b-target"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
