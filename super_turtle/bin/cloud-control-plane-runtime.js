const fs = require("fs");
const { dirname, resolve } = require("path");

const {
  assertManagedInstanceTransition,
  assertProvisioningJobTransition,
  validateCliCloudStatusResponse,
  validateCliTokenResponse,
  validateCliWhoAmIResponse,
} = require("./cloud-control-plane-contract.js");

const STATE_SCHEMA_VERSION = 1;
const ACTIVE_ENTITLEMENT_STATES = new Set(["active", "trialing"]);
const CONTROL_PLANE_WRITE_SCOPE = "cloud:write";
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_REQUEST_BODY_MAX_BYTES = 16 * 1024;
const DEFAULT_LOGIN_INTERVAL_MS = 2000;
const DEFAULT_LOGIN_TTL_MS = 15 * 60 * 1000;

function createDefaultState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    users: [],
    identities: [],
    sessions: [],
    login_requests: [],
    entitlements: [],
    managed_instances: [],
    provisioning_jobs: [],
    audit_log: [],
  };
}

function defaultNow() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureStateShape(state, statePath) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`Control-plane state at ${statePath} must be a JSON object.`);
  }
  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `Control-plane state at ${statePath} has unsupported schema_version ${JSON.stringify(state.schema_version)}.`
    );
  }

  for (const field of [
    "users",
    "identities",
    "sessions",
    "entitlements",
    "managed_instances",
    "provisioning_jobs",
    "audit_log",
  ]) {
    if (!Array.isArray(state[field])) {
      throw new Error(`Control-plane state at ${statePath} is missing array field ${field}.`);
    }
  }

  if (!Array.isArray(state.login_requests)) {
    state.login_requests = [];
  }

  return state;
}

