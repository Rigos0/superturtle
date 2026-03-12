const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { resolve, dirname, parse, sep } = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_CONTROL_PLANE = "https://api.superturtle.dev";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_BROWSER_OPEN_TIMEOUT_MS = 5 * 1000;
const DEFAULT_RESPONSE_MAX_BYTES = 256 * 1024;
const DEFAULT_SESSION_FILE_MAX_BYTES = 256 * 1024;
const SESSION_EXPIRY_SKEW_MS = 30 * 1000;
const CLOUD_SESSION_SCHEMA_VERSION = 1;

function invalidSessionFile(path, message) {
  return new Error(
    `Hosted session file at ${path} ${message}. Run 'superturtle logout' and then 'superturtle login' again.`
  );
}

function invalidSessionDirectory(path, message) {
  return new Error(
    `Hosted session directory at ${path} ${message}. Run 'superturtle logout' and then 'superturtle login' again.`
  );
}

function validateHttpUrl(value, fieldName, context, options = {}) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  if (parsed.protocol === "http:" && !options.allowInsecureHttp) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  if (options.disallowSearch && parsed.search) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  if (options.disallowHash && parsed.hash) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }
  if (options.disallowPath && parsed.pathname && parsed.pathname !== "/") {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }

  return parsed.toString();
}

function isLoopbackHostname(hostname) {
  if (!isNonEmptyString(hostname)) {
    return false;
  }

  const normalized = hostname.trim().toLowerCase();
  const bracketless =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;

  if (
    bracketless === "localhost" ||
    bracketless === "::1" ||
    bracketless === "0:0:0:0:0:0:0:1" ||
    bracketless.endsWith(".localhost")
  ) {
    return true;
  }

  if (/^127(?:\.\d{1,3}){3}$/.test(bracketless)) {
    return bracketless
      .split(".")
      .every((segment) => Number.isInteger(Number(segment)) && Number(segment) >= 0 && Number(segment) <= 255);
  }

  return false;
}

