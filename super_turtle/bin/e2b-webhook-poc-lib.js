"use strict";

const fs = require("fs");
const os = require("os");
const { dirname, join, resolve } = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const {
  fetchTeleportTarget,
  mergeSessionSnapshot,
  persistSessionIfChanged,
  readSession,
  resumeManagedInstance,
} = require("./cloud.js");

const TELEPORT_STATE_RELATIVE_PATH = join(".superturtle", "teleport-state.json");
const LEGACY_POC_STATE_RELATIVE_PATH = join(".superturtle", "e2b-webhook-poc.json");
const PROJECT_CONFIG_RELATIVE_PATH = join(".superturtle", "project.json");
const PROJECT_ENV_RELATIVE_PATH = join(".superturtle", ".env");
const TELEGRAM_OWNER_RELATIVE_PATH = join(".superturtle", "telegram-owner.json");
const LEGACY_SUBTURTLES_RELATIVE_PATH = ".subturtles";
const SUBTURTLES_RELATIVE_PATH = join(".superturtle", "subturtles");
const TELEPORT_RUNTIME_RELATIVE_PATH = join(".superturtle", "teleport");
const LEGACY_TELEPORT_RUNTIME_RELATIVE_PATH = join("-s", ".superturtle", "teleport");
const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_REMOTE_HOME = "/home/user";
const DEFAULT_LOG_PATH = "/tmp/superturtle-e2b-bot.log";
const DEFAULT_PID_PATH = "/tmp/superturtle-e2b-bot.pid";
const DEFAULT_TEMPLATE_NAME =
  process.env.SUPERTURTLE_E2B_TEMPLATE_NAME?.trim() || "superturtle-managed-runtime";
const DEFAULT_TEMPLATE_CHANNEL =
  process.env.SUPERTURTLE_E2B_TEMPLATE_CHANNEL?.trim() || "latest";
const DEFAULT_TEMPLATE_REF = `${DEFAULT_TEMPLATE_NAME}:${DEFAULT_TEMPLATE_CHANNEL}`;
const DEFAULT_OWNER_MODE = "local";
const DEFAULT_REMOTE_MODE = "control";
const DEFAULT_REMOTE_CODEX_AUTH_PATH = join(".codex", "auth.json");
const DEFAULT_REMOTE_PROJECT_ENV_PATH = join(".superturtle", ".env");
const MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH = join(".superturtle", "managed-runtime.json");
const DEFAULT_CLAUDE_CREDENTIAL_PATHS = [
  join(".config", "claude-code", "credentials.json"),
  join(".claude", "credentials.json"),
];

async function emitProgress(options, stage, extra = {}) {
  if (!options || typeof options.onProgress !== "function") {
    return;
  }
  await options.onProgress({ stage, ...extra });
}

function normalizeExistingPath(path) {
  try {
    return fs.realpathSync(path);
  } catch {
    return resolve(path);
  }
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

  const gitRoot = findGitRoot(startDir);
  if (gitRoot) {
    return gitRoot;
  }

  return normalizeExistingPath(startDir);
}

function removeDirIfEmpty(pathname) {
  try {
    fs.rmdirSync(pathname);
  } catch {}
}

function migrateLegacyRuntimeLayout(projectRoot) {
  const subturtlesDir = resolve(projectRoot, SUBTURTLES_RELATIVE_PATH);
  const legacySubturtlesDir = resolve(projectRoot, LEGACY_SUBTURTLES_RELATIVE_PATH);
  const teleportDir = resolve(projectRoot, TELEPORT_RUNTIME_RELATIVE_PATH);
  const legacyTeleportDir = resolve(projectRoot, LEGACY_TELEPORT_RUNTIME_RELATIVE_PATH);

  fs.mkdirSync(resolve(projectRoot, ".superturtle"), { recursive: true });

  if (fs.existsSync(legacySubturtlesDir)) {
    if (fs.existsSync(subturtlesDir)) {
      throw new Error(
        `Cannot migrate legacy SubTurtle workspaces because both ${legacySubturtlesDir} and ${subturtlesDir} exist.`
      );
    }
    fs.mkdirSync(dirname(subturtlesDir), { recursive: true });
    fs.renameSync(legacySubturtlesDir, subturtlesDir);
  }

  if (fs.existsSync(legacyTeleportDir)) {
    if (fs.existsSync(teleportDir)) {
      throw new Error(
        `Cannot migrate legacy teleport runtime files because both ${legacyTeleportDir} and ${teleportDir} exist.`
      );
    }
    fs.mkdirSync(dirname(teleportDir), { recursive: true });
    fs.renameSync(legacyTeleportDir, teleportDir);
    removeDirIfEmpty(resolve(projectRoot, "-s", ".superturtle"));
    removeDirIfEmpty(resolve(projectRoot, "-s"));
  }
}

function getStateFilePath(projectRoot) {
  return resolve(projectRoot, TELEPORT_STATE_RELATIVE_PATH);
}

function getLegacyPocStateFilePath(projectRoot) {
  return resolve(projectRoot, LEGACY_POC_STATE_RELATIVE_PATH);
}

function loadPocState(projectRoot) {
  const statePath = getStateFilePath(projectRoot);
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  }
  const legacyStatePath = getLegacyPocStateFilePath(projectRoot);
  if (!fs.existsSync(legacyStatePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(legacyStatePath, "utf-8"));
}