function readState(statePath) {
  const resolvedPath = resolve(statePath);
  if (!fs.existsSync(resolvedPath)) {
    return createDefaultState();
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  return ensureStateShape(JSON.parse(raw), resolvedPath);
}

function fsyncPath(targetPath) {
  const fd = fs.openSync(targetPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensureDirectory(path) {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeState(statePath, state) {
  const resolvedPath = resolve(statePath);
  const dirPath = dirname(resolvedPath);
  ensureDirectory(dirPath);

  const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = JSON.stringify(state, null, 2);
  fs.writeFileSync(tempPath, serialized, { mode: 0o600 });
  fsyncPath(tempPath);
  fs.renameSync(tempPath, resolvedPath);
  fsyncPath(resolvedPath);
  fsyncPath(dirPath);
}

function createRuntime(options) {
  if (!options || typeof options !== "object") {
    throw new Error("Control-plane runtime options are required.");
  }
  if (!options.statePath) {
    throw new Error("Control-plane runtime requires a statePath.");
  }

  return {
    statePath: resolve(options.statePath),
    now: options.now || defaultNow,
    createId: options.createId || randomId,
    provisioner: options.provisioner || createNoopProvisioner(),
    config: {
      provider: "gcp",
      region: options.region || "us-central1",
      zone: options.zone || "us-central1-a",
      hostnameDomain: options.hostnameDomain || "managed.superturtle.internal",
      publicOrigin: String(options.publicOrigin || "https://api.superturtle.dev").replace(/\/+$/, ""),
    },
    sessionTtlMs: Number.isFinite(options.sessionTtlMs) && options.sessionTtlMs > 0
      ? options.sessionTtlMs
      : DEFAULT_SESSION_TTL_MS,
    requestBodyMaxBytes: Number.isInteger(options.requestBodyMaxBytes) && options.requestBodyMaxBytes > 0
      ? options.requestBodyMaxBytes
      : DEFAULT_REQUEST_BODY_MAX_BYTES,
    loginPollIntervalMs: Number.isInteger(options.loginPollIntervalMs) && options.loginPollIntervalMs > 0
      ? options.loginPollIntervalMs
      : DEFAULT_LOGIN_INTERVAL_MS,
    loginRequestTtlMs: Number.isInteger(options.loginRequestTtlMs) && options.loginRequestTtlMs > 0
      ? options.loginRequestTtlMs
      : DEFAULT_LOGIN_TTL_MS,
  };
}

function getUserSession(state, accessToken) {
  return state.sessions.find(
    (session) =>
      session &&
      session.access_token === accessToken &&
      session.state === "active" &&
      Array.isArray(session.scopes) &&
      session.scopes.includes(CONTROL_PLANE_WRITE_SCOPE)
  );
}

function getAuthenticatedSession(state, accessToken) {
  return state.sessions.find(
    (session) => session && session.access_token === accessToken && session.state === "active"
  );
}

function getRefreshSession(state, refreshToken) {
  return state.sessions.find(
    (session) => session && session.refresh_token === refreshToken && session.state === "active"
  );
}

function getUser(state, userId) {
  return state.users.find((user) => user && user.id === userId) || null;
}

function getIdentities(state, userId) {
  return state.identities.filter((identity) => identity && identity.user_id === userId);
}

function getEntitlement(state, userId) {
  return state.entitlements.find((entitlement) => entitlement && entitlement.user_id === userId) || null;
}

function getManagedInstance(state, userId) {
  return state.managed_instances.find((instance) => instance && instance.user_id === userId) || null;
}

function getLatestProvisioningJob(state, instanceId) {
  const jobs = state.provisioning_jobs.filter((job) => job && job.instance_id === instanceId);
  if (jobs.length === 0) {
    return null;
  }
  return jobs.reduce((latest, job) => {
    if (!latest) return job;
    return String(job.updated_at || job.created_at || "") > String(latest.updated_at || latest.created_at || "")
      ? job
      : latest;
  }, null);
}

function getRecentAuditLog(state, targetId) {
  return state.audit_log
    .filter((entry) => entry && entry.target_id === targetId)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, 20);
}

function getLoginRequest(state, deviceCode) {
  return state.login_requests.find((request) => request && request.device_code === deviceCode) || null;
}

function appendAudit(state, runtime, entry) {
  state.audit_log.push({
    id: runtime.createId("audit"),
    created_at: runtime.now(),
    ...entry,
  });
}

function buildCloudStatusPayload(state, instance) {
  const latestJob = instance ? getLatestProvisioningJob(state, instance.id) : null;
  return validateCliCloudStatusResponse({
    instance: instance
      ? {
          id: instance.id,
          provider: instance.provider,
          state: instance.state,
          region: instance.region || null,
          zone: instance.zone || null,
          hostname: instance.hostname || null,
          vm_name: instance.vm_name || null,
          machine_token_id: instance.machine_token_id || null,
          last_seen_at: instance.last_seen_at || null,
          resume_requested_at: instance.resume_requested_at || null,
        }
      : null,
    provisioning_job: latestJob
      ? {
          id: latestJob.id,
          kind: latestJob.kind,
          state: latestJob.state,
          attempt: latestJob.attempt,
          created_at: latestJob.created_at || null,
          started_at: latestJob.started_at || null,
          updated_at: latestJob.updated_at || null,
          completed_at: latestJob.completed_at || null,
          error_code: latestJob.error_code || null,
          error_message: latestJob.error_message || null,
        }
      : null,
    audit_log: instance ? getRecentAuditLog(state, instance.id) : [],
  });
}

function buildWhoAmIPayload(state, session) {
  const user = getUser(state, session.user_id);
  if (!user) {
    throw new Error(`Session ${session.id} references missing user ${session.user_id}.`);
  }

  const entitlement = getEntitlement(state, session.user_id);
  const identities = getIdentities(state, session.user_id).map((identity) => ({
    id: identity.id,
    provider: identity.provider,
    provider_user_id: identity.provider_user_id,
    email: identity.email || null,
    created_at: identity.created_at || null,
    last_used_at: identity.last_used_at || null,
  }));

  return validateCliWhoAmIResponse({
    user: {
      id: user.id,
      email: user.email || null,
      created_at: user.created_at || null,
    },
    workspace: null,
    identities,
    session: {
      id: session.id,
      state: session.state,
      scopes: Array.isArray(session.scopes) ? session.scopes : [],
      created_at: session.created_at || null,
      expires_at: session.expires_at || null,
      last_authenticated_at: session.last_authenticated_at || null,
    },
    entitlement: entitlement
      ? {
          plan: entitlement.plan,
          state: entitlement.state,
          subscription_id: entitlement.subscription_id || null,
          current_period_end: entitlement.current_period_end || null,
          cancel_at_period_end:
            typeof entitlement.cancel_at_period_end === "boolean" ? entitlement.cancel_at_period_end : null,
        }
      : null,
  });
}

function buildTokenPayload(state, session) {
  const whoami = buildWhoAmIPayload(state, session);
  const cloudStatus = buildCloudStatusPayload(state, getManagedInstance(state, session.user_id));
  return validateCliTokenResponse({
    access_token: session.access_token,
    refresh_token: session.refresh_token || null,
    expires_at: session.expires_at || null,
    user: whoami.user,
    workspace: whoami.workspace,
    identities: whoami.identities,
    session: whoami.session,
    entitlement: whoami.entitlement,
    instance: cloudStatus.instance,
    provisioning_job: cloudStatus.provisioning_job,
    audit_log: cloudStatus.audit_log,
  });
}

function buildLoginStartPayload(loginRequest) {
  return {
    device_code: loginRequest.device_code,
    user_code: loginRequest.user_code,
    verification_uri: loginRequest.verification_uri,
    verification_uri_complete: loginRequest.verification_uri_complete,
    interval_ms: loginRequest.interval_ms,
  };
}

function addDuration(timestamp, durationMs) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Cannot add a session duration to invalid timestamp ${JSON.stringify(timestamp)}.`);
  }
  return new Date(parsed + durationMs).toISOString();
}

function normalizeRequestedScopes(scopes) {
  const normalized = Array.isArray(scopes)
    ? scopes.filter((scope) => typeof scope === "string" && scope.trim().length > 0)
    : [];
  if (!normalized.includes(CONTROL_PLANE_WRITE_SCOPE)) {
    normalized.push(CONTROL_PLANE_WRITE_SCOPE);
  }
  return Array.from(new Set(normalized));
}

function createUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${chunk()}-${chunk()}`;
}

function createLoginRequest(state, runtime, payload) {
  const timestamp = runtime.now();
  const userCode = createUserCode();
  const loginRequest = {
    id: runtime.createId("login"),
    state: "pending",
    client_name: typeof payload.client_name === "string" ? payload.client_name : null,
    device_name: typeof payload.device_name === "string" ? payload.device_name : null,
    scopes: normalizeRequestedScopes(payload.scopes),
    device_code: runtime.createId("device"),
    user_code: userCode,
    verification_uri: `${runtime.config.publicOrigin}/verify`,
    verification_uri_complete: `${runtime.config.publicOrigin}/verify?user_code=${encodeURIComponent(userCode)}`,
    interval_ms: runtime.loginPollIntervalMs,
    created_at: timestamp,
    expires_at: addDuration(timestamp, runtime.loginRequestTtlMs),
    completed_at: null,
    session_id: null,
  };
  state.login_requests.push(loginRequest);
  appendAudit(state, runtime, {
    actor_type: "system",
    actor_id: "control-plane",
    action: "login_request.created",
    target_type: "login_request",
    target_id: loginRequest.id,
    metadata: {
      client_name: loginRequest.client_name,
      device_name: loginRequest.device_name,
    },
  });
  return loginRequest;
}

function createManagedInstance(state, runtime, session) {
  const timestamp = runtime.now();
  const instance = {
    id: runtime.createId("inst"),
    user_id: session.user_id,
    provider: runtime.config.provider,
    state: "requested",
    region: runtime.config.region,
    zone: runtime.config.zone,
    hostname: null,
    vm_name: null,
    machine_token_id: null,
    last_seen_at: null,
    resume_requested_at: timestamp,
  };
  state.managed_instances.push(instance);
  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "instance.created",
    target_type: "managed_instance",
    target_id: instance.id,
    metadata: { origin: "cli_resume" },
  });
  return instance;
}

