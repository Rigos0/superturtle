const MAX_DISPLAY_FIELD_BYTES = 1024;
const MAX_AUDIT_ENTRIES = 20;
const MAX_IDENTITIES = 10;

const IDENTITY_PROVIDERS = ["github", "google"];
const SESSION_STATES = ["pending", "active", "expired", "revoked"];
const ENTITLEMENT_STATES = ["inactive", "trialing", "active", "past_due", "suspended", "canceled"];
const INSTANCE_PROVIDERS = ["gcp"];
const MANAGED_INSTANCE_STATES = [
  "requested",
  "provisioning",
  "running",
  "stopped",
  "suspended",
  "failed",
  "deleting",
  "deleted",
];
const PROVISIONING_JOB_KINDS = ["provision", "resume", "suspend", "reprovision", "delete", "repair"];
const PROVISIONING_JOB_STATES = ["queued", "running", "succeeded", "failed", "canceled"];
const AUDIT_ACTOR_TYPES = ["user", "system", "operator", "instance"];
const AUDIT_TARGET_TYPES = [
  "user",
  "identity",
  "session",
  "entitlement",
  "managed_instance",
  "provisioning_job",
  "teleport_session",
];

const MANAGED_INSTANCE_TRANSITIONS = {
  requested: ["provisioning", "deleted"],
  provisioning: ["running", "failed", "deleted"],
  running: ["provisioning", "stopped", "suspended", "failed", "deleting"],
  stopped: ["provisioning", "running", "suspended", "failed", "deleting"],
  suspended: ["provisioning", "running", "deleting"],
  failed: ["provisioning", "deleting"],
  deleting: ["deleted"],
  deleted: [],
};

const PROVISIONING_JOB_TRANSITIONS = {
  queued: ["running", "canceled"],
  running: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: ["queued"],
  canceled: ["queued"],
};

function fail(fieldName, message = "is invalid") {
  throw new Error(`${fieldName} ${message}.`);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateObject(value, fieldName) {
  if (!isPlainObject(value)) {
    fail(fieldName);
  }
  return value;
}

function validateOptionalObject(value, fieldName) {
  if (value == null) {
    return null;
  }
  return validateObject(value, fieldName);
}

function validateDisplayField(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf-8") > MAX_DISPLAY_FIELD_BYTES ||
    /[\x00-\x1F\x7F]/.test(value)
  ) {
    fail(fieldName);
  }
  return value;
}

function validateTimestamp(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() !== value || !Number.isFinite(Date.parse(value))) {
    fail(fieldName);
  }
  return value;
}

function validateBoolean(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "boolean") {
    fail(fieldName);
  }
  return value;
}

function validatePositiveInteger(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    fail(fieldName);
  }
  return value;
}

function validateEnum(value, allowedValues, fieldName) {
  if (value == null) {
    return null;
  }
  if (!allowedValues.includes(value)) {
    fail(fieldName);
  }
  return value;
}

function validateArray(value, fieldName, { maxItems = Infinity } = {}) {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(fieldName);
  }
  return value;
}

function validateStringRecord(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (!isPlainObject(value)) {
    fail(fieldName);
  }
  return value;
}

function validateWorkspace(value, fieldName = "workspace") {
  const workspace = validateOptionalObject(value, fieldName);
  if (!workspace) {
    return null;
  }
  return {
    slug: validateDisplayField(workspace.slug, `${fieldName}.slug`),
  };
}

function validateUser(value, fieldName = "user") {
  const user = validateOptionalObject(value, fieldName);
  if (!user) {
    return null;
  }
  return {
    id: validateDisplayField(user.id, `${fieldName}.id`),
    email: validateDisplayField(user.email, `${fieldName}.email`),
    created_at: validateTimestamp(user.created_at, `${fieldName}.created_at`),
  };
}

function validateIdentity(value, fieldName = "identity") {
  const identity = validateObject(value, fieldName);
  return {
    id: validateDisplayField(identity.id, `${fieldName}.id`),
    provider: validateEnum(identity.provider, IDENTITY_PROVIDERS, `${fieldName}.provider`),
    provider_user_id: validateDisplayField(identity.provider_user_id, `${fieldName}.provider_user_id`),
    email: validateDisplayField(identity.email, `${fieldName}.email`),
    created_at: validateTimestamp(identity.created_at, `${fieldName}.created_at`),
    last_used_at: validateTimestamp(identity.last_used_at, `${fieldName}.last_used_at`),
  };
}