function savePocState(projectRoot, state) {
  const statePath = getStateFilePath(projectRoot);
  fs.mkdirSync(dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return statePath;
}

function parseDotEnv(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function serializeDotEnv(env) {
  const lines = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (!key || rawValue == null) {
      continue;
    }
    const value = String(rawValue);
    if (/^[A-Za-z0-9_./:@%+,=?-]+$/.test(value)) {
      lines.push(`${key}=${value}`);
      continue;
    }
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function extractTokenFromCredentialPayload(rawValue) {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!trimmed) {
    return null;
  }

  const candidates = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      const candidate = value.trim();
      if (candidate) {
        candidates.push(candidate);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };

  try {
    visit(JSON.parse(trimmed));
  } catch {
    candidates.push(trimmed);
  }

  return candidates.find((candidate) => candidate.length > 0) || null;
}

function readClaudeAccessTokenFromFile(path) {
  try {
    if (!path || !fs.existsSync(path)) {
      return null;
    }
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
    if (token) {
      return token;
    }
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
        if (token) {
          return token;
        }
      }
    }
  }

  if (
    process.platform === "linux" &&
    spawnSync("sh", ["-c", "command -v secret-tool"], { stdio: "ignore" }).status === 0
  ) {
    const attempts = [
      ["secret-tool", ["lookup", "service", "Claude Code-credentials", "username", user]],
      ["secret-tool", ["lookup", "service", "Claude Code-credentials"]],
    ];
    for (const [command, args] of attempts) {
      const result = spawnSync(command, args, { stdio: "pipe" });
      if (result.status === 0) {
        const token = extractTokenFromCredentialPayload(result.stdout.toString("utf-8"));
        if (token) {
          return token;
        }
      }
    }
  }

  const home = process.env.HOME || os.homedir();
  for (const relativePath of DEFAULT_CLAUDE_CREDENTIAL_PATHS) {
    const token = readClaudeAccessTokenFromFile(resolve(home, relativePath));
    if (token) {
      return token;
    }
  }

  return null;
}

function getLocalCodexAuthSourcePath() {
  const override = process.env.SUPERTURTLE_TELEPORT_CODEX_AUTH_PATH;
  if (override && override.trim()) {
    return normalizeExistingPath(override.trim());
  }
  const home = process.env.HOME || os.homedir();
  return resolve(home, DEFAULT_REMOTE_CODEX_AUTH_PATH);
}

function hasLocalCodexAuth(path = getLocalCodexAuthSourcePath()) {
  try {
    return !!path && fs.existsSync(path) && fs.statSync(path).size > 0;
  } catch {
    return false;
  }
}

function buildLocalAuthBootstrap(projectEnv = {}) {
  const claudeAccessToken =
    extractTokenFromCredentialPayload(projectEnv.CLAUDE_CODE_OAUTH_TOKEN) ||
    discoverClaudeAccessToken();
  const codexAuthSourcePath = hasLocalCodexAuth() ? getLocalCodexAuthSourcePath() : null;
  return {
    claudeAccessToken,
    codexAuthSourcePath,
  };
}