function enqueueProvisioningJob(state, runtime, instance, session, kind) {
  const timestamp = runtime.now();
  const job = {
    id: runtime.createId("job"),
    instance_id: instance.id,
    user_id: session.user_id,
    kind,
    state: "queued",
    attempt: 1,
    created_at: timestamp,
    started_at: null,
    updated_at: timestamp,
    completed_at: null,
    error_code: null,
    error_message: null,
  };
  state.provisioning_jobs.push(job);
  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "provisioning_job.queued",
    target_type: "provisioning_job",
    target_id: job.id,
    metadata: { kind, instance_id: instance.id },
  });
  return job;
}

function requestInstanceResume(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const entitlement = getEntitlement(state, session.user_id);
  if (!entitlement || !ACTIVE_ENTITLEMENT_STATES.has(entitlement.state)) {
    return { status: 403, data: { error: "managed_hosting_inactive" } };
  }

  let instance = getManagedInstance(state, session.user_id);
  if (!instance) {
    instance = createManagedInstance(state, runtime, session);
  }

  const activeJob = state.provisioning_jobs.find(
    (job) =>
      job &&
      job.instance_id === instance.id &&
      ["queued", "running"].includes(job.state) &&
      ["provision", "resume"].includes(job.kind)
  );

  if (activeJob) {
    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "instance.resume_deduplicated",
      target_type: "managed_instance",
      target_id: instance.id,
      metadata: { job_id: activeJob.id },
    });
    writeState(runtime.statePath, state);
    return { status: 200, data: buildCloudStatusPayload(state, instance) };
  }

  if (instance.state === "running") {
    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "instance.resume_ignored",
      target_type: "managed_instance",
      target_id: instance.id,
      metadata: { reason: "already_running" },
    });
    writeState(runtime.statePath, state);
    return { status: 200, data: buildCloudStatusPayload(state, instance) };
  }

  const nextJobKind = instance.state === "requested" ? "provision" : "resume";
  if (nextJobKind === "provision" && instance.state !== "provisioning") {
    assertManagedInstanceTransition(instance.state, "provisioning");
    instance.state = "provisioning";
  }
  instance.resume_requested_at = runtime.now();

  enqueueProvisioningJob(state, runtime, instance, session, nextJobKind);
  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "instance.resume_requested",
    target_type: "managed_instance",
    target_id: instance.id,
    metadata: { job_kind: nextJobKind },
  });
  writeState(runtime.statePath, state);

  return { status: 200, data: buildCloudStatusPayload(state, instance) };
}

