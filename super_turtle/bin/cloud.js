const fs = require("fs");
const os = require("os");
const { resolve, dirname } = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_CONTROL_PLANE = "https://api.superturtle.dev";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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

async function fetchWhoAmI(session, env = process.env) {
  const baseUrl = getControlPlaneBaseUrl(env);
  return requestJson(`${baseUrl}/v1/cli/session`, {
    headers: getAuthHeaders(session),
  });
}

async function fetchCloudStatus(session, env = process.env) {
  const baseUrl = getControlPlaneBaseUrl(env);
  return requestJson(`${baseUrl}/v1/cli/cloud/status`, {
    headers: getAuthHeaders(session),
  });
}

module.exports = {
  clearSession,
  DEFAULT_CONTROL_PLANE,
  fetchCloudStatus,
  fetchWhoAmI,
  getControlPlaneBaseUrl,
  getSessionPath,
  openBrowser,
  pollLogin,
  readSession,
  startLogin,
  writeSession,
};