function validateIdentityList(value, fieldName = "identities") {
  const identities = validateArray(value, fieldName, { maxItems: MAX_IDENTITIES });
  if (!identities) {
    return null;
  }
  return identities.map((identity, index) => validateIdentity(identity, `${fieldName}[${index}]`));
}

function validateControlPlaneSession(value, fieldName = "session") {
  const session = validateOptionalObject(value, fieldName);
  if (!session) {
    return null;
  }
  const scopes = validateArray(session.scopes, `${fieldName}.scopes`);
  if (!scopes || scopes.length === 0) {
    fail(`${fieldName}.scopes`);
  }
  return {
    id: validateDisplayField(session.id, `${fieldName}.id`),
    state: validateEnum(session.state, SESSION_STATES, `${fieldName}.state`),
    scopes: scopes.map((scope, index) => validateDisplayField(scope, `${fieldName}.scopes[${index}]`)),
    created_at: validateTimestamp(session.created_at, `${fieldName}.created_at`),
    expires_at: validateTimestamp(session.expires_at, `${fieldName}.expires_at`),
    last_authenticated_at: validateTimestamp(
      session.last_authenticated_at,
      `${fieldName}.last_authenticated_at`
    ),
  };
}

function validateEntitlement(value, fieldName = "entitlement") {
  const entitlement = validateOptionalObject(value, fieldName);
  if (!entitlement) {
    return null;
  }
  return {
    plan: validateDisplayField(entitlement.plan, `${fieldName}.plan`),
    state: validateEnum(entitlement.state, ENTITLEMENT_STATES, `${fieldName}.state`),
    subscription_id: validateDisplayField(entitlement.subscription_id, `${fieldName}.subscription_id`),
    current_period_end: validateTimestamp(
      entitlement.current_period_end,
      `${fieldName}.current_period_end`
    ),
    cancel_at_period_end: validateBoolean(
      entitlement.cancel_at_period_end,
      `${fieldName}.cancel_at_period_end`
    ),
  };
}

function validateManagedInstance(value, fieldName = "instance") {
  const instance = validateOptionalObject(value, fieldName);
  if (!instance) {
    return null;
  }
  return {
    id: validateDisplayField(instance.id, `${fieldName}.id`),
    provider: validateEnum(instance.provider, INSTANCE_PROVIDERS, `${fieldName}.provider`),
    state: validateEnum(instance.state, MANAGED_INSTANCE_STATES, `${fieldName}.state`),
    region: validateDisplayField(instance.region, `${fieldName}.region`),
    zone: validateDisplayField(instance.zone, `${fieldName}.zone`),
    hostname: validateDisplayField(instance.hostname, `${fieldName}.hostname`),
    vm_name: validateDisplayField(instance.vm_name, `${fieldName}.vm_name`),
    machine_token_id: validateDisplayField(instance.machine_token_id, `${fieldName}.machine_token_id`),
    last_seen_at: validateTimestamp(instance.last_seen_at, `${fieldName}.last_seen_at`),
    resume_requested_at: validateTimestamp(
      instance.resume_requested_at,
      `${fieldName}.resume_requested_at`
    ),
  };
}

function validateProvisioningJob(value, fieldName = "provisioning_job") {
  const job = validateOptionalObject(value, fieldName);
  if (!job) {
    return null;
  }
  return {
    id: validateDisplayField(job.id, `${fieldName}.id`),
    kind: validateEnum(job.kind, PROVISIONING_JOB_KINDS, `${fieldName}.kind`),
    state: validateEnum(job.state, PROVISIONING_JOB_STATES, `${fieldName}.state`),
    attempt: validatePositiveInteger(job.attempt, `${fieldName}.attempt`),
    created_at: validateTimestamp(job.created_at, `${fieldName}.created_at`),
    started_at: validateTimestamp(job.started_at, `${fieldName}.started_at`),
    updated_at: validateTimestamp(job.updated_at, `${fieldName}.updated_at`),
    completed_at: validateTimestamp(job.completed_at, `${fieldName}.completed_at`),
    error_code: validateDisplayField(job.error_code, `${fieldName}.error_code`),
    error_message: validateDisplayField(job.error_message, `${fieldName}.error_message`),
  };
}

