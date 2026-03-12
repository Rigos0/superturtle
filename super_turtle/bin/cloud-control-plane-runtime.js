const fs = require("fs");
const { dirname, resolve } = require("path");
const { createGcpProvisioner } = require("./cloud-gcp-provisioner.js");
const {
  createStripeBillingAdapter,
  normalizeStripeWebhookEvent,
  parseStripeWebhookEvent,
  verifyStripeWebhookSignature,
} = require("./cloud-stripe-adapter.js");

const {
  validateCliClaudeAuthStatusResponse,
  assertManagedInstanceTransition,
  assertProvisioningJobTransition,
  validateCliCloudStatusResponse,
  validateMachineClaudeAuthResponse,
  validateCliTeleportTargetResponse,
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
    subscriptions: [],
    managed_instances: [],
    provider_credentials: [],
    provisioning_jobs: [],
    billing_events: [],
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
    "subscriptions",
    "managed_instances",
    "provisioning_jobs",
    "billing_events",
    "audit_log",
  ]) {
    if (!Array.isArray(state[field])) {
      throw new Error(`Control-plane state at ${statePath} is missing array field ${field}.`);
    }
  }

  if (!Array.isArray(state.login_requests)) {
    state.login_requests = [];
  }
  if (!Array.isArray(state.provider_credentials)) {
    state.provider_credentials = [];
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
    provisioner: options.provisioner || createConfiguredProvisioner(options),
    stripe: {
      webhookSecret:
        options.stripe && typeof options.stripe.webhookSecret === "string"
          ? options.stripe.webhookSecret
          : "",
      billingAdapter: createConfiguredStripeBillingAdapter(options),
    },
    claude: {
      authAdapter: createConfiguredClaudeAuthAdapter(options),
    },
    config: {
      provider: "gcp",
      region: options.region || "us-central1",
      zone: options.zone || "us-central1-a",
      hostnameDomain: options.hostnameDomain || "managed.superturtle.internal",
      publicOrigin: String(options.publicOrigin || "https://api.superturtle.dev").replace(/\/+$/, ""),
      managedSshUser: options.managedSshUser || "superturtle",
      managedProjectRoot: options.managedProjectRoot || "/srv/superturtle",
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

function getSubscription(state, { subscriptionId = null, customerId = null, checkoutSessionId = null } = {}) {
  return (
    state.subscriptions.find(
      (subscription) =>
        subscription &&
        ((subscriptionId && subscription.provider_subscription_id === subscriptionId) ||
          (customerId && subscription.provider_customer_id === customerId) ||
          (checkoutSessionId && subscription.checkout_session_id === checkoutSessionId))
    ) || null
  );
}

function getManagedInstance(state, userId) {
  return state.managed_instances.find((instance) => instance && instance.user_id === userId) || null;
}

function getProviderCredential(state, userId, provider) {
  return (
    state.provider_credentials.find(
      (credential) =>
        credential &&
        credential.user_id === userId &&
        credential.provider === provider
    ) || null
  );
}

function findProviderCredentialByAccessToken(state, provider, accessToken, excludedUserId = null) {
  return (
    state.provider_credentials.find(
      (credential) =>
        credential &&
        credential.provider === provider &&
        credential.access_token === accessToken &&
        credential.user_id !== excludedUserId
    ) || null
  );
}

function getManagedInstanceByMachineToken(state, machineToken) {
  return (
    state.managed_instances.find(
      (instance) =>
        instance &&
        instance.machine_auth_token === machineToken &&
        instance.state !== "deleted" &&
        instance.state !== "deleting"
    ) || null
  );
}

function getLatestProvisioningJob(state, instanceId) {
  const jobs = state.provisioning_jobs.filter((job) => job && job.instance_id === instanceId);
  if (jobs.length === 0) {
    return null;
  }
  return jobs.reduce((latest, job) => {
    if (!latest) return job;
    const jobTimestamp = String(job.updated_at || job.created_at || "");
    const latestTimestamp = String(latest.updated_at || latest.created_at || "");
    if (jobTimestamp > latestTimestamp) {
      return job;
    }
    if (jobTimestamp === latestTimestamp) {
      return job;
    }
    return latest;
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

function getBillingEvent(state, provider, eventId) {
  return (
    state.billing_events.find(
      (event) => event && event.provider === provider && event.event_id === eventId
    ) || null
  );
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

function buildTeleportTargetPayload(state, instance, config) {
  return validateCliTeleportTargetResponse({
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
    ssh_target: `${config.managedSshUser}@${instance.hostname}`,
    remote_root: config.managedProjectRoot,
    audit_log: getRecentAuditLog(state, instance.id),
  });
}

function buildClaudeAuthStatusPayload(state, credential) {
  return validateCliClaudeAuthStatusResponse({
    provider: "claude",
    configured: Boolean(credential && credential.state === "valid" && credential.access_token),
    credential: credential
      ? {
          id: credential.id,
          provider: credential.provider,
          state: credential.state,
          account_email: credential.account_email || null,
          configured_at: credential.configured_at || null,
          last_validated_at: credential.last_validated_at || null,
          last_error_code: credential.last_error_code || null,
          last_error_message: credential.last_error_message || null,
        }
      : null,
    audit_log: credential ? getRecentAuditLog(state, credential.id) : [],
  });
}

function buildMachineClaudeAuthPayload(state, credential) {
  return validateMachineClaudeAuthResponse({
    provider: "claude",
    configured: Boolean(credential && credential.state === "valid" && credential.access_token),
    access_token:
      credential && credential.state === "valid" && credential.access_token
        ? credential.access_token
        : null,
    credential: credential
      ? {
          id: credential.id,
          provider: credential.provider,
          state: credential.state,
          account_email: credential.account_email || null,
          configured_at: credential.configured_at || null,
          last_validated_at: credential.last_validated_at || null,
          last_error_code: credential.last_error_code || null,
          last_error_message: credential.last_error_message || null,
        }
      : null,
    audit_log: credential ? getRecentAuditLog(state, credential.id) : [],
  });
}

function buildMachineStatusPayload(instance) {
  return {
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
  };
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

function isStripeWebhookConfigured(runtime) {
  return Boolean(runtime.stripe && typeof runtime.stripe.webhookSecret === "string" && runtime.stripe.webhookSecret);
}

function isStripeCheckoutConfigured(runtime) {
  return Boolean(
    runtime.stripe &&
      runtime.stripe.billingAdapter &&
      typeof runtime.stripe.billingAdapter.createCheckoutSession === "function"
  );
}

function isStripeCustomerPortalConfigured(runtime) {
  return Boolean(
    runtime.stripe &&
      runtime.stripe.billingAdapter &&
      typeof runtime.stripe.billingAdapter.createCustomerPortalSession === "function"
  );
}

function recordBillingEvent(state, runtime, event) {
  state.billing_events.push({
    id: runtime.createId("bill"),
    provider: "stripe",
    event_id: event.eventId,
    event_type: event.eventType,
    state: event.state || "processed",
    created_at: runtime.now(),
  });
}

function upsertSubscriptionRecord(state, runtime, subject) {
  let record =
    getSubscription(state, {
      subscriptionId: subject.subscriptionId,
      customerId: subject.customerId,
      checkoutSessionId: subject.checkoutSessionId,
    }) || null;

  if (!record) {
    record = {
      id: runtime.createId("subrec"),
      provider: "stripe",
      user_id: subject.userId,
      provider_customer_id: subject.customerId || null,
      provider_subscription_id: subject.subscriptionId || null,
      checkout_session_id: subject.checkoutSessionId || null,
      plan: subject.plan || "managed",
      state: null,
      current_period_end: null,
      cancel_at_period_end: false,
      latest_event_id: subject.eventId,
      latest_event_type: subject.eventType,
      created_at: runtime.now(),
      updated_at: runtime.now(),
    };
    state.subscriptions.push(record);
  }

  if (subject.userId) {
    record.user_id = subject.userId;
  }
  if (subject.customerId) {
    record.provider_customer_id = subject.customerId;
  }
  if (subject.subscriptionId) {
    record.provider_subscription_id = subject.subscriptionId;
  }
  if (subject.checkoutSessionId) {
    record.checkout_session_id = subject.checkoutSessionId;
  }
  if (subject.plan) {
    record.plan = subject.plan;
  }
  if (subject.entitlementState) {
    record.state = subject.entitlementState;
  }
  if (Object.prototype.hasOwnProperty.call(subject, "currentPeriodEnd")) {
    record.current_period_end = subject.currentPeriodEnd;
  }
  if (Object.prototype.hasOwnProperty.call(subject, "cancelAtPeriodEnd")) {
    record.cancel_at_period_end = subject.cancelAtPeriodEnd;
  }
  record.latest_event_id = subject.eventId;
  record.latest_event_type = subject.eventType;
  record.updated_at = runtime.now();
  return record;
}

function syncEntitlementFromSubscription(state, runtime, subscriptionRecord) {
  if (!subscriptionRecord.user_id) {
    throw new Error(`Stripe subscription ${subscriptionRecord.id} is missing a user_id.`);
  }

  let entitlement = getEntitlement(state, subscriptionRecord.user_id);
  const nextState = subscriptionRecord.state || "inactive";
  if (!entitlement) {
    entitlement = {
      user_id: subscriptionRecord.user_id,
      plan: subscriptionRecord.plan || "managed",
      state: nextState,
      subscription_id: subscriptionRecord.provider_subscription_id || null,
      current_period_end: subscriptionRecord.current_period_end || null,
      cancel_at_period_end: Boolean(subscriptionRecord.cancel_at_period_end),
    };
    state.entitlements.push(entitlement);
  } else {
    entitlement.plan = subscriptionRecord.plan || entitlement.plan || "managed";
    entitlement.state = nextState;
    entitlement.subscription_id = subscriptionRecord.provider_subscription_id || entitlement.subscription_id || null;
    entitlement.current_period_end = subscriptionRecord.current_period_end || null;
    entitlement.cancel_at_period_end = Boolean(subscriptionRecord.cancel_at_period_end);
  }

  appendAudit(state, runtime, {
    actor_type: "system",
    actor_id: "stripe",
    action: "entitlement.synced_from_billing",
    target_type: "entitlement",
    target_id: entitlement.user_id,
    metadata: {
      subscription_id: entitlement.subscription_id,
      state: entitlement.state,
      event_type: subscriptionRecord.latest_event_type,
    },
  });

  return entitlement;
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

function authenticateMachineRequest(state, machineToken) {
  if (typeof machineToken !== "string" || machineToken.length === 0) {
    return null;
  }
  return getManagedInstanceByMachineToken(state, machineToken);
}

function requestMachineRegister(runtime, machineToken, payload = {}) {
  const state = readState(runtime.statePath);
  const instance = authenticateMachineRequest(state, machineToken);
  if (!instance) {
    return { status: 401, data: { error: "invalid_machine_token" } };
  }

  const registerPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const timestamp = runtime.now();

  if (instance.state === "provisioning") {
    assertManagedInstanceTransition(instance.state, "running");
    instance.state = "running";
  }

  if (typeof registerPayload.hostname === "string" && registerPayload.hostname.trim().length > 0) {
    instance.hostname = registerPayload.hostname.trim();
  }
  if (typeof registerPayload.vm_name === "string" && registerPayload.vm_name.trim().length > 0) {
    instance.vm_name = registerPayload.vm_name.trim();
  }
  if (typeof registerPayload.region === "string" && registerPayload.region.trim().length > 0) {
    instance.region = registerPayload.region.trim();
  }
  if (typeof registerPayload.zone === "string" && registerPayload.zone.trim().length > 0) {
    instance.zone = registerPayload.zone.trim();
  }

  instance.last_seen_at = timestamp;
  instance.registered_at = instance.registered_at || timestamp;
  instance.health_checked_at = timestamp;
  instance.health_status = "healthy";

  appendAudit(state, runtime, {
    actor_type: "instance",
    actor_id: instance.id,
    action: "machine.registered",
    target_type: "managed_instance",
    target_id: instance.id,
    metadata: {
      hostname: instance.hostname,
      vm_name: instance.vm_name,
    },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildMachineStatusPayload(instance) };
}

function requestMachineHeartbeat(runtime, machineToken, payload = {}) {
  const state = readState(runtime.statePath);
  const instance = authenticateMachineRequest(state, machineToken);
  if (!instance) {
    return { status: 401, data: { error: "invalid_machine_token" } };
  }

  const heartbeatPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const timestamp = runtime.now();

  if (typeof heartbeatPayload.hostname === "string" && heartbeatPayload.hostname.trim().length > 0) {
    instance.hostname = heartbeatPayload.hostname.trim();
  }
  if (typeof heartbeatPayload.vm_name === "string" && heartbeatPayload.vm_name.trim().length > 0) {
    instance.vm_name = heartbeatPayload.vm_name.trim();
  }
  if (typeof heartbeatPayload.region === "string" && heartbeatPayload.region.trim().length > 0) {
    instance.region = heartbeatPayload.region.trim();
  }
  if (typeof heartbeatPayload.zone === "string" && heartbeatPayload.zone.trim().length > 0) {
    instance.zone = heartbeatPayload.zone.trim();
  }

  instance.last_seen_at = timestamp;
  instance.health_checked_at = timestamp;
  if (typeof heartbeatPayload.health_status === "string" && heartbeatPayload.health_status.trim().length > 0) {
    instance.health_status = heartbeatPayload.health_status.trim();
  }

  appendAudit(state, runtime, {
    actor_type: "instance",
    actor_id: instance.id,
    action: "machine.heartbeat",
    target_type: "managed_instance",
    target_id: instance.id,
    metadata: {
      health_status: instance.health_status || null,
    },
  });
  writeState(runtime.statePath, state);
  return {
    status: 200,
    data: {
      ok: true,
      last_seen_at: instance.last_seen_at,
      health_status: instance.health_status || null,
    },
  };
}

function requestMachineClaudeProviderAuth(runtime, machineToken) {
  const state = readState(runtime.statePath);
  const instance = authenticateMachineRequest(state, machineToken);
  if (!instance) {
    return { status: 401, data: { error: "invalid_machine_token" } };
  }

  const credential = getProviderCredential(state, instance.user_id, "claude");

  appendAudit(state, runtime, {
    actor_type: "instance",
    actor_id: instance.id,
    action: "provider_credential.claude_machine_lookup",
    target_type: credential ? "provider_credential" : "managed_instance",
    target_id: credential ? credential.id : instance.id,
    metadata: {
      configured: credential ? "true" : "false",
    },
  });
  writeState(runtime.statePath, state);
  return {
    status: 200,
    data: buildMachineClaudeAuthPayload(state, credential || null),
  };
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

function requestTeleportTarget(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const entitlement = getEntitlement(state, session.user_id);
  if (!entitlement || !ACTIVE_ENTITLEMENT_STATES.has(entitlement.state)) {
    return { status: 403, data: { error: "managed_hosting_inactive" } };
  }

  const instance = getManagedInstance(state, session.user_id);
  if (!instance) {
    return { status: 409, data: { error: "managed_instance_unavailable" } };
  }
  if (instance.state !== "running") {
    return { status: 409, data: { error: "managed_instance_not_running" } };
  }
  if (typeof instance.hostname !== "string" || instance.hostname.trim().length === 0) {
    return { status: 409, data: { error: "managed_instance_missing_hostname" } };
  }

  const timestamp = runtime.now();
  session.last_authenticated_at = timestamp;
  for (const identity of getIdentities(state, session.user_id)) {
    identity.last_used_at = timestamp;
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "teleport_target.lookup",
    target_type: "managed_instance",
    target_id: instance.id,
    metadata: {
      ssh_target: `${runtime.config.managedSshUser}@${instance.hostname}`,
      remote_root: runtime.config.managedProjectRoot,
    },
  });
  writeState(runtime.statePath, state);
  return { status: 200, data: buildTeleportTargetPayload(state, instance, runtime.config) };
}

function requestInstanceReprovision(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const entitlement = getEntitlement(state, session.user_id);
  if (!entitlement || !ACTIVE_ENTITLEMENT_STATES.has(entitlement.state)) {
    return { status: 403, data: { error: "managed_hosting_inactive" } };
  }

  const instance = getManagedInstance(state, session.user_id);
  if (!instance || ["requested", "deleted", "deleting"].includes(instance.state)) {
    return { status: 409, data: { error: "managed_instance_not_ready_for_reprovision" } };
  }

  const activeJob = state.provisioning_jobs.find(
    (job) =>
      job &&
      job.instance_id === instance.id &&
      ["queued", "running"].includes(job.state) &&
      ["provision", "resume", "reprovision"].includes(job.kind)
  );

  if (activeJob) {
    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "control-plane",
      action: "instance.reprovision_deduplicated",
      target_type: "managed_instance",
      target_id: instance.id,
      metadata: { job_id: activeJob.id, job_kind: activeJob.kind },
    });
    writeState(runtime.statePath, state);
    return { status: 200, data: buildCloudStatusPayload(state, instance) };
  }

  assertManagedInstanceTransition(instance.state, "provisioning");
  instance.state = "provisioning";
  instance.resume_requested_at = runtime.now();
  instance.machine_token_id = null;
  instance.machine_auth_token = null;
  instance.last_seen_at = null;
  instance.registered_at = null;
  instance.health_checked_at = null;
  instance.health_status = null;

  enqueueProvisioningJob(state, runtime, instance, session, "reprovision");
  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "instance.reprovision_requested",
    target_type: "managed_instance",
    target_id: instance.id,
    metadata: null,
  });
  writeState(runtime.statePath, state);

  return { status: 200, data: buildCloudStatusPayload(state, instance) };
}

function requestStripeWebhook(runtime, signatureHeader, rawBody) {
  if (!isStripeWebhookConfigured(runtime)) {
    return { status: 503, data: { error: "stripe_webhook_not_configured" } };
  }

  try {
    verifyStripeWebhookSignature({
      payload: rawBody,
      signatureHeader,
      webhookSecret: runtime.stripe.webhookSecret,
      now: Date.parse(runtime.now()),
    });
  } catch (error) {
    const status = error.code === "missing_webhook_secret" ? 503 : 401;
    return { status, data: { error: error.code || "invalid_signature" } };
  }

  let parsed;
  try {
    parsed = parseStripeWebhookEvent(rawBody);
  } catch (error) {
    return { status: 400, data: { error: error.code || "invalid_event" } };
  }

  const normalized = normalizeStripeWebhookEvent(parsed);
  const state = readState(runtime.statePath);
  const existingEvent = getBillingEvent(state, "stripe", normalized.eventId);
  if (existingEvent) {
    return {
      status: 200,
      data: { ok: true, event_id: normalized.eventId, state: "already_processed" },
    };
  }

  if (normalized.kind === "ignored") {
    recordBillingEvent(state, runtime, { ...normalized, state: "ignored" });
    appendAudit(state, runtime, {
      actor_type: "system",
      actor_id: "stripe",
      action: "billing.webhook_ignored",
      target_type: "user",
      target_id: "unknown",
      metadata: { event_id: normalized.eventId, event_type: normalized.eventType },
    });
    writeState(runtime.statePath, state);
    return { status: 200, data: { ok: true, event_id: normalized.eventId, state: "ignored" } };
  }

  const existingSubscription =
    getSubscription(state, {
      subscriptionId: normalized.subscriptionId,
      customerId: normalized.customerId,
      checkoutSessionId: normalized.checkoutSessionId,
    }) || null;
  const userId = normalized.userId || existingSubscription?.user_id || null;
  if (!userId || !getUser(state, userId)) {
    return { status: 422, data: { error: "unresolved_billing_user" } };
  }

  const subscriptionRecord = upsertSubscriptionRecord(state, runtime, {
    ...normalized,
    userId,
  });
  if (normalized.kind === "subscription") {
    syncEntitlementFromSubscription(state, runtime, subscriptionRecord);
  }

  recordBillingEvent(state, runtime, normalized);
  appendAudit(state, runtime, {
    actor_type: "system",
    actor_id: "stripe",
    action: "billing.webhook_processed",
    target_type: "user",
    target_id: userId,
    metadata: {
      event_id: normalized.eventId,
      event_type: normalized.eventType,
      subscription_id: subscriptionRecord.provider_subscription_id,
    },
  });
  writeState(runtime.statePath, state);

  return {
    status: 200,
    data: {
      ok: true,
      event_id: normalized.eventId,
      subscription_id: subscriptionRecord.provider_subscription_id || null,
      entitlement_state: normalized.kind === "subscription" ? subscriptionRecord.state : null,
    },
  };
}

async function requestStripeCheckoutSession(runtime, accessToken, payload = {}) {
  if (!isStripeCheckoutConfigured(runtime)) {
    return { status: 503, data: { error: "stripe_checkout_not_configured" } };
  }

  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const entitlement = getEntitlement(state, session.user_id);
  if (entitlement && ACTIVE_ENTITLEMENT_STATES.has(entitlement.state)) {
    return { status: 409, data: { error: "managed_hosting_already_active" } };
  }

  const requestPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const plan =
    typeof requestPayload.plan === "string" && requestPayload.plan.trim().length > 0
      ? requestPayload.plan.trim()
      : "managed";
  const existingSubscription =
    state.subscriptions
      .filter((subscription) => subscription && subscription.user_id === session.user_id)
      .sort((left, right) =>
        String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""))
      )[0] || null;
  const user = getUser(state, session.user_id);
  if (!user) {
    throw new Error(`Session ${session.id} references missing user ${session.user_id}.`);
  }

  let checkout;
  try {
    checkout = await runtime.stripe.billingAdapter.createCheckoutSession({
      userId: session.user_id,
      plan,
      customerId: existingSubscription?.provider_customer_id || null,
      metadata: {
        session_id: session.id,
        user_email: user.email || "",
      },
    });
  } catch (error) {
    return {
      status: 502,
      data: { error: error && typeof error.code === "string" ? error.code : "stripe_checkout_failed" },
    };
  }

  const subscriptionRecord = upsertSubscriptionRecord(state, runtime, {
    userId: session.user_id,
    customerId: checkout.customerId || existingSubscription?.provider_customer_id || null,
    subscriptionId: checkout.subscriptionId || existingSubscription?.provider_subscription_id || null,
    checkoutSessionId: checkout.id,
    plan,
    eventId: existingSubscription?.latest_event_id || null,
    eventType: "checkout.session.created",
  });
  if (!subscriptionRecord.state) {
    subscriptionRecord.state = "inactive";
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "billing.checkout_session_created",
    target_type: "user",
    target_id: session.user_id,
    metadata: {
      checkout_session_id: checkout.id,
      customer_id: subscriptionRecord.provider_customer_id || null,
      subscription_id: subscriptionRecord.provider_subscription_id || null,
      plan,
    },
  });
  writeState(runtime.statePath, state);

  return {
    status: 200,
    data: {
      checkout_session_id: checkout.id,
      checkout_url: checkout.url,
      customer_id: subscriptionRecord.provider_customer_id || null,
      subscription_id: subscriptionRecord.provider_subscription_id || null,
      plan,
    },
  };
}

async function requestStripeCustomerPortalSession(runtime, accessToken) {
  if (!isStripeCustomerPortalConfigured(runtime)) {
    return { status: 503, data: { error: "stripe_customer_portal_not_configured" } };
  }

  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const subscription =
    state.subscriptions
      .filter((record) => record && record.user_id === session.user_id)
      .sort((left, right) =>
        String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""))
      )[0] || null;

  const customerId = subscription?.provider_customer_id || null;
  if (!customerId) {
    return { status: 409, data: { error: "billing_customer_not_found" } };
  }

  let portalSession;
  try {
    portalSession = await runtime.stripe.billingAdapter.createCustomerPortalSession({
      customerId,
      userId: session.user_id,
    });
  } catch (error) {
    return {
      status: 502,
      data: { error: error && typeof error.code === "string" ? error.code : "stripe_portal_failed" },
    };
  }

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "billing.customer_portal_session_created",
    target_type: "user",
    target_id: session.user_id,
    metadata: {
      customer_id: customerId,
      subscription_id: subscription?.provider_subscription_id || null,
      portal_session_id: portalSession.id,
    },
  });
  writeState(runtime.statePath, state);

  return {
    status: 200,
    data: {
      customer_id: customerId,
      portal_session_id: portalSession.id,
      portal_url: portalSession.url,
    },
  };
}

function validateClaudeSetupPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "invalid_request" };
  }
  if (typeof payload.access_token !== "string" || payload.access_token.trim().length === 0) {
    return { error: "invalid_access_token" };
  }
  const accessToken = payload.access_token.trim();
  if (accessToken.length > 4096 || /[\x00-\x1F\x7F]/.test(accessToken)) {
    return { error: "invalid_access_token" };
  }
  return { accessToken };
}

function requestClaudeProviderStatus(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const credential = getProviderCredential(state, session.user_id, "claude");
  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "provider_credential.claude_status_lookup",
    target_type: credential ? "provider_credential" : "user",
    target_id: credential ? credential.id : session.user_id,
    metadata: null,
  });
  writeState(runtime.statePath, state);
  return {
    status: 200,
    data: buildClaudeAuthStatusPayload(state, credential),
  };
}

function revokeClaudeProviderAuth(runtime, accessToken) {
  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  const credential = getProviderCredential(state, session.user_id, "claude");
  if (!credential) {
    return { status: 404, data: { error: "provider_credential_not_found" } };
  }

  credential.state = "revoked";
  credential.access_token = null;
  credential.last_error_code = null;
  credential.last_error_message = null;

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "provider_credential.claude_revoked",
    target_type: "provider_credential",
    target_id: credential.id,
    metadata: {
      account_email: credential.account_email || null,
    },
  });
  writeState(runtime.statePath, state);
  return {
    status: 200,
    data: buildClaudeAuthStatusPayload(state, credential),
  };
}

