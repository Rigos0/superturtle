const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { resolve } = require("path");

const {
  CONTROL_PLANE_WRITE_SCOPE,
  createDefaultState,
  createRuntime,
  handleHttpRequest,
  readState,
  requestSession,
  requestInstanceResume,
  runNextProvisioningJob,
  writeState,
} = require("../bin/cloud-control-plane-runtime.js");

function createSeedState() {
  const state = createDefaultState();
  state.users.push({
    id: "user_123",
    email: "user@example.com",
    created_at: "2026-03-12T10:00:00Z",
  });
  state.identities.push({
    id: "ident_123",
    user_id: "user_123",
    provider: "github",
    provider_user_id: "github_123",
    email: "user@example.com",
    created_at: "2026-03-12T10:00:00Z",
    last_used_at: null,
  });
  state.sessions.push({
    id: "sess_123",
    user_id: "user_123",
    state: "active",
    access_token: "access_123",
    scopes: [CONTROL_PLANE_WRITE_SCOPE],
    created_at: "2026-03-12T10:00:00Z",
  });
  state.entitlements.push({
    user_id: "user_123",
    plan: "managed",
    state: "active",
    subscription_id: "sub_123",
    current_period_end: "2026-04-12T10:00:00Z",
    cancel_at_period_end: false,
  });
  return state;
}

function createClock() {
  const values = [
    "2026-03-12T10:00:00Z",
    "2026-03-12T10:00:01Z",
    "2026-03-12T10:00:02Z",
    "2026-03-12T10:00:03Z",
    "2026-03-12T10:00:04Z",
    "2026-03-12T10:00:05Z",
    "2026-03-12T10:00:06Z",
    "2026-03-12T10:00:07Z",
    "2026-03-12T10:00:08Z",
    "2026-03-12T10:00:09Z",
  ];
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function run() {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-control-plane-runtime-"));
  const statePath = resolve(tmpDir, "control-plane-state.json");

  writeState(statePath, createSeedState());

  const runtime = createRuntime({
    statePath,
    now: createClock(),
    createId(prefix) {
      return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    },
  });

  const whoami = requestSession(runtime, "access_123");
  assert.strictEqual(whoami.status, 200);
  assert.strictEqual(whoami.data.user.email, "user@example.com");
  assert.strictEqual(whoami.data.identities.length, 1);
  assert.strictEqual(whoami.data.identities[0].provider, "github");
  assert.strictEqual(whoami.data.session.id, "sess_123");
  assert.strictEqual(whoami.data.session.last_authenticated_at, "2026-03-12T10:00:00Z");

  const persistedAfterWhoAmI = readState(statePath);
  assert.strictEqual(persistedAfterWhoAmI.sessions[0].last_authenticated_at, "2026-03-12T10:00:00Z");
  assert.strictEqual(persistedAfterWhoAmI.identities[0].last_used_at, "2026-03-12T10:00:00Z");
  assert.match(
    JSON.stringify(persistedAfterWhoAmI.audit_log),
    /session\.lookup/,
    "expected session lookups to be written to the durable audit log"
  );

  const created = requestInstanceResume(runtime, "access_123");
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.data.instance.state, "provisioning");
  assert.strictEqual(created.data.provisioning_job.kind, "provision");
  assert.strictEqual(created.data.provisioning_job.state, "queued");

  const persistedAfterCreate = readState(statePath);
  assert.strictEqual(persistedAfterCreate.managed_instances.length, 1);
  assert.strictEqual(persistedAfterCreate.provisioning_jobs.length, 1);
  assert.strictEqual(persistedAfterCreate.managed_instances[0].state, "provisioning");

  const deduped = requestInstanceResume(runtime, "access_123");
  assert.strictEqual(deduped.status, 200);
  assert.strictEqual(deduped.data.provisioning_job.id, created.data.provisioning_job.id);
  assert.match(
    JSON.stringify(readState(statePath).audit_log),
    /instance\.resume_deduplicated/,
    "expected resume dedupe to be written to the durable audit log"
  );

  const completed = await runNextProvisioningJob(runtime);
  assert.strictEqual(completed.instance.state, "running");
  assert.strictEqual(completed.provisioning_job.state, "succeeded");
  assert.ok(completed.instance.hostname);
  assert.ok(completed.instance.machine_token_id);

  const persistedAfterRun = readState(statePath);
  assert.strictEqual(persistedAfterRun.managed_instances[0].state, "running");
  assert.strictEqual(persistedAfterRun.provisioning_jobs[0].state, "succeeded");

  const forbiddenPath = resolve(tmpDir, "forbidden-state.json");
  const forbiddenState = createSeedState();
  forbiddenState.entitlements[0].state = "inactive";
  writeState(forbiddenPath, forbiddenState);
  const forbiddenRuntime = createRuntime({ statePath: forbiddenPath, now: createClock() });
  const forbidden = requestInstanceResume(forbiddenRuntime, "access_123");
  assert.strictEqual(forbidden.status, 403);
  assert.deepStrictEqual(readState(forbiddenPath).managed_instances, []);

  const httpPath = resolve(tmpDir, "http-state.json");
  writeState(httpPath, createSeedState());
  const httpRuntime = createRuntime({ statePath: httpPath, now: createClock() });
  const server = http.createServer(async (req, res) => {
    const response = await handleHttpRequest(httpRuntime, req);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/cli/cloud/instance/resume`, {
    method: "POST",
    headers: {
      authorization: "Bearer access_123",
    },
  });
  assert.strictEqual(response.status, 200);
  const payload = await response.json();
  assert.strictEqual(payload.instance.state, "provisioning");
  assert.strictEqual(payload.provisioning_job.state, "queued");

  const whoamiResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/session`, {
    headers: {
      authorization: "Bearer access_123",
    },
  });
  assert.strictEqual(whoamiResponse.status, 200);
  const whoamiPayload = await whoamiResponse.json();
  assert.strictEqual(whoamiPayload.user.email, "user@example.com");
  assert.strictEqual(whoamiPayload.session.id, "sess_123");
  assert.strictEqual(whoamiPayload.identities[0].provider, "github");

  server.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
