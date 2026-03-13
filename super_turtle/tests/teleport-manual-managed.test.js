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
const ENV_FILE_PATH = resolve(REPO_ROOT, ".superturtle", ".env");

function readEnvValue(path, key) {
  if (!fs.existsSync(path)) {
    return "";
  }
  for (const rawLine of fs.readFileSync(path, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const prefix = `${key}=`;
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }
  return "";
}

function sanitizeTokenPrefix(token) {
  const prefix = (token.split(":", 1)[0] || "default").toLowerCase();
  return prefix.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function seedDriverPrefs(activeDriver = "claude") {
  const token = readEnvValue(ENV_FILE_PATH, "TELEGRAM_BOT_TOKEN");
  const tokenPrefix = sanitizeTokenPrefix(token);
  const claudePrefsPath = resolve(os.tmpdir(), `claude-telegram-${tokenPrefix}-prefs.json`);
  const codexPrefsPath = resolve(os.tmpdir(), `codex-telegram-${tokenPrefix}-prefs.json`);
  fs.writeFileSync(
    claudePrefsPath,
    `${JSON.stringify(
      {
        activeDriver,
        model: activeDriver === "codex" ? "gpt-5" : "sonnet",
        effort: activeDriver === "codex" ? "medium" : "normal",
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    codexPrefsPath,
    `${JSON.stringify(
      {
        model: "gpt-5",
        reasoningEffort: "medium",
      },
      null,
      2
    )}\n`
  );
}

function seedTeleportContext(activeDriver = "claude") {
  fs.mkdirSync(resolve(REPO_ROOT, ".superturtle", "teleport"), { recursive: true });
  fs.writeFileSync(
    TELEPORT_CONTEXT_PATH,
    `${JSON.stringify(
      {
        token_prefix: "test-token",
        active_driver: activeDriver,
      },
      null,
      2
    )}\n`
  );
}

function runTeleport(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("bash", [SCRIPT_PATH, ...args], {
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

function runDryRun(env) {
  return runTeleport(["--managed", "--dry-run"], env);
}

function writeExecutable(path, body) {
  fs.writeFileSync(path, body, { mode: 0o755 });
}

function createBaseEnvironment(tmpDir, options = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const activeDriver = options.activeDriver || "claude";
  seedTeleportContext(activeDriver);
  seedDriverPrefs(activeDriver);
  const realTmpDir = fs.realpathSync(tmpDir);
  const fakeBinDir = resolve(realTmpDir, "bin");
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const sshLogPath = resolve(realTmpDir, "ssh.log");
  const rsyncLogPath = resolve(realTmpDir, "rsync.log");
  const sessionPath = resolve(realTmpDir, "cloud-session.json");
  const ctlPath = resolve(realTmpDir, "fake-ctl");
  const e2bHelperLogPath = resolve(realTmpDir, "e2b-helper.log.jsonl");

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
  writeExecutable(
    resolve(fakeBinDir, "tmux"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 1
`
  );
  writeExecutable(
    resolve(fakeBinDir, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-czf" ]]; then
  args=("$@")
  for ((index = 0; index < \${#args[@]}; index += 1)); do
    if [[ "\${args[$index]}" == "-C" && $((index + 1)) -lt \${#args[@]} && "\${args[$((index + 1))]}" == ${JSON.stringify(REPO_ROOT)} ]]; then
      archive_path="\${2:?missing archive path}"
      tmp_dir="$(mktemp -d)"
      trap 'rm -rf "$tmp_dir"' EXIT
      /usr/bin/tar -czf "$archive_path" -C "$tmp_dir" .
      exit 0
    fi
  done
fi
exec /usr/bin/tar "$@"
`
  );
  writeExecutable(
    ctlPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "list" ]]; then
  exit 0
fi
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

  return { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath, ctlPath, e2bHelperLogPath };
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
    const result = await runDryRun({
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
    const result = await runDryRun({
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
    const result = await runDryRun({
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
    const result = await runDryRun({
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_INSTANCE_READY_TIMEOUT_MS: "250",
      SUPERTURTLE_TELEPORT_INSTANCE_READY_POLL_INTERVAL_MS: "10",
    });

    assert.strictEqual(result.code, 1, `expected failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.strictEqual(resumeCalls, 1);
    assert.ok(statusCalls >= 1, `expected at least one status poll but saw ${statusCalls}`);
    assert.match(result.stderr, /managed runtime is not ready; requesting resume/i);
    assert.match(result.stderr, /waiting for managed sandbox to become ready/i);
    assert.match(
      result.stderr,
      /Timed out waiting for the managed sandbox to become ready after 250ms \(instance state provisioning, job resume running\)\./
    );
  } finally {
    server.close();
  }
}

function createFakeE2BHelper(helperPath, logPath, sandboxRoot) {
  writeExecutable(
    helperPath,
    `#!/usr/bin/env node
const fs = require("fs");
const { dirname, resolve } = require("path");
const { spawnSync } = require("child_process");

const logPath = ${JSON.stringify(logPath)};
const sandboxRoot = ${JSON.stringify(sandboxRoot)};

function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    throw new Error("Missing option " + name);
  }
  return args[index + 1];
}

function sandboxPath(targetPath) {
  return resolve(sandboxRoot, "." + targetPath);
}

function runUpload(args) {
  const sandboxId = readOption(args, "--sandbox-id");
  const source = readOption(args, "--source");
  const destination = readOption(args, "--destination");
  const sandboxDestination = sandboxPath(destination);
  fs.mkdirSync(dirname(sandboxDestination), { recursive: true });
  fs.copyFileSync(source, sandboxDestination);
  log({ subcommand: "upload-file", sandboxId, source, destination });
}

	function runSyncArchive(args) {
  const sandboxId = readOption(args, "--sandbox-id");
  const source = readOption(args, "--source");
  const remoteRoot = readOption(args, "--remote-root");
  const archivePath = readOption(args, "--archive-path");
  const sandboxArchivePath = sandboxPath(archivePath);
  const sandboxRemoteRoot = sandboxPath(remoteRoot);
  fs.mkdirSync(dirname(sandboxArchivePath), { recursive: true });
  fs.copyFileSync(source, sandboxArchivePath);
  fs.mkdirSync(dirname(sandboxRemoteRoot), { recursive: true });
  fs.rmSync(sandboxRemoteRoot, { recursive: true, force: true });
  fs.mkdirSync(sandboxRemoteRoot, { recursive: true });
  const result = spawnSync("tar", ["-xzf", sandboxArchivePath, "-C", sandboxRemoteRoot], { stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  fs.rmSync(sandboxArchivePath, { force: true });
	  log({ subcommand: "sync-archive", sandboxId, source, remoteRoot, archivePath });
	}

	function runExtractArchive(args) {
	  const sandboxId = readOption(args, "--sandbox-id");
	  const source = readOption(args, "--source");
	  const destinationRoot = readOption(args, "--destination-root");
	  const archivePath = readOption(args, "--archive-path");
	  const sandboxArchivePath = sandboxPath(archivePath);
	  const sandboxDestinationRoot = sandboxPath(destinationRoot);
	  fs.mkdirSync(dirname(sandboxArchivePath), { recursive: true });
	  fs.copyFileSync(source, sandboxArchivePath);
	  fs.mkdirSync(sandboxDestinationRoot, { recursive: true });
	  const result = spawnSync("tar", ["-xzf", sandboxArchivePath, "-C", sandboxDestinationRoot], { stdio: "pipe" });
	  if (result.status !== 0) {
	    process.stderr.write(result.stderr);
	    process.exit(result.status || 1);
	  }
	  fs.rmSync(sandboxArchivePath, { force: true });
	  log({ subcommand: "extract-archive", sandboxId, source, destinationRoot, archivePath });
	}

	function runScript(args) {
  const sandboxId = readOption(args, "--sandbox-id");
  const cwdIndex = args.indexOf("--cwd");
  const cwd = cwdIndex !== -1 ? args[cwdIndex + 1] : "/";
  const separatorIndex = args.indexOf("--");
  const command = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
  const script = fs.readFileSync(0, "utf-8");
  const interpreterArgs = command.slice(1).map((value) => value.startsWith("/") ? sandboxPath(value) : value);
  log({ subcommand: "run-script", sandboxId, cwd, command, script });

  if (script.includes('tar -xzf "$archive_path" -C "$remote_root"')) {
    const remoteRoot = interpreterArgs[2];
    const archivePath = interpreterArgs[3];
    fs.mkdirSync(remoteRoot, { recursive: true });
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", remoteRoot], { stdio: "pipe" });
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exit(result.status || 1);
    }
    return;
  }

  if (script.includes('status_output="$(bun super_turtle/bin/superturtle.js status)"')) {
    process.stdout.write("Bot: running (sandbox-session)\\n");
    return;
  }

  if (script.includes('preflight ok')) {
    if (script.includes("require_cmd rsync")) {
      throw new Error("E2B preflight unexpectedly required rsync");
    }
    return;
  }

	  if (
	    script.includes('bun install') ||
	    script.includes('chmod 600 "$remote_home/.codex/auth.json"') ||
	    script.includes('teleport_handoff.py" import') ||
	    script.includes('bun super_turtle/bin/superturtle.js start') ||
	    script.includes('teleport_handoff.py" notify')
  ) {
    return;
  }

  throw new Error("Unexpected run-script payload");
}

const [subcommand, ...args] = process.argv.slice(2);
	try {
	  if (subcommand === "upload-file") {
	    runUpload(args);
	  } else if (subcommand === "sync-archive") {
	    runSyncArchive(args);
	  } else if (subcommand === "extract-archive") {
	    runExtractArchive(args);
	  } else if (subcommand === "run-script") {
	    runScript(args);
	  } else {
    throw new Error("Unknown subcommand " + subcommand);
  }
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n");
  process.exit(1);
}
`
  );
}

function readHelperLog(path) {
  if (!fs.existsSync(path)) {
    return [];
  }
  return fs.readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function testManagedTeleportUsesE2BHelperForSandboxCutover(tmpDir) {
  const { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath, ctlPath, e2bHelperLogPath } = createBaseEnvironment(tmpDir);
  const helperPath = resolve(tmpDir, "fake-e2b-helper");
  const sandboxRoot = resolve(tmpDir, "sandbox-root");
  createFakeE2BHelper(helperPath, e2bHelperLogPath, sandboxRoot);

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
    const result = await runTeleport(["--managed"], {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_E2B_HELPER_PATH: helperPath,
      SUPERTURTLE_TELEPORT_CTL_PATH: ctlPath,
    });

    assert.strictEqual(result.code, 0, `expected success, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /\[teleport\] managed sandbox: sandbox_123/);
    assert.match(result.stdout, /\[teleport\] template id: template_teleport_v1/);
    assert.match(result.stdout, /\[teleport\] project root: \/home\/user\/agentic/);
    assert.match(result.stdout, /\[teleport\] success/);
    assert.ok(!fs.existsSync(sshLogPath), "expected SSH not to run for an E2B target");
    assert.ok(!fs.existsSync(rsyncLogPath), "expected rsync not to run for an E2B target");

    const helperLog = readHelperLog(e2bHelperLogPath);
    assert.ok(helperLog.some((entry) => entry.subcommand === "sync-archive"), "expected archive sync");
    assert.ok(helperLog.some((entry) => entry.subcommand === "run-script" && /preflight ok/.test(entry.script)), "expected remote preflight");
    assert.ok(helperLog.some((entry) => entry.subcommand === "run-script" && /bun install/.test(entry.script)), "expected remote dependency install");
    assert.ok(helperLog.some((entry) => entry.subcommand === "run-script" && /teleport_handoff\.py" import/.test(entry.script)), "expected runtime import");
    assert.ok(helperLog.some((entry) => entry.subcommand === "run-script" && /bun super_turtle\/bin\/superturtle\.js start/.test(entry.script)), "expected remote start");
    assert.ok(helperLog.some((entry) => entry.subcommand === "run-script" && /status_output="\$\(bun super_turtle\/bin\/superturtle\.js status\)"/.test(entry.script)), "expected remote status verification");
  } finally {
    server.close();
  }
}

async function testManagedTeleportBootstrapsLocalCodexAuthIntoSandbox(tmpDir) {
  const { fakeBinDir, sshLogPath, rsyncLogPath, sessionPath, ctlPath, e2bHelperLogPath } = createBaseEnvironment(tmpDir);
  const helperPath = resolve(tmpDir, "fake-e2b-helper");
  const sandboxRoot = resolve(tmpDir, "sandbox-root");
  const localCodexDir = resolve(tmpDir, "local-codex");
  const localCodexAuthPath = resolve(localCodexDir, "auth.json");
  fs.mkdirSync(localCodexDir, { recursive: true });
  fs.writeFileSync(localCodexAuthPath, '{"token":"local-codex"}\n');
  createFakeE2BHelper(helperPath, e2bHelperLogPath, sandboxRoot);

  const server = http.createServer((req, res) => {
    const authorize = req.headers.authorization;
    assert.strictEqual(authorize, "Bearer access-abc");

    if (req.method === "GET" && req.url === "/v1/cli/teleport/target") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: {
            id: "inst_e2b_codex",
            provider: "e2b",
            state: "running",
            sandbox_id: "sandbox_codex",
            template_id: "template_teleport_v1",
            machine_token_id: "machine-token-123",
            last_seen_at: "2026-03-12T10:00:00Z",
            resume_requested_at: "2026-03-12T09:58:00Z",
          },
          transport: "e2b",
          sandbox_id: "sandbox_codex",
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
    const result = await runTeleport(["--managed"], {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
      SUPERTURTLE_TELEPORT_E2B_HELPER_PATH: helperPath,
      SUPERTURTLE_TELEPORT_CTL_PATH: ctlPath,
      SUPERTURTLE_TELEPORT_CODEX_AUTH_PATH: localCodexAuthPath,
    });

    assert.strictEqual(result.code, 0, `expected success, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /\[teleport\] bootstrapping local Codex auth into managed sandbox/);
    assert.ok(!fs.existsSync(sshLogPath), "expected SSH not to run for an E2B target");
    assert.ok(!fs.existsSync(rsyncLogPath), "expected rsync not to run for an E2B target");
    assert.strictEqual(
      fs.readFileSync(resolve(sandboxRoot, "home", "user", ".codex", "auth.json"), "utf-8"),
      '{"token":"local-codex"}\n'
    );

    const helperLog = readHelperLog(e2bHelperLogPath);
    assert.ok(helperLog.some((entry) => entry.subcommand === "extract-archive"), "expected Codex auth archive extraction");
    assert.ok(
      helperLog.some(
        (entry) =>
          entry.subcommand === "run-script" &&
          /chmod 600 "\$remote_home\/\.codex\/auth\.json"/.test(entry.script)
      ),
      "expected Codex auth permission fixup"
    );
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
    await testManagedTeleportUsesE2BHelperForSandboxCutover(resolve(tmpDir, "e2b-target"));
    await testManagedTeleportBootstrapsLocalCodexAuthIntoSandbox(resolve(tmpDir, "e2b-codex-auth"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