function requestLoginStart(runtime, payload = {}) {
  const state = readState(runtime.statePath);
  const requestPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const loginRequest = createLoginRequest(state, runtime, requestPayload);
  writeState(runtime.statePath, state);
  return { status: 200, data: buildLoginStartPayload(loginRequest) };
}

function completeLoginRequest(runtime, deviceCode, options = {}) {
  const state = readState(runtime.statePath);
  const loginRequest = getLoginRequest(state, deviceCode);
  if (!loginRequest) {
    return { status: 404, data: { error: "invalid_device_code" } };
  }
  if (loginRequest.state !== "pending") {
    return { status: 409, data: { error: "login_request_not_pending" } };
  }
  if (Date.parse(loginRequest.expires_at) <= Date.parse(runtime.now())) {
    loginRequest.state = "expired";
    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "login_request.expired",
      target_type: "login_request",
      target_id: loginRequest.id,
      metadata: null,
    });
    writeState(runtime.statePath, state);
    return { status: 410, data: { error: "expired_device_code" } };
  }

  const user = getUser(state, options.userId);
  if (!user) {
    throw new Error(`Cannot complete login for missing user ${JSON.stringify(options.userId)}.`);
  }

  const timestamp = runtime.now();
  const session = {
    id: runtime.createId("sess"),
    user_id: user.id,
    state: "active",
    access_token: runtime.createId("access"),
    refresh_token: runtime.createId("refresh"),
    scopes: normalizeRequestedScopes(loginRequest.scopes),
    created_at: timestamp,
    expires_at: addDuration(timestamp, runtime.sessionTtlMs),
    last_authenticated_at: timestamp,
  };
  state.sessions.push(session);
  loginRequest.state = "completed";
  loginRequest.completed_at = timestamp;
  loginRequest.session_id = session.id;

  const identities = getIdentities(state, user.id);
  for (const identity of identities) {
    identity.last_used_at = timestamp;
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: user.id,
    action: "login_request.completed",
    target_type: "login_request",
    target_id: loginRequest.id,
    metadata: { session_id: session.id },
  });
  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: user.id,
    action: "session.created",
    target_type: "session",
    target_id: session.id,
    metadata: { origin: "device_login" },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildTokenPayload(state, session) };
}

