#!/usr/bin/env node

/**
 * Super Turtle CLI — thin Node wrapper that delegates to Bun for the actual bot.
 *
 * Commands:
 *   superturtle init    — scaffold .superturtle/ config in the bound project repo
 *   superturtle start   — interactive tmux launcher/attach
 *   superturtle service run — foreground service runner
 *   superturtle stop    — stop bot + all SubTurtles
 *   superturtle status  — show bot and SubTurtle status
 *   superturtle doctor  — full process + log observability snapshot
 *   superturtle logs    — tail loop/pino/audit logs
 */

const { execSync, spawn, spawnSync } = require("child_process");
const { resolve, dirname, basename, join } = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");
const {
  clearSession,
  claimRuntimeLease,
  createStripeCheckoutSession,
  createStripeCustomerPortalSession,
  fetchCloudStatus,
  fetchClaudeAuthStatus,
  fetchWhoAmI,
  getControlPlaneBaseUrl,
  hasCachedSnapshot,
  heartbeatRuntimeLease,
  isRetryableCloudError,
  getSessionControlPlaneBaseUrl,
  getSessionPath,
  mergeSessionSnapshot,
  openBrowser,
  pollLogin,
  persistSessionIfChanged,
  readSession,
  releaseRuntimeLease,
  revokeClaudeAuth,
  resumeManagedInstance,
  setupClaudeAuth,
  startLogin,
  writeSession,
} = require("./cloud");

const PACKAGE_ROOT = resolve(__dirname, "..");
const BOT_DIR = resolve(PACKAGE_ROOT, "claude-telegram-bot");
const TEMPLATES_DIR = resolve(PACKAGE_ROOT, "templates");
const SUPERTURTLE_DIRNAME = ".superturtle";
const SUPERTURTLE_SUBTURTLES_RELATIVE_PATH = join(SUPERTURTLE_DIRNAME, "subturtles");
const SUPERTURTLE_TELEPORT_RELATIVE_PATH = join(SUPERTURTLE_DIRNAME, "teleport");
const SUPERTURTLE_SERVICE_PID_RELATIVE_PATH = join(SUPERTURTLE_DIRNAME, "service.pid");
const SUPERTURTLE_SELF_UPDATE_RELATIVE_PATH = join(SUPERTURTLE_DIRNAME, "self-update.json");
const SUPERTURTLE_SELF_UPDATE_LOG_RELATIVE_PATH = join(SUPERTURTLE_DIRNAME, "self-update.log");
const SUPERTURTLE_MANAGED_RUNTIME_RELATIVE_PATH = join(SUPERTURTLE_DIRNAME, "managed-runtime.json");
const PROJECT_CONFIG_RELATIVE_PATH = join(".superturtle", "project.json");
const PROJECT_ENV_RELATIVE_PATH = join(".superturtle", ".env");
const PROJECT_ENV_EXAMPLE_RELATIVE_PATH = join(".superturtle", ".env.example");
const TELEGRAM_OWNER_RELATIVE_PATH = join(".superturtle", "telegram-owner.json");