function loadProjectEnv(projectRoot) {
  migrateLegacyRuntimeLayout(projectRoot);
  const envPath = resolve(projectRoot, PROJECT_ENV_RELATIVE_PATH);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing project env file at ${envPath}. Run 'superturtle init' first.`);
  }
  return parseDotEnv(fs.readFileSync(envPath, "utf-8"));
}

function loadTelegramOwnerState(projectRoot) {
  const ownerPath = resolve(projectRoot, TELEGRAM_OWNER_RELATIVE_PATH);
  if (!fs.existsSync(ownerPath)) {
    return null;
  }
  return fs.readFileSync(ownerPath, "utf-8");
}

function loadRuntimeEnv(projectRoot) {
  try {
    return loadProjectEnv(projectRoot);
  } catch {
    return Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === "string")
    );
  }
}

function getLocalRuntimeVersion() {
  const packageJsonPath = resolve(__dirname, "..", "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    if (parsed && typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {}
  return "0.0.0-dev";
}

function deriveRuntimeVersionFromInstallSpec(installSpec) {
  const trimmed = String(installSpec || "").trim();
  if (!trimmed) {
    return "";
  }
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return "";
  }
  const candidate = trimmed.slice(atIndex + 1).trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate) ? candidate : "";
}

async function resolveManagedTeleportTarget(env = process.env) {
  let session = null;
  try {
    session = readSession(env);
  } catch {
    return null;
  }
  if (!session?.access_token) {
    return null;
  }

  let activeSession = session;
  if (
    activeSession.instance?.state &&
    ["stopped", "suspended"].includes(String(activeSession.instance.state))
  ) {
    const resumed = await resumeManagedInstance(activeSession, env);
    activeSession = persistSessionIfChanged(
      activeSession,
      mergeSessionSnapshot(
        resumed.session,
        resumed.data
      ),
      env
    );
  }

  const target = await fetchTeleportTarget(activeSession, env);
  persistSessionIfChanged(
    activeSession,
    mergeSessionSnapshot(target.session, target.data),
    env
  );
  return target.data;
}

function randomToken(length = 24) {
  return crypto.randomBytes(length).toString("hex");
}

function normalizePath(pathname) {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.replace(/\/{2,}/g, "/");
}

function buildPocConfig(projectRoot, options = {}, existingState = null) {
  const repoName = projectRoot.split("/").filter(Boolean).pop() || "project";
  const port = Number.parseInt(String(options.port || existingState?.port || DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port ${String(options.port || existingState?.port || DEFAULT_PORT)}.`);
  }

  const timeoutMs = Number.parseInt(
    String(options.timeoutMs || existingState?.timeoutMs || DEFAULT_TIMEOUT_MS),
    10
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeoutMs ${String(options.timeoutMs || existingState?.timeoutMs || DEFAULT_TIMEOUT_MS)}.`);
  }

  const healthPath = normalizePath(
    options.healthPath || existingState?.healthPath || DEFAULT_HEALTH_PATH
  );
  const readyPath = normalizePath(
    options.readyPath || existingState?.readyPath || DEFAULT_READY_PATH
  );
  const remoteRoot = options.remoteRoot || existingState?.remoteRoot || `${DEFAULT_REMOTE_HOME}/${repoName}`;
  const templateId =
    options.templateId ||
    existingState?.templateId ||
    DEFAULT_TEMPLATE_REF;
  const templateVersion =
    options.templateVersion ||
    existingState?.templateVersion ||
    DEFAULT_TEMPLATE_CHANNEL;
  const runtimeInstallSpec =
    options.runtimeInstallSpec ||
    existingState?.runtimeInstallSpec ||
    process.env.SUPERTURTLE_RUNTIME_INSTALL_SPEC?.trim() ||
    `superturtle@${getLocalRuntimeVersion()}`;
  const runtimeVersion =
    options.runtimeVersion ||
    existingState?.runtimeVersion ||
    deriveRuntimeVersionFromInstallSpec(runtimeInstallSpec) ||
    getLocalRuntimeVersion();
  const webhookSecret = options.webhookSecret || existingState?.webhookSecret || randomToken(16);
  const remoteMode = options.remoteMode || existingState?.remoteMode || DEFAULT_REMOTE_MODE;
  if (remoteMode !== "control" && remoteMode !== "agent") {
    throw new Error(`Invalid remoteMode ${String(remoteMode)}.`);
  }
  const remoteDriver =
    remoteMode === "agent"
      ? options.remoteDriver || existingState?.remoteDriver || "codex"
      : null;
  if (remoteDriver && remoteDriver !== "codex") {
    throw new Error(`Invalid remoteDriver ${String(remoteDriver)}.`);
  }
  const webhookPath = normalizePath(
    options.webhookPath ||
      existingState?.webhookPath ||
      `/telegram/webhook/${randomToken(8)}`
  );
  const logPath = options.logPath || existingState?.logPath || DEFAULT_LOG_PATH;
  const pidPath = options.pidPath || existingState?.pidPath || DEFAULT_PID_PATH;

  return {
    port,
    timeoutMs,
    healthPath,
    readyPath,
    remoteRoot,
    templateId,
    templateVersion,
    runtimeInstallSpec,
    runtimeVersion,
    remoteMode,
    remoteDriver,
    webhookSecret,
    webhookPath,
    logPath,
    pidPath,
  };
}

function buildWebhookUrl(host, webhookPath) {
  return `https://${host}${normalizePath(webhookPath)}`;
}

function buildHealthUrl(host, healthPath) {
  return `https://${host}${normalizePath(healthPath)}`;
}

function buildReadyUrl(host, readyPath) {
  return `https://${host}${normalizePath(readyPath)}`;
}

function buildRemoteEnv(
  projectEnv,
  remoteRoot,
  webhookUrl,
  webhookSecret,
  port,
  healthPath,
  readyPath,
  remoteMode,
  remoteDriver,
  authBootstrap = {}
) {
  const env = {
    ...projectEnv,
    CLAUDE_WORKING_DIR: remoteRoot,
    SUPERTURTLE_RUNTIME_PROFILE: "managed",
    SUPERTURTLE_DRIVER: remoteDriver || "codex",
    TELEGRAM_TRANSPORT: "webhook",
    TELEGRAM_WEBHOOK_REGISTER: "false",
    TELEGRAM_WEBHOOK_URL: webhookUrl,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_WEBHOOK_HEALTH_PATH: healthPath,
    TELEGRAM_WEBHOOK_READY_PATH: readyPath,
    PORT: String(port),
    TURTLE_GREETINGS: "false",
  };
  const claudeAccessToken =
    extractTokenFromCredentialPayload(env.CLAUDE_CODE_OAUTH_TOKEN) ||
    authBootstrap.claudeAccessToken ||
    null;
  if (claudeAccessToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = claudeAccessToken;
  }
  const requiredKeys = ["TELEGRAM_BOT_TOKEN"];
  for (const key of requiredKeys) {
    if (!env[key] || !String(env[key]).trim()) {
      throw new Error(`Missing required env ${key} in project config.`);
    }
  }

  return env;
}

