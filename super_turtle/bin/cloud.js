const fs = require("fs");
const os = require("os");
const { resolve, dirname } = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_CONTROL_PLANE = "https://api.superturtle.dev";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_EXPIRY_SKEW_MS = 30 * 1000;
const CLOUD_SESSION_SCHEMA_VERSION = 1;

function invalidSessionFile(path, message) {
  return new Error(
    `Hosted session file at ${path} ${message}. Run 'superturtle logout' and then 'superturtle login' again.`
  );
}

function getControlPlaneBaseUrl(env = process.env) {
  return String(env.SUPERTURTLE_CLOUD_URL || DEFAULT_CONTROL_PLANE).replace(/\/+$/, "");
}

function getSessionPath(env = process.env) {
  const explicit = env.SUPERTURTLE_CLOUD_SESSION_PATH;
  if (explicit) return resolve(explicit);

  const configHome = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : resolve(os.homedir(), ".config");
  return resolve(configHome, "superturtle", "cloud-session.json");
}

function getSessionControlPlaneBaseUrl(session, env = process.env) {
  if (session && typeof session.control_plane === "string" && session.control_plane.trim()) {
    return session.control_plane.replace(/\/+$/, "");
  }
  return getControlPlaneBaseUrl(env);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
}

function hardenSessionFilePermissions(path) {
  if (process.platform === "win32" || !fs.existsSync(path)) {
    return;
  }

  const currentMode = fs.statSync(path).mode & 0o777;
  if (currentMode === 0o600) {
    return;
  }

  fs.chmodSync(path, 0o600);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateTimestamp(value, fieldName, context) {
  if (value == null) {
    return null;
  }
  if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  return value;
}

function validateOptionalObject(value, fieldName, context) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  return value;
}

function validateTokenResponse(payload, context) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid response.`);
  }
  if (!isNonEmptyString(payload.access_token)) {
    throw new Error(`${context} did not include a valid access_token.`);
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "refresh_token") &&
    payload.refresh_token != null &&
    !isNonEmptyString(payload.refresh_token)
  ) {
    throw new Error(`${context} returned an invalid refresh_token.`);
  }

  return {
    ...payload,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: validateTimestamp(payload.expires_at || null, "expires_at", context),
  };
}

function validateLoginStartResponse(payload, context) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid response.`);
  }

  if (!isNonEmptyString(payload.device_code)) {
    throw new Error(`${context} did not include a valid device_code.`);
  }

  const verificationUri = isNonEmptyString(payload.verification_uri)
    ? payload.verification_uri
    : null;
  const verificationUriComplete = isNonEmptyString(payload.verification_uri_complete)
    ? payload.verification_uri_complete
    : null;
  if (!verificationUri && !verificationUriComplete) {
    throw new Error(
      `${context} did not include a valid verification_uri or verification_uri_complete.`
    );
  }

  let intervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (Object.prototype.hasOwnProperty.call(payload, "interval_ms") && payload.interval_ms != null) {
    intervalMs = Number(payload.interval_ms);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`${context} returned an invalid interval_ms.`);
    }
  }

  return {
    ...payload,
    device_code: payload.device_code,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    user_code: isNonEmptyString(payload.user_code) ? payload.user_code : null,
    interval_ms: intervalMs,
  };
}

