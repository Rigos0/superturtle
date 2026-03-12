const fs = require("fs");
const { dirname, resolve } = require("path");

const {
  assertManagedInstanceTransition,
  assertProvisioningJobTransition,
  validateCliCloudStatusResponse,
  validateCliWhoAmIResponse,
} = require("./cloud-control-plane-contract.js");

const STATE_SCHEMA_VERSION = 1;
const ACTIVE_ENTITLEMENT_STATES = new Set(["active", "trialing"]);
const CONTROL_PLANE_WRITE_SCOPE = "cloud:write";

function createDefaultState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    users: [],
    identities: [],
    sessions: [],
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
    },
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

  return {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ error: "not_found" }),
  };
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
  createDefaultState,
  createNoopProvisioner,
  createRuntime,
  handleHttpRequest,
  readState,
  requestCloudStatus,
  requestSession,
  requestInstanceResume,
  runNextProvisioningJob,
  writeState,
};