function buildStateRecord(projectRoot, sandboxId, host, config, ownerMode = DEFAULT_OWNER_MODE) {
  return {
    version: 1,
    repoRoot: projectRoot,
    ownerMode,
    managed: Boolean(config.templateId),
    remoteMode: config.remoteMode || DEFAULT_REMOTE_MODE,
    remoteDriver: config.remoteDriver || null,
    sandboxId,
    templateId: config.templateId || null,
    templateVersion: config.templateVersion || null,
    runtimeInstallSpec: config.runtimeInstallSpec || null,
    runtimeVersion: config.runtimeVersion || null,
    host,
    port: config.port,
    timeoutMs: config.timeoutMs,
    remoteRoot: config.remoteRoot,
    webhookPath: config.webhookPath,
    webhookSecret: config.webhookSecret,
    webhookUrl: buildWebhookUrl(host, config.webhookPath),
    healthPath: config.healthPath,
    healthUrl: buildHealthUrl(host, config.healthPath),
    readyPath: config.readyPath,
    readyUrl: buildReadyUrl(host, config.readyPath),
    logPath: config.logPath,
    pidPath: config.pidPath,
    updatedAt: new Date().toISOString(),
  };
}

function formatStateSummary(state) {
  const lines = [
    `Owner mode: ${state.ownerMode || DEFAULT_OWNER_MODE}`,
    `Remote mode: ${state.remoteMode || DEFAULT_REMOTE_MODE}`,
    `Sandbox: ${state.sandboxId}`,
    `Managed target: ${state.managed ? "yes" : "no"}`,
    `Template: ${state.templateId || "<unset>"}`,
    `Template version: ${state.templateVersion || "<unset>"}`,
    `Runtime install spec: ${state.runtimeInstallSpec || "<unset>"}`,
    `Runtime version: ${state.runtimeVersion || "<unset>"}`,
    `Webhook URL: ${state.webhookUrl}`,
    `Health URL: ${state.healthUrl}`,
    `Ready URL: ${state.readyUrl}`,
    `Remote root: ${state.remoteRoot}`,
    `Remote log: ${state.logPath}`,
  ];
  if (state.updatedAt) {
    lines.push(`Updated: ${state.updatedAt}`);
  }
  return lines.join("\n");
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildRemoteBootstrapCommand(config, options = {}) {
  const bunInstallSnippet =
    "if ! command -v bun >/dev/null 2>&1; then " +
    "curl -fsSL https://bun.sh/install | bash >/tmp/superturtle-e2b-bun-install.log 2>&1; " +
    "fi";
  const shouldResetRemoteRoot = options.resetRemoteRoot !== false;

  const commands = [
    "set -euo pipefail",
    bunInstallSnippet,
    "export BUN_INSTALL=\"$HOME/.bun\" PATH=\"$HOME/.bun/bin:$HOME/.local/bin:$PATH\"",
  ];

  if (shouldResetRemoteRoot) {
    commands.push(`rm -rf ${shellEscape(config.remoteRoot)}`);
  }

  commands.push(
    `mkdir -p ${shellEscape(config.remoteRoot)}`,
    `mkdir -p ${shellEscape(`${config.remoteRoot}/.superturtle`)}`,
    `bun install -g ${shellEscape(config.runtimeInstallSpec)} >/tmp/superturtle-e2b-runtime-install.log 2>&1`,
    "command -v superturtle >/dev/null 2>&1"
  );

  return commands.join(" && ");
}

function buildRemoteAuthFinalizeCommand(config) {
  const remoteProjectEnvPath = `${config.remoteRoot}/${DEFAULT_REMOTE_PROJECT_ENV_PATH}`;
  const remoteCodexAuthPath = `${DEFAULT_REMOTE_HOME}/${DEFAULT_REMOTE_CODEX_AUTH_PATH}`;

  return [
    "set -euo pipefail",
    "export PATH=\"$HOME/.bun/bin:$HOME/.local/bin:$PATH\"",
    "mkdir -p \"$HOME/.local/bin\" \"$HOME/.codex\" \"$HOME/.claude\"",
    "chmod 700 \"$HOME/.codex\" \"$HOME/.claude\"",
    `if [ -f ${shellEscape(remoteProjectEnvPath)} ]; then chmod 600 ${shellEscape(remoteProjectEnvPath)}; fi`,
    `if [ -f ${shellEscape(remoteCodexAuthPath)} ]; then chmod 600 ${shellEscape(remoteCodexAuthPath)}; fi`,
    "if ! command -v codex >/dev/null 2>&1; then " +
      "if ! command -v npm >/dev/null 2>&1; then " +
      "echo 'Codex CLI is missing and npm is unavailable for installation.' >&2; exit 1; " +
      "fi; " +
      "npm install -g --prefix \"$HOME/.local\" @openai/codex >/tmp/superturtle-e2b-codex-install.log 2>&1; " +
      "fi",
    "command -v codex >/dev/null 2>&1",
    config.remoteMode === "agent"
      ? "codex login status >/tmp/superturtle-e2b-codex-login-status.log 2>&1"
      : "true",
  ].join(" && ");
}

function buildRemoteStartCommand(config) {
  return [
    "set -euo pipefail",
    "export PATH=\"$HOME/.bun/bin:$HOME/.local/bin:$PATH\"",
    `cd ${shellEscape(config.remoteRoot)}`,
    "command -v superturtle >/dev/null 2>&1",
    `if [ -f ${shellEscape(config.pidPath)} ]; then kill "$(cat ${shellEscape(config.pidPath)})" >/dev/null 2>&1 || true; rm -f ${shellEscape(config.pidPath)}; fi`,
    "superturtle stop >/tmp/superturtle-e2b-stop.log 2>&1 || true",
    `: > ${shellEscape(config.logPath)}`,
    `export CLAUDE_WORKING_DIR=${shellEscape(config.remoteRoot)}`,
    "export SUPERTURTLE_RESTART_ON_CRASH=1",
    `echo $$ > ${shellEscape(config.pidPath)}`,
    `exec superturtle service run >> ${shellEscape(config.logPath)} 2>&1`,
  ].join(" && ");
}

async function importSandbox() {
  try {
    return await import("e2b");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load the E2B SDK (${message}). Run 'cd super_turtle && bun install' first.`
    );
  }
}

async function persistRemoteProjectState(sandbox, config, remoteEnv, telegramOwnerState = null) {
  const remoteProjectDir = `${config.remoteRoot}/.superturtle`;
  const remoteProjectConfigPath = `${remoteProjectDir}/project.json`;
  const remoteProjectEnvPath = `${config.remoteRoot}/${DEFAULT_REMOTE_PROJECT_ENV_PATH}`;
  const remoteTelegramOwnerPath = `${config.remoteRoot}/${TELEGRAM_OWNER_RELATIVE_PATH}`;

  await sandbox.commands.run(
    ["set -euo pipefail", `mkdir -p ${shellEscape(remoteProjectDir)}`].join(" && "),
    { timeoutMs: 30_000 }
  );

  await sandbox.files.write(
    remoteProjectConfigPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        repo_root: config.remoteRoot,
        init_cwd: config.remoteRoot,
        git_created: false,
        initialized_at: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
  await sandbox.files.write(remoteProjectEnvPath, serializeDotEnv(remoteEnv));
  if (telegramOwnerState) {
    await sandbox.files.write(remoteTelegramOwnerPath, telegramOwnerState);
  }
  await sandbox.commands.run(
    [
      "set -euo pipefail",
      `chmod 600 ${shellEscape(remoteProjectConfigPath)}`,
      `chmod 600 ${shellEscape(remoteProjectEnvPath)}`,
      ...(telegramOwnerState ? [`chmod 600 ${shellEscape(remoteTelegramOwnerPath)}`] : []),
    ].join(" && "),
    { timeoutMs: 30_000 }
  );

  return {
    remoteProjectConfigPath,
    remoteProjectEnvPath,
    remoteTelegramOwnerPath: telegramOwnerState ? remoteTelegramOwnerPath : null,
  };
}

function buildManagedRuntimeManifest(config) {
  return {
    runtime_install_spec: config.runtimeInstallSpec || null,
    runtime_version: config.runtimeVersion || null,
    template_id: config.templateId || null,
    template_version: config.templateVersion || null,
    remote_mode: config.remoteMode || DEFAULT_REMOTE_MODE,
    remote_driver: config.remoteDriver || null,
    updated_at: new Date().toISOString(),
  };
}

async function persistManagedRuntimeManifest(sandbox, config) {
  const manifestPath = `${config.remoteRoot}/${MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH}`;
  await sandbox.files.write(
    manifestPath,
    `${JSON.stringify(buildManagedRuntimeManifest(config), null, 2)}\n`
  );
  return manifestPath;
}

async function readRemoteManagedRuntimeManifest(sandbox, config) {
  const manifestPath = `${config.remoteRoot}/${MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH}`;
  try {
    const result = await sandbox.commands.run(
      `cat ${shellEscape(manifestPath)}`,
      { timeoutMs: 15_000 }
    );
    const text = String(result.stdout || "").trim();
    if (!text) {
      return null;
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function shouldRunFullBootstrap(config, remoteManifest) {
  if (!remoteManifest || typeof remoteManifest !== "object") {
    return true;
  }
  const runtimeInstallSpec =
    typeof remoteManifest.runtime_install_spec === "string"
      ? remoteManifest.runtime_install_spec.trim()
      : "";
  const runtimeVersion =
    typeof remoteManifest.runtime_version === "string"
      ? remoteManifest.runtime_version.trim()
      : "";
  const remoteMode =
    typeof remoteManifest.remote_mode === "string"
      ? remoteManifest.remote_mode.trim()
      : "";
  const remoteDriver =
    typeof remoteManifest.remote_driver === "string"
      ? remoteManifest.remote_driver.trim()
      : remoteManifest.remote_driver == null
        ? ""
        : String(remoteManifest.remote_driver).trim();

  return (
    runtimeInstallSpec !== String(config.runtimeInstallSpec || "") ||
    runtimeVersion !== String(config.runtimeVersion || "") ||
    remoteMode !== String(config.remoteMode || DEFAULT_REMOTE_MODE) ||
    remoteDriver !== String(config.remoteDriver || "")
  );
}

async function bootstrapRemoteDriverAuth(sandbox, config, remoteEnv, authBootstrap = {}) {
  await sandbox.commands.run(
    "set -euo pipefail && mkdir -p \"$HOME/.codex\" \"$HOME/.claude\" \"$HOME/.local/bin\"",
    {
      envs: remoteEnv,
      timeoutMs: 30_000,
    }
  );

  if (authBootstrap.codexAuthSourcePath) {
    const remoteCodexAuthPath = `${DEFAULT_REMOTE_HOME}/${DEFAULT_REMOTE_CODEX_AUTH_PATH}`;
    await sandbox.files.write(remoteCodexAuthPath, fs.readFileSync(authBootstrap.codexAuthSourcePath));
  }

  await sandbox.commands.run(buildRemoteAuthFinalizeCommand(config), {
    envs: remoteEnv,
    timeoutMs: 5 * 60 * 1000,
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
  return payload;
}

async function setTelegramWebhook(botToken, webhookUrl, webhookSecret, options = {}) {
  const endpoint = `https://api.telegram.org/bot${botToken}/setWebhook`;
  return fetchJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      drop_pending_updates: Boolean(options.dropPendingUpdates),
    }),
  });
}