function requestLoginPoll(runtime, deviceCode) {
  const state = readState(runtime.statePath);
  const loginRequest = getLoginRequest(state, deviceCode);
  if (!loginRequest) {
    return { status: 404, data: { error: "invalid_device_code" } };
  }

  const nowValue = Date.parse(runtime.now());
  if (Number.isFinite(nowValue) && Date.parse(loginRequest.expires_at) <= nowValue) {
    if (loginRequest.state !== "expired") {
      loginRequest.state = "expired";
      appendAudit(state, runtime, {
        actor_type: "system",
        actor_id: "control-plane",
        action: "login_request.expired",
        target_type: "login_request",
        target_id: loginRequest.id,
        metadata: null,
      });
      writeState(runtime.statePath, state);
    }
    return { status: 410, data: { error: "expired_device_code" } };
  }

  if (loginRequest.state === "pending") {
    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "login_request.polled_pending",
      target_type: "login_request",
      target_id: loginRequest.id,
      metadata: null,
    });
    writeState(runtime.statePath, state);
    return { status: 428, data: { error: "authorization_pending" } };
  }

  if (loginRequest.state !== "completed" || !loginRequest.session_id) {
    return { status: 409, data: { error: "invalid_login_request_state" } };
  }

  const session = state.sessions.find((candidate) => candidate && candidate.id === loginRequest.session_id);
  if (!session) {
    throw new Error(`Login request ${loginRequest.id} references missing session ${loginRequest.session_id}.`);
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "login_request.polled_completed",
    target_type: "login_request",
    target_id: loginRequest.id,
    metadata: { session_id: session.id },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildTokenPayload(state, session) };
}

function requestSession(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getAuthenticatedSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const timestamp = runtime.now();
  session.last_authenticated_at = timestamp;
  const identities = getIdentities(state, session.user_id);
  for (const identity of identities) {
    identity.last_used_at = timestamp;
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "session.lookup",
    target_type: "session",
    target_id: session.id,
    metadata: { surface: "cli_session" },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildWhoAmIPayload(state, session) };
}

function requestCloudStatus(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getAuthenticatedSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const timestamp = runtime.now();
  session.last_authenticated_at = timestamp;
  const identities = getIdentities(state, session.user_id);
  for (const identity of identities) {
    identity.last_used_at = timestamp;
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "cloud_status.lookup",
    target_type: "session",
    target_id: session.id,
    metadata: { surface: "cli_cloud_status" },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildCloudStatusPayload(state, getManagedInstance(state, session.user_id)) };
}

function requestSessionRefresh(runtime, refreshToken) {
  const state = readState(runtime.statePath);
  const session = getRefreshSession(state, refreshToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_refresh_token" } };
  }

  const timestamp = runtime.now();
  session.access_token = runtime.createId("access");
  session.refresh_token = runtime.createId("refresh");
  session.last_authenticated_at = timestamp;
  session.expires_at = addDuration(timestamp, runtime.sessionTtlMs);

  const identities = getIdentities(state, session.user_id);
  for (const identity of identities) {
    identity.last_used_at = timestamp;
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "session.refreshed",
    target_type: "session",
    target_id: session.id,
    metadata: { surface: "cli_session_refresh" },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildTokenPayload(state, session) };
}