function validateControlPlaneUrl(value, fieldName, context, options = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${context} returned an invalid ${fieldName}.`);
  }

  return validateHttpUrl(value, fieldName, context, {
    ...options,
    allowInsecureHttp: parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname),
  });
}

function normalizeUrlOrigin(value, fieldName, context) {
  const parsed = new URL(validateControlPlaneUrl(value, fieldName, context));
  return parsed.origin;
}

function getControlPlaneBaseUrl(env = process.env) {
  return validateControlPlaneUrl(
    String(env.SUPERTURTLE_CLOUD_URL || DEFAULT_CONTROL_PLANE),
    "control_plane",
    "Configured hosted control plane",
    { disallowSearch: true, disallowHash: true, disallowPath: true }
  ).replace(/\/+$/, "");
}

function getRequestTimeoutMs(env = process.env) {
  const configured = env.SUPERTURTLE_CLOUD_TIMEOUT_MS;
  if (configured == null || configured === "") {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const timeoutMs = Number(configured);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Configured hosted control plane timeout must be a positive number of milliseconds.");
  }

  return timeoutMs;
}

function getBrowserOpenTimeoutMs(env = process.env) {
  const configured = env.SUPERTURTLE_CLOUD_BROWSER_TIMEOUT_MS;
  if (configured == null || configured === "") {
    return DEFAULT_BROWSER_OPEN_TIMEOUT_MS;
  }

  const timeoutMs = Number(configured);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Configured hosted browser launch timeout must be a positive number of milliseconds.");
  }

  return timeoutMs;
}

function getResponseMaxBytes(env = process.env) {
  const configured = env.SUPERTURTLE_CLOUD_RESPONSE_MAX_BYTES;
  if (configured == null || configured === "") {
    return DEFAULT_RESPONSE_MAX_BYTES;
  }

  const maxBytes = Number(configured);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Configured hosted control plane response size limit must be a positive integer number of bytes.");
  }

  return maxBytes;
}

function getSessionFileMaxBytes(env = process.env) {
  const configured = env.SUPERTURTLE_CLOUD_SESSION_MAX_BYTES;
  if (configured == null || configured === "") {
    return DEFAULT_SESSION_FILE_MAX_BYTES;
  }

  const maxBytes = Number(configured);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Configured hosted session file size limit must be a positive integer number of bytes.");
  }

  return maxBytes;
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
    try {
      return validateControlPlaneUrl(
        session.control_plane,
        "control_plane",
        "Hosted session",
        { disallowSearch: true, disallowHash: true, disallowPath: true }
      ).replace(/\/+$/, "");
    } catch (error) {
      throw new Error("Hosted session contains an invalid control_plane.");
    }
  }
  return getControlPlaneBaseUrl(env);
}

function ensureSafeSessionDirectory(dirPath, options = {}) {
  const resolvedDir = resolve(dirPath);
  const { root } = parse(resolvedDir);
  const relativePath = resolvedDir.slice(root.length);
  const segments = relativePath ? relativePath.split(sep).filter(Boolean) : [];
  let current = root;

  for (const segment of segments) {
    current = current ? resolve(current, segment) : segment;
    const stats = lstatIfExists(current);
    if (!stats) {
      if (!options.create) {
        return;
      }
      fs.mkdirSync(current, { mode: 0o700 });
      fsyncParentDirectory(current);
      fsyncPath(current, `directory ${current}`, { kind: "directory" });
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw invalidSessionDirectory(current, "must not be a symlink");
    }
    if (!stats.isDirectory()) {
      throw invalidSessionDirectory(current, "must be a directory");
    }
  }
}

function lstatIfExists(path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function ensureRegularSessionFile(path) {
  let stats;
  try {
    stats = fs.lstatSync(path);
  } catch (error) {
    throw new Error(
      `Failed to inspect hosted session file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!stats.isFile()) {
    throw invalidSessionFile(path, "must be a regular file");
  }

  return stats;
}

function openSessionFileForRead(path) {
  const openFlags =
    process.platform !== "win32" && typeof fs.constants?.O_NOFOLLOW === "number"
      ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDONLY;

  try {
    return fs.openSync(path, openFlags);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw invalidSessionFile(path, "must be a regular file");
    }
    throw error;
  }
}