async function deleteTelegramWebhook(botToken, options = {}) {
  const endpoint = `https://api.telegram.org/bot${botToken}/deleteWebhook`;
  return fetchJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      drop_pending_updates: Boolean(options.dropPendingUpdates),
    }),
  });
}

async function getTelegramWebhookInfo(botToken) {
  const endpoint = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
  return fetchJson(endpoint, { method: "GET" });
}

async function waitForHttpReady(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return true;
      }
      const body = (await response.text()).trim();
      lastError = new Error(
        `${label} returned ${response.status}${body ? `: ${body}` : ""}`
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((nextResolve) => setTimeout(nextResolve, 1000));
  }

  throw new Error(
    `Timed out waiting for sandbox ${label} at ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function waitForHealth(url, timeoutMs) {
  return waitForHttpReady(url, timeoutMs, "health");
}

async function waitForReady(url, timeoutMs) {
  return waitForHttpReady(url, timeoutMs, "readiness");
}

async function ensureTeleportTargetReady(projectRoot, state, options = {}) {
  await emitProgress(options, "connecting_sandbox", {
    sandboxId: state.sandboxId,
    remoteMode: state.remoteMode || DEFAULT_REMOTE_MODE,
  });
  const { Sandbox } = await importSandbox();
  const sandbox = await Sandbox.connect(state.sandboxId, {
    timeoutMs: state.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  const readyUrl = state.readyUrl || state.healthUrl;
  await waitForReady(readyUrl, 15 * 1000);

  const nextState = buildStateRecord(projectRoot, sandbox.sandboxId, sandbox.getHost(state.port), {
    ...state,
    readyPath: state.readyPath || DEFAULT_READY_PATH,
    healthPath: state.healthPath || DEFAULT_HEALTH_PATH,
  }, state.ownerMode || DEFAULT_OWNER_MODE);
  savePocState(projectRoot, nextState);
  return nextState;
}

async function lookupSandboxInfo(Sandbox, sandboxId) {
  const paginator = await Sandbox.list();
  while (paginator.hasNext) {
    const items = await paginator.nextItems();
    const match = items.find((item) => item.sandboxId === sandboxId);
    if (match) {
      return match;
    }
  }
  return null;
}

function isMissingSandboxError(error) {
  if (!error) return false;
  const name = typeof error.name === "string" ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    name === "NotFoundError" ||
    (normalized.includes("sandbox") && normalized.includes("not found"))
  );
}

function requireProjectState(projectRoot) {
  const state = loadPocState(projectRoot);
  if (!state) {
    throw new Error(`No local teleport state found at ${getStateFilePath(projectRoot)}.`);
  }
  return state;
}

function saveStateWithOwner(projectRoot, state, ownerMode) {
  const nextState = {
    ...state,
    ownerMode,
    updatedAt: new Date().toISOString(),
  };
  savePocState(projectRoot, nextState);
  return nextState;
}

async function launchTeleportRuntime(projectRoot, options = {}) {
  await emitProgress(options, "preparing");
  const projectEnv = loadProjectEnv(projectRoot);
  const telegramOwnerState = loadTelegramOwnerState(projectRoot);
  const existingState = loadPocState(projectRoot);
  const config = buildPocConfig(projectRoot, options, existingState);
  const authBootstrap = buildLocalAuthBootstrap(projectEnv);
  const { Sandbox } = await importSandbox();

  const canReuseExistingSandbox =
    Boolean(options["sandbox-id"]) ||
    Boolean(
      existingState?.sandboxId &&
      existingState?.templateId &&
      existingState.templateId === config.templateId
    );
  const sandboxId =
    options["sandbox-id"] ||
    (canReuseExistingSandbox ? existingState?.sandboxId || null : null);
  let sandbox = null;
  if (sandboxId) {
    try {
      await emitProgress(options, "connecting_sandbox", {
        sandboxId,
        remoteMode: config.remoteMode,
      });
      sandbox = await Sandbox.connect(sandboxId, { timeoutMs: config.timeoutMs });
    } catch (error) {
      if (!isMissingSandboxError(error)) {
        throw error;
      }
    }
  }
  if (!sandbox) {
    await emitProgress(options, "creating_sandbox", {
      remoteMode: config.remoteMode,
    });
    sandbox = await Sandbox.create(config.templateId, {
      timeoutMs: config.timeoutMs,
      lifecycle: {
        onTimeout: "pause",
        autoResume: true,
      },
    });
  }

  const host = sandbox.getHost(config.port);
  const webhookUrl = buildWebhookUrl(host, config.webhookPath);
  const healthUrl = buildHealthUrl(host, config.healthPath);
  const readyUrl = buildReadyUrl(host, config.readyPath);
  const remoteEnv = buildRemoteEnv(
    projectEnv,
    config.remoteRoot,
    webhookUrl,
    config.webhookSecret,
    config.port,
    config.healthPath,
    config.readyPath,
    config.remoteMode,
    config.remoteDriver,
    authBootstrap
  );

  const remoteManifest = sandbox ? await readRemoteManagedRuntimeManifest(sandbox, config) : null;
  if (sandbox && !shouldRunFullBootstrap(config, remoteManifest)) {
    try {
      await emitProgress(options, "waiting_ready", {
        sandboxId: sandbox.sandboxId,
        remoteMode: config.remoteMode,
      });
      await waitForReady(readyUrl, 5 * 1000);
      const state = buildStateRecord(projectRoot, sandbox.sandboxId, host, config, DEFAULT_OWNER_MODE);
      savePocState(projectRoot, state);
      await emitProgress(options, "done", {
        sandboxId: sandbox.sandboxId,
        remoteMode: config.remoteMode,
      });
      return state;
    } catch {
      // Fall through to a full runtime reinstall/restart when the existing runtime is not ready.
    }
  }

  await emitProgress(options, "configuring_remote", {
    sandboxId: sandbox.sandboxId,
    remoteMode: config.remoteMode,
  });
  await sandbox.commands.run(buildRemoteBootstrapCommand(config), {
    envs: remoteEnv,
    timeoutMs: 10 * 60 * 1000,
  });
  await persistRemoteProjectState(sandbox, config, remoteEnv, telegramOwnerState);
  await emitProgress(options, "bootstrapping_auth", {
    sandboxId: sandbox.sandboxId,
    remoteMode: config.remoteMode,
  });
  await bootstrapRemoteDriverAuth(sandbox, config, remoteEnv, authBootstrap);
  await emitProgress(options, "starting_remote", {
    sandboxId: sandbox.sandboxId,
    remoteMode: config.remoteMode,
  });
  await sandbox.commands.run(buildRemoteStartCommand(config), {
    envs: remoteEnv,
    background: true,
    timeoutMs: 10 * 60 * 1000,
  });
  await emitProgress(options, "waiting_ready", {
    sandboxId: sandbox.sandboxId,
    remoteMode: config.remoteMode,
  });
  await waitForReady(readyUrl, 90 * 1000);
  await persistManagedRuntimeManifest(sandbox, config);

  const state = buildStateRecord(projectRoot, sandbox.sandboxId, host, config, DEFAULT_OWNER_MODE);
  savePocState(projectRoot, state);
  await emitProgress(options, "done", {
    sandboxId: sandbox.sandboxId,
    remoteMode: config.remoteMode,
  });
  return state;
}

async function getTeleportStatus(projectRoot) {
  const state = requireProjectState(projectRoot);
  const runtimeEnv = loadRuntimeEnv(projectRoot);
  const { Sandbox } = await importSandbox();
  const info = await lookupSandboxInfo(Sandbox, state.sandboxId);
  let health = "unknown";
  let readiness = "unknown";

  if (info?.state === "paused") {
    health = "skipped while paused";
    readiness = "skipped while paused";
  } else {
    try {
      await waitForHealth(state.healthUrl, 5 * 1000);
      health = "ok";
    } catch (error) {
      health = error instanceof Error ? error.message : String(error);
    }
    try {
      await waitForReady(state.readyUrl || state.healthUrl, 5 * 1000);
      readiness = "ok";
    } catch (error) {
      readiness = error instanceof Error ? error.message : String(error);
    }
  }

  const webhookInfo = await getTelegramWebhookInfo(runtimeEnv.TELEGRAM_BOT_TOKEN);
  return { state, info, health, readiness, webhookInfo };
}

async function setRemoteWebhook(projectRoot, options = {}) {
  const existingState = requireProjectState(projectRoot);
  const runtimeEnv = loadRuntimeEnv(projectRoot);
  const state = await ensureTeleportTargetReady(projectRoot, existingState, options);
  await emitProgress(options, "switching_telegram", {
    sandboxId: existingState.sandboxId,
    remoteMode: existingState.remoteMode || DEFAULT_REMOTE_MODE,
  });
  await setTelegramWebhook(runtimeEnv.TELEGRAM_BOT_TOKEN, state.webhookUrl, state.webhookSecret, {
    dropPendingUpdates: Boolean(options.dropPendingUpdates),
  });

  await emitProgress(options, "verifying_cutover", {
    sandboxId: state.sandboxId,
    remoteMode: state.remoteMode || DEFAULT_REMOTE_MODE,
  });
  const webhookInfo = await getTelegramWebhookInfo(runtimeEnv.TELEGRAM_BOT_TOKEN);
  const currentUrl = webhookInfo?.result?.url || "";
  if (currentUrl !== state.webhookUrl) {
    await deleteTelegramWebhook(runtimeEnv.TELEGRAM_BOT_TOKEN, {
      dropPendingUpdates: false,
    });
    throw new Error(`Webhook ownership verification failed. Expected ${state.webhookUrl} but Telegram reports ${currentUrl || "<unset>"}.`);
  }

  return {
    state: saveStateWithOwner(projectRoot, state, "remote"),
    webhookInfo,
  };
}

async function clearRemoteWebhook(projectRoot, options = {}) {
  const state = loadPocState(projectRoot);
  const runtimeEnv = loadRuntimeEnv(projectRoot);
  await emitProgress(options, "releasing_telegram", {
    sandboxId: state?.sandboxId,
    remoteMode: state?.remoteMode || DEFAULT_REMOTE_MODE,
  });
  await deleteTelegramWebhook(runtimeEnv.TELEGRAM_BOT_TOKEN, {
    dropPendingUpdates: Boolean(options.dropPendingUpdates),
  });
  await emitProgress(options, "verifying_release", {
    sandboxId: state?.sandboxId,
    remoteMode: state?.remoteMode || DEFAULT_REMOTE_MODE,
  });
  const webhookInfo = await getTelegramWebhookInfo(runtimeEnv.TELEGRAM_BOT_TOKEN);
  const currentUrl = webhookInfo?.result?.url || "";
  if (currentUrl) {
    throw new Error(`Webhook delete verification failed. Telegram still reports ${currentUrl}.`);
  }
  return {
    state: state ? saveStateWithOwner(projectRoot, state, "local") : null,
    webhookInfo,
  };
}

async function reconcileTeleportOwnership(projectRoot) {
  const state = loadPocState(projectRoot);
  if (!state || state.ownerMode !== "remote") {
    return state;
  }

  const runtimeEnv = loadRuntimeEnv(projectRoot);
  const webhookInfo = await getTelegramWebhookInfo(runtimeEnv.TELEGRAM_BOT_TOKEN);
  const currentUrl = webhookInfo?.result?.url || "";
  if (currentUrl === state.webhookUrl) {
    return state;
  }

  return saveStateWithOwner(projectRoot, state, "local");
}

async function pauseTeleportSandbox(projectRoot, options = {}) {
  const state = requireProjectState(projectRoot);
  await emitProgress(options, "pausing_remote", {
    sandboxId: state.sandboxId,
    remoteMode: state.remoteMode || DEFAULT_REMOTE_MODE,
  });
  const { Sandbox } = await importSandbox();
  const info = await lookupSandboxInfo(Sandbox, state.sandboxId);
  if (info?.state === "paused") {
    await emitProgress(options, "done", {
      sandboxId: state.sandboxId,
      remoteMode: state.remoteMode || DEFAULT_REMOTE_MODE,
    });
    return state;
  }
  const sandbox = await Sandbox.connect(state.sandboxId, { timeoutMs: state.timeoutMs || 60_000 });
  await sandbox.pause();
  await emitProgress(options, "done", {
    sandboxId: state.sandboxId,
    remoteMode: state.remoteMode || DEFAULT_REMOTE_MODE,
  });
  return state;
}

async function resumeTeleportSandbox(projectRoot) {
  const state = requireProjectState(projectRoot);
  const { Sandbox } = await importSandbox();
  await Sandbox.connect(state.sandboxId, { timeoutMs: state.timeoutMs || 60_000 });
  await waitForReady(state.readyUrl || state.healthUrl, 90 * 1000);
  return state;
}

async function tailTeleportLogs(projectRoot, lines = 50) {
  const state = requireProjectState(projectRoot);
  const { Sandbox } = await importSandbox();
  const sandbox = await Sandbox.connect(state.sandboxId, { timeoutMs: state.timeoutMs || 60_000 });
  return sandbox.commands.run(`tail -n ${lines} ${JSON.stringify(state.logPath)}`, {
    timeoutMs: 30_000,
  });
}

module.exports = {
  DEFAULT_CLAUDE_CREDENTIAL_PATHS,
  DEFAULT_HEALTH_PATH,
  DEFAULT_REMOTE_CODEX_AUTH_PATH,
  DEFAULT_READY_PATH,
  DEFAULT_LOG_PATH,
  DEFAULT_PORT,
  DEFAULT_PID_PATH,
  DEFAULT_TIMEOUT_MS,
  TELEPORT_STATE_RELATIVE_PATH,
  buildLocalAuthBootstrap,
  bootstrapRemoteDriverAuth,
  buildHealthUrl,
  buildManagedRuntimeManifest,
  buildReadyUrl,
  buildRemoteAuthFinalizeCommand,
  buildRemoteBootstrapCommand,
  buildPocConfig,
  buildRemoteEnv,
  buildRemoteStartCommand,
  buildStateRecord,
  buildWebhookUrl,
  discoverClaudeAccessToken,
  extractTokenFromCredentialPayload,
  formatStateSummary,
  getBoundProjectRoot,
  getLegacyPocStateFilePath,
  getLocalCodexAuthSourcePath,
  getStateFilePath,
  getTelegramWebhookInfo,
  hasLocalCodexAuth,
  clearRemoteWebhook,
  deleteTelegramWebhook,
  getTeleportStatus,
  importSandbox,
  ensureTeleportTargetReady,
  launchTeleportRuntime,
  loadPocState,
  loadProjectEnv,
  loadRuntimeEnv,
  lookupSandboxInfo,
  isMissingSandboxError,
  parseDotEnv,
  persistManagedRuntimeManifest,
  persistRemoteProjectState,
  serializeDotEnv,
  shouldRunFullBootstrap,
  pauseTeleportSandbox,
  reconcileTeleportOwnership,
  resumeTeleportSandbox,
  savePocState,
  setRemoteWebhook,
  setTelegramWebhook,
  tailTeleportLogs,
  waitForHealth,
  waitForReady,
};