function validateWhoAmIResponse(payload, context) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid response.`);
  }

  const user = validateOptionalObject(payload.user, "user", context);
  if (user) {
    if (Object.prototype.hasOwnProperty.call(user, "id") && user.id != null && !isNonEmptyString(user.id)) {
      throw new Error(`${context} returned an invalid user.id.`);
    }
    if (
      Object.prototype.hasOwnProperty.call(user, "email") &&
      user.email != null &&
      !isNonEmptyString(user.email)
    ) {
      throw new Error(`${context} returned an invalid user.email.`);
    }
  }

  const workspace = validateOptionalObject(payload.workspace, "workspace", context);
  if (
    workspace &&
    Object.prototype.hasOwnProperty.call(workspace, "slug") &&
    workspace.slug != null &&
    !isNonEmptyString(workspace.slug)
  ) {
    throw new Error(`${context} returned an invalid workspace.slug.`);
  }

  const entitlement = validateOptionalObject(payload.entitlement, "entitlement", context);
  if (entitlement) {
    if (
      Object.prototype.hasOwnProperty.call(entitlement, "plan") &&
      entitlement.plan != null &&
      !isNonEmptyString(entitlement.plan)
    ) {
      throw new Error(`${context} returned an invalid entitlement.plan.`);
    }
    if (
      Object.prototype.hasOwnProperty.call(entitlement, "state") &&
      entitlement.state != null &&
      !isNonEmptyString(entitlement.state)
    ) {
      throw new Error(`${context} returned an invalid entitlement.state.`);
    }
  }

  return {
    user,
    workspace,
    entitlement,
  };
}

function validateCloudStatusResponse(payload, context) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid response.`);
  }

  const instance = validateOptionalObject(payload.instance, "instance", context);
  if (instance) {
    if (
      Object.prototype.hasOwnProperty.call(instance, "id") &&
      instance.id != null &&
      !isNonEmptyString(instance.id)
    ) {
      throw new Error(`${context} returned an invalid instance.id.`);
    }
    if (
      Object.prototype.hasOwnProperty.call(instance, "state") &&
      instance.state != null &&
      !isNonEmptyString(instance.state)
    ) {
      throw new Error(`${context} returned an invalid instance.state.`);
    }
    if (
      Object.prototype.hasOwnProperty.call(instance, "region") &&
      instance.region != null &&
      !isNonEmptyString(instance.region)
    ) {
      throw new Error(`${context} returned an invalid instance.region.`);
    }
    if (
      Object.prototype.hasOwnProperty.call(instance, "hostname") &&
      instance.hostname != null &&
      !isNonEmptyString(instance.hostname)
    ) {
      throw new Error(`${context} returned an invalid instance.hostname.`);
    }
  }

  const provisioningJob = validateOptionalObject(
    payload.provisioning_job,
    "provisioning_job",
    context
  );
  if (provisioningJob) {
    if (
      Object.prototype.hasOwnProperty.call(provisioningJob, "state") &&
      provisioningJob.state != null &&
      !isNonEmptyString(provisioningJob.state)
    ) {
      throw new Error(`${context} returned an invalid provisioning_job.state.`);
    }
    if (Object.prototype.hasOwnProperty.call(provisioningJob, "updated_at")) {
      validateTimestamp(provisioningJob.updated_at, "provisioning_job.updated_at", context);
    }
  }

  return {
    instance,
    provisioning_job: provisioningJob,
  };
}

function normalizeStoredSession(session, env = process.env, fallbackTimestamp = null) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return session;
  }

  const normalized = {
    ...session,
  };

  if (!Object.prototype.hasOwnProperty.call(normalized, "schema_version")) {
    normalized.schema_version = CLOUD_SESSION_SCHEMA_VERSION;
  }

  if (!isNonEmptyString(normalized.control_plane)) {
    normalized.control_plane = getControlPlaneBaseUrl(env);
  } else {
    normalized.control_plane = normalized.control_plane.replace(/\/+$/, "");
  }

  if (!Object.prototype.hasOwnProperty.call(normalized, "refresh_token")) {
    normalized.refresh_token = null;
  }

  const normalizedCreatedAt = isNonEmptyString(normalized.created_at)
    ? normalized.created_at
    : fallbackTimestamp;
  if (normalizedCreatedAt) {
    normalized.created_at = normalizedCreatedAt;
  }

  const normalizedLastSyncAt = isNonEmptyString(normalized.last_sync_at)
    ? normalized.last_sync_at
    : normalizedCreatedAt;
  if (normalizedLastSyncAt) {
    normalized.last_sync_at = normalizedLastSyncAt;
  }

  if (
    !isNonEmptyString(normalized.identity_sync_at) &&
    (normalized.user || normalized.workspace || normalized.entitlement)
  ) {
    normalized.identity_sync_at = normalizedLastSyncAt || normalizedCreatedAt || null;
  }

  if (
    !isNonEmptyString(normalized.cloud_status_sync_at) &&
    (normalized.instance || normalized.provisioning_job)
  ) {
    normalized.cloud_status_sync_at = normalizedLastSyncAt || normalizedCreatedAt || null;
  }

  return normalized;
}

