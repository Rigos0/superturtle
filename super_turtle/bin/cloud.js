const fs = require("fs");
const os = require("os");
const { resolve, dirname } = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_CONTROL_PLANE = "https://api.superturtle.dev";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_EXPIRY_SKEW_MS = 30 * 1000;

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

function readSession(env = process.env) {
  const path = getSessionPath(env);
  if (!fs.existsSync(path)) return null;
  const raw = fs.readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

function writeSession(session, env = process.env) {
  const path = getSessionPath(env);
  ensureParentDir(path);
  fs.writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
  return path;
}

function clearSession(env = process.env) {
  const path = getSessionPath(env);
  if (fs.existsSync(path)) fs.unlinkSync(path);
  return path;
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
  const nextSession = {
    ...session,
    last_sync_at: new Date().toISOString(),
  };

  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "user")) {
    nextSession.user = snapshot.user || null;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "workspace")) {
    nextSession.workspace = snapshot.workspace || null;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "entitlement")) {
    nextSession.entitlement = snapshot.entitlement || null;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "instance")) {
    nextSession.instance = snapshot.instance || null;
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "provisioning_job")) {
    nextSession.provisioning_job = snapshot.provisioning_job || null;
  }
  if (baseUrl) {
    nextSession.control_plane = baseUrl;
  }

  return nextSession;
}

async function startLogin(options = {}, env = process.env) {
  const baseUrl = getControlPlaneBaseUrl(env);
  const payload = {
    client_name: "superturtle-cli",
    device_name: options.deviceName || os.hostname(),
    scopes: ["cloud:read", "teleport:write"],
  };
  return requestJson(`${baseUrl}/v1/cli/login/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
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
      return await requestJson(`${baseUrl}/v1/cli/login/poll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ device_code: started.device_code }),
      });
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

  const refreshed = await requestJson(`${baseUrl}/v1/cli/session/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });

  return normalizeSessionUpdate(refreshed, session, baseUrl);
}

async function requestWithSession(session, env, path) {
  const baseUrl = getSessionControlPlaneBaseUrl(session, env);
  let activeSession = session;

  if (isSessionExpired(activeSession)) {
    activeSession = await refreshSession(activeSession, env);
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
    if (status !== 401 || !activeSession?.refresh_token) {
      throw error;
    }
    activeSession = await refreshSession(activeSession, env);
    const data = await doRequest(activeSession);
    return { data, session: activeSession };
  }
}

async function fetchWhoAmI(session, env = process.env) {
  return requestWithSession(session, env, "/v1/cli/session");
}

async function fetchCloudStatus(session, env = process.env) {
  return requestWithSession(session, env, "/v1/cli/cloud/status");
}

module.exports = {
  clearSession,
  DEFAULT_CONTROL_PLANE,
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
  startLogin,
  writeSession,
};