async function setupClaudeProviderAuth(runtime, accessToken, payload = {}) {
  const validatedPayload = validateClaudeSetupPayload(payload);
  if (validatedPayload.error) {
    return { status: 400, data: { error: validatedPayload.error } };
  }

  const state = readState(runtime.statePath);
  const session = getUserSession(state, accessToken);
  if (!session) {
    return { status: 401, data: { error: "invalid_session" } };
  }

  if (!runtime.claude.authAdapter || typeof runtime.claude.authAdapter.validateAccessToken !== "function") {
    return { status: 503, data: { error: "claude_auth_not_configured" } };
  }

  const existingCredential = getProviderCredential(state, session.user_id, "claude");
  const conflictingCredential = findProviderCredentialByAccessToken(
    state,
    "claude",
    validatedPayload.accessToken,
    session.user_id
  );
  if (conflictingCredential) {
    appendAudit(state, runtime, {
      actor_type: "user",
      actor_id: session.user_id,
      action: "provider_credential.claude_conflict_rejected",
      target_type: "provider_credential",
      target_id: conflictingCredential.id,
      metadata: {
        conflicting_user_id: conflictingCredential.user_id,
      },
    });
    writeState(runtime.statePath, state);
    return {
      status: 409,
      data: {
        error: "provider_credential_conflict",
      },
    };
  }
  let validationResult;
  try {
    validationResult = await runtime.claude.authAdapter.validateAccessToken({
      accessToken: validatedPayload.accessToken,
      userId: session.user_id,
    });
  } catch (error) {
    appendAudit(state, runtime, {
      actor_type: "user",
      actor_id: session.user_id,
      action: "provider_credential.claude_validation_errored",
      target_type: existingCredential ? "provider_credential" : "user",
      target_id: existingCredential ? existingCredential.id : session.user_id,
      metadata: {
        error_code: error && typeof error.code === "string" ? error.code : "claude_validation_failed",
      },
    });
    writeState(runtime.statePath, state);
    return {
      status: 502,
      data: {
        error: error && typeof error.code === "string" ? error.code : "claude_validation_failed",
      },
    };
  }

  if (!validationResult || validationResult.valid !== true) {
    appendAudit(state, runtime, {
      actor_type: "user",
      actor_id: session.user_id,
      action: "provider_credential.claude_validation_rejected",
      target_type: existingCredential ? "provider_credential" : "user",
      target_id: existingCredential ? existingCredential.id : session.user_id,
      metadata: {
        error_code:
          validationResult && typeof validationResult.errorCode === "string"
            ? validationResult.errorCode
            : "invalid_claude_credentials",
      },
    });
    writeState(runtime.statePath, state);
    return {
      status: 422,
      data: {
        error:
          validationResult && typeof validationResult.errorCode === "string"
            ? validationResult.errorCode
            : "invalid_claude_credentials",
      },
    };
  }

  const timestamp = runtime.now();
  const credential =
    existingCredential ||
    {
      id: runtime.createId("cred"),
      user_id: session.user_id,
      provider: "claude",
      configured_at: timestamp,
    };
  if (!existingCredential) {
    state.provider_credentials.push(credential);
  }
  credential.state = "valid";
  credential.access_token = validatedPayload.accessToken;
  credential.account_email =
    validationResult.accountEmail && typeof validationResult.accountEmail === "string"
      ? validationResult.accountEmail
      : existingCredential?.account_email || null;
  credential.configured_at = credential.configured_at || timestamp;
  credential.last_validated_at = timestamp;
  credential.last_error_code = null;
  credential.last_error_message = null;

  appendAudit(state, runtime, {
    actor_type: "user",
    actor_id: session.user_id,
    action: "provider_credential.claude_configured",
    target_type: "provider_credential",
    target_id: credential.id,
    metadata: {
      account_email: credential.account_email || null,
    },
  });
  writeState(runtime.statePath, state);
  return {
    status: 200,
    data: buildClaudeAuthStatusPayload(state, credential),
  };
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
      createId: runtime.createId,
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
    instance.machine_auth_token = result.machine_auth_token || instance.machine_auth_token || runtime.createId("machine");
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
  if (request.method === "POST" && request.url === "/v1/billing/stripe/checkout-session") {
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
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = await requestStripeCheckoutSession(runtime, accessToken, payload);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/billing/stripe/customer-portal-session") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = await requestStripeCustomerPortalSession(runtime, accessToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/billing/stripe/webhook") {
    let rawBody;
    try {
      rawBody = await readRawRequestBody(request, runtime.requestBodyMaxBytes, { requireJsonContentType: true });
    } catch (error) {
      return {
        status: error.status || 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: error.code || "invalid_request" }),
      };
    }
    const result = requestStripeWebhook(runtime, request.headers?.["stripe-signature"], rawBody);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

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

  if (request.method === "GET" && request.url === "/v1/cli/providers/claude/status") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestClaudeProviderStatus(runtime, accessToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/cli/providers/claude/setup") {
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
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = await setupClaudeProviderAuth(runtime, accessToken, payload);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "DELETE" && request.url === "/v1/cli/providers/claude") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = revokeClaudeProviderAuth(runtime, accessToken);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "GET" && request.url === "/v1/cli/teleport/target") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestTeleportTarget(runtime, accessToken);
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

  if (request.method === "POST" && request.url === "/v1/cli/cloud/instance/reprovision") {
    const accessToken = extractBearerToken(request);
    if (!accessToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestInstanceReprovision(runtime, accessToken);
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

  if (request.method === "POST" && request.url === "/v1/machine/register") {
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
    const machineToken = extractBearerToken(request);
    if (!machineToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestMachineRegister(runtime, machineToken, payload);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "POST" && request.url === "/v1/machine/heartbeat") {
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
    const machineToken = extractBearerToken(request);
    if (!machineToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestMachineHeartbeat(runtime, machineToken, payload);
    return {
      status: result.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result.data),
    };
  }

  if (request.method === "GET" && request.url === "/v1/machine/providers/claude") {
    const machineToken = extractBearerToken(request);
    if (!machineToken) {
      return {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ error: "missing_bearer_token" }),
      };
    }
    const result = requestMachineClaudeProviderAuth(runtime, machineToken);
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
  const raw = await readRawRequestBody(request, maxBytes, { requireJsonContentType: true });
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

async function readRawRequestBody(request, maxBytes, options = {}) {
  if (options.requireJsonContentType) {
    const contentType = request.headers?.["content-type"];
    if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      const error = new Error("Expected application/json request body.");
      error.status = 415;
      error.code = "unsupported_media_type";
      throw error;
    }
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

  return Buffer.concat(chunks).toString("utf-8");
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
        machine_auth_token: `machine-auth-${instance.id}`,
      };
    },
  };
}