function readSession(env = process.env) {
  const path = getSessionPath(env);
  if (!fs.existsSync(path)) return null;
  let raw;
  let stats;
  try {
    raw = fs.readFileSync(path, "utf-8");
    stats = fs.statSync(path);
  } catch (error) {
    throw new Error(
      `Failed to read hosted session file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidSessionFile(path, "is invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidSessionFile(path, "is invalid");
  }

  const fallbackTimestamp =
    stats && Number.isFinite(stats.mtimeMs) ? new Date(stats.mtimeMs).toISOString() : null;

  const normalized = normalizeStoredSession(parsed, env, fallbackTimestamp);

  if (!Number.isInteger(normalized.schema_version) || normalized.schema_version <= 0) {
    throw invalidSessionFile(path, "has an invalid schema_version");
  }

  if (normalized.schema_version > CLOUD_SESSION_SCHEMA_VERSION) {
    throw new Error(
      `Hosted session file at ${path} uses schema_version ${normalized.schema_version}, but this CLI supports up to ${CLOUD_SESSION_SCHEMA_VERSION}. Upgrade SuperTurtle or run 'superturtle logout' and then 'superturtle login' again.`
    );
  }

  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
    writeSession(normalized, env);
  } else {
    hardenSessionFilePermissions(path);
  }

  return normalized;
}

function writeSession(session, env = process.env) {
  const path = getSessionPath(env);
  ensureParentDir(path);
  const normalized = {
    schema_version: CLOUD_SESSION_SCHEMA_VERSION,
    ...session,
  };
  const tempPath = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, path);
  fs.chmodSync(path, 0o600);
  return path;
}

function persistSessionIfChanged(previousSession, nextSession, env = process.env) {
  if (!nextSession) return nextSession;
  if (JSON.stringify(previousSession) === JSON.stringify(nextSession)) {
    return nextSession;
  }
  writeSession(nextSession, env);
  return nextSession;
}

function clearSession(env = process.env) {
  const path = getSessionPath(env);
  if (fs.existsSync(path)) fs.unlinkSync(path);
  return path;
}

function invalidateSession(env = process.env, message = "is no longer valid") {
  const path = clearSession(env);
  const error = new Error(
    `Hosted session ${message}. Removed local cloud session at ${path}. Run 'superturtle login' again.`
  );
  error.code = "SESSION_REAUTH_REQUIRED";
  error.sessionCleared = true;
  return error;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!response.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `Request failed with ${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function openBrowser(url) {
  const platform = process.platform;
  const commands =
    platform === "darwin"
      ? [["open", [url]]]
      : platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [["xdg-open", [url]]];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function getAuthHeaders(session) {
  return {
    authorization: `Bearer ${session.access_token}`,
    accept: "application/json",
  };
}

function parseExpiry(value) {
  if (typeof value !== "string" || !value) return null;
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

function isSessionExpired(session) {
  const expiresAt = parseExpiry(session?.expires_at);
  if (!expiresAt) return false;
  return expiresAt <= Date.now() + SESSION_EXPIRY_SKEW_MS;
}

function normalizeSessionUpdate(nextSession, session, baseUrl) {
  return {
    ...session,
    ...nextSession,
    refresh_token: nextSession.refresh_token || session.refresh_token || null,
    control_plane: baseUrl,
    refreshed_at: new Date().toISOString(),
  };
}

function mergeSessionSnapshot(session, snapshot, baseUrl = null) {
  const syncedAt = new Date().toISOString();
  const nextSession = {
    ...session,
    last_sync_at: syncedAt,
  };

  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "user")) {
    nextSession.user = snapshot.user || null;
    nextSession.identity_sync_at = syncedAt;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "workspace")) {
    nextSession.workspace = snapshot.workspace || null;
    nextSession.identity_sync_at = syncedAt;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "entitlement")) {
    nextSession.entitlement = snapshot.entitlement || null;
    nextSession.identity_sync_at = syncedAt;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "instance")) {
    nextSession.instance = snapshot.instance || null;
    nextSession.cloud_status_sync_at = syncedAt;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "provisioning_job")) {
    nextSession.provisioning_job = snapshot.provisioning_job || null;
    nextSession.cloud_status_sync_at = syncedAt;
  }
  if (baseUrl) {
    nextSession.control_plane = baseUrl;
  }

  return nextSession;
}

function hasCachedSnapshot(session, keys) {
  if (!session || typeof session !== "object") return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(session, key) && session[key] != null);
}