function normalizeExistingPath(path) {
  try {
    return fs.realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathsEqual(left, right) {
  return normalizeExistingPath(left) === normalizeExistingPath(right);
}

function findUpwards(startDir, relativePath) {
  let current = normalizeExistingPath(startDir);
  while (true) {
    const candidate = resolve(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findGitRoot(startDir) {
  let current = normalizeExistingPath(startDir);
  while (true) {
    const gitPath = resolve(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getBoundProjectRoot(startDir) {
  const configPath = findUpwards(startDir, PROJECT_CONFIG_RELATIVE_PATH);
  if (configPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed.repo_root === "string" && parsed.repo_root.trim()) {
        return normalizeExistingPath(parsed.repo_root.trim());
      }
    } catch {}
    return dirname(dirname(configPath));
  }

  const envPath = findUpwards(startDir, PROJECT_ENV_RELATIVE_PATH);
  if (envPath) {
    return dirname(dirname(envPath));
  }

  return normalizeExistingPath(startDir);
}

function isUnsafeRepoRoot(repoRoot) {
  const normalized = normalizeExistingPath(repoRoot);
  const home = process.env.HOME ? normalizeExistingPath(process.env.HOME) : null;
  return normalized === "/" || (home && normalized === home);
}

function ensureSafeRepoRoot(repoRoot) {
  if (!isUnsafeRepoRoot(repoRoot)) {
    return;
  }
  throw new Error(
    `Refusing to bind SuperTurtle to unsafe repo root ${repoRoot}. Use a dedicated project repo instead of / or your home directory.`
  );
}

function removeDirIfEmpty(path) {
  try {
    fs.rmdirSync(path);
  } catch {}
}

function getRuntimeLayoutPaths(projectRoot) {
  return {
    dataDir: resolve(projectRoot, SUPERTURTLE_DIRNAME),
    subturtlesDir: resolve(projectRoot, SUPERTURTLE_SUBTURTLES_RELATIVE_PATH),
    legacySubturtlesDir: resolve(projectRoot, ".subturtles"),
    teleportDir: resolve(projectRoot, SUPERTURTLE_TELEPORT_RELATIVE_PATH),
    legacyTeleportDir: resolve(projectRoot, "-s", ".superturtle", "teleport"),
    legacyTeleportParentDir: resolve(projectRoot, "-s", ".superturtle"),
    legacyTeleportRootDir: resolve(projectRoot, "-s"),
  };
}

function migrateLegacyRuntimeLayout(projectRoot) {
  const paths = getRuntimeLayoutPaths(projectRoot);
  fs.mkdirSync(paths.dataDir, { recursive: true });

  if (fs.existsSync(paths.legacySubturtlesDir)) {
    if (fs.existsSync(paths.subturtlesDir)) {
      throw new Error(
        `Cannot migrate legacy SubTurtle workspaces: both ${paths.legacySubturtlesDir} and ${paths.subturtlesDir} exist.`
      );
    }
    fs.mkdirSync(dirname(paths.subturtlesDir), { recursive: true });
    fs.renameSync(paths.legacySubturtlesDir, paths.subturtlesDir);
  }

  if (fs.existsSync(paths.legacyTeleportDir)) {
    if (fs.existsSync(paths.teleportDir)) {
      throw new Error(
        `Cannot migrate legacy teleport runtime files: both ${paths.legacyTeleportDir} and ${paths.teleportDir} exist.`
      );
    }
    fs.mkdirSync(dirname(paths.teleportDir), { recursive: true });
    fs.renameSync(paths.legacyTeleportDir, paths.teleportDir);
    removeDirIfEmpty(paths.legacyTeleportParentDir);
    removeDirIfEmpty(paths.legacyTeleportRootDir);
  }

  return paths;
}

function importLegacyProjectEnv(projectRoot) {
  const envPath = resolve(projectRoot, PROJECT_ENV_RELATIVE_PATH);
  if (fs.existsSync(envPath)) {
    return { envPath, imported: false };
  }

  const legacyEnvPath = resolve(BOT_DIR, ".env");
  if (!fs.existsSync(legacyEnvPath)) {
    return { envPath, imported: false };
  }

  fs.mkdirSync(dirname(envPath), { recursive: true });
  fs.copyFileSync(legacyEnvPath, envPath);
  console.log(
    `[superturtle] Imported legacy env from ${legacyEnvPath} to ${envPath}. Legacy file left in place.`
  );
  return { envPath, imported: true };
}

function writeProjectBinding(projectRoot, initCwd, options = {}) {
  const dataDir = resolve(projectRoot, SUPERTURTLE_DIRNAME);
  const configPath = resolve(dataDir, "project.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const payload = {
    schema_version: 1,
    repo_root: normalizeExistingPath(projectRoot),
    init_cwd: normalizeExistingPath(initCwd),
    git_created: Boolean(options.gitCreated),
    initialized_at: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return configPath;
}

function resolveEnvExampleTemplatePath() {
  const packagedTemplatePath = resolve(TEMPLATES_DIR, "superturtle.env.example.template");
  if (fs.existsSync(packagedTemplatePath)) {
    return packagedTemplatePath;
  }

  const repoTemplatePath = resolve(PACKAGE_ROOT, "..", ".env.example");
  if (fs.existsSync(repoTemplatePath)) {
    return repoTemplatePath;
  }

  return null;
}

function loadProjectEnv(cwd) {
  const { envPath } = importLegacyProjectEnv(cwd);
  if (!fs.existsSync(envPath)) return null;
  const parsed = {};
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1).trim().replace(/\r$/, "");
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function getTelegramOwnerPath(projectRoot) {
  return resolve(projectRoot, TELEGRAM_OWNER_RELATIVE_PATH);
}

function writeTelegramOwnerState(projectRoot, token, userId, claimSource) {
  const ownerPath = getTelegramOwnerPath(projectRoot);
  const tokenPrefix = String(token || "").split(":")[0] || "unknown";
  const parsedUserId = Number.parseInt(String(userId), 10);
  if (!Number.isInteger(parsedUserId)) {
    throw new Error("Telegram user ID must be a valid integer.");
  }
  const payload = {
    schema_version: 1,
    bot_token_prefix: tokenPrefix,
    owner_user_id: parsedUserId,
    owner_chat_id: parsedUserId,
    claimed_at: new Date().toISOString(),
    claim_source: claimSource,
  };
  fs.writeFileSync(ownerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return ownerPath;
}

function sanitizeName(value, fallback) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || fallback;
}

function deriveTmuxSessionName(cwd, env) {
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const tokenPrefix = sanitizeName(token.split(":")[0], "default");
  const projectSlug = sanitizeName(basename(cwd), "project");
  const combined = `superturtle-${tokenPrefix}-${projectSlug}`;
  return combined.length > 80 ? combined.slice(0, 80) : combined;
}

function resolveTmuxSession(cwd, env) {
  return process.env.SUPERTURTLE_TMUX_SESSION || deriveTmuxSessionName(cwd, env);
}

function deriveTokenPrefix(env) {
  const token = env.TELEGRAM_BOT_TOKEN || "";
  return sanitizeName(token.split(":")[0], "default");
}

function getLogPaths(cwd, env) {
  const tokenPrefix = deriveTokenPrefix(env);
  return {
    tokenPrefix,
    loop: env.SUPERTURTLE_LOOP_LOG_PATH || `/tmp/claude-telegram-${tokenPrefix}-bot-ts.log`,
    pino: env.SUPERTURTLE_PINO_LOG_PATH || `/tmp/claude-telegram-${tokenPrefix}-bot.log.jsonl`,
    audit: env.AUDIT_LOG_PATH || `/tmp/claude-telegram-${tokenPrefix}-audit.log`,
    cronJobs: resolve(cwd, ".superturtle", "cron-jobs.json"),
  };
}

function shellCommandExists(commandName) {
  const check = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(commandName)} >/dev/null 2>&1`], {
    stdio: "pipe",
  });
  return check.status === 0;
}

function getKeepAwakeCommand(platform = os.platform(), commandExists = shellCommandExists) {
  if (platform === "darwin") {
    return commandExists("caffeinate") ? "caffeinate -s" : "";
  }
  if (platform === "linux") {
    return commandExists("systemd-inhibit")
      ? "systemd-inhibit --what=idle --who=superturtle --why='Bot running' --mode=block"
      : "";
  }
  return "";
}

function buildServiceCommand({ cwd, logPath, restartOnCrash, keepAwakeCommand = "" }) {
  const keepAwakePrefix = keepAwakeCommand ? `${keepAwakeCommand} ` : "";
  return (
    `set -o pipefail` +
    ` && cd "${BOT_DIR}"` +
    ` && export CLAUDE_WORKING_DIR="${cwd}"` +
    ` && export SUPER_TURTLE_DIR="${PACKAGE_ROOT}"` +
    ` && export SUPERTURTLE_RUN_LOOP=1` +
    ` && export SUPERTURTLE_LOOP_LOG_PATH="${logPath}"` +
    ` && export SUPERTURTLE_RESTART_ON_CRASH="${restartOnCrash}"` +
    ` && exec ${keepAwakePrefix}./run-loop.sh 2>&1 | tee -a "${logPath}"`
  );
}

function buildPlatformServiceCommand({
  cwd,
  logPath,
  restartOnCrash,
  platform = os.platform(),
  commandExists = shellCommandExists,
}) {
  const keepAwakeCommand = getKeepAwakeCommand(platform, commandExists);
  const serviceCommand = buildServiceCommand({
    cwd,
    logPath,
    restartOnCrash,
    keepAwakeCommand,
  });
  return { keepAwakeCommand, serviceCommand };
}

function getCloudLeaseStatePath(cwd) {
  return resolve(cwd, ".superturtle", "cloud-runtime-lease.json");
}

function readCloudLeaseState(cwd) {
  const path = getCloudLeaseStatePath(cwd);
  if (!fs.existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeCloudLeaseState(cwd, leaseState) {
  const path = getCloudLeaseStatePath(cwd);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(leaseState, null, 2)}\n`, "utf-8");
  return path;
}

function clearCloudLeaseState(cwd) {
  const path = getCloudLeaseStatePath(cwd);
  try {
    fs.unlinkSync(path);
  } catch {}
  return path;
}

function getServicePidPath(cwd) {
  return resolve(cwd, SUPERTURTLE_SERVICE_PID_RELATIVE_PATH);
}

function readServicePid(cwd) {
  const path = getServicePidPath(cwd);
  if (!fs.existsSync(path)) {
    return null;
  }

  const raw = fs.readFileSync(path, "utf-8").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  return Number.parseInt(raw, 10);
}

function writeServicePid(cwd, pid) {
  const path = getServicePidPath(cwd);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${pid}\n`, "utf-8");
  return path;
}

function clearServicePid(cwd) {
  const path = getServicePidPath(cwd);
  try {
    fs.unlinkSync(path);
  } catch {}
  return path;
}

function removeStaleServicePid(cwd, isPidRunningFn = isPidRunning) {
  const pid = readServicePid(cwd);
  if (!Number.isInteger(pid) || pid <= 0 || isPidRunningFn(pid)) {
    return { removed: false, pid };
  }
  clearServicePid(cwd);
  return { removed: true, pid };
}

function getSelfUpdateStatePath(cwd) {
  return resolve(cwd, SUPERTURTLE_SELF_UPDATE_RELATIVE_PATH);
}

function getSelfUpdateLogPath(cwd) {
  return resolve(cwd, SUPERTURTLE_SELF_UPDATE_LOG_RELATIVE_PATH);
}

function getManagedRuntimeManifestPath(cwd) {
  return resolve(cwd, SUPERTURTLE_MANAGED_RUNTIME_RELATIVE_PATH);
}

function readJsonFile(path) {
  if (!fs.existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(path, payload) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, path);
  return path;
}

function appendSelfUpdateLog(cwd, message) {
  const logPath = getSelfUpdateLogPath(cwd);
  fs.mkdirSync(dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
  return logPath;
}

function parseExactRuntimeInstallSpec(rawValue) {
  if (typeof rawValue !== "string") {
    return null;
  }
  const trimmed = rawValue.trim();
  const match = /^superturtle@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(trimmed);
  if (!match || !match[1]) {
    return null;
  }
  return {
    installSpec: trimmed,
    version: match[1],
  };
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isPidRunning(pid) {
  return Number.isInteger(pid) && pid > 0 && spawnSync("kill", ["-0", String(pid)], { stdio: "ignore" }).status === 0;
}

function signalPid(pid, signal = "TERM") {
  return spawnSync("kill", [`-${signal}`, String(pid)], { stdio: "ignore" });
}

function getInstanceLockPathForEnv(env) {
  return `/tmp/claude-telegram-bot.${deriveTokenPrefix(env)}.instance.lock`;
}

function readInstanceLockPid(lockPath) {
  if (!lockPath || !fs.existsSync(lockPath)) {
    return null;
  }

  const raw = fs.readFileSync(lockPath, "utf-8").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function inspectInstanceLock(lockPath, isPidRunningFn = isPidRunning) {
  const pid = readInstanceLockPid(lockPath);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      path: lockPath,
      exists: Boolean(lockPath && fs.existsSync(lockPath)),
      pid: null,
      alive: false,
      valid: false,
    };
  }

  const alive = isPidRunningFn(pid);
  return {
    path: lockPath,
    exists: true,
    pid,
    alive,
    valid: alive,
  };
}

function listProcesses() {
  const proc = spawnSync("ps", ["-eo", "pid=", "-o", "ppid=", "-o", "command="], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (proc.status !== 0) {
    return [];
  }

  return proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/s);
      if (!match) {
        return null;
      }
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
        return null;
      }
      return {
        pid,
        ppid,
        command: (match[3] || "").trim(),
      };
    })
    .filter(Boolean);
}

function collectDescendantProcessIds(processes, seedPids) {
  const tracked = new Set();
  const queue = [];

  for (const pid of seedPids || []) {
    if (Number.isInteger(pid) && pid > 0 && !tracked.has(pid)) {
      tracked.add(pid);
      queue.push(pid);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    for (const info of processes) {
      if (!info || !Number.isInteger(info.pid) || !Number.isInteger(info.ppid)) {
        continue;
      }
      if (info.ppid !== current || tracked.has(info.pid)) {
        continue;
      }
      tracked.add(info.pid);
      queue.push(info.pid);
    }
  }

  return tracked;
}

function expandTrackedProcessIds(trackedPids, processes) {
  return collectDescendantProcessIds(processes, trackedPids);
}

function collectAncestorProcessIds(processes, startPid) {
  const byPid = new Map();
  for (const info of processes || []) {
    if (info && Number.isInteger(info.pid) && info.pid > 0) {
      byPid.set(info.pid, info);
    }
  }

  const tracked = new Set();
  let currentPid = startPid;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!Number.isInteger(currentPid) || currentPid <= 1 || tracked.has(currentPid)) {
      break;
    }
    const info = byPid.get(currentPid);
    if (!info) {
      break;
    }
    tracked.add(info.pid);
    if (!Number.isInteger(info.ppid) || info.ppid <= 1 || info.ppid === info.pid) {
      break;
    }
    currentPid = info.ppid;
  }

  return tracked;
}

function isExpectedRuntimeInstanceLockPid(processes, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const byPid = new Map();
  for (const info of processes || []) {
    if (info && Number.isInteger(info.pid) && info.pid > 0) {
      byPid.set(info.pid, info);
    }
  }

  const processInfo = byPid.get(pid);
  if (!processInfo) {
    return false;
  }

  const botCommand = processInfo.command || "";
  const looksLikeBotProcess =
    botCommand.includes("bun run src/index.ts") ||
    botCommand.includes("bun run src/index.js") ||
    botCommand.includes("tsx src/index.ts");
  if (!looksLikeBotProcess) {
    return false;
  }

  const ancestorPids = collectAncestorProcessIds(processes, pid);
  for (const ancestorPid of ancestorPids) {
    const ancestorInfo = byPid.get(ancestorPid);
    const ancestorCommand = ancestorInfo?.command || "";
    if (ancestorCommand.includes("run-loop.sh")) {
      return true;
    }
  }

  return false;
}

function subtractPidSet(values, excluded) {
  const next = new Set();
  for (const pid of values || []) {
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (excluded && excluded.has(pid)) {
      continue;
    }
    next.add(pid);
  }
  return next;
}

function removeStaleInstanceLock(lockPath, isPidRunningFn = isPidRunning) {
  if (!lockPath || !fs.existsSync(lockPath)) {
    return { removed: false, pid: null };
  }

  const state = inspectInstanceLock(lockPath, isPidRunningFn);
  if (!state.exists || state.alive || !Number.isInteger(state.pid)) {
    return { removed: false, pid: state.pid };
  }

  try {
    fs.unlinkSync(lockPath);
    return { removed: true, pid: state.pid };
  } catch {
    return { removed: false, pid: state.pid };
  }
}

function signalPidSet(pids, signal = "TERM") {
  const signaled = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    signalPid(pid, signal);
    signaled.push(pid);
  }
  return signaled;
}

function parseServiceStopTreeArgs(argv = process.argv.slice(4)) {
  const options = {
    cwd: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      options.cwd = argv[index + 1] || "";
      index += 1;
      continue;
    }
  }

  return options;
}

function discoverTrackedRuntimePids(cwd, projectEnv, deps = {}) {
  const listProcessesFn = deps.listProcesses || listProcesses;
  const isPidRunningFn = deps.isPidRunning || isPidRunning;
  const readServicePidFn = deps.readServicePid || readServicePid;
  const inspectInstanceLockFn = deps.inspectInstanceLock || inspectInstanceLock;
  const processes = listProcessesFn();
  const tracked = new Set();

  const servicePid = readServicePidFn(cwd);
  if (Number.isInteger(servicePid) && servicePid > 0 && isPidRunningFn(servicePid)) {
    for (const pid of collectDescendantProcessIds(processes, [servicePid])) {
      tracked.add(pid);
    }
  }

  const instanceLockPath = getInstanceLockPathForEnv({ ...process.env, ...projectEnv });
  const lockState = inspectInstanceLockFn(instanceLockPath, isPidRunningFn);
  const lockPidMatchesRuntime =
    lockState.alive &&
    Number.isInteger(lockState.pid) &&
    lockState.pid > 0 &&
    isExpectedRuntimeInstanceLockPid(processes, lockState.pid);
  if (lockPidMatchesRuntime) {
    for (const pid of collectAncestorProcessIds(processes, lockState.pid)) {
      tracked.add(pid);
    }
    for (const pid of collectDescendantProcessIds(processes, [lockState.pid])) {
      tracked.add(pid);
    }
  }

  return {
    instanceLockPath,
    lockPidMatchesRuntime,
    servicePid: Number.isInteger(servicePid) ? servicePid : null,
    trackedPids: Array.from(tracked).sort((left, right) => left - right),
  };
}

function parseSelfUpdateRunnerArgs(argv = process.argv.slice(4)) {
  const options = {
    cwd: "",
    installSpec: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      options.cwd = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--spec") {
      options.installSpec = argv[index + 1] || "";
      index += 1;
    }
  }
  return options;
}

async function waitForServiceRunnerShutdown(
  cwd,
  servicePid,
  timeoutMs = 90_000,
  options = {},
  deps = {}
) {
  const projectEnv = options.projectEnv || loadProjectEnv(cwd) || {};
  const instanceLockPath =
    options.instanceLockPath || getInstanceLockPathForEnv({ ...process.env, ...projectEnv });
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : 250;
  const softKillAfterMs = Number.isInteger(options.softKillAfterMs) && options.softKillAfterMs >= 0
    ? options.softKillAfterMs
    : 10_000;
  const hardKillAfterMs = Number.isInteger(options.hardKillAfterMs) && options.hardKillAfterMs >= 0
    ? options.hardKillAfterMs
    : 20_000;
  const listProcessesFn = deps.listProcesses || listProcesses;
  const isPidRunningFn = deps.isPidRunning || isPidRunning;
  const readServicePidFn = deps.readServicePid || readServicePid;
  const signalPidSetFn = deps.signalPidSet || signalPidSet;
  const removeStaleServicePidFn = deps.removeStaleServicePid || removeStaleServicePid;
  const removeStaleInstanceLockFn = deps.removeStaleInstanceLock || removeStaleInstanceLock;
  const inspectInstanceLockFn = deps.inspectInstanceLock || inspectInstanceLock;
  const sleepFn =
    deps.sleep || ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)));
  const logger = deps.logger || (() => {});

  const deadline = Date.now() + timeoutMs;
  const ignoredPids =
    Array.isArray(options.ignoredPids) && options.ignoredPids.length > 0
      ? options.ignoredPids.filter((pid) => Number.isInteger(pid) && pid > 0)
      : [process.pid];
  const initialTrackedPids =
    Array.isArray(options.initialTrackedPids) && options.initialTrackedPids.length > 0
      ? options.initialTrackedPids
      : [servicePid];
  let processes = listProcessesFn();
  let ignoredPidSet = collectDescendantProcessIds(processes, ignoredPids);
  let trackedPids = subtractPidSet(
    collectDescendantProcessIds(processes, initialTrackedPids),
    ignoredPidSet
  );
  let softEscalated = false;
  let hardEscalated = false;

  logger(
    `Tracking old runtime shutdown via ${instanceLockPath}; watched pids: ${Array.from(trackedPids).sort((a, b) => a - b).join(", ") || "none"}; ignored pids: ${Array.from(ignoredPidSet).sort((a, b) => a - b).join(", ") || "none"}.`
  );

  while (Date.now() < deadline) {
    processes = listProcessesFn();
    ignoredPidSet = collectDescendantProcessIds(processes, ignoredPids);
    trackedPids = subtractPidSet(expandTrackedProcessIds(trackedPids, processes), ignoredPidSet);

    const staleServicePid = removeStaleServicePidFn(cwd, isPidRunningFn);
    if (staleServicePid.removed) {
      logger(`Removed stale service pid file for dead pid ${staleServicePid.pid}.`);
    }

    const staleLock = removeStaleInstanceLockFn(instanceLockPath, isPidRunningFn);
    if (staleLock.removed) {
      logger(`Removed stale Telegram instance lock ${instanceLockPath} for dead pid ${staleLock.pid}.`);
    }

    let lockState = inspectInstanceLockFn(instanceLockPath, isPidRunningFn);
    if (lockState.alive && Number.isInteger(lockState.pid) && lockState.pid > 0) {
      trackedPids.add(lockState.pid);
      trackedPids = subtractPidSet(expandTrackedProcessIds(trackedPids, processes), ignoredPidSet);
    }

    const survivors = Array.from(trackedPids)
      .filter((pid) => isPidRunningFn(pid))
      .sort((left, right) => left - right);
    const trackedPid = readServicePidFn(cwd);
    const serviceCleared = !isPidRunningFn(servicePid) && (!trackedPid || trackedPid !== servicePid);
    if (serviceCleared && survivors.length === 0 && !lockState.alive) {
      return {
        instanceLockPath,
        trackedPids: Array.from(trackedPids).sort((left, right) => left - right),
      };
    }

    const elapsedMs = timeoutMs - Math.max(0, deadline - Date.now());
    if (!softEscalated && elapsedMs >= softKillAfterMs && survivors.length > 0) {
      const signaled = signalPidSetFn(survivors, "TERM");
      if (signaled.length > 0) {
        logger(`Old runtime still alive after ${elapsedMs}ms; sent SIGTERM to pids ${signaled.join(", ")}.`);
      }
      softEscalated = true;
    }

    lockState = inspectInstanceLockFn(instanceLockPath, isPidRunningFn);
    if (!hardEscalated && elapsedMs >= hardKillAfterMs) {
      const livePids = Array.from(new Set([
        ...survivors,
        lockState.alive && Number.isInteger(lockState.pid) ? lockState.pid : null,
      ].filter((pid) => Number.isInteger(pid) && pid > 0)));
      const signaled = signalPidSetFn(livePids, "KILL");
      if (signaled.length > 0) {
        logger(`Old runtime still alive after ${elapsedMs}ms; sent SIGKILL to pids ${signaled.join(", ")}.`);
      }
      hardEscalated = true;
    }

    await sleepFn(pollIntervalMs);
  }

  const finalProcesses = listProcessesFn();
  const finalIgnoredPidSet = collectDescendantProcessIds(finalProcesses, ignoredPids);
  trackedPids = subtractPidSet(expandTrackedProcessIds(trackedPids, finalProcesses), finalIgnoredPidSet);
  const finalSurvivors = Array.from(trackedPids)
    .filter((pid) => isPidRunningFn(pid))
    .sort((left, right) => left - right);
  const finalLock = inspectInstanceLockFn(instanceLockPath, isPidRunningFn);
  const details = [];
  if (finalSurvivors.length > 0) {
    details.push(`live pids ${finalSurvivors.join(", ")}`);
  }
  if (finalLock.alive && Number.isInteger(finalLock.pid)) {
    details.push(`instance lock pid ${finalLock.pid}`);
  }
  throw new Error(
    `Timed out waiting for service runner ${servicePid} to stop${details.length > 0 ? ` (${details.join("; ")})` : ""}.`
  );
}

async function waitForReplacementServiceRunner(cwd, previousServicePid, timeoutMs = 30_000, options = {}, deps = {}) {
  const projectEnv = options.projectEnv || loadProjectEnv(cwd) || {};
  const instanceLockPath =
    options.instanceLockPath || getInstanceLockPathForEnv({ ...process.env, ...projectEnv });
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : 250;
  const readServicePidFn = deps.readServicePid || readServicePid;
  const isPidRunningFn = deps.isPidRunning || isPidRunning;
  const removeStaleInstanceLockFn = deps.removeStaleInstanceLock || removeStaleInstanceLock;
  const inspectInstanceLockFn = deps.inspectInstanceLock || inspectInstanceLock;
  const sleepFn =
    deps.sleep || ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)));
  const logger = deps.logger || (() => {});
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const staleLock = removeStaleInstanceLockFn(instanceLockPath, isPidRunningFn);
    if (staleLock.removed) {
      logger(`Removed stale Telegram instance lock ${instanceLockPath} for dead pid ${staleLock.pid}.`);
    }

    const nextServicePid = readServicePidFn(cwd);
    const lockState = inspectInstanceLockFn(instanceLockPath, isPidRunningFn);
    if (
      Number.isInteger(nextServicePid) &&
      nextServicePid > 0 &&
      nextServicePid !== previousServicePid &&
      isPidRunningFn(nextServicePid) &&
      lockState.alive
    ) {
      return {
        servicePid: nextServicePid,
        instanceLockPath,
        lockPid: lockState.pid,
      };
    }

    await sleepFn(pollIntervalMs);
  }

  const nextServicePid = readServicePidFn(cwd);
  const lockState = inspectInstanceLockFn(instanceLockPath, isPidRunningFn);
  throw new Error(
    `Replacement service runner did not stabilize${Number.isInteger(nextServicePid) ? ` (service pid ${nextServicePid})` : ""}${lockState.alive && Number.isInteger(lockState.pid) ? ` (instance lock pid ${lockState.pid})` : ""}.`
  );
}

function updateManagedRuntimeManifest(cwd, installSpec, version) {
  const manifestPath = getManagedRuntimeManifestPath(cwd);
  const existing = readJsonFile(manifestPath);
  const projectEnv = loadProjectEnv(cwd) || {};
  const runtimeProfile =
    (projectEnv.SUPERTURTLE_RUNTIME_PROFILE || process.env.SUPERTURTLE_RUNTIME_PROFILE || "").trim() ||
    ((projectEnv.SUPERTURTLE_RUNTIME_ROLE || process.env.SUPERTURTLE_RUNTIME_ROLE) === "teleport-remote"
      ? "managed"
      : "local");
  const driver =
    (
      projectEnv.SUPERTURTLE_DRIVER ||
      process.env.SUPERTURTLE_DRIVER ||
      projectEnv.SUPERTURTLE_REMOTE_DRIVER ||
      process.env.SUPERTURTLE_REMOTE_DRIVER ||
      projectEnv.MAIN_PROVIDER ||
      process.env.MAIN_PROVIDER ||
      (runtimeProfile === "managed" ? "codex" : "claude")
    ).trim();
  const nextPayload =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  nextPayload.runtime_install_spec = installSpec;
  nextPayload.runtime_version = version;
  nextPayload.runtime_profile = runtimeProfile;
  nextPayload.driver = driver;
  nextPayload.remote_mode = runtimeProfile === "managed" ? "agent" : null;
  nextPayload.remote_driver = runtimeProfile === "managed" ? driver : null;
  nextPayload.updated_at = new Date().toISOString();
  writeJsonFile(manifestPath, nextPayload);
  return manifestPath;
}

function launchDetachedServiceRunner(cwd) {
  const child = spawn(
    "bash",
    [
      "-lc",
      `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" && cd ${shellEscape(cwd)} && exec superturtle service run`,
    ],
    {
      cwd,
      env: { ...process.env, CLAUDE_WORKING_DIR: cwd },
      stdio: "ignore",
      detached: true,
    }
  );
  child.unref();
  return child;
}

async function serviceSelfUpdateRunner() {
  const options = parseSelfUpdateRunnerArgs();
  const cwd = options.cwd ? getBoundProjectRoot(options.cwd) : getBoundProjectRoot(process.cwd());
  const parsedSpec = parseExactRuntimeInstallSpec(options.installSpec);
  if (!parsedSpec) {
    throw new Error("Usage: superturtle service self-update-runner --cwd <project> --spec superturtle@<exact-version>");
  }

  const statePath = getSelfUpdateStatePath(cwd);
  const initialState = readJsonFile(statePath);
  if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)) {
    throw new Error(`Missing self-update state file at ${statePath}.`);
  }

  const servicePid = Number.isInteger(initialState.service_pid)
    ? initialState.service_pid
    : readServicePid(cwd);
  if (!Number.isInteger(servicePid) || servicePid <= 0) {
    throw new Error("Missing service runner pid for self-update handoff.");
  }

  const writeState = (patch) => {
    const current = readJsonFile(statePath);
    const nextState =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...current, ...patch }
        : { ...initialState, ...patch };
    writeJsonFile(statePath, nextState);
    return nextState;
  };

  let replacementLaunched = false;
  let oldRuntimeStopped = false;
  const restartAvailableRuntime = () => {
    if (replacementLaunched) {
      return null;
    }
    appendSelfUpdateLog(cwd, "Launching replacement service runner.");
    const child = launchDetachedServiceRunner(cwd);
    appendSelfUpdateLog(cwd, `Replacement service runner launched with pid ${child.pid}.`);
    replacementLaunched = true;
    return child;
  };

  appendSelfUpdateLog(cwd, `Starting self-update to ${parsedSpec.installSpec}.`);
  writeState({
    status: "installing",
    requested_spec: parsedSpec.installSpec,
    target_version: parsedSpec.version,
    helper_pid: process.pid,
  });

  try {
    const projectEnv = loadProjectEnv(cwd) || {};
    const runningProcesses = listProcesses();
    const ignoredPids = Array.from(collectDescendantProcessIds(runningProcesses, [process.pid]));
    const initialTrackedPids = Array.from(
      subtractPidSet(
        collectDescendantProcessIds(runningProcesses, [servicePid]),
        new Set(ignoredPids)
      )
    );
    appendSelfUpdateLog(
      cwd,
      `Captured old runtime tree before shutdown: ${initialTrackedPids.sort((left, right) => left - right).join(", ") || "none"}. Ignoring updater pids: ${ignoredPids.sort((left, right) => left - right).join(", ") || "none"}.`
    );
    appendSelfUpdateLog(cwd, `Stopping service runner pid ${servicePid}.`);
    signalPid(servicePid, "TERM");
    await waitForServiceRunnerShutdown(cwd, servicePid, 90_000, { projectEnv, initialTrackedPids, ignoredPids }, {
      logger: (message) => appendSelfUpdateLog(cwd, message),
    });
    oldRuntimeStopped = true;
    appendSelfUpdateLog(cwd, "Previous service runner stopped cleanly.");

    const install = spawnSync(
      "bash",
      [
        "-lc",
        `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" && bun install -g ${shellEscape(parsedSpec.installSpec)}`,
      ],
      {
        cwd,
        env: { ...process.env, CLAUDE_WORKING_DIR: cwd },
        stdio: "pipe",
      }
    );
    if (install.error) {
      throw new Error(`bun install failed: ${install.error.message}`);
    }
    if (install.status !== 0) {
      const stderr = install.stderr?.toString().trim();
      const stdout = install.stdout?.toString().trim();
      throw new Error(stderr || stdout || `bun install exited with code ${install.status}.`);
    }

    updateManagedRuntimeManifest(cwd, parsedSpec.installSpec, parsedSpec.version);
    appendSelfUpdateLog(cwd, `Installed ${parsedSpec.installSpec}.`);
    restartAvailableRuntime();
    const replacement = await waitForReplacementServiceRunner(cwd, servicePid, 30_000, { projectEnv }, {
      logger: (message) => appendSelfUpdateLog(cwd, message),
    });
    appendSelfUpdateLog(
      cwd,
      `Replacement service runner stabilized with service pid ${replacement.servicePid}${Number.isInteger(replacement.lockPid) ? ` and instance lock pid ${replacement.lockPid}` : ""}.`
    );
    writeState({
      status: "starting",
      completed_at: new Date().toISOString(),
      error: null,
      service_pid: replacement.servicePid,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendSelfUpdateLog(cwd, `Self-update failed: ${message}`);
    writeState({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: message,
    });
    if (oldRuntimeStopped) {
      restartAvailableRuntime();
    }
    throw error;
  }
}

async function serviceStopTree() {
  const options = parseServiceStopTreeArgs();
  const cwd = options.cwd ? getBoundProjectRoot(options.cwd) : getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd) || {};
  const discovery = discoverTrackedRuntimePids(cwd, projectEnv);
  const ignoredPids = Array.from(collectDescendantProcessIds(listProcesses(), [process.pid]));

  if (discovery.trackedPids.length === 0) {
    const staleServicePid = removeStaleServicePid(cwd);
    const staleLock = removeStaleInstanceLock(discovery.instanceLockPath);
    if (staleServicePid.removed) {
      console.log(`Removed stale service pid file for dead pid ${staleServicePid.pid}.`);
    }
    if (staleLock.removed) {
      console.log(`Removed stale Telegram instance lock ${discovery.instanceLockPath} for dead pid ${staleLock.pid}.`);
    }
    console.log("No live SuperTurtle runtime tree found.");
    return;
  }

  const signaled = signalPidSet(discovery.trackedPids, "TERM");
  if (signaled.length > 0) {
    console.log(`Sent SIGTERM to runtime pids: ${signaled.join(", ")}`);
  }

  const anchorPid =
    Number.isInteger(discovery.servicePid) && discovery.servicePid > 0 ? discovery.servicePid : discovery.trackedPids[0];

  await waitForServiceRunnerShutdown(
    cwd,
    anchorPid,
    30_000,
    {
      projectEnv,
      initialTrackedPids: discovery.trackedPids,
      ignoredPids,
      softKillAfterMs: 1_000,
      hardKillAfterMs: 5_000,
    },
    {
      logger: (message) => console.log(message),
    }
  );

  clearServicePid(cwd);
  removeStaleInstanceLock(discovery.instanceLockPath);
  console.log("SuperTurtle runtime tree stopped cleanly.");
}

function getRuntimeOwnerType(env) {
  return env.SUPERTURTLE_RUNTIME_PROFILE === "managed" ||
    env.SUPERTURTLE_RUNTIME_ROLE === "teleport-remote" ||
    env.TELEGRAM_TRANSPORT === "webhook"
    ? "cloud"
    : "local";
}

function buildRuntimeIdForEnv(env) {
  return buildRuntimeId(getRuntimeOwnerType(env));
}

function serviceModeLabel(env) {
  return env.SUPERTURTLE_TMUX_SESSION ? "tmux" : "service";
}

function buildRuntimeId(kind = "local") {
  const host = sanitizeName(os.hostname(), "host");
  return `${kind}-${host}-${Date.now().toString(36)}-${process.pid}`;
}

function formatLeaseOwner(lease) {
  if (!lease) {
    return "unknown runtime";
  }
  const runtimeId = lease.runtime_id || "unknown-runtime";
  const ownerType = lease.owner_type || "unknown";
  const host = lease.owner_hostname ? ` on ${lease.owner_hostname}` : "";
  const pid = Number.isInteger(lease.owner_pid) ? ` pid=${lease.owner_pid}` : "";
  const expires = lease.expires_at ? ` until ${lease.expires_at}` : "";
  return `${ownerType} runtime ${runtimeId}${host}${pid}${expires}`;
}

function isOptionalHostedOwnershipError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = typeof error.message === "string" ? error.message.trim() : "";
  const payload =
    error.payload && typeof error.payload === "object" && !Array.isArray(error.payload)
      ? error.payload
      : null;
  const errorCode =
    (payload && typeof payload.error_code === "string" && payload.error_code.trim()) ||
    (payload && typeof payload.code === "string" && payload.code.trim()) ||
    "";

  return [message, errorCode].some((value) =>
    /^(managed_cloud_surface_disabled|runtime_lease_unsupported)$/i.test(value)
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function printManagedInstanceSummary(instance) {
  if (!instance) {
    return;
  }

  if (instance.id) console.log(`Instance: ${instance.id}`);
  if (instance.provider) console.log(`Provider: ${instance.provider}`);
  if (instance.sandbox_id) console.log(`Sandbox: ${instance.sandbox_id}`);
  if (instance.template_id) console.log(`Template: ${instance.template_id}`);
  if (instance.template_version) console.log(`Template version: ${instance.template_version}`);
  if (instance.runtime_version) console.log(`Runtime version: ${instance.runtime_version}`);
  if (instance.state) console.log(`State: ${instance.state}`);
  if (instance.health_status) console.log(`Health: ${instance.health_status}`);
  if (instance.health_checked_at) console.log(`Health checked: ${instance.health_checked_at}`);
  if (instance.registered_at) console.log(`Registered: ${instance.registered_at}`);
  if (instance.last_seen_at) console.log(`Last seen: ${instance.last_seen_at}`);
  if (instance.region) console.log(`Region: ${instance.region}`);
  if (instance.hostname) console.log(`Hostname: ${instance.hostname}`);
  if (instance.project_root) console.log(`Project root: ${instance.project_root}`);
  if (instance.resume_requested_at) console.log(`Resume requested: ${instance.resume_requested_at}`);
}

function describeFile(path) {
  try {
    const stats = fs.statSync(path);
    return {
      exists: true,
      size: stats.size,
      mtimeIso: stats.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      size: 0,
      mtimeIso: "",
    };
  }
}

function readCronSummary(cronJobsPath) {
  if (!fs.existsSync(cronJobsPath)) {
    return { exists: false, total: 0, overdue: 0, dueSoon: 0, parseError: null };
  }

  try {
    const raw = fs.readFileSync(cronJobsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    const inFiveMinutes = now + 5 * 60 * 1000;
    let overdue = 0;
    let dueSoon = 0;

    for (const job of jobs) {
      const fireAt = Number(job?.fire_at);
      if (!Number.isFinite(fireAt)) continue;
      if (fireAt < now) overdue += 1;
      if (fireAt >= now && fireAt <= inFiveMinutes) dueSoon += 1;
    }

    return {
      exists: true,
      total: jobs.length,
      overdue,
      dueSoon,
      parseError: null,
    };
  } catch (error) {
    return {
      exists: true,
      total: 0,
      overdue: 0,
      dueSoon: 0,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function printLogSummary(label, path) {
  const info = describeFile(path);
  if (!info.exists) {
    console.log(`${label}: missing`);
    console.log(`  ${path}`);
    return;
  }
  console.log(`${label}: ${formatBytes(info.size)}, updated ${info.mtimeIso}`);
  console.log(`  ${path}`);
}

function printLoopLogErrorHints(loopPath) {
  if (!fs.existsSync(loopPath)) return;
  const tail = spawnSync("tail", ["-n", "120", loopPath], { stdio: "pipe" });
  if (tail.status !== 0) return;
  const lines = tail.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const hints = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|fail|crash|panic|exit code|sigterm|sigkill|exception/i.test(lines[i])) {
      hints.unshift(lines[i]);
      if (hints.length >= 5) break;
    }
  }
  if (hints.length === 0) return;
  console.log("\nRecent loop failure hints:");
  for (const hint of hints) {
    const preview = hint.length > 180 ? `${hint.slice(0, 177)}...` : hint;
    console.log(`  - ${preview}`);
  }
}

function printSubturtleList(ctlPath, cwd) {
  if (!fs.existsSync(ctlPath)) {
    console.log("SubTurtles: ctl missing");
    return;
  }
  const proc = spawnSync(ctlPath, ["list"], {
    cwd,
    env: { ...process.env, SUPER_TURTLE_PROJECT_DIR: cwd },
    stdio: "pipe",
  });
  if (proc.status !== 0) {
    const stderr = proc.stderr?.toString().trim();
    console.log(`SubTurtles: failed to read list${stderr ? ` (${stderr})` : ""}`);
    return;
  }
  const output = proc.stdout?.toString().trim();
  if (!output) {
    console.log("SubTurtles: none");
    return;
  }
  console.log("SubTurtles:");
  console.log(output);
}

function exitFromSpawn(result, context) {
  if (!result) {
    console.error(`Error: failed to run ${context}.`);
    process.exit(1);
  }
  if (result.error) {
    console.error(`Error: failed to run ${context}: ${result.error.message}`);
    process.exit(1);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = result.stderr?.toString()?.trim();
    if (stderr) console.error(stderr);
    console.error(`Error: ${context} exited with code ${result.status}.`);
    process.exit(result.status || 1);
  }
}

// --- Output helpers (ANSI, no dependencies) ---
const isTTY = process.stdout.isTTY;
const c = {
  green: (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  dim: (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  bold: (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  yellow: (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  red: (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
};
const ok = (msg) => console.log(`  ${c.green("\u2713")} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow("!")} ${msg}`);
const fail = (msg) => { console.error(`  ${c.red("\u2717")} ${msg}`); };
const info = (msg) => console.log(`  ${c.dim(msg)}`);
const blank = () => console.log();

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8")).version;
  } catch { return "0.0.0"; }
}

function checkBun() {
  try {
    execSync("bun --version", { stdio: "pipe" });
    ok("bun");
    return true;
  } catch {
    fail("bun not found — https://bun.sh");
    process.exit(1);
  }
}

function checkTmux() {
  if (!hasTmux()) {
    fail("tmux not found — brew install tmux");
    process.exit(1);
  }
  ok("tmux");
  return true;
}

function hasTmux() {
  try {
    execSync("tmux -V", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function checkClaude() {
  try {
    execSync("claude --version", { stdio: "pipe" });
    ok("claude");
    return true;
  } catch {
    warn("claude CLI not found — https://claude.ai/code");
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseInitFlags() {
  const flags = { token: null, user: null, openaiKey: null, createGit: false };
  const args = process.argv.slice(3); // skip node, script, "init"
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
        flags.token = args[++i] || null;
        break;
      case "--user":
        flags.user = args[++i] || null;
        break;
      case "--openai-key":
        flags.openaiKey = args[++i] || null;
        break;
      case "--create-git":
        flags.createGit = true;
        break;
    }
  }
  return flags;
}

function copyDirFiltered(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".DS_Store" ||
      entry.name === "settings.local.json" ||
      entry.name === "agent-memory"
    ) {
      continue;
    }
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(sourcePath, targetPath);
      continue;
    }
    if (fs.existsSync(targetPath)) continue;
    fs.copyFileSync(sourcePath, targetPath);
  }
}

async function init() {
  const cwd = normalizeExistingPath(process.cwd());
  const flags = parseInitFlags();
  let projectRoot = findGitRoot(cwd);
  let gitCreated = false;

  if (!projectRoot) {
    if (!flags.createGit) {
      throw new Error(
        `No Git repository found for ${cwd}. Run 'git init' yourself first, or rerun 'superturtle init --create-git' to create a repo explicitly.`
      );
    }
    const gitInit = spawnSync("git", ["init"], { cwd, stdio: "pipe" });
    if (gitInit.error) {
      throw new Error(`Failed to run git init: ${gitInit.error.message}`);
    }
    if (gitInit.status !== 0) {
      const stderr = gitInit.stderr?.toString().trim();
      throw new Error(stderr || "git init failed.");
    }
    projectRoot = cwd;
    gitCreated = true;
  }

  ensureSafeRepoRoot(projectRoot);
  const { dataDir } = migrateLegacyRuntimeLayout(projectRoot);
  const { imported: importedLegacyEnv } = importLegacyProjectEnv(projectRoot);

  blank();
  console.log(`  \u{1F422} ${c.bold("superturtle")} ${c.dim("v" + getVersion())}`);
  blank();

  // --- Prerequisites ---
  checkBun();
  checkTmux();
  checkClaude();
  blank();

  if (gitCreated) {
    ok(`.git ${c.dim("(created via --create-git)")}`);
  } else {
    ok(`.git ${c.dim(`(bound to ${projectRoot})`)}`);
  }
  if (!pathsEqual(cwd, projectRoot)) {
    warn(`Init was run from subfolder ${cwd}`);
    info(`Bound repo root: ${projectRoot}`);
    info(`Teleport and sync scope will be the full repo rooted at ${projectRoot}.`);
    blank();
  } else {
    info(`Bound repo root: ${projectRoot}`);
    blank();
  }

  // --- .superturtle/ directory ---
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const gitignorePath = resolve(dataDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "*\n");
  }
  ok(".superturtle/");
  writeProjectBinding(projectRoot, cwd, { gitCreated });
  ok(".superturtle/project.json");

  const envExamplePath = resolve(projectRoot, PROJECT_ENV_EXAMPLE_RELATIVE_PATH);
  if (!fs.existsSync(envExamplePath)) {
    const envExampleTemplatePath = resolveEnvExampleTemplatePath();
    if (envExampleTemplatePath) {
      fs.copyFileSync(envExampleTemplatePath, envExamplePath);
      ok(".superturtle/.env.example");
    } else {
      warn("Missing env example template in package; skipped .superturtle/.env.example");
    }
  } else {
    ok(".superturtle/.env.example " + c.dim("(exists)"));
  }

  // --- .env config ---
  const envPath = resolve(dataDir, ".env");
  const telegramOwnerPath = getTelegramOwnerPath(projectRoot);
  if (!fs.existsSync(envPath)) {
    let token = flags.token;
    let userId = flags.user;
    let openaiKey = flags.openaiKey;

    if (!token) {
      // Non-interactive mode: fail fast
      if (!process.stdin.isTTY) {
        blank();
        fail("Missing required flags for non-interactive mode:");
        if (!token) fail("  --token <TELEGRAM_BOT_TOKEN>");
        blank();
        info("Usage: superturtle init [--create-git] --token <token> [--user <id>] [--openai-key <key>]");
        blank();
        process.exit(1);
      }

      // Interactive mode
      blank();
      console.log(`  ${c.bold("Telegram Bot Configuration")}`);
      info("\u2500".repeat(30));
      blank();

      if (!token) {
        info("Get a token: message @BotFather on Telegram \u2192 /newbot");
        blank();
        token = await ask("Bot token: ");
        if (!token) { fail("Bot token is required."); process.exit(1); }
        blank();
      }

    }

    if (process.stdin.isTTY && openaiKey === null) {
      openaiKey = await ask("OpenAI API key " + c.dim("(for voice, Enter to skip)") + ": ");
      blank();
    }

    let envContent = `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `CLAUDE_WORKING_DIR=${projectRoot}\n`;
    if (openaiKey) {
      envContent += `OPENAI_API_KEY=${openaiKey}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    ok(".superturtle/.env");
  } else {
    const status = importedLegacyEnv
      ? "(imported from legacy claude-telegram-bot/.env; legacy file kept)"
      : "(exists)";
    ok(".superturtle/.env " + c.dim(status));
  }

  if (flags.user && !fs.existsSync(telegramOwnerPath)) {
    writeTelegramOwnerState(projectRoot, flags.token || loadProjectEnv(projectRoot)?.TELEGRAM_BOT_TOKEN, flags.user, "init_flag");
    ok(".superturtle/telegram-owner.json");
  } else if (!fs.existsSync(telegramOwnerPath)) {
    info("Finish Telegram linking by sending your bot a private message once.");
  }

  // --- CLAUDE.md ---
  const claudeMdPath = resolve(projectRoot, "CLAUDE.md");
  const templatePath = resolve(TEMPLATES_DIR, "CLAUDE.md.template");
  if (!fs.existsSync(claudeMdPath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, claudeMdPath);
    ok("CLAUDE.md");
  } else if (fs.existsSync(claudeMdPath)) {
    ok("CLAUDE.md " + c.dim("(exists)"));
  }

  // --- AGENTS.md symlink ---
  const agentsPath = resolve(projectRoot, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    try {
      fs.symlinkSync("CLAUDE.md", agentsPath);
      ok("AGENTS.md \u2192 CLAUDE.md");
    } catch (error) {
      warn(`AGENTS.md symlink failed: ${error.message}`);
    }
  }

  // --- .claude templates ---
  const claudeTemplateDir = resolve(TEMPLATES_DIR, ".claude");
  if (fs.existsSync(claudeTemplateDir)) {
    const targetClaudeDir = resolve(projectRoot, ".claude");
    copyDirFiltered(claudeTemplateDir, targetClaudeDir);
    ok(targetClaudeDir.replace(projectRoot + "/", ""));
  }

  // --- .gitignore ---
  const projectGitignore = resolve(projectRoot, ".gitignore");
  if (fs.existsSync(projectGitignore)) {
    const content = fs.readFileSync(projectGitignore, "utf-8");
    const additions = [];
    if (!content.includes(".superturtle/")) additions.push(".superturtle/");
    if (additions.length > 0) {
      fs.appendFileSync(projectGitignore, "\n# superturtle\n" + additions.join("\n") + "\n");
      ok(".gitignore");
    }
  }

  // --- Dependencies ---
  blank();
  info("Installing dependencies...");
  const install = spawnSync("bun", ["install"], { cwd: BOT_DIR, stdio: "pipe" });
  exitFromSpawn(install, "bun install");
  ok("dependencies installed");

  // --- Done ---
  blank();
  console.log(`  ${c.green("Ready!")} Bound repo: ${c.bold(projectRoot)}`);
  console.log(`  ${c.green("Ready!")} Run: ${c.bold("superturtle start")}`);
  blank();
}

function shouldPassEnvKey(k) {
  return (
    k.startsWith("TELEGRAM_") ||
    k.startsWith("OPENAI_") ||
    k.startsWith("CLAUDE_") ||
    k.startsWith("CODEX_") ||
    k.startsWith("E2B_") ||
    k.startsWith("META_") ||
    k.startsWith("DASHBOARD_") ||
    k.startsWith("AUDIT_LOG_") ||
    k.startsWith("RATE_LIMIT_") ||
    k.startsWith("THINKING_") ||
    k.startsWith("TRANSCRIPTION_") ||
    k.startsWith("TURTLE_") ||
    k.startsWith("DEFAULT_") ||
    k === "ALLOWED_PATHS" ||
    k === "LOG_LEVEL"
  );
}

function terminateChildProcessGroup(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  try {
    if (process.platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}

  try {
    child.kill(signal);
  } catch {}
}

function buildServiceChildSpawnOptions(env) {
  return {
    cwd: BOT_DIR,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  };
}

async function serviceRun() {
  checkBun();

  const cwd = getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd);

  if (!projectEnv) {
    console.error("No .superturtle/.env found. Run 'superturtle init' first.");
    process.exit(1);
  }

  const env = {
    ...process.env,
    ...projectEnv,
    SUPER_TURTLE_DIR: PACKAGE_ROOT,
    CLAUDE_WORKING_DIR: cwd,
  };
  const logPaths = getLogPaths(cwd, env);
  const existingPid = readServicePid(cwd);

  if (existingPid && existingPid !== process.pid && isPidRunning(existingPid)) {
    console.error(`Refusing to start service runner: another SuperTurtle service is already running (PID ${existingPid}).`);
    process.exit(1);
  }

  writeServicePid(cwd, process.pid);

  let currentSession = null;
  let leaseClaim = null;
  let child = null;
  let shuttingDown = false;
  let consecutiveHeartbeatFailures = 0;

  const cleanupLease = async () => {
    if (leaseClaim?.lease?.lease_id && leaseClaim.runtimeId && currentSession?.access_token) {
      try {
        await releaseRuntimeLease(
          currentSession,
          {
            lease_id: leaseClaim.lease.lease_id,
            lease_epoch: leaseClaim.lease.lease_epoch,
            runtime_id: leaseClaim.runtimeId,
          },
          env
        );
      } catch (error) {
        if (!isRetryableCloudError(error) && !isOptionalHostedOwnershipError(error)) {
          console.error(
            `Warning: failed to release hosted runtime ownership: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    clearCloudLeaseState(cwd);
  };

  const shutdown = async (signal = "SIGTERM") => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    terminateChildProcessGroup(child, signal);
    await cleanupLease();
    clearServicePid(cwd);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").finally(() => process.exit(0));
  });
  process.on("SIGHUP", () => {
    shutdown("SIGHUP").finally(() => process.exit(0));
  });
  process.on("exit", () => {
    clearServicePid(cwd);
  });

  try {
    currentSession = readSession();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (currentSession?.access_token) {
    const runtimeId = buildRuntimeIdForEnv(env);
    try {
      const claimResult = await claimRuntimeLease(
        currentSession,
        {
          runtime_id: runtimeId,
          owner_type: getRuntimeOwnerType(env),
          owner_hostname: os.hostname(),
          owner_pid: process.pid,
          ttl_seconds: 45,
          metadata: {
            mode: serviceModeLabel(env),
            project: basename(cwd),
            tmux_session: env.SUPERTURTLE_TMUX_SESSION || null,
          },
        },
        env
      );

      currentSession = persistSessionIfChanged(currentSession, claimResult.session, env);
      leaseClaim = {
        runtimeId,
        lease: claimResult.data.lease,
        controlPlane: getSessionControlPlaneBaseUrl(claimResult.session),
      };
      writeCloudLeaseState(cwd, {
        claimed_at: new Date().toISOString(),
        control_plane: leaseClaim.controlPlane,
        lease: leaseClaim.lease,
        runtime_id: runtimeId,
        tmux_session: env.SUPERTURTLE_TMUX_SESSION || null,
      });
    } catch (error) {
      if (error && typeof error === "object" && error.session) {
        currentSession = persistSessionIfChanged(currentSession, error.session, env);
      }

      const status = error && typeof error === "object" ? error.status : undefined;
      const payload = error && typeof error === "object" ? error.payload : null;
      if (status === 409 && payload && typeof payload === "object" && payload.lease) {
        console.error(
          `Refusing to start: another linked runtime currently owns this bot identity (${formatLeaseOwner(payload.lease)}).`
        );
        clearServicePid(cwd);
        process.exit(1);
      }

      if (isOptionalHostedOwnershipError(error)) {
        console.error(
          `Warning: hosted runtime ownership is unavailable (${error instanceof Error ? error.message : String(error)}). Starting without ownership checks.`
        );
      } else if (isRetryableCloudError(error)) {
        console.error(
          `Warning: control plane could not verify runtime ownership. Starting anyway because ownership could not be checked (${error.message || String(error)}).`
        );
      } else {
        console.error(
          `Failed to claim hosted runtime ownership: ${error instanceof Error ? error.message : String(error)}`
        );
        clearServicePid(cwd);
        process.exit(1);
      }
    }
  }

  const serviceEnv = {
    ...env,
    SUPERTURTLE_RUN_LOOP: "1",
    SUPERTURTLE_LOOP_LOG_PATH: logPaths.loop,
    SUPERTURTLE_RESTART_ON_CRASH: env.SUPERTURTLE_RESTART_ON_CRASH || "1",
  };

  fs.mkdirSync(dirname(logPaths.loop), { recursive: true });
  fs.closeSync(fs.openSync(logPaths.loop, "a"));

  const { keepAwakeCommand, serviceCommand } = buildPlatformServiceCommand({
    cwd,
    logPath: logPaths.loop,
    restartOnCrash: serviceEnv.SUPERTURTLE_RESTART_ON_CRASH,
    platform: process.platform,
  });
  if (process.platform === "darwin" && !keepAwakeCommand) {
    console.warn("Warning: caffeinate not found on macOS. System may sleep during long runs.");
  } else if (process.platform === "linux" && !keepAwakeCommand) {
    console.warn("Warning: systemd-inhibit not found. Running without sleep prevention.");
  }

  console.log(`Starting SuperTurtle ${serviceModeLabel(env)} runner...`);
  console.log(`Loop log: ${logPaths.loop}`);
  if (leaseClaim) {
    console.log(`Hosted runtime ownership: ${leaseClaim.lease.lease_id} epoch ${leaseClaim.lease.lease_epoch}`);
  }

  child = spawn("bash", ["-lc", serviceCommand], buildServiceChildSpawnOptions(serviceEnv));

  const heartbeatLoop = async () => {
    if (!leaseClaim || !currentSession?.access_token || shuttingDown || !child || child.exitCode !== null) {
      return;
    }

    try {
      const result = await heartbeatRuntimeLease(
        currentSession,
        {
          lease_id: leaseClaim.lease.lease_id,
          lease_epoch: leaseClaim.lease.lease_epoch,
          runtime_id: leaseClaim.runtimeId,
          ttl_seconds: 45,
        },
        env
      );
      currentSession = persistSessionIfChanged(currentSession, result.session, env);
      consecutiveHeartbeatFailures = 0;
    } catch (error) {
      if (error && typeof error === "object" && error.session) {
        currentSession = persistSessionIfChanged(currentSession, error.session, env);
      }

      const status = error && typeof error === "object" ? error.status : undefined;
      const payload = error && typeof error === "object" ? error.payload : null;

      if (status === 409) {
        const owner = payload && typeof payload === "object" ? payload.lease : null;
        console.error(
          `Hosted runtime ownership lost to another runtime${owner?.runtime_id ? ` (${owner.runtime_id})` : ""}; stopping.`
        );
        await shutdown("SIGTERM");
        process.exit(1);
      }

      if (status === 401 || status === 403) {
        console.error(`Hosted session rejected (${status}); stopping.`);
        await shutdown("SIGTERM");
        process.exit(1);
      }

      if (!isRetryableCloudError(error)) {
        console.error(`Non-retryable runtime lease error: ${error instanceof Error ? error.message : String(error)}`);
        await shutdown("SIGTERM");
        process.exit(1);
      }

      consecutiveHeartbeatFailures += 1;
      console.error(
        `Transient runtime lease heartbeat failure ${consecutiveHeartbeatFailures}/3: ${error instanceof Error ? error.message : String(error)}`
      );
      if (consecutiveHeartbeatFailures >= 3) {
        console.error("Runtime lease heartbeat failed repeatedly; stopping.");
        await shutdown("SIGTERM");
        process.exit(1);
      }
    }
  };

  const heartbeatTimer = leaseClaim ? setInterval(() => void heartbeatLoop(), 15_000) : null;
  if (heartbeatTimer) {
    heartbeatTimer.unref();
  }

  await new Promise((resolveChild) => {
    child.on("exit", (code, signal) => {
      resolveChild({ code, signal });
    });
  }).then(async ({ code, signal }) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await cleanupLease();
    clearServicePid(cwd);
    if (!shuttingDown && signal) {
      process.exit(1);
    }
    process.exit(typeof code === "number" ? code : 1);
  });
}

async function start() {
  checkBun();
  checkTmux();

  const cwd = getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd);

  if (!projectEnv) {
    console.error("No .superturtle/.env found. Run 'superturtle init' first.");
    process.exit(1);
  }

  const env = {
    ...process.env,
    ...projectEnv,
    SUPER_TURTLE_DIR: PACKAGE_ROOT,
    CLAUDE_WORKING_DIR: cwd,
  };
  const tmuxSession = resolveTmuxSession(cwd, env);
  const logPaths = getLogPaths(cwd, env);

  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    console.log(`Bot is already running. Attaching to tmux session '${tmuxSession}'...`);
    const attachExisting = spawnSync("tmux", ["attach-session", "-t", tmuxSession], { stdio: "inherit" });
    exitFromSpawn(attachExisting, "tmux attach-session");
    return;
  }

  const serviceCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} service run`;
  console.log("Starting Super Turtle bot...");

  const startProc = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      tmuxSession,
      "-e",
      `SUPER_TURTLE_DIR=${PACKAGE_ROOT}`,
      "-e",
      `CLAUDE_WORKING_DIR=${cwd}`,
      "-e",
      `SUPERTURTLE_TMUX_SESSION=${tmuxSession}`,
      ...Object.entries(env)
        .filter(([k]) => shouldPassEnvKey(k))
        .map(([k, v]) => ["-e", `${k}=${v}`])
        .flat(),
      serviceCmd,
    ],
    { stdio: "pipe" }
  );
  exitFromSpawn(startProc, "tmux new-session");

  spawnSync("sleep", ["0.3"], { stdio: "pipe" });
  const aliveCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (aliveCheck.status !== 0) {
    console.error(`Bot session '${tmuxSession}' exited immediately.`);
    if (fs.existsSync(logPaths.loop)) {
      console.error(`Last log lines from ${logPaths.loop}:`);
      const tail = spawnSync("tail", ["-n", "40", logPaths.loop], { stdio: "pipe" });
      const out = tail.stdout?.toString().trim();
      if (out) {
        console.error(out);
      }
    } else {
      console.error(`No loop log found at ${logPaths.loop}`);
    }
    process.exit(1);
  }

  console.log(`Bot started in tmux session '${tmuxSession}'.`);
  console.log(`Loop log: ${logPaths.loop}`);
  const attach = spawnSync("tmux", ["attach-session", "-t", tmuxSession], { stdio: "inherit" });
  exitFromSpawn(attach, "tmux attach-session");
}

async function stop() {
  const cwd = getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd) || {};
  const tmuxSession = resolveTmuxSession(cwd, { ...process.env, ...projectEnv });
  const leaseState = readCloudLeaseState(cwd);
  const servicePid = readServicePid(cwd);
  let stopped = false;

  const tmuxCheck = hasTmux() ? spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" }) : null;
  if (tmuxCheck?.status === 0) {
    spawnSync("tmux", ["kill-session", "-t", tmuxSession], { stdio: "pipe" });
    stopped = true;
  }

  if (servicePid && isPidRunning(servicePid)) {
    signalPid(servicePid, "TERM");
    stopped = true;
  }

  if (stopped) {
    console.log("Bot stop requested.");
  } else {
    console.log("Bot is not running.");
  }

  if (leaseState?.lease?.lease_id && leaseState?.runtime_id) {
    try {
      const session = readSession();
      if (session?.access_token) {
        await releaseRuntimeLease(
          session,
          {
            lease_id: leaseState.lease.lease_id,
            lease_epoch: leaseState.lease.lease_epoch,
            runtime_id: leaseState.runtime_id,
          },
          process.env
        );
      }
    } catch (error) {
      if (!isRetryableCloudError(error) && !isOptionalHostedOwnershipError(error)) {
        console.error(
          `Warning: failed to release hosted runtime ownership: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      clearCloudLeaseState(cwd);
    }
  }

  if (!servicePid || !isPidRunning(servicePid)) {
    clearServicePid(cwd);
  }

  // Stop SubTurtles
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");
  if (fs.existsSync(ctlPath)) {
    const proc = spawnSync(ctlPath, ["stopall"], {
      cwd,
      env: { ...process.env, SUPER_TURTLE_PROJECT_DIR: cwd },
      stdio: "pipe",
    });
    exitFromSpawn(proc, "subturtle ctl stopall");
    if (proc.stdout?.toString().trim()) {
      console.log(proc.stdout.toString().trim());
    }
  }
}

function status() {
  const cwd = getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd) || {};
  const env = { ...process.env, ...projectEnv };
  const tmuxSession = resolveTmuxSession(cwd, env);
  const logPaths = getLogPaths(cwd, env);
  const servicePid = readServicePid(cwd);
  const serviceRunning = servicePid && isPidRunning(servicePid);

  const tmuxCheck = hasTmux() ? spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" }) : null;
  if (tmuxCheck?.status === 0) {
    console.log(`Bot: running (${tmuxSession})`);
  } else if (serviceRunning) {
    console.log(`Bot: running (service pid ${servicePid})`);
  } else {
    console.log(`Bot: stopped (${tmuxSession})`);
  }

  // Check SubTurtles
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");
  printSubturtleList(ctlPath, cwd);

  const cronSummary = readCronSummary(logPaths.cronJobs);
  console.log("\nCron:");
  if (!cronSummary.exists) {
    console.log(`  missing (${logPaths.cronJobs})`);
  } else if (cronSummary.parseError) {
    console.log(`  parse error: ${cronSummary.parseError}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  } else {
    console.log(`  total=${cronSummary.total} due_soon_5m=${cronSummary.dueSoon} overdue=${cronSummary.overdue}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  }

  console.log("\nLogs:");
  printLogSummary("  loop", logPaths.loop);
  printLogSummary("  pino", logPaths.pino);
  printLogSummary("  audit", logPaths.audit);
}

function doctor() {
  const cwd = getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd) || {};
  const env = { ...process.env, ...projectEnv };
  const tmuxSession = resolveTmuxSession(cwd, env);
  const logPaths = getLogPaths(cwd, env);
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");
  const servicePid = readServicePid(cwd);
  const serviceRunning = servicePid && isPidRunning(servicePid);

  console.log(`Project: ${cwd}`);
  console.log(`Token prefix: ${logPaths.tokenPrefix}`);
  console.log(`Session: ${tmuxSession}`);

  const tmuxCheck = hasTmux() ? spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" }) : null;
  if (tmuxCheck?.status === 0) {
    console.log("Bot process: running");
    const details = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", tmuxSession, "#{session_name} windows=#{session_windows} attached=#{session_attached}"],
      { stdio: "pipe" }
    );
    const infoLine = details.stdout?.toString().trim();
    if (infoLine) console.log(`  ${infoLine}`);
  } else if (serviceRunning) {
    console.log("Bot process: running");
    console.log(`  service pid=${servicePid}`);
  } else {
    console.log("Bot process: stopped");
  }

  console.log("");
  printSubturtleList(ctlPath, cwd);

  const cronSummary = readCronSummary(logPaths.cronJobs);
  console.log("\nCron jobs:");
  if (!cronSummary.exists) {
    console.log(`  missing (${logPaths.cronJobs})`);
  } else if (cronSummary.parseError) {
    console.log(`  parse error: ${cronSummary.parseError}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  } else {
    console.log(`  total=${cronSummary.total} due_soon_5m=${cronSummary.dueSoon} overdue=${cronSummary.overdue}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  }

  console.log("\nLogs:");
  printLogSummary("  loop", logPaths.loop);
  printLogSummary("  pino", logPaths.pino);
  printLogSummary("  audit", logPaths.audit);
  printLoopLogErrorHints(logPaths.loop);

  console.log("\nQuick commands:");
  console.log(`  superturtle logs loop`);
  console.log(`  superturtle logs pino --pretty`);
  console.log(`  superturtle logs audit`);
  if (tmuxCheck?.status === 0) {
    console.log(`  tmux attach -t ${tmuxSession}`);
  }
}

function parseLogsArgs(args) {
  const opts = {
    target: "loop",
    follow: true,
    lines: 100,
    pretty: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "loop" || arg === "pino" || arg === "audit") {
      opts.target = arg;
      continue;
    }
    if (arg === "--follow") {
      opts.follow = true;
      continue;
    }
    if (arg === "--no-follow") {
      opts.follow = false;
      continue;
    }
    if (arg === "--pretty") {
      opts.pretty = true;
      continue;
    }
    if (arg === "--lines" || arg === "-n") {
      const next = args[i + 1];
      if (!next || !/^\d+$/.test(next)) {
        throw new Error(`Invalid value for ${arg}. Expected a positive integer.`);
      }
      opts.lines = Math.max(1, Number.parseInt(next, 10));
      i += 1;
      continue;
    }
    throw new Error(`Unknown logs argument: ${arg}`);
  }

  return opts;
}

function logs() {
  const cwd = getBoundProjectRoot(process.cwd());
  migrateLegacyRuntimeLayout(cwd);
  const projectEnv = loadProjectEnv(cwd) || {};
  const env = { ...process.env, ...projectEnv };
  const logPaths = getLogPaths(cwd, env);
  const args = process.argv.slice(3);
  let opts;
  try {
    opts = parseLogsArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: superturtle logs [loop|pino|audit] [--pretty] [--lines N] [--follow|--no-follow]");
    process.exit(1);
  }

  const path = logPaths[opts.target];
  if (!fs.existsSync(path) && opts.follow) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.closeSync(fs.openSync(path, "a"));
  }
  if (!fs.existsSync(path)) {
    console.error(`Log file not found: ${path}`);
    process.exit(1);
  }

  if (opts.pretty && opts.target !== "pino") {
    console.error("--pretty is only supported for pino logs.");
    process.exit(1);
  }

  if (opts.pretty) {
    const followFlag = opts.follow ? "-F" : "";
    const cmd = `tail -n ${opts.lines} ${followFlag} "${path}" | npx --yes pino-pretty -c`;
    const proc = spawnSync("bash", ["-lc", cmd], {
      cwd: BOT_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR || "1",
        NO_COLOR: "",
      },
    });
    exitFromSpawn(proc, "pretty log tail");
    return;
  }

  const tailArgs = ["-n", String(opts.lines)];
  if (opts.follow) tailArgs.push("-F");
  tailArgs.push(path);
  const proc = spawnSync("tail", tailArgs, { stdio: "inherit" });
  exitFromSpawn(proc, "tail");
}

function parseCloudArgs(args, parseOptions = {}) {
  const options = {
    openBrowser: true,
    plan: "managed",
  };
  const allowPlan = Boolean(parseOptions.allowPlan);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-browser") {
      options.openBrowser = false;
      continue;
    }
    if (arg === "--browser") {
      options.openBrowser = true;
      continue;
    }
    if (arg === "--plan" && allowPlan) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --plan");
      }
      options.plan = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown cloud argument: ${arg}`);
  }

  return options;
}

function extractTokenFromCredentialPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  const candidates = [];
  try {
    const parsed = JSON.parse(trimmed);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (
          typeof child === "string" &&
          ["accessToken", "access_token", "oauthAccessToken", "token"].includes(key)
        ) {
          candidates.push(child.trim());
        } else {
          visit(child);
        }
      }
    };
    visit(parsed);
  } catch {
    candidates.push(trimmed);
  }

  return candidates.find((candidate) => candidate.length > 0) || null;
}

function readClaudeAccessTokenFromFile(path) {
  try {
    if (!fs.existsSync(path)) return null;
    return extractTokenFromCredentialPayload(fs.readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function discoverClaudeAccessToken() {
  const envCandidates = [
    process.env.SUPERTURTLE_CLAUDE_ACCESS_TOKEN,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ];
  for (const candidate of envCandidates) {
    const token = extractTokenFromCredentialPayload(candidate);
    if (token) return token;
  }

  const user = process.env.USER || "unknown";
  if (process.platform === "darwin") {
    const attempts = [
      ["security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", user, "-w"]],
      ["security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]],
    ];
    for (const [command, args] of attempts) {
      const result = spawnSync(command, args, { stdio: "pipe" });
      if (result.status === 0) {
        const token = extractTokenFromCredentialPayload(result.stdout.toString("utf-8"));
        if (token) return token;
      }
    }
  }

  if (process.platform === "linux" && spawnSync("sh", ["-c", "command -v secret-tool"], { stdio: "ignore" }).status === 0) {
    const attempts = [
      ["secret-tool", ["lookup", "service", "Claude Code-credentials", "username", user]],
      ["secret-tool", ["lookup", "service", "Claude Code-credentials"]],
    ];
    for (const [command, args] of attempts) {
      const result = spawnSync(command, args, { stdio: "pipe" });
      if (result.status === 0) {
        const token = extractTokenFromCredentialPayload(result.stdout.toString("utf-8"));
        if (token) return token;
      }
    }
  }

  const home = process.env.HOME || "";
  const fileCandidates = [
    resolve(home, ".config", "claude-code", "credentials.json"),
    resolve(home, ".claude", "credentials.json"),
  ];
  for (const path of fileCandidates) {
    const token = readClaudeAccessTokenFromFile(path);
    if (token) return token;
  }

  return null;
}

function parseClaudeSetupArgs(args) {
  const options = {
    tokenEnv: null,
    tokenFile: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--token-env") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --token-env");
      }
      options.tokenEnv = value;
      index += 1;
      continue;
    }
    if (arg === "--token-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --token-file");
      }
      options.tokenFile = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown cloud Claude setup argument: ${arg}`);
  }

  return options;
}

function resolveClaudeSetupToken(options) {
  if (options.tokenEnv) {
    return extractTokenFromCredentialPayload(process.env[options.tokenEnv] || "");
  }
  if (options.tokenFile) {
    return readClaudeAccessTokenFromFile(resolve(options.tokenFile));
  }
  return discoverClaudeAccessToken();
}

async function login() {
  let options;
  try {
    options = parseCloudArgs(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: superturtle login [--browser|--no-browser]");
    process.exit(1);
  }

  const started = await startLogin();
  const verificationUrl = started.verification_uri_complete || started.verification_uri;
  if (!verificationUrl || !started.device_code) {
    throw new Error("Control plane login response is missing verification URL or device code.");
  }

  console.log(`Control plane: ${getControlPlaneBaseUrl()}`);
  console.log(`Session file: ${getSessionPath()}`);
  console.log(`Open this URL to sign in: ${verificationUrl}`);
  if (started.user_code) {
    console.log(`Verification code: ${started.user_code}`);
  }

  if (options.openBrowser) {
    const opened = openBrowser(verificationUrl, process.env);
    console.log(opened ? "Browser opened." : "Browser open failed; continue in any browser.");
  }

  console.log("Waiting for login completion...");
  const completed = await pollLogin(started);
  const createdAt = new Date().toISOString();
  const session = {
    access_token: completed.access_token,
    refresh_token: completed.refresh_token || null,
    expires_at: completed.expires_at || null,
    user: completed.user || null,
    workspace: completed.workspace || null,
    entitlement: completed.entitlement || null,
    instance: completed.instance || null,
    provisioning_job: completed.provisioning_job || null,
    control_plane: getControlPlaneBaseUrl(),
    created_at: createdAt,
    identity_sync_at:
      completed.user || completed.workspace || completed.entitlement ? createdAt : null,
    cloud_status_sync_at: completed.instance || completed.provisioning_job ? createdAt : null,
    last_sync_at: createdAt,
  };
  const path = writeSession(session);
  console.log(`Logged in. Session saved to ${path}`);
  if (session.user?.email) {
    console.log(`Signed in as ${session.user.email}`);
  }
}

async function whoami() {
  let session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  let identity = null;
  try {
    const result = await fetchWhoAmI(session);
    identity = result.data;
    const mergedSession = mergeSessionSnapshot(
      result.session,
      identity,
      getSessionControlPlaneBaseUrl(result.session)
    );
    session = persistSessionIfChanged(session, mergedSession);
  } catch (error) {
    if (error && typeof error === "object" && error.session) {
      session = persistSessionIfChanged(session, error.session);
    }
    if (!isRetryableCloudError(error) || !hasCachedSnapshot(session, ["user", "workspace", "entitlement"])) {
      throw error;
    }
    identity = {
      user: session.user || null,
      workspace: session.workspace || null,
      entitlement: session.entitlement || null,
    };
    console.error(
      `Control plane unreachable; using cached identity snapshot from ${session.identity_sync_at || session.last_sync_at || session.created_at || "unknown time"}.`
    );
  }

  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(session)}`);
  if (identity.user?.email) console.log(`User: ${identity.user.email}`);
  if (identity.user?.id) console.log(`User ID: ${identity.user.id}`);
  if (identity.workspace?.slug) console.log(`Workspace: ${identity.workspace.slug}`);
  if (identity.entitlement?.plan) console.log(`Plan: ${identity.entitlement.plan}`);
  if (identity.entitlement?.state) console.log(`Entitlement: ${identity.entitlement.state}`);
}

async function cloudStatus() {
  let session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  let status = null;
  try {
    const result = await fetchCloudStatus(session);
    status = result.data;
    const mergedSession = mergeSessionSnapshot(
      result.session,
      status,
      getSessionControlPlaneBaseUrl(result.session)
    );
    session = persistSessionIfChanged(session, mergedSession);
  } catch (error) {
    if (error && typeof error === "object" && error.session) {
      session = persistSessionIfChanged(session, error.session);
    }
    if (!isRetryableCloudError(error) || !hasCachedSnapshot(session, ["instance", "provisioning_job"])) {
      throw error;
    }
    status = {
      instance: session.instance || null,
      provisioning_job: session.provisioning_job || null,
    };
    console.error(
      `Control plane unreachable; using cached cloud status snapshot from ${session.cloud_status_sync_at || session.last_sync_at || session.created_at || "unknown time"}.`
    );
  }

  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(session)}`);
  printManagedInstanceSummary(status.instance);
  if (status.provisioning_job?.state) console.log(`Provisioning: ${status.provisioning_job.state}`);
  if (status.provisioning_job?.updated_at) console.log(`Provisioning updated: ${status.provisioning_job.updated_at}`);
}

async function cloudResume() {
  let session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  const result = await resumeManagedInstance(session);
  const mergedSession = mergeSessionSnapshot(
    result.session,
    result.data,
    getSessionControlPlaneBaseUrl(result.session)
  );
  session = persistSessionIfChanged(session, mergedSession);

  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(session)}`);
  printManagedInstanceSummary(result.data.instance);
  if (result.data.provisioning_job?.state) console.log(`Provisioning: ${result.data.provisioning_job.state}`);
  if (result.data.provisioning_job?.updated_at) {
    console.log(`Provisioning updated: ${result.data.provisioning_job.updated_at}`);
  }
}

async function cloudCheckout() {
  let options;
  try {
    options = parseCloudArgs(process.argv.slice(4), { allowPlan: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: superturtle cloud checkout [--plan <plan>]");
    process.exit(1);
  }

  let session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  const result = await createStripeCheckoutSession(session, { plan: options.plan });
  session = persistSessionIfChanged(session, result.session);

  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(session)}`);
  if (result.data.plan) console.log(`Plan: ${result.data.plan}`);
  if (result.data.customer_id) console.log(`Customer: ${result.data.customer_id}`);
  if (result.data.subscription_id) console.log(`Subscription: ${result.data.subscription_id}`);
  console.log(`Checkout URL: ${result.data.checkout_url}`);
}

async function cloudPortal() {
  let session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  const result = await createStripeCustomerPortalSession(session);
  session = persistSessionIfChanged(session, result.session);

  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(session)}`);
  if (result.data.customer_id) console.log(`Customer: ${result.data.customer_id}`);
  if (result.data.portal_session_id) console.log(`Portal session: ${result.data.portal_session_id}`);
  console.log(`Portal URL: ${result.data.portal_url}`);
}

async function cloudClaudeStatus() {
  const session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  const result = await fetchClaudeAuthStatus(session);
  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(result.session)}`);
  console.log(`Provider: ${result.data.provider}`);
  console.log(`Configured: ${result.data.configured ? "yes" : "no"}`);
  if (result.data.credential?.state) console.log(`State: ${result.data.credential.state}`);
  if (result.data.credential?.account_email) {
    console.log(`Claude account: ${result.data.credential.account_email}`);
  }
  if (result.data.credential?.last_validated_at) {
    console.log(`Last validated: ${result.data.credential.last_validated_at}`);
  }
}

async function cloudClaudeSetup() {
  let options;
  try {
    options = parseClaudeSetupArgs(process.argv.slice(5));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: superturtle cloud claude setup [--token-env <env-var>|--token-file <path>]");
    process.exit(1);
  }

  const session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  const claudeAccessToken = resolveClaudeSetupToken(options);
  if (!claudeAccessToken) {
    throw new Error(
      "No local Claude access token was found. Run Claude login locally or pass --token-env/--token-file."
    );
  }

  const result = await setupClaudeAuth(session, claudeAccessToken);
  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(result.session)}`);
  console.log(`Provider: ${result.data.provider}`);
  console.log(`Configured: ${result.data.configured ? "yes" : "no"}`);
  if (result.data.credential?.state) console.log(`State: ${result.data.credential.state}`);
  if (result.data.credential?.account_email) {
    console.log(`Claude account: ${result.data.credential.account_email}`);
  }
  if (result.data.credential?.last_validated_at) {
    console.log(`Last validated: ${result.data.credential.last_validated_at}`);
  }
}

async function cloudClaudeRevoke() {
  const session = readSession();
  if (!session?.access_token) {
    console.error(`Not logged in. Run 'superturtle login'. Expected session file at ${getSessionPath()}`);
    process.exit(1);
  }

  const result = await revokeClaudeAuth(session);
  console.log(`Control plane: ${getSessionControlPlaneBaseUrl(result.session)}`);
  console.log(`Provider: ${result.data.provider}`);
  console.log(`Configured: ${result.data.configured ? "yes" : "no"}`);
  if (result.data.credential?.state) console.log(`State: ${result.data.credential.state}`);
  if (result.data.credential?.account_email) {
    console.log(`Claude account: ${result.data.credential.account_email}`);
  }
}

function logout() {
  const path = clearSession();
  console.log(`Removed local cloud session at ${path}`);
}

function printManagedAuthUnavailable(commandName) {
  console.error(
    `${commandName} is not enabled in this cycle. Use BYO E2B for teleport for now; hosted account commands will come back when managed mode is ready.`
  );
  process.exit(1);
}

if (require.main === module) {
  // Dispatch command
  const command = process.argv[2];

  switch (command) {
    case "init":
      init().catch((err) => { console.error(err); process.exit(1); });
      break;
    case "start":
      start().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
      break;
    case "service":
      if (process.argv[3] === "run") {
        serviceRun().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
        break;
      }
      if (process.argv[3] === "stop-tree") {
        serviceStopTree().catch((err) => {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        });
        break;
      }
      if (process.argv[3] === "self-update-runner") {
        serviceSelfUpdateRunner().catch((err) => {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        });
        break;
      }
      console.error("Usage: superturtle service run | superturtle service stop-tree [--cwd <project>] | superturtle service self-update-runner --cwd <project> --spec superturtle@<exact-version>");
      process.exit(1);
      break;
    case "stop":
      stop().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
      break;
    case "status":
      status();
      break;
    case "doctor":
      doctor();
      break;
    case "logs":
      logs();
      break;
    case "login":
      printManagedAuthUnavailable("superturtle login");
      break;
    case "whoami":
      printManagedAuthUnavailable("superturtle whoami");
      break;
    case "cloud":
      if (process.argv[3] === "claude") {
        if (process.argv[4] === "status") {
          cloudClaudeStatus().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
          break;
        }
        if (process.argv[4] === "setup") {
          cloudClaudeSetup().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
          break;
        }
        if (process.argv[4] === "revoke") {
          cloudClaudeRevoke().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
          break;
        }
        console.error("Usage: superturtle cloud claude <status|setup|revoke>");
        process.exit(1);
        break;
      }
      if (process.argv[3] === "status") {
        cloudStatus().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
        break;
      }
      if (process.argv[3] === "checkout") {
        cloudCheckout().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
        break;
      }
      if (process.argv[3] === "portal") {
        cloudPortal().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
        break;
      }
      if (process.argv[3] === "resume") {
        cloudResume().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
        break;
      }
      console.error("Usage: superturtle cloud <status|resume|checkout|portal|claude>");
      process.exit(1);
      break;
    case "logout":
      printManagedAuthUnavailable("superturtle logout");
      break;
    case "--version":
    case "-v":
      try {
        const pkg = JSON.parse(fs.readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8"));
        console.log(`superturtle v${pkg.version}`);
      } catch {
        console.log("superturtle (unknown version)");
      }
      break;
    default:
      console.log(`superturtle - Code from anywhere

Usage: superturtle <command>

Commands:
  init      Set up superturtle in the bound project repo
  cloud     Hosted cloud commands (status, resume, checkout, portal, claude)
  start     Launch the interactive tmux session and attach immediately
  service   Foreground service commands
  stop      Stop the bot and all SubTurtles
  status    Show bot and SubTurtle status
  doctor    Full process + log observability snapshot
  logs      Tail logs (loop|pino|audit)

Init flags (for non-interactive / agent use):
  --token <token>       Telegram bot token
  --user <id>           Optional Telegram user ID bootstrap
  --openai-key <key>    OpenAI API key (optional)
  --create-git          Explicitly run git init if no repo exists

Options:
  -v, --version  Show version

Logs:
  superturtle logs loop
  superturtle logs pino --pretty
  superturtle logs audit --no-follow -n 200

Service:
  superturtle service run
  superturtle service stop-tree --cwd <project>
  superturtle service self-update-runner --cwd <project> --spec superturtle@<exact-version>

Cloud:
  superturtle cloud status
  superturtle cloud resume
  superturtle cloud checkout
  superturtle cloud portal
  superturtle cloud claude status
  superturtle cloud claude setup
  superturtle cloud claude revoke`);
      if (command && command !== "help" && command !== "--help" && command !== "-h") {
        process.exit(1);
      }
  }
}

module.exports = {
  __test__: {
    buildServiceCommand,
    buildPlatformServiceCommand,
    getKeepAwakeCommand,
    buildServiceChildSpawnOptions,
    terminateChildProcessGroup,
    parseExactRuntimeInstallSpec,
    parseSelfUpdateRunnerArgs,
    collectDescendantProcessIds,
    collectAncestorProcessIds,
    expandTrackedProcessIds,
    discoverTrackedRuntimePids,
    getInstanceLockPathForEnv,
    inspectInstanceLock,
    parseServiceStopTreeArgs,
    removeStaleInstanceLock,
    removeStaleServicePid,
    serviceStopTree,
    waitForServiceRunnerShutdown,
    waitForReplacementServiceRunner,
  },
};