function createConfiguredProvisioner(options) {
  const gcpOptions = options && options.gcp && typeof options.gcp === "object" ? options.gcp : null;
  if (gcpOptions && typeof gcpOptions.projectId === "string" && gcpOptions.projectId.trim().length > 0) {
    return createGcpProvisioner({
      ...gcpOptions,
      hostnameDomain: gcpOptions.hostnameDomain || options.hostnameDomain,
    });
  }
  return createNoopProvisioner();
}

function createConfiguredStripeBillingAdapter(options) {
  const stripeOptions = options && options.stripe && typeof options.stripe === "object" ? options.stripe : null;
  if (
    stripeOptions &&
    stripeOptions.billingAdapter &&
    (typeof stripeOptions.billingAdapter.createCheckoutSession === "function" ||
      typeof stripeOptions.billingAdapter.createCustomerPortalSession === "function")
  ) {
    return stripeOptions.billingAdapter;
  }
  if (
    stripeOptions &&
    typeof stripeOptions.secretKey === "string" &&
    stripeOptions.secretKey.trim().length > 0 &&
    typeof stripeOptions.priceId === "string" &&
    stripeOptions.priceId.trim().length > 0 &&
    typeof stripeOptions.successUrl === "string" &&
    stripeOptions.successUrl.trim().length > 0 &&
    typeof stripeOptions.cancelUrl === "string" &&
    stripeOptions.cancelUrl.trim().length > 0
  ) {
    return createStripeBillingAdapter(stripeOptions);
  }
  return null;
}

