/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir, platform } from "os";
import { resolve, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import type { McpServerConfig } from "./types";
import { logger } from "./logger";
import { TOKEN_PREFIX } from "./token-prefix";

const configLog = logger.child({ module: "config" });

// ============== Environment Setup ==============

const HOME = homedir();
export const IS_MACOS = platform() === "darwin";
export const IS_LINUX = platform() === "linux";
export const IS_WINDOWS = platform() === "win32";

// Ensure necessary paths are available for Claude's bash commands.
// LaunchAgents (macOS) don't inherit the full shell environment;
// systemd services (Linux) may have similarly restricted PATHs.
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  // macOS Homebrew paths (Apple Silicon + Intel)
  ...(IS_MACOS ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : []),
  // Linux Linuxbrew / snap paths
  ...(IS_LINUX ? ["/home/linuxbrew/.linuxbrew/bin", "/snap/bin"] : []),
  "/usr/local/bin",
];

const PATH_SEPARATOR = IS_WINDOWS ? ";" : ":";
const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(PATH_SEPARATOR);
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(PATH_SEPARATOR);

// ============== Core Configuration ==============

const IS_TEST_ENV =
  (process.env.NODE_ENV || "").toLowerCase() === "test" ||
  typeof process.env.BUN_TEST !== "undefined";

export const TELEGRAM_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || (IS_TEST_ENV ? "test-token" : "");
export { TOKEN_PREFIX };
export const IPC_DIR = `/tmp/superturtle-${TOKEN_PREFIX}`;
process.env.SUPERTURTLE_IPC_DIR ||= IPC_DIR;
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || (IS_TEST_ENV ? "123" : "")
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;

// Package root: where Super Turtle code is installed.
// In dev: /path/to/repo/super_turtle
// As npm package: /path/to/node_modules/superturtle (or global install path)
// import.meta.dir = .../claude-telegram-bot/src → dirname → .../claude-telegram-bot → .. → .../super_turtle
export const SUPER_TURTLE_DIR = process.env.SUPER_TURTLE_DIR
  || resolve(dirname(import.meta.dir), "..");

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ============== Env Defaults (single source of truth) ==============

export const ENV_DEFAULTS = {
  DEFAULT_MODEL: "claude-opus-4-6",
  DEFAULT_EFFORT: "high",
  HIDE_TOOL_STATUS: "false",
  LOG_LEVEL: "info",
  RATE_LIMIT_ENABLED: "true",
  RATE_LIMIT_REQUESTS: "20",
  RATE_LIMIT_WINDOW: "60",
  DASHBOARD_ENABLED: "false",
  DASHBOARD_PORT: "4173",
  CODEX_ENABLED: "false",
  AUDIT_LOG_JSON: "false",
  TURTLE_GREETINGS: "true",
} as const;

// Derived paths — package code vs user runtime data
export const CTL_PATH = `${SUPER_TURTLE_DIR}/subturtle/ctl`;
export const BOT_DIR = `${SUPER_TURTLE_DIR}/claude-telegram-bot`;
export const SUPERTURTLE_DATA_DIR = `${WORKING_DIR}/.superturtle`;
export const CODEX_USER_ENABLED =
  (process.env.CODEX_ENABLED || ENV_DEFAULTS.CODEX_ENABLED).toLowerCase() === "true";
export const CODEX_ENABLED = CODEX_USER_ENABLED;

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

function parseOptionalBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseCodexSandboxMode(raw: string | undefined): CodexSandboxMode {
  const value = (raw || "workspace-write").toLowerCase();
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  configLog.warn(
    `Invalid META_CODEX_SANDBOX_MODE="${raw}". Falling back to "workspace-write".`
  );
  return "workspace-write";
}

function parseCodexApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  const value = (raw || "never").toLowerCase();
  if (value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted") {
    return value;
  }
  configLog.warn(
    `Invalid META_CODEX_APPROVAL_POLICY="${raw}". Falling back to "never".`
  );
  return "never";
}

function parseMetaCodexNetworkAccess(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") {
    return false;
  }
  const value = raw.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  configLog.warn(
    `Invalid META_CODEX_NETWORK_ACCESS="${raw}". Falling back to "false".`
  );
  return false;
}

export const META_CODEX_SANDBOX_MODE = parseCodexSandboxMode(
  process.env.META_CODEX_SANDBOX_MODE
);
export const META_CODEX_APPROVAL_POLICY = parseCodexApprovalPolicy(
  process.env.META_CODEX_APPROVAL_POLICY
);
export const META_CODEX_NETWORK_ACCESS = parseMetaCodexNetworkAccess(
  process.env.META_CODEX_NETWORK_ACCESS
);

// ============== Claude CLI Path ==============

