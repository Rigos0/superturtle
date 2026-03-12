const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { resolve } = require("path");

const {
  CONTROL_PLANE_WRITE_SCOPE,
  completeLoginRequest,
  createDefaultState,
  createRuntime,
  handleHttpRequest,
  readState,
  requestCloudStatus,
  requestLoginPoll,
  requestLoginStart,
  requestSession,
  requestSessionRefresh,
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
    refresh_token: "refresh_123",
    scopes: [CONTROL_PLANE_WRITE_SCOPE],
    created_at: "2026-03-12T10:00:00Z",
    expires_at: "2026-03-12T11:00:00Z",
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
    "2026-03-12T10:00:10Z",
    "2026-03-12T10:00:11Z",
    "2026-03-12T10:00:12Z",
    "2026-03-12T10:00:13Z",
    "2026-03-12T10:00:14Z",
    "2026-03-12T10:00:15Z",
    "2026-03-12T10:00:16Z",
    "2026-03-12T10:00:17Z",
    "2026-03-12T10:00:18Z",
    "2026-03-12T10:00:19Z",
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
    publicOrigin: "https://api.superturtle.dev",
    createId(prefix) {
      return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    },
  });

  const loginStarted = requestLoginStart(runtime, {
    client_name: "superturtle-cli",
    device_name: "devbox",
    scopes: ["cloud:read", "teleport:write"],
  });
  assert.strictEqual(loginStarted.status, 200);
  assert.match(loginStarted.data.device_code, /^device_/);
  assert.strictEqual(loginStarted.data.interval_ms, 2000);
  assert.strictEqual(loginStarted.data.verification_uri, "https://api.superturtle.dev/verify");
  assert.match(
    loginStarted.data.verification_uri_complete,
    /^https:\/\/api\.superturtle\.dev\/verify\?user_code=/
  );

  const loginPending = requestLoginPoll(runtime, loginStarted.data.device_code);
  assert.strictEqual(loginPending.status, 428);
  assert.strictEqual(loginPending.data.error, "authorization_pending");

  const completedLogin = completeLoginRequest(runtime, loginStarted.data.device_code, {
    userId: "user_123",
  });
  assert.strictEqual(completedLogin.status, 200);
  assert.match(completedLogin.data.access_token, /^access_/);
  assert.match(completedLogin.data.refresh_token, /^refresh_/);
  assert.strictEqual(completedLogin.data.user.email, "user@example.com");
  assert.strictEqual(completedLogin.data.entitlement.state, "active");

  const loginPollCompleted = requestLoginPoll(runtime, loginStarted.data.device_code);
  assert.strictEqual(loginPollCompleted.status, 200);
  assert.strictEqual(loginPollCompleted.data.session.id, completedLogin.data.session.id);

  const persistedAfterLogin = readState(statePath);
  assert.strictEqual(persistedAfterLogin.login_requests.length, 1);
  assert.strictEqual(persistedAfterLogin.login_requests[0].state, "completed");
  assert.strictEqual(persistedAfterLogin.login_requests[0].session_id, completedLogin.data.session.id);
  assert.match(
    JSON.stringify(persistedAfterLogin.audit_log),
    /login_request\.completed/,
    "expected completed login requests to be written to the durable audit log"
  );

  const whoami = requestSession(runtime, "access_123");
  assert.strictEqual(whoami.status, 200);
  assert.strictEqual(whoami.data.user.email, "user@example.com");
  assert.strictEqual(whoami.data.identities.length, 1);
  assert.strictEqual(whoami.data.identities[0].provider, "github");
  assert.strictEqual(whoami.data.session.id, "sess_123");
  assert.strictEqual(whoami.data.session.last_authenticated_at, "2026-03-12T10:00:10Z");

  const persistedAfterWhoAmI = readState(statePath);
  assert.strictEqual(persistedAfterWhoAmI.sessions[0].last_authenticated_at, "2026-03-12T10:00:10Z");
  assert.strictEqual(persistedAfterWhoAmI.identities[0].last_used_at, "2026-03-12T10:00:10Z");
  assert.match(
    JSON.stringify(persistedAfterWhoAmI.audit_log),
    /session\.lookup/,
    "expected session lookups to be written to the durable audit log"
  );

  const refreshed = requestSessionRefresh(runtime, "refresh_123");
  assert.strictEqual(refreshed.status, 200);
  assert.match(refreshed.data.access_token, /^access_/);
  assert.match(refreshed.data.refresh_token, /^refresh_/);
  assert.strictEqual(refreshed.data.session.id, "sess_123");
  assert.strictEqual(refreshed.data.session.last_authenticated_at, "2026-03-12T10:00:12Z");
  assert.strictEqual(refreshed.data.entitlement.state, "active");

  const persistedAfterRefresh = readState(statePath);
  assert.strictEqual(persistedAfterRefresh.sessions[0].access_token, refreshed.data.access_token);
  assert.strictEqual(persistedAfterRefresh.sessions[0].refresh_token, refreshed.data.refresh_token);
  assert.strictEqual(persistedAfterRefresh.sessions[0].expires_at, "2026-03-12T11:00:12.000Z");
  assert.strictEqual(persistedAfterRefresh.sessions[0].last_authenticated_at, "2026-03-12T10:00:12Z");
  assert.strictEqual(persistedAfterRefresh.identities[0].last_used_at, "2026-03-12T10:00:12Z");
  assert.match(
    JSON.stringify(persistedAfterRefresh.audit_log),
    /session\.refreshed/,
    "expected session refreshes to be written to the durable audit log"
  );

  const initialStatus = requestCloudStatus(runtime, refreshed.data.access_token);
  assert.strictEqual(initialStatus.status, 200);
  assert.strictEqual(initialStatus.data.instance, null);
  assert.strictEqual(initialStatus.data.provisioning_job, null);
  assert.deepStrictEqual(initialStatus.data.audit_log, []);

  const persistedAfterStatus = readState(statePath);
  assert.strictEqual(persistedAfterStatus.sessions[0].last_authenticated_at, "2026-03-12T10:00:14Z");
  assert.strictEqual(persistedAfterStatus.identities[0].last_used_at, "2026-03-12T10:00:14Z");
  assert.match(
    JSON.stringify(persistedAfterStatus.audit_log),
    /cloud_status\.lookup/,
    "expected cloud status lookups to be written to the durable audit log"
  );

  const created = requestInstanceResume(runtime, refreshed.data.access_token);
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.data.instance.state, "provisioning");
  assert.strictEqual(created.data.provisioning_job.kind, "provision");
  assert.strictEqual(created.data.provisioning_job.state, "queued");

  const persistedAfterCreate = readState(statePath);
  assert.strictEqual(persistedAfterCreate.managed_instances.length, 1);
  assert.strictEqual(persistedAfterCreate.provisioning_jobs.length, 1);
  assert.strictEqual(persistedAfterCreate.managed_instances[0].state, "provisioning");

  const deduped = requestInstanceResume(runtime, refreshed.data.access_token);
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

  const runningStatus = requestCloudStatus(runtime, refreshed.data.access_token);
  assert.strictEqual(runningStatus.status, 200);
  assert.strictEqual(runningStatus.data.instance.id, created.data.instance.id);
  assert.strictEqual(runningStatus.data.instance.state, "running");
  assert.strictEqual(runningStatus.data.provisioning_job.id, created.data.provisioning_job.id);
  assert.strictEqual(runningStatus.data.provisioning_job.state, "succeeded");

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

  const refreshResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/session/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ refresh_token: "refresh_123" }),
  });
  assert.strictEqual(refreshResponse.status, 200);
  const refreshPayload = await refreshResponse.json();
  assert.match(refreshPayload.access_token, /^access_/);
  assert.match(refreshPayload.refresh_token, /^refresh_/);
  assert.strictEqual(refreshPayload.session.id, "sess_123");

  const cloudStatusResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/cloud/status`, {
    headers: {
      authorization: `Bearer ${refreshPayload.access_token}`,
    },
  });
  assert.strictEqual(cloudStatusResponse.status, 200);
  const cloudStatusPayload = await cloudStatusResponse.json();
  assert.strictEqual(cloudStatusPayload.instance.state, "provisioning");
  assert.strictEqual(cloudStatusPayload.provisioning_job.state, "queued");

  const loginStartResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/login/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "superturtle-cli",
      device_name: "http-devbox",
      scopes: ["cloud:read"],
    }),
  });
  assert.strictEqual(loginStartResponse.status, 200);
  const loginStartPayload = await loginStartResponse.json();
  assert.match(loginStartPayload.device_code, /^device_/);

  const loginPollPendingResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/login/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ device_code: loginStartPayload.device_code }),
  });
  assert.strictEqual(loginPollPendingResponse.status, 428);

  const httpRuntimeCompleted = completeLoginRequest(httpRuntime, loginStartPayload.device_code, {
    userId: "user_123",
  });
  assert.strictEqual(httpRuntimeCompleted.status, 200);

  const loginPollCompletedResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/login/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ device_code: loginStartPayload.device_code }),
  });
  assert.strictEqual(loginPollCompletedResponse.status, 200);
  const loginPollCompletedPayload = await loginPollCompletedResponse.json();
  assert.strictEqual(loginPollCompletedPayload.session.id, httpRuntimeCompleted.data.session.id);

  const malformedRefreshResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/session/refresh`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
    },
    body: "refresh_123",
  });
  assert.strictEqual(malformedRefreshResponse.status, 415);

  server.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