function createConfiguredClaudeAuthAdapter(options) {
  const claudeOptions = options && options.claude && typeof options.claude === "object" ? options.claude : null;
  if (
    claudeOptions &&
    claudeOptions.authAdapter &&
    typeof claudeOptions.authAdapter.validateAccessToken === "function"
  ) {
    return claudeOptions.authAdapter;
  }
  return createClaudeAuthAdapter();
}

function createClaudeAuthAdapter() {
  return {
    async validateAccessToken({ accessToken }) {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      if (response.status === 401 || response.status === 403) {
        return { valid: false, errorCode: "invalid_claude_credentials" };
      }
      if (!response.ok) {
        const error = new Error(`Anthropic validation returned HTTP ${response.status}.`);
        error.code = "claude_validation_failed";
        throw error;
      }
      return { valid: true, accountEmail: null };
    },
  };
}

module.exports = {
  CONTROL_PLANE_WRITE_SCOPE,
  STATE_SCHEMA_VERSION,
  completeLoginRequest,
  createDefaultState,
  createConfiguredProvisioner,
  createConfiguredStripeBillingAdapter,
  createNoopProvisioner,
  createRuntime,
  handleHttpRequest,
  readState,
  requestCloudStatus,
  requestClaudeProviderStatus,
  revokeClaudeProviderAuth,
  requestMachineClaudeProviderAuth,
  requestMachineHeartbeat,
  requestMachineRegister,
  requestInstanceReprovision,
  requestStripeCheckoutSession,
  requestStripeCustomerPortalSession,
  requestStripeWebhook,
  requestLoginPoll,
  requestLoginStart,
  requestSession,
  requestSessionRefresh,
  setupClaudeProviderAuth,
  requestInstanceResume,
  requestTeleportTarget,
  runNextProvisioningJob,
  writeState,
};