function validateAuditEntry(value, fieldName = "audit_log[]") {
  const entry = validateObject(value, fieldName);
  return {
    id: validateDisplayField(entry.id, `${fieldName}.id`),
    actor_type: validateEnum(entry.actor_type, AUDIT_ACTOR_TYPES, `${fieldName}.actor_type`),
    actor_id: validateDisplayField(entry.actor_id, `${fieldName}.actor_id`),
    action: validateDisplayField(entry.action, `${fieldName}.action`),
    target_type: validateEnum(entry.target_type, AUDIT_TARGET_TYPES, `${fieldName}.target_type`),
    target_id: validateDisplayField(entry.target_id, `${fieldName}.target_id`),
    created_at: validateTimestamp(entry.created_at, `${fieldName}.created_at`),
    metadata: validateStringRecord(entry.metadata, `${fieldName}.metadata`),
  };
}

function validateAuditLog(value, fieldName = "audit_log") {
  const auditLog = validateArray(value, fieldName, { maxItems: MAX_AUDIT_ENTRIES });
  if (!auditLog) {
    return null;
  }
  return auditLog.map((entry, index) => validateAuditEntry(entry, `${fieldName}[${index}]`));
}

function validateCliWhoAmIResponse(payload) {
  const response = validateObject(payload, "response");
  return {
    user: validateUser(response.user, "user"),
    workspace: validateWorkspace(response.workspace, "workspace"),
    identities: validateIdentityList(response.identities, "identities"),
    session: validateControlPlaneSession(response.session, "session"),
    entitlement: validateEntitlement(response.entitlement, "entitlement"),
  };
}

function validateCliCloudStatusResponse(payload) {
  const response = validateObject(payload, "response");
  return {
    instance: validateManagedInstance(response.instance, "instance"),
    provisioning_job: validateProvisioningJob(response.provisioning_job, "provisioning_job"),
    audit_log: validateAuditLog(response.audit_log, "audit_log"),
  };
}

function validateCliTokenResponse(payload) {
  const response = validateObject(payload, "response");
  return {
    access_token: validateDisplayField(response.access_token, "access_token"),
    refresh_token: validateDisplayField(response.refresh_token, "refresh_token"),
    expires_at: validateTimestamp(response.expires_at, "expires_at"),
    user: validateUser(response.user, "user"),
    workspace: validateWorkspace(response.workspace, "workspace"),
    identities: validateIdentityList(response.identities, "identities"),
    session: validateControlPlaneSession(response.session, "session"),
    entitlement: validateEntitlement(response.entitlement, "entitlement"),
    instance: validateManagedInstance(response.instance, "instance"),
    provisioning_job: validateProvisioningJob(response.provisioning_job, "provisioning_job"),
    audit_log: validateAuditLog(response.audit_log, "audit_log"),
  };
}

function canTransition(transitionMap, fromState, toState) {
  if (!Object.prototype.hasOwnProperty.call(transitionMap, fromState)) {
    return false;
  }
  return transitionMap[fromState].includes(toState);
}

function assertTransition(transitionMap, lifecycleName, fromState, toState) {
  if (!canTransition(transitionMap, fromState, toState)) {
    throw new Error(`Invalid ${lifecycleName} transition from ${fromState} to ${toState}.`);
  }
}

function assertManagedInstanceTransition(fromState, toState) {
  assertTransition(MANAGED_INSTANCE_TRANSITIONS, "managed-instance", fromState, toState);
}

function assertProvisioningJobTransition(fromState, toState) {
  assertTransition(PROVISIONING_JOB_TRANSITIONS, "provisioning-job", fromState, toState);
}

module.exports = {
  AUDIT_ACTOR_TYPES,
  AUDIT_TARGET_TYPES,
  ENTITLEMENT_STATES,
  IDENTITY_PROVIDERS,
  INSTANCE_PROVIDERS,
  MANAGED_INSTANCE_STATES,
  MANAGED_INSTANCE_TRANSITIONS,
  PROVISIONING_JOB_KINDS,
  PROVISIONING_JOB_STATES,
  PROVISIONING_JOB_TRANSITIONS,
  SESSION_STATES,
  assertManagedInstanceTransition,
  assertProvisioningJobTransition,
  canTransition,
  validateCliCloudStatusResponse,
  validateCliTokenResponse,
  validateCliWhoAmIResponse,
};