function readBoundedFileText(fd, path, maxBytes) {
  const chunks = [];
  const chunkSize = Math.min(64 * 1024, Math.max(1024, maxBytes));
  let totalBytes = 0;

  for (;;) {
    const buffer = Buffer.allocUnsafe(chunkSize);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw invalidSessionFile(path, `exceeds the configured size limit of ${maxBytes} bytes`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function hardenSessionFilePermissions(path) {
  if (process.platform === "win32") {
    return;
  }

  const existing = lstatIfExists(path);
  if (!existing) {
    return;
  }

  const currentMode = ensureRegularSessionFile(path).mode & 0o777;
  if (currentMode === 0o600) {
    return;
  }

  let fd;
  try {
    fd = openSessionFileForRead(path);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      throw invalidSessionFile(path, "must be a regular file");
    }
    if ((stats.mode & 0o777) !== 0o600) {
      fs.fchmodSync(fd, 0o600);
    }
  } finally {
    if (fd != null) {
      fs.closeSync(fd);
    }
  }
}

function fsyncDescriptor(fd, pathDescription) {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    throw new Error(
      `Failed to sync hosted session data for ${pathDescription}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function openPathForSync(path, kind = "file") {
  if (process.platform === "win32") {
    return fs.openSync(path, "r");
  }

  let flags = fs.constants.O_RDONLY;
  if (typeof fs.constants?.O_NOFOLLOW === "number") {
    flags |= fs.constants.O_NOFOLLOW;
  }
  if (kind === "directory" && typeof fs.constants?.O_DIRECTORY === "number") {
    flags |= fs.constants.O_DIRECTORY;
  }

  try {
    const fd = fs.openSync(path, flags);
    const stats = fs.fstatSync(fd);
    if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
      fs.closeSync(fd);
      if (kind === "directory") {
        throw invalidSessionDirectory(path, "must be a directory");
      }
      throw invalidSessionFile(path, "must be a regular file");
    }
    return fd;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      if (kind === "directory") {
        throw invalidSessionDirectory(path, "must not be a symlink");
      }
      throw invalidSessionFile(path, "must be a regular file");
    }
    throw error;
  }
}

function fsyncPath(path, pathDescription, options = {}) {
  const kind = options.kind === "directory" ? "directory" : "file";
  let fd;
  try {
    fd = openPathForSync(path, kind);
    fsyncDescriptor(fd, pathDescription);
  } finally {
    if (fd != null) {
      fs.closeSync(fd);
    }
  }
}

function fsyncParentDirectory(path) {
  if (process.platform === "win32") {
    return;
  }
  fsyncPath(dirname(path), `directory ${dirname(path)}`, { kind: "directory" });
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

  const identity = validateWhoAmIResponse(
    {
      user: Object.prototype.hasOwnProperty.call(payload, "user") ? payload.user : undefined,
      workspace: Object.prototype.hasOwnProperty.call(payload, "workspace")
        ? payload.workspace
        : undefined,
      entitlement: Object.prototype.hasOwnProperty.call(payload, "entitlement")
        ? payload.entitlement
        : undefined,
    },
    context
  );
  const cloudStatus = validateCloudStatusResponse(
    {
      instance: Object.prototype.hasOwnProperty.call(payload, "instance") ? payload.instance : undefined,
      provisioning_job: Object.prototype.hasOwnProperty.call(payload, "provisioning_job")
        ? payload.provisioning_job
        : undefined,
    },
    context
  );

  return {
    ...payload,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: validateTimestamp(payload.expires_at || null, "expires_at", context),
    user: identity.user,
    workspace: identity.workspace,
    entitlement: identity.entitlement,
    instance: cloudStatus.instance,
    provisioning_job: cloudStatus.provisioning_job,
  };
}

function validateLoginStartResponse(payload, context, controlPlaneBaseUrl = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid response.`);
  }

  if (!isNonEmptyString(payload.device_code)) {
    throw new Error(`${context} did not include a valid device_code.`);
  }

  const verificationUri = isNonEmptyString(payload.verification_uri)
    ? validateControlPlaneUrl(payload.verification_uri, "verification_uri", context, {
        disallowHash: true,
      })
    : null;
  const verificationUriComplete = isNonEmptyString(payload.verification_uri_complete)
    ? validateControlPlaneUrl(payload.verification_uri_complete, "verification_uri_complete", context, {
        disallowHash: true,
      })
    : null;
  if (!verificationUri && !verificationUriComplete) {
    throw new Error(
      `${context} did not include a valid verification_uri or verification_uri_complete.`
    );
  }

  if (controlPlaneBaseUrl) {
    const expectedOrigin = normalizeUrlOrigin(
      controlPlaneBaseUrl,
      "control_plane",
      "Configured hosted control plane"
    );
    if (verificationUri) {
      const verificationOrigin = normalizeUrlOrigin(
        verificationUri,
        "verification_uri",
        context
      );
      if (verificationOrigin !== expectedOrigin) {
        throw new Error(
          `${context} returned a verification_uri that does not match the configured control plane origin.`
        );
      }
    }
    if (verificationUriComplete) {
      const verificationCompleteOrigin = normalizeUrlOrigin(
        verificationUriComplete,
        "verification_uri_complete",
        context
      );
      if (verificationCompleteOrigin !== expectedOrigin) {
        throw new Error(
          `${context} returned a verification_uri_complete that does not match the configured control plane origin.`
        );
      }
    }
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

function validateStoredSession(session, path) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw invalidSessionFile(path, "is invalid");
  }

  if (!Number.isInteger(session.schema_version) || session.schema_version <= 0) {
    throw invalidSessionFile(path, "has an invalid schema_version");
  }

  if (!isNonEmptyString(session.control_plane)) {
    throw invalidSessionFile(path, "has an invalid control_plane");
  }
  try {
    session.control_plane = validateControlPlaneUrl(
      session.control_plane,
      "control_plane",
      "Stored hosted session",
      { disallowSearch: true, disallowHash: true, disallowPath: true }
    ).replace(/\/+$/, "");
  } catch (error) {
    throw invalidSessionFile(path, "has an invalid control_plane");
  }

  if (!isNonEmptyString(session.access_token)) {
    throw invalidSessionFile(path, "has an invalid access_token");
  }

  if (
    Object.prototype.hasOwnProperty.call(session, "refresh_token") &&
    session.refresh_token != null &&
    !isNonEmptyString(session.refresh_token)
  ) {
    throw invalidSessionFile(path, "has an invalid refresh_token");
  }

  if (Object.prototype.hasOwnProperty.call(session, "expires_at")) {
    validateTimestamp(session.expires_at, "expires_at", "Stored hosted session");
  }
  if (Object.prototype.hasOwnProperty.call(session, "created_at")) {
    validateTimestamp(session.created_at, "created_at", "Stored hosted session");
  }
  if (Object.prototype.hasOwnProperty.call(session, "refreshed_at")) {
    validateTimestamp(session.refreshed_at, "refreshed_at", "Stored hosted session");
  }
  if (Object.prototype.hasOwnProperty.call(session, "last_sync_at")) {
    validateTimestamp(session.last_sync_at, "last_sync_at", "Stored hosted session");
  }
  if (Object.prototype.hasOwnProperty.call(session, "identity_sync_at")) {
    validateTimestamp(session.identity_sync_at, "identity_sync_at", "Stored hosted session");
  }
  if (Object.prototype.hasOwnProperty.call(session, "cloud_status_sync_at")) {
    validateTimestamp(session.cloud_status_sync_at, "cloud_status_sync_at", "Stored hosted session");
  }

  validateWhoAmIResponse(
    {
      user: Object.prototype.hasOwnProperty.call(session, "user") ? session.user : undefined,
      workspace: Object.prototype.hasOwnProperty.call(session, "workspace")
        ? session.workspace
        : undefined,
      entitlement: Object.prototype.hasOwnProperty.call(session, "entitlement")
        ? session.entitlement
        : undefined,
    },
    "Stored hosted session"
  );
  validateCloudStatusResponse(
    {
      instance: Object.prototype.hasOwnProperty.call(session, "instance") ? session.instance : undefined,
      provisioning_job: Object.prototype.hasOwnProperty.call(session, "provisioning_job")
        ? session.provisioning_job
        : undefined,
    },
    "Stored hosted session"
  );

  return session;
}

function readSession(env = process.env) {
  const path = getSessionPath(env);
  if (!lstatIfExists(path)) return null;
  ensureSafeSessionDirectory(dirname(path));
  let raw;
  let fd;
  let stats;
  try {
    ensureRegularSessionFile(path);
    fd = openSessionFileForRead(path);
    stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      throw invalidSessionFile(path, "must be a regular file");
    }
    const maxBytes = getSessionFileMaxBytes(env);
    if (stats.size > maxBytes) {
      throw invalidSessionFile(path, `exceeds the configured size limit of ${maxBytes} bytes`);
    }
    raw = readBoundedFileText(fd, path, maxBytes);
  } catch (error) {
    if (error instanceof Error && /^Hosted session file at .* must be a regular file\./.test(error.message)) {
      throw error;
    }
    throw new Error(
      `Failed to read hosted session file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (fd != null) {
      fs.closeSync(fd);
    }
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

  try {
    validateStoredSession(normalized, path);
  } catch (error) {
    if (error instanceof Error && /Stored hosted session returned an invalid /.test(error.message)) {
      const detail = error.message.replace(/^Stored hosted session returned an invalid /, "");
      throw invalidSessionFile(path, `has an invalid ${detail.replace(/\.$/, "")}`);
    }
    throw error;
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
  ensureSafeSessionDirectory(dirname(path), { create: true });
  if (lstatIfExists(path)) {
    ensureRegularSessionFile(path);
  }
  const normalized = {
    schema_version: CLOUD_SESSION_SCHEMA_VERSION,
    ...session,
  };
  validateStoredSession(normalized, path);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  const serializedBytes = Buffer.byteLength(serialized, "utf-8");
  const maxBytes = getSessionFileMaxBytes(env);
  if (serializedBytes > maxBytes) {
    throw invalidSessionFile(path, `exceeds the configured size limit of ${maxBytes} bytes`);
  }
  let tempPath = null;
  let tempFd = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = crypto.randomBytes(8).toString("hex");
    const candidatePath = `${path}.${process.pid}.${suffix}.tmp`;
    try {
      tempFd = fs.openSync(candidatePath, "wx", 0o600);
      tempPath = candidatePath;
      break;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  if (tempFd == null || !tempPath) {
    throw new Error(`Failed to create a temporary hosted session file next to ${path}.`);
  }

  try {
    fs.writeFileSync(tempFd, serialized, { encoding: "utf-8" });
    fsyncDescriptor(tempFd, `temporary hosted session file ${tempPath}`);
    fs.closeSync(tempFd);
    tempFd = null;
    fs.renameSync(tempPath, path);
    fsyncPath(path, `hosted session file ${path}`);
    fsyncParentDirectory(path);
  } catch (error) {
    if (tempFd != null) {
      fs.closeSync(tempFd);
    }
    if (tempPath) {
      fs.rmSync(tempPath, { force: true });
    }
    throw error;
  }
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
  ensureSafeSessionDirectory(dirname(path));
  if (lstatIfExists(path)) {
    ensureRegularSessionFile(path);
    fs.unlinkSync(path);
    fsyncParentDirectory(path);
  }
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

function isJsonContentType(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  return normalized === "application/json" || normalized.endsWith("+json");
}

async function cancelResponseBody(response) {
  if (!response?.body || typeof response.body.cancel !== "function") {
    return;
  }

  try {
    await response.body.cancel();
  } catch {}
}

async function requestJson(url, options = {}, env = process.env) {
  const timeoutMs = getRequestTimeoutMs(env);
  const maxBytes = getResponseMaxBytes(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request to ${url} timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      const error = new Error(
        `Control plane request to ${url} was redirected${location ? ` to ${location}` : ""}, but redirects are not allowed.`
      );
      error.status = response.status;
      error.location = location;
      throw error;
    }
    const contentLength = response.headers.get("content-length");
    if (isNonEmptyString(contentLength)) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        await cancelResponseBody(response);
        throw new Error(`Response from ${url} exceeded configured size limit of ${maxBytes} bytes.`);
      }
    }

    const contentType = response.headers.get("content-type");
    if (!isJsonContentType(contentType)) {
      await cancelResponseBody(response);
      const error = new Error(
        `Response from ${url} returned unsupported content-type ${contentType || "(missing)"}. Expected application/json.`
      );
      error.status = response.status;
      error.statusText = response.statusText;
      error.contentType = contentType;
      error.retryAfterMs = getRetryAfterMs(response.headers.get("retry-after"));
      throw error;
    }

    const text = await readResponseText(response, url, maxBytes);
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        const parseError = new Error(
          `Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`
        );
        parseError.status = response.status;
        parseError.statusText = response.statusText;
        parseError.retryAfterMs = getRetryAfterMs(response.headers.get("retry-after"));
        throw parseError;
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
      error.retryAfterMs = getRetryAfterMs(response.headers.get("retry-after"));
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError =
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`Request to ${url} timed out after ${timeoutMs}ms.`);
      timeoutError.name = "AbortError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseText(response, url, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new Error(`Response from ${url} exceeded configured size limit of ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Response from ${url} exceeded configured size limit of ${maxBytes} bytes.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
    }
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function getRetryAfterMs(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }

  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - Date.now());
}