function isRetryableCloudError(error) {
  if (!error || typeof error !== "object") return false;
  if (typeof error.status === "number") {
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (error.name === "AbortError") return true;

  const code = typeof error.code === "string" ? error.code : "";
  if (code) {
    return [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
    ].includes(code);
  }

  const causeCode =
    error.cause && typeof error.cause === "object" && typeof error.cause.code === "string"
      ? error.cause.code
      : "";
  if (causeCode) {
    return [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
    ].includes(causeCode);
  }

  return /fetch failed|network error|timed out|timeout/i.test(error.message || "");
}

async function startLogin(options = {}, env = process.env) {
  const baseUrl = getControlPlaneBaseUrl(env);
  const payload = {
    client_name: "superturtle-cli",
    device_name: options.deviceName || os.hostname(),
    scopes: ["cloud:read", "teleport:write"],
  };
  const started = await requestJson(`${baseUrl}/v1/cli/login/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  return validateLoginStartResponse(started, "Hosted login start");
}

async function pollLogin(started, options = {}, env = process.env) {
  const baseUrl = getControlPlaneBaseUrl(env);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const intervalMs = Math.max(
    1000,
    Number(started.interval_ms || options.intervalMs || DEFAULT_POLL_INTERVAL_MS)
  );

  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for browser login completion.");
    }
    await sleep(intervalMs);
    try {
      const completed = await requestJson(`${baseUrl}/v1/cli/login/poll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ device_code: started.device_code }),
      });
      return validateTokenResponse(completed, "Hosted login completion");
    } catch (error) {
      const status = error && typeof error === "object" ? error.status : undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 428 || status === 404 || /authorization pending/i.test(message)) {
        continue;
      }
      throw error;
    }
  }
}

async function refreshSession(session, env = process.env) {
  const baseUrl = getSessionControlPlaneBaseUrl(session, env);
  if (!session?.refresh_token) {
    const error = new Error("Hosted session expired and cannot be refreshed. Run 'superturtle login' again.");
    error.code = "SESSION_REFRESH_REQUIRED";
    throw error;
  }

  let refreshed;
  try {
    refreshed = await requestJson(`${baseUrl}/v1/cli/session/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
  } catch (error) {
    const status = error && typeof error === "object" ? error.status : undefined;
    if (status === 401 || status === 403) {
      throw invalidateSession(env, "was rejected by the control plane");
    }
    throw error;
  }

  return normalizeSessionUpdate(validateTokenResponse(refreshed, "Hosted session refresh"), session, baseUrl);
}

async function requestWithSession(session, env, path) {
  const baseUrl = getSessionControlPlaneBaseUrl(session, env);
  let activeSession = session;
  let sessionChanged = false;

  if (isSessionExpired(activeSession)) {
    activeSession = await refreshSession(activeSession, env);
    sessionChanged = true;
  }

  const doRequest = async (currentSession) =>
    requestJson(`${baseUrl}${path}`, {
      headers: getAuthHeaders(currentSession),
    });

  try {
    const data = await doRequest(activeSession);
    return { data, session: activeSession };
  } catch (error) {
    const status = error && typeof error === "object" ? error.status : undefined;
    if (status === 401 && !activeSession?.refresh_token) {
      throw invalidateSession(env, "expired and cannot be refreshed");
    }
    if (status !== 401 || !activeSession?.refresh_token) {
      if (sessionChanged && error && typeof error === "object") {
        error.session = activeSession;
      }
      throw error;
    }
    activeSession = await refreshSession(activeSession, env);
    sessionChanged = true;
    let data;
    try {
      data = await doRequest(activeSession);
    } catch (error) {
      const retryStatus = error && typeof error === "object" ? error.status : undefined;
      if (retryStatus === 401) {
        throw invalidateSession(env, "was rejected after refresh");
      }
      throw error;
    }
    return { data, session: activeSession };
  }
}

async function fetchWhoAmI(session, env = process.env) {
  const result = await requestWithSession(session, env, "/v1/cli/session");
  return {
    ...result,
    data: validateWhoAmIResponse(result.data, "Hosted session lookup"),
  };
}

async function fetchCloudStatus(session, env = process.env) {
  const result = await requestWithSession(session, env, "/v1/cli/cloud/status");
  return {
    ...result,
    data: validateCloudStatusResponse(result.data, "Hosted cloud status lookup"),
  };
}

module.exports = {
  clearSession,
  DEFAULT_CONTROL_PLANE,
  CLOUD_SESSION_SCHEMA_VERSION,
  fetchCloudStatus,
  fetchWhoAmI,
  getControlPlaneBaseUrl,
  getSessionControlPlaneBaseUrl,
  getSessionPath,
  isSessionExpired,
  openBrowser,
  pollLogin,
  readSession,
  refreshSession,
  mergeSessionSnapshot,
  hasCachedSnapshot,
  invalidateSession,
  startLogin,
  isRetryableCloudError,
  persistSessionIfChanged,
  validateLoginStartResponse,
  validateWhoAmIResponse,
  validateCloudStatusResponse,
  writeSession,
};