async function runNextProvisioningJob(runtime) {
  const state = readState(runtime.statePath);
  const job = state.provisioning_jobs.find((candidate) => candidate && candidate.state === "queued");
  if (!job) {
    return null;
  }

  const instance = state.managed_instances.find((candidate) => candidate && candidate.id === job.instance_id);
  if (!instance) {
    throw new Error(`Provisioning job ${job.id} references missing instance ${job.instance_id}.`);
  }

  assertProvisioningJobTransition(job.state, "running");
  job.state = "running";
  job.started_at = runtime.now();
  job.updated_at = job.started_at;
  appendAudit(state, runtime, {
    actor_type: "system",
    actor_id: "control-plane",
    action: "provisioning_job.running",
    target_type: "provisioning_job",
    target_id: job.id,
    metadata: { instance_id: instance.id, kind: job.kind },
  });
  writeState(runtime.statePath, state);

  try {
    const result = await runtime.provisioner.runJob({
      job,
      instance,
      state,
      config: runtime.config,
    });

    assertProvisioningJobTransition(job.state, "succeeded");
    job.state = "succeeded";
    job.updated_at = runtime.now();
    job.completed_at = job.updated_at;
    job.error_code = null;
    job.error_message = null;

    if (instance.state !== "running") {
      assertManagedInstanceTransition(instance.state, "running");
      instance.state = "running";
    }
    instance.hostname = result.hostname || instance.hostname;
    instance.vm_name = result.vm_name || instance.vm_name;
    instance.zone = result.zone || instance.zone;
    instance.region = result.region || instance.region;
    instance.machine_token_id = result.machine_token_id || instance.machine_token_id;
    instance.last_seen_at = job.completed_at;

    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "provisioning_job.succeeded",
      target_type: "provisioning_job",
      target_id: job.id,
      metadata: { instance_id: instance.id, kind: job.kind },
    });
    appendAudit(state, runtime, {
      actor_type: "instance",
      actor_id: instance.id,
      action: "instance.running",
      target_type: "managed_instance",
      target_id: instance.id,
      metadata: { job_id: job.id },
    });
    writeState(runtime.statePath, state);
    return buildCloudStatusPayload(state, instance);
  } catch (error) {
    assertProvisioningJobTransition(job.state, "failed");
    job.state = "failed";
    job.updated_at = runtime.now();
    job.completed_at = job.updated_at;
    job.error_code = "provisioner_error";
    job.error_message = error instanceof Error ? error.message : String(error);

    if (instance.state !== "failed") {
      assertManagedInstanceTransition(instance.state, "failed");
      instance.state = "failed";
    }

    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "provisioning_job.failed",
      target_type: "provisioning_job",
      target_id: job.id,
      metadata: { instance_id: instance.id, kind: job.kind },
    });
    writeState(runtime.statePath, state);
    throw error;
  }
}

function extractBearerToken(request) {
  const header = request.headers?.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

async function handleHttpRequest(runtime, request) {
  if (request.method === "POST" && request.url === "/v1/cli/login/start") {
    let payload;
    try {
      payload = await readJsonRequestBody(request, runtime.requestBodyMaxBytes);
    } catch (error) {
      return {
        status: error.status || 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: error.code || "invalid_request" }),
      };
    }
    const result = requestLoginStart(runtime, payload);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/cli/login/poll") {
    let payload;
    try {
      payload = await readJsonRequestBody(request, runtime.requestBodyMaxBytes);
    } catch (error) {
      return {
        status: error.status || 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: error.code || "invalid_request" }),
      };
    }
    const deviceCode =
      payload && typeof payload === "object" && !Array.isArray(payload) ? payload.device_code : null;
    if (typeof deviceCode !== "string" || deviceCode.length === 0) {
      return {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "invalid_device_code" }),
      };
    }
    const result = requestLoginPoll(runtime, deviceCode);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "GET" && request.url === "/v1/cli/session") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestSession(runtime, accessToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "GET" && request.url === "/v1/cli/cloud/status") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestCloudStatus(runtime, accessToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/cli/cloud/instance/resume") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestInstanceResume(runtime, accessToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/cli/session/refresh") {
    let payload;
    try {
      payload = await readJsonRequestBody(request, runtime.requestBodyMaxBytes);
    } catch (error) {
      return {
        status: error.status || 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: error.code || "invalid_request" }),
      };
    }
    const refreshToken =
      payload && typeof payload === "object" && !Array.isArray(payload) ? payload.refresh_token : null;
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      return {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "invalid_refresh_token" }),
      };
    }
    const result = requestSessionRefresh(runtime, refreshToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  return {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ error: "not_found" }),
  };
}

async function readJsonRequestBody(request, maxBytes) {
  const contentType = request.headers?.["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error("Expected application/json request body.");
    error.status = 415;
    error.code = "unsupported_media_type";
    throw error;
  }

  let totalBytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      const error = new Error(`Request body exceeded ${maxBytes} bytes.`);
      error.status = 413;
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    const error = new Error("Expected JSON request body.");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (parseError) {
    const error = new Error("Request body was not valid JSON.");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function createNoopProvisioner() {
  return {
    async runJob({ instance, config }) {
      return {
        region: config.region,
        zone: config.zone,
        hostname: `${instance.id}.${config.hostnameDomain}`,
        vm_name: `vm-${instance.id}`,
        machine_token_id: `machine-${instance.id}`,
      };
    },
  };
}

module.exports = {
  CONTROL_PLANE_WRITE_SCOPE,
  STATE_SCHEMA_VERSION,
  completeLoginRequest,
  createDefaultState,
  createNoopProvisioner,
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
};