function openBrowser(url, env = process.env) {
  validateControlPlaneUrl(url, "verification_uri", "Hosted browser login", { disallowHash: true });
  const platform = process.platform;
  const timeout = getBrowserOpenTimeoutMs(env);
  const commands =
    platform === "darwin"
      ? [["open", [url]]]
      : platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [["xdg-open", [url]]];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      timeout,
    });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function getNoStoreHeaders() {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
  };
}

function getJsonRequestHeaders() {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...getNoStoreHeaders(),
  };
}

function getAuthHeaders(session) {
  return {
    authorization: `Bearer ${session.access_token}`,
    accept: "application/json",
    ...getNoStoreHeaders(),
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
    headers: getJsonRequestHeaders(),
    body: JSON.stringify(payload),
  }, env);
  return validateLoginStartResponse(started, "Hosted login start", baseUrl);
}

async function pollLogin(started, options = {}, env = process.env) {
  const baseUrl = getControlPlaneBaseUrl(env);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let intervalMs = Math.max(
    1000,
    Number(started.interval_ms || options.intervalMs || DEFAULT_POLL_INTERVAL_MS)
  );

  for (;;) {
    let remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error("Timed out waiting for browser login completion.");
    }
    await sleep(Math.min(intervalMs, remainingMs));
    remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error("Timed out waiting for browser login completion.");
    }
    try {
      const completed = await requestJson(`${baseUrl}/v1/cli/login/poll`, {
        method: "POST",
        headers: getJsonRequestHeaders(),
        body: JSON.stringify({ device_code: started.device_code }),
      }, env);
      return validateTokenResponse(completed, "Hosted login completion");
    } catch (error) {
      const status = error && typeof error === "object" ? error.status : undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 428 || status === 404 || /authorization pending/i.test(message)) {
        continue;
      }
      if (status === 429 || /slow[_ ]?down/i.test(message)) {
        const payloadIntervalMs =
          error &&
          typeof error === "object" &&
          error.payload &&
          typeof error.payload === "object" &&
          !Array.isArray(error.payload)
            ? Number(error.payload.interval_ms)
            : Number.NaN;
        const retryAfterMs =
          error && typeof error === "object" && Number.isFinite(error.retryAfterMs)
            ? error.retryAfterMs
            : 0;
        intervalMs = Math.max(
          intervalMs + 1000,
          retryAfterMs,
          Number.isFinite(payloadIntervalMs) && payloadIntervalMs > 0
            ? payloadIntervalMs
            : 0
        );
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
      headers: getJsonRequestHeaders(),
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    }, env);
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
    }, env);

  try {
    const data = await doRequest(activeSession);
    return { data, session: activeSession };
  } catch (error) {
    const status = error && typeof error === "object" ? error.status : undefined;
    if (status === 401 && !activeSession?.refresh_token) {
      throw invalidateSession(env, "expired and cannot be refreshed");
    }
    if (status === 403) {
      throw invalidateSession(env, "was rejected by the control plane");
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
      if (retryStatus === 401 || retryStatus === 403) {
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
  DEFAULT_BROWSER_OPEN_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_BYTES,
  DEFAULT_SESSION_FILE_MAX_BYTES,
  CLOUD_SESSION_SCHEMA_VERSION,
  fetchCloudStatus,
  fetchWhoAmI,
  getBrowserOpenTimeoutMs,
  getControlPlaneBaseUrl,
  getRequestTimeoutMs,
  getResponseMaxBytes,
  getSessionFileMaxBytes,
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
  validateStoredSession,
};