function resolveClaudeCliPath(): string | null {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const whichResult = Bun.which("claude");
  if (whichResult) return whichResult;

  if (existsSync("/usr/local/bin/claude")) return "/usr/local/bin/claude";
  return null;
}

// Auto-detect from PATH, or use environment override
function findClaudeCli(): string {
  const resolvedPath = resolveClaudeCliPath();
  if (resolvedPath) return resolvedPath;

  // Final fallback
  return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_AVAILABLE = resolveClaudeCliPath() !== null;
export const CLAUDE_CLI_PATH = findClaudeCli();

function resolveCodexCliPath(): string | null {
  const fromPath = Bun.which("codex");
  if (fromPath) return fromPath;

  if (IS_MACOS) {
    if (existsSync("/opt/homebrew/bin/codex")) return "/opt/homebrew/bin/codex";
    if (existsSync("/usr/local/bin/codex")) return "/usr/local/bin/codex";
  }

  const linuxFallbacks = [
    `${HOME}/.local/bin/codex`,
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const fallback of linuxFallbacks) {
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

export const CODEX_CLI_PATH = resolveCodexCliPath();
const codexCliAvailableOverride = parseOptionalBool(
  process.env.CODEX_CLI_AVAILABLE_OVERRIDE
);
export const CODEX_CLI_AVAILABLE =
  codexCliAvailableOverride !== null
    ? codexCliAvailableOverride
    : CODEX_CLI_PATH !== null;
export const CODEX_AVAILABLE = CODEX_USER_ENABLED && CODEX_CLI_AVAILABLE;

export function getCodexUnavailableReason(): string | null {
  if (!CODEX_USER_ENABLED) {
    return "Codex is disabled in config (CODEX_ENABLED=false).";
  }
  if (!CODEX_CLI_AVAILABLE) {
    return "Codex CLI is not installed or not available on PATH.";
  }
  return null;
}

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  // Dynamic import of MCP config
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;
    configLog.info(
      `Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`
    );
  }
} catch {
  configLog.info("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations
const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`, // Claude Code data (plans, settings)
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

// Load META_SHARED.md as system prompt so the bot acts as the meta agent
let META_PROMPT = "";
try {
  const metaPath = resolve(SUPER_TURTLE_DIR, "meta/META_SHARED.md");
  META_PROMPT = readFileSync(metaPath, "utf-8")
    .replace(/\{\{SUPER_TURTLE_DIR\}\}/g, SUPER_TURTLE_DIR)
    .replace(/\{\{CTL_PATH\}\}/g, CTL_PATH)
    .replace(/\{\{DATA_DIR\}\}/g, SUPERTURTLE_DATA_DIR)
    .trim();
  configLog.info({ metaPath }, `Loaded meta prompt from ${metaPath}`);
} catch {
  configLog.warn("Failed to load META_SHARED.md - running without meta prompt");
}

export { META_PROMPT };

// Load ORCHESTRATOR_PROMPT.md for full-auto overnight mode cron jobs
let ORCHESTRATOR_PROMPT = "";
try {
  const orchPath = resolve(SUPER_TURTLE_DIR, "meta/ORCHESTRATOR_PROMPT.md");
  ORCHESTRATOR_PROMPT = readFileSync(orchPath, "utf-8")
    .replace(/\{\{CTL_PATH\}\}/g, CTL_PATH)
    .replace(/\{\{DATA_DIR\}\}/g, SUPERTURTLE_DATA_DIR)
    .replace(/\{\{SUPER_TURTLE_DIR\}\}/g, SUPER_TURTLE_DIR)
    .trim();
  configLog.info({ orchPath }, `Loaded orchestrator prompt from ${orchPath}`);
} catch {
  configLog.info("No ORCHESTRATOR_PROMPT.md found - orchestrator mode unavailable");
}

export { ORCHESTRATOR_PROMPT };

// Dangerous command patterns to block.
// Each entry is a regex string (case-insensitive match against the full command).
// Use word-boundary / end-of-string anchors so "rm -rf /Users/..." doesn't match
// the rule meant to block "rm -rf /" (delete root).
export const BLOCKED_PATTERNS: Array<{ regex: string; label: string }> = [
  // "rm -rf /" — only when "/" is the entire target (end-of-string or followed by whitespace).
  // Does NOT match "rm -rf /Users/foo/bar".
  { regex: "rm\\s+-[^\\s]*r[^\\s]*f[^\\s]*\\s+/(\\s|$)", label: "rm -rf / (root)" },
  // "rm -rf ~" — bare tilde or tilde/ as the entire target.
  { regex: "rm\\s+-[^\\s]*r[^\\s]*f[^\\s]*\\s+~(\\s|/\\s|/$|$)", label: "rm -rf ~ (home)" },
  // "rm -rf $HOME" — whole target.
  { regex: "rm\\s+-[^\\s]*r[^\\s]*f[^\\s]*\\s+\\$HOME(\\s|/\\s|/$|$)", label: "rm -rf $HOME (home)" },
  { regex: "sudo\\s+rm\\b", label: "sudo rm" },
  { regex: ":\\(\\)\\{\\s*:\\|:&\\s*\\};:", label: "fork bomb" },
  { regex: ">\\s*/dev/sd", label: "disk overwrite" },
  { regex: "\\bmkfs\\.", label: "filesystem format" },
  { regex: "\\bdd\\s+if=", label: "raw disk operation" },
];

// Hide tool call status messages from Telegram chat (only show final text)
export const HIDE_TOOL_STATUS =
  (process.env.HIDE_TOOL_STATUS || ENV_DEFAULTS.HIDE_TOOL_STATUS).toLowerCase() === "true";

// Query timeout (3 minutes)
export const QUERY_TIMEOUT_MS = 180_000;

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

let TRANSCRIPTION_CONTEXT = "";
if (process.env.TRANSCRIPTION_CONTEXT_FILE) {
  try {
    const file = Bun.file(process.env.TRANSCRIPTION_CONTEXT_FILE);
    if (await file.exists()) {
      TRANSCRIPTION_CONTEXT = (await file.text()).trim();
    }
  } catch {
    // File not found or unreadable — proceed without context
  }
}

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

// ============== Default Model & Effort ==============

export type EffortLevel = "low" | "medium" | "high";

export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || ENV_DEFAULTS.DEFAULT_MODEL;
export const DEFAULT_EFFORT: EffortLevel = (() => {
  const val = process.env.DEFAULT_EFFORT?.toLowerCase();
  if (val === "low" || val === "medium" || val === "high") return val;
  return ENV_DEFAULTS.DEFAULT_EFFORT as EffortLevel;
})();

configLog.info({ model: DEFAULT_MODEL, effort: DEFAULT_EFFORT }, "Default model & effort");

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Dashboard Configuration ==============

const rawDashboardPort = Number(process.env.DASHBOARD_PORT || ENV_DEFAULTS.DASHBOARD_PORT);
export const DASHBOARD_ENABLED = (
  process.env.DASHBOARD_ENABLED || ENV_DEFAULTS.DASHBOARD_ENABLED
).toLowerCase() === "true";
export const DASHBOARD_PORT = Number.isFinite(rawDashboardPort) && rawDashboardPort > 0
  ? rawDashboardPort
  : 4173;
export const DASHBOARD_BIND_ADDR = process.env.DASHBOARD_BIND_ADDR || "127.0.0.1";
export const DASHBOARD_AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || "";
export const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "http://localhost";

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || `/tmp/claude-telegram-${TOKEN_PREFIX}-audit.log`;
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || ENV_DEFAULTS.AUDIT_LOG_JSON).toLowerCase() === "true";

// ============== Env Overrides Log ==============

const overrides: Record<string, string> = {};
for (const [key, defaultVal] of Object.entries(ENV_DEFAULTS)) {
  const actual = process.env[key];
  if (actual && actual.toLowerCase() !== defaultVal.toLowerCase()) {
    overrides[key] = actual;
  }
}
if (Object.keys(overrides).length > 0) {
  configLog.info({ overrides }, "Env overrides (non-default values)");
}

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || ENV_DEFAULTS.RATE_LIMIT_ENABLED).toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || ENV_DEFAULTS.RATE_LIMIT_REQUESTS,
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || ENV_DEFAULTS.RATE_LIMIT_WINDOW,
  10
);

// ============== File Paths ==============

export const SESSION_FILE = `/tmp/claude-telegram-${TOKEN_PREFIX}-session.json`;
export const RESTART_FILE = `/tmp/claude-telegram-${TOKEN_PREFIX}-restart.json`;
export const TEMP_DIR = `/tmp/telegram-bot-${TOKEN_PREFIX}`;

// Temp paths that are always allowed for bot operations.
// /private/tmp/ and /var/folders/ are macOS-specific symlink targets.
export const TEMP_PATHS = [
  "/tmp/",
  ...(IS_MACOS ? ["/private/tmp/", "/var/folders/"] : []),
];

// Ensure temp directory exists
await Bun.write(`${TEMP_DIR}/.keep`, "");

// ============== Validation ==============

if (!IS_TEST_ENV) {
  if (!TELEGRAM_TOKEN) {
    configLog.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
    process.exit(1);
  }

  if (ALLOWED_USERS.length === 0) {
    configLog.error(
      "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
    );
    process.exit(1);
  }
}

configLog.info(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`
);
