/**
 * Session management for Codex using the official Codex TypeScript SDK.
 *
 * CodexSession class manages Codex sessions with thread persistence.
 * Supports streaming responses with ThreadEvent processing.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  WORKING_DIR,
  META_PROMPT,
  MCP_SERVERS,
  META_CODEX_APPROVAL_POLICY,
  META_CODEX_NETWORK_ACCESS,
  META_CODEX_SANDBOX_MODE,
} from "./config";
import { formatCodexToolStatus } from "./formatting";
import type { StatusCallback, McpCompletionCallback, RecentMessage, SavedSession, SessionHistory } from "./types";
import { codexLog } from "./logger";

// Prefs file for Codex (separate from Claude)
const CODEX_PREFS_FILE = "/tmp/codex-telegram-prefs.json";
const CODEX_SESSION_FILE = "/tmp/codex-telegram-session.json";
const MAX_CODEX_SESSIONS = 5;
const APP_SERVER_TIMEOUT_MS = 6000;
const MODEL_CACHE_TTL_MS = 60_000;
const EVENT_STREAM_STALL_TIMEOUT_MS = (() => {
  const raw = process.env.CODEX_EVENT_STREAM_STALL_TIMEOUT_MS;
  if (!raw) return 120_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 120_000;
})();

interface CodexPrefs {
  threadId?: string;
  createdAt?: string;
  model?: string;
  reasoningEffort?: CodexEffortLevel;
}

function loadCodexPrefs(): CodexPrefs {
  try {
    const text = readFileSync(CODEX_PREFS_FILE, "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function saveCodexPrefs(prefs: CodexPrefs): void {
  try {
    Bun.write(CODEX_PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (error) {
    codexLog.warn({ err: error }, "Failed to save Codex preferences");
  }
}

type CodexUsage = {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
};

type AgentMessageItem = {
  id: string;
  type: "agent_message";
  text: string;
};

type ReasoningItem = {
  id: string;
  type: "reasoning";
  text: string;
};

type CommandExecutionItem = {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
};

type FileChangeItem = {
  id: string;
  type: "file_change";
  changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
  status: "completed" | "failed";
};

type McpToolCallItem = {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  status: "in_progress" | "completed" | "failed";
  error?: { message: string };
};

type WebSearchItem = {
  id: string;
  type: "web_search";
  query: string;
};

type TodoListItem = {
  id: string;
  type: "todo_list";
  items: Array<{ text: string; completed: boolean }>;
};

type ErrorItem = {
  id: string;
  type: "error";
  message: string;
};

type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem;

// Supports current SDK event names and legacy aliases.
type ThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "thread_started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn_started" }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn_completed"; usage?: CodexUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "turn_failed"; error: string }
  | { type: "item.started"; item: ThreadItem }
  | { type: "item.updated"; item: ThreadItem }
  | { type: "item.completed"; item: ThreadItem }
  | { type: "item_started"; item_type: string }
  | { type: "item_updated"; item: ThreadItem }
  | { type: "item_completed"; item: ThreadItem }
  | { type: "error"; message: string }
  | { type: "thread_error"; error: string };

type StreamedTurn = {
  events: AsyncGenerator<ThreadEvent>;
};

type CodexTurn = {
  items?: Array<Record<string, unknown>>;
  finalResponse?: string;
  usage?: CodexUsage;
};

type CodexThread = {
  id: string | null;
  run(message: string): Promise<CodexTurn>;
  runStreamed(message: string, options?: { signal?: AbortSignal }): Promise<StreamedTurn>;
};

type CodexClient = {
  startThread(options?: {
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    networkAccessEnabled?: boolean;
    approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
    model?: string;
    modelReasoningEffort?: string;
  }): CodexThread;
  resumeThread(threadId: string, options?: {
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    networkAccessEnabled?: boolean;
    approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
    model?: string;
    modelReasoningEffort?: string;
  }): CodexThread;
};

type CodexCtor = new (options?: Record<string, unknown>) => CodexClient;

function formatCodexInitError(error: unknown): string {
  const message = String(error);
  if (
    message.includes("Cannot find module") ||
    message.includes("module not found")
  ) {
    return "Codex SDK is unavailable. Run `bun install` in super_turtle/claude-telegram-bot.";
  }
  return `Failed to initialize Codex SDK: ${message.slice(0, 160)}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Check if MCP servers are already configured in ~/.codex/config.toml.
 * Returns true if any of our built-in servers are found.
 */
async function hasExistingMcpConfig(): Promise<boolean> {
  try {
    const homeDir = process.env.HOME || "";
    const configPath = `${homeDir}/.codex/config.toml`;
    const file = Bun.file(configPath);
    if (!(await file.exists())) {
      return false;
    }

    const content = await file.text();
    // Check for any of our MCP server names in the config
    const ourServers = ["send-turtle", "bot-control"];
    const hasOurServers = ourServers.some((server) => content.includes(server));
    if (!hasOurServers) return false;
    // If config uses bare "bun" commands, prefer programmatic config with absolute path.
    if (/\bcommand\s*=\s*"bun"\b/.test(content)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert MCP server config to Codex SDK format.
 * Codex config expects: { mcp_servers: { name: { command: ..., args: ..., cwd: ... } } }
 *
 * CRITICAL: Set cwd to WORKING_DIR so relative imports in MCP servers resolve correctly.
 * Without this, `import { mcpLog } from "../src/logger"` fails when Codex spawns the subprocess
 * from a different working directory, causing "Transport closed" errors.
 */
function buildCodexMcpConfig(): Record<string, unknown> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const bunPath = Bun.which("bun") || "/opt/homebrew/bin/bun";
  const envPath = process.env.PATH || "";

  for (const [name, config] of Object.entries(MCP_SERVERS)) {
    if ("command" in config && "args" in config) {
      const resolvedCommand = config.command === "bun" ? bunPath : config.command;
      const env = config.env ? { ...config.env } : {};
      if (envPath && !env.PATH) {
        env.PATH = envPath;
      }

      mcpServers[name] = {
        command: resolvedCommand,
        ...(config.args && { args: config.args }),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        // Set working directory so relative imports in MCP servers resolve correctly
        cwd: WORKING_DIR,
      };
    }
  }

  return { mcp_servers: mcpServers };
}

/**
 * Determine Codex reasoning effort based on message keywords.
 * Maps thinking keywords to modelReasoningEffort levels.
 */
function mapThinkingToReasoningEffort(message: string): CodexEffortLevel {
  const msgLower = message.toLowerCase();

  // Check for "ultrathink" or "think hard" — deepest reasoning
  if (msgLower.includes("ultrathink") || msgLower.includes("think hard")) {
    return "xhigh";
  }

  // Check for "pensa bene" (Italian) — deep reasoning
  if (msgLower.includes("pensa bene")) {
    return "high";
  }

  // Check for "think" or "pensa" or "ragiona" — normal reasoning
  if (msgLower.includes("think") || msgLower.includes("pensa") || msgLower.includes("ragiona")) {
    return "high";
  }

  // Default — medium effort
  return "medium";
}

// Codex models available (as of Feb 2026)
export type CodexEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CodexModelInfo {
  value: string;
  displayName: string;
  description: string;
}

const DEFAULT_CODEX_MODELS: CodexModelInfo[] = [
  { value: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", description: "Most capable (recommended)" },
  { value: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", description: "Fast, real-time (Pro)" },
  { value: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", description: "Previous generation" },
];

export function getAvailableCodexModels(): CodexModelInfo[] {
  return DEFAULT_CODEX_MODELS;
}

type AppServerModel = {
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
};

type AppServerModelListResponse = {
  data?: AppServerModel[];
  nextCursor?: string | null;
};

type AppServerConversation = {
  conversationId?: string;
  preview?: string;
  timestamp?: string | null;
  updatedAt?: string | null;
  cwd?: string;
};

type AppServerConversationListResponse = {
  items?: AppServerConversation[];
  nextCursor?: string | null;
};

let cachedModelCatalog:
  | {
      fetchedAt: number;
      models: CodexModelInfo[];
    }
  | null = null;

function getCodexBinaryPath(): string {
  const fromPath = Bun.which("codex");
  if (fromPath) return fromPath;

  // Platform-specific fallback locations
  const { platform } = require("os");
  if (platform() === "darwin") {
    // macOS: Homebrew on Apple Silicon, then Intel
    if (require("fs").existsSync("/opt/homebrew/bin/codex")) return "/opt/homebrew/bin/codex";
    if (require("fs").existsSync("/usr/local/bin/codex")) return "/usr/local/bin/codex";
  }

  // Linux / fallback: standard locations
  const home = process.env.HOME || "";
  const fallbacks = [
    `${home}/.local/bin/codex`,
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const p of fallbacks) {
    if (require("fs").existsSync(p)) return p;
  }

  // Last resort — hope it appears in PATH later
  return "codex";
}

function getCodexSdkPathOverride(): string {
  const wrapperPath = resolve(
    WORKING_DIR,
    "super_turtle/claude-telegram-bot/scripts/codex-yolo-wrapper.sh"
  );
  if (existsSync(wrapperPath)) {
    return wrapperPath;
  }
  return getCodexBinaryPath();
}

function uniqBySessionId(sessions: SavedSession[]): SavedSession[] {
  const seen = new Set<string>();
  const deduped: SavedSession[] = [];
  for (const session of sessions) {
    if (!session.session_id || seen.has(session.session_id)) continue;
    seen.add(session.session_id);
    deduped.push(session);
  }
  return deduped;
}

async function requestAppServer<T>(
  method: string,
  params: Record<string, unknown>
): Promise<T | null> {
  // Keep unit/integration tests deterministic and fast.
  if ((process.env.TELEGRAM_BOT_TOKEN || "") === "test-token") {
    return null;
  }

  const proc = Bun.spawn([getCodexBinaryPath(), "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!proc.stdin || !proc.stdout) {
    return null;
  }

  const send = (payload: Record<string, unknown>) => {
    proc.stdin!.write(JSON.stringify(payload) + "\n");
  };

  let initialized = false;
  let response: T | null = null;
  let requestError: string | null = null;
  const requestId = 2;

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "telegram-bot", version: "1.0.0" } },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + APP_SERVER_TIMEOUT_MS;

    while (Date.now() < deadline && response === null && !requestError) {
      const timeoutMs = Math.max(1, deadline - Date.now());
      const readResult: { done: boolean; value?: Uint8Array } = await Promise.race([
        reader.read(),
        Bun.sleep(timeoutMs).then(
          () =>
            ({
              done: true,
              value: undefined,
            })
        ),
      ]);

      if (readResult.done) {
        break;
      }

      buffer += decoder.decode(readResult.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (!initialized && parsed.id === 1) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: requestId, method, params });
          continue;
        }

        if (parsed.id === requestId) {
          if (parsed.error && typeof parsed.error === "object") {
            const err = parsed.error as { message?: string };
            requestError = err.message || `App-server request failed: ${method}`;
          } else {
            response = (parsed.result as T | undefined) || null;
          }
          break;
        }
      }
    }

    reader.releaseLock();
  } catch {
    return null;
  } finally {
    try {
      proc.stdin.end();
    } catch {
      // Ignore process shutdown errors.
    }
    proc.kill();
  }

  if (requestError) {
    codexLog.warn({ action: method }, `Codex app-server ${method} error: ${requestError}`);
    return null;
  }

  return response;
}

async function fetchModelsFromAppServer(): Promise<CodexModelInfo[]> {
  const models: CodexModelInfo[] = [];
  let cursor: string | null = null;

  while (true) {
    const result: AppServerModelListResponse | null =
      await requestAppServer<AppServerModelListResponse>(
      "model/list",
      {
        cursor,
        limit: 100,
        includeHidden: false,
      }
      );

    if (!result || !Array.isArray(result.data)) {
      break;
    }

    for (const item of result.data) {
      if (!item || typeof item.model !== "string") continue;
      models.push({
        value: item.model,
        displayName: item.displayName || item.model,
        description: item.description || "",
      });
    }

    cursor =
      typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : null;
    if (!cursor) break;
  }

  // Deduplicate by model id while keeping order.
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.value)) return false;
    seen.add(model.value);
    return true;
  });
}

async function fetchConversationsFromAppServer(
  maxSessions = 50
): Promise<SavedSession[]> {
  const sessions: SavedSession[] = [];
  let cursor: string | null = null;

  while (sessions.length < maxSessions) {
    const result: AppServerConversationListResponse | null =
      await requestAppServer<AppServerConversationListResponse>(
      "listConversations",
      {
        pageSize: Math.min(25, maxSessions - sessions.length),
        cursor,
        modelProviders: null,
      }
      );

    if (!result || !Array.isArray(result.items)) {
      break;
    }

    for (const item of result.items) {
      if (!item || typeof item.conversationId !== "string") continue;
      if (item.cwd && item.cwd !== WORKING_DIR) continue;

      const preview = (item.preview || "").trim();
      const firstLine = preview.split("\n")[0]?.trim() || "Codex session";
      sessions.push({
        session_id: item.conversationId,
        saved_at: item.updatedAt || item.timestamp || new Date().toISOString(),
        working_dir: item.cwd || WORKING_DIR,
        title: firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine,
        ...(preview ? { preview } : {}),
      });
    }

    cursor =
      typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : null;
    if (!cursor) break;
  }

  return uniqBySessionId(sessions);
}

export async function getAvailableCodexModelsLive(): Promise<CodexModelInfo[]> {
  if (
    cachedModelCatalog &&
    Date.now() - cachedModelCatalog.fetchedAt < MODEL_CACHE_TTL_MS
  ) {
    return cachedModelCatalog.models;
  }

  const liveModels = await fetchModelsFromAppServer();
  if (liveModels.length > 0) {
    cachedModelCatalog = {
      fetchedAt: Date.now(),
      models: liveModels,
    };
    return liveModels;
  }

  return DEFAULT_CODEX_MODELS;
}

/**
 * Manages Codex sessions using the official Codex SDK.
 */
export class CodexSession {
  private codex: CodexClient | null = null;
  private thread: CodexThread | null = null;
  private threadId: string | null = null;
  private systemPromptPrepended = false;
  private _model: string;
  private _reasoningEffort: CodexEffortLevel;
  private abortController: AbortController | null = null;
  private stopRequested = false;
  private isQueryRunning = false;
  private queryStarted: Date | null = null;
  lastActivity: Date | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastMessage: string | null = null;
  lastAssistantMessage: string | null = null;
  lastUsage: { input_tokens: number; output_tokens: number } | null = null;
  recentMessages: RecentMessage[] = []; // Rolling buffer for resume preview

  private static readonly MAX_RECENT_MESSAGES = 10;
  private static readonly MAX_MESSAGE_TEXT = 500;

  /** Push a user or assistant message into the rolling buffer. */
  pushRecentMessage(role: "user" | "assistant", text: string): void {
    const truncated = text.length > CodexSession.MAX_MESSAGE_TEXT
      ? text.slice(0, CodexSession.MAX_MESSAGE_TEXT - 3) + "..."
      : text;
    this.recentMessages.push({
      role,
      text: truncated,
      timestamp: new Date().toISOString(),
    });
    if (this.recentMessages.length > CodexSession.MAX_RECENT_MESSAGES) {
      this.recentMessages = this.recentMessages.slice(-CodexSession.MAX_RECENT_MESSAGES);
    }
  }

  get model(): string { return this._model; }
  set model(value: string) {
    this._model = value;
    saveCodexPrefs({
      threadId: this.threadId || undefined,
      model: this._model,
      reasoningEffort: this._reasoningEffort,
      createdAt: new Date().toISOString(),
    });
  }

  get reasoningEffort(): CodexEffortLevel { return this._reasoningEffort; }
  set reasoningEffort(value: CodexEffortLevel) {
    this._reasoningEffort = value;
    saveCodexPrefs({
      threadId: this.threadId || undefined,
      model: this._model,
      reasoningEffort: this._reasoningEffort,
      createdAt: new Date().toISOString(),
    });
  }

  constructor() {
    // Load preferences
    const prefs = loadCodexPrefs();
    this._model = prefs.model || "gpt-5.3-codex";
    this._reasoningEffort = (prefs.reasoningEffort as CodexEffortLevel) || "medium";

    if (prefs.threadId) {
      this.threadId = prefs.threadId;
      codexLog.info(
        `Loaded saved Codex thread: ${this.threadId.slice(0, 8)}...`
      );
    }

    if (prefs.model || prefs.reasoningEffort) {
      codexLog.info(
        { model: this._model, reasoningEffort: this._reasoningEffort },
        `Codex preferences: model=${this._model}, reasoningEffort=${this._reasoningEffort}`
      );
    }
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      codexLog.info("Codex stop requested - aborting current query");
      return "stopped";
    }

    return false;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.codex) {
      return;
    }

    try {
      const module = (await import("@openai/codex-sdk")) as unknown as {
        Codex?: CodexCtor;
      };
      const CodexImpl = module.Codex;
      if (!CodexImpl) {
        throw new Error("Codex export not found in @openai/codex-sdk");
      }

      // Check if MCP servers are already configured in ~/.codex/config.toml
      const codexPathOverride = getCodexSdkPathOverride();
      const hasExisting = await hasExistingMcpConfig();
      if (hasExisting) {
        codexLog.info("MCP servers found in ~/.codex/config.toml, using existing config");
        this.codex = new CodexImpl({ codexPathOverride });
      } else {
        // Pass MCP config programmatically if not already configured
        codexLog.info("Passing MCP servers via Codex constructor");
        const mcpConfig = buildCodexMcpConfig();
        this.codex = new CodexImpl({ codexPathOverride, config: mcpConfig });
      }
    } catch (error) {
      throw new Error(formatCodexInitError(error));
    }
  }

  /**
   * Start a new Codex thread.
   */
  async startNewThread(model?: string, reasoningEffort?: CodexEffortLevel): Promise<void> {
    await this.ensureInitialized();

    try {
      if (!this.codex) {
        throw new Error("Codex SDK client not initialized");
      }

      // Use provided model/effort or instance defaults
      const threadModel = model || this._model;
      const threadEffort = reasoningEffort || this._reasoningEffort;

      // Create new thread with working directory and model settings
      this.thread = await this.codex.startThread({
        workingDirectory: WORKING_DIR,
        skipGitRepoCheck: true,
        // Runtime policy defaults to least privilege, but stays overrideable via env.
        sandboxMode: META_CODEX_SANDBOX_MODE,
        approvalPolicy: META_CODEX_APPROVAL_POLICY,
        networkAccessEnabled: META_CODEX_NETWORK_ACCESS,
        model: threadModel,
        modelReasoningEffort: threadEffort,
      });

      // Capture thread ID
      if (!this.thread) {
        throw new Error("Failed to create Codex thread");
      }

      this.threadId = this.thread.id;
      this.systemPromptPrepended = false; // Reset flag for new thread

      codexLog.info({ sessionId: this.threadId }, `Started new Codex thread: ${this.threadId?.slice(0, 8)}...`);

      // Save thread ID for persistence
      saveCodexPrefs({
        threadId: this.threadId || undefined,
        createdAt: new Date().toISOString(),
        model: threadModel,
        reasoningEffort: threadEffort,
      });
    } catch (error) {
      codexLog.error({ err: error }, "Error starting Codex thread");
      this.lastError = String(error).slice(0, 100);
      this.lastErrorTime = new Date();
      throw error;
    }
  }

  /**
   * Resume a saved Codex thread by ID.
   */
  async resumeThread(threadId: string, model?: string, reasoningEffort?: CodexEffortLevel): Promise<void> {
    await this.ensureInitialized();

    try {
      if (!this.codex) {
        throw new Error("Codex SDK client not initialized");
      }

      // Use provided model/effort or instance defaults
      const threadModel = model || this._model;
      const threadEffort = reasoningEffort || this._reasoningEffort;

      this.thread = await this.codex.resumeThread(threadId, {
        workingDirectory: WORKING_DIR,
        skipGitRepoCheck: true,
        // Keep resumed threads on the same policy as newly created threads.
        sandboxMode: META_CODEX_SANDBOX_MODE,
        approvalPolicy: META_CODEX_APPROVAL_POLICY,
        networkAccessEnabled: META_CODEX_NETWORK_ACCESS,
        model: threadModel,
        modelReasoningEffort: threadEffort,
      });
      this.threadId = threadId;
      this.systemPromptPrepended = true; // Already sent in original thread

      codexLog.info({ sessionId: threadId }, `Resumed Codex thread: ${threadId.slice(0, 8)}...`);
    } catch (error) {
      codexLog.error({ err: error }, "Error resuming Codex thread");
      this.lastError = String(error).slice(0, 100);
      this.lastErrorTime = new Date();
      throw error;
    }
  }

  /**
   * Send a message to the current Codex thread with streaming support.
   * Returns the final response text.
   *
   * On first message, prepends system prompt (META_SHARED.md content).
   * Uses thread.runStreamed() to process events in real-time via statusCallback.
   *
   * mcpCompletionCallback: Optional callback fired when an mcp_tool_call completes.
   * Should return true if ask_user was detected and handled (triggers event loop break).
   */
  async sendMessage(
    userMessage: string,
    statusCallback?: StatusCallback,
    model?: string,
    reasoningEffort?: CodexEffortLevel,
    mcpCompletionCallback?: McpCompletionCallback
  ): Promise<string> {
    // Acquire query lock IMMEDIATELY to prevent TOCTOU races.
    // Without this, two callers can both check isRunning (false), then both
    // enter sendMessage concurrently — causing ghost responses or stalls.
    this.isQueryRunning = true;

    if (!this.thread) {
      // Create thread if not already created
      try {
        await this.startNewThread(model, reasoningEffort);
      } catch (error) {
        this.isQueryRunning = false; // Release lock on thread creation failure
        throw error;
      }
      if (!this.thread) {
        this.isQueryRunning = false; // Release lock on thread creation failure
        throw new Error("Failed to create Codex thread");
      }
    }

    // Store for debugging
    this.lastMessage = userMessage;
    this.pushRecentMessage("user", userMessage);

    try {
      // Prepend system prompt and date/time prefix to first message in a new thread.
      let messageToSend = userMessage;
      if (!this.systemPromptPrepended) {
        const now = new Date();
        const datePrefix = `[Current date/time: ${now.toLocaleDateString(
          "en-US",
          {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          }
        )}]\n\n`;
        messageToSend = `${datePrefix}${userMessage}`;
        if (META_PROMPT) {
          messageToSend = `<system-instructions>
${META_PROMPT}
</system-instructions>

${messageToSend}`;
        }
        this.systemPromptPrepended = true;
      }

      // Create abort controller for cancellation
      this.abortController = new AbortController();
      this.stopRequested = false;
      this.queryStarted = new Date();

      // Run with streaming
      const streamedTurn = await this.thread.runStreamed(messageToSend, {
        signal: this.abortController.signal,
      });

      // Process the event stream
      const segmentByItemId = new Map<string, number>();
      const segmentText = new Map<number, string>();
      const completedSegments = new Set<number>();
      let nextSegmentId = 0;
      let lastTextUpdate = 0;
      let askUserTriggered = false;
      let queryCompleted = false;
      let stalled = false;
      const stallTimeoutSentinel = Symbol("event-stream-stall-timeout");

      const getOrCreateSegment = (itemId: string): number => {
        const existing = segmentByItemId.get(itemId);
        if (existing !== undefined) {
          return existing;
        }
        const created = nextSegmentId++;
        segmentByItemId.set(itemId, created);
        return created;
      };

      const getCombinedResponse = (): string =>
        [...segmentText.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, text]) => text)
          .join("");

      const isItemEvent = (type: ThreadEvent["type"]): boolean =>
        type === "item.started" ||
        type === "item.updated" ||
        type === "item.completed" ||
        type === "item_updated" ||
        type === "item_completed";

      const isItemCompleted = (type: ThreadEvent["type"]): boolean =>
        type === "item.completed" || type === "item_completed";

      const eventsIterator = streamedTurn.events[Symbol.asyncIterator]();
      while (true) {
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const nextResult:
          | IteratorResult<ThreadEvent>
          | typeof stallTimeoutSentinel = await Promise.race([
          eventsIterator.next(),
          new Promise<typeof stallTimeoutSentinel>((resolve) => {
            stallTimer = setTimeout(
              () => resolve(stallTimeoutSentinel),
              EVENT_STREAM_STALL_TIMEOUT_MS
            );
          }),
        ]);

        if (stallTimer) {
          clearTimeout(stallTimer);
        }

        if (nextResult === stallTimeoutSentinel) {
          stalled = true;
          codexLog.warn(
            `Codex event stream stalled for ${EVENT_STREAM_STALL_TIMEOUT_MS}ms; aborting stream`
          );
          this.stopRequested = true;
          if (this.abortController) {
            this.abortController.abort();
          }
          break;
        }

        if (nextResult.done) {
          break;
        }

        const event = nextResult.value;
        // Check for abort
        if (this.stopRequested) {
          codexLog.info("Codex query aborted by user");
          break;
        }

        if (isItemEvent(event.type) && "item" in event && event.item) {
          const item = event.item;
          const itemCompleted = isItemCompleted(event.type);

          if (item.type === "agent_message") {
            const legacyContent =
              "message" in item &&
              item.message &&
              typeof item.message === "object" &&
              "content" in item.message &&
              Array.isArray(item.message.content)
                ? item.message.content
                : [];
            const legacyText = legacyContent
              .filter((block) => block && typeof block === "object" && block.type === "text")
              .map((block) => String(block.text || ""))
              .join("");
            const text = item.text || legacyText;
            const itemId =
              "id" in item && typeof item.id === "string" && item.id.length > 0
                ? item.id
                : `legacy-agent-${nextSegmentId}`;
            const segmentId = getOrCreateSegment(itemId);
            const previousText = segmentText.get(segmentId) || "";

            if (text !== previousText) {
              segmentText.set(segmentId, text);
              if (statusCallback) {
                const now = Date.now();
                if (now - lastTextUpdate > 500 && text.length > 20) {
                  await statusCallback("text", text, segmentId);
                  lastTextUpdate = now;
                }
              }
            }

            if (itemCompleted && statusCallback && text && !completedSegments.has(segmentId)) {
              completedSegments.add(segmentId);
              await statusCallback("segment_end", text, segmentId);
            }
          }

          if (item.type === "reasoning" && statusCallback && item.text) {
            codexLog.info(`THINKING: ${item.text.slice(0, 100)}...`);
            await statusCallback("thinking", item.text);
          }

          if (item.type === "mcp_tool_call" && itemCompleted) {
            const toolLabel = `${item.server}/${item.tool}`;
            const statusSuffix =
              item.status === "failed" ? `(failed: ${item.error?.message || "unknown"})` : "";
            codexLog.info({ tool: item.tool }, `MCP TOOL: ${toolLabel}`);
            if (statusCallback) {
              await statusCallback("tool", formatCodexToolStatus("mcp", toolLabel, statusSuffix || undefined));
            }

            // Call MCP completion callback if provided
            if (mcpCompletionCallback && item.status === "completed") {
              try {
                const triggered = await mcpCompletionCallback(item.server, item.tool);
                if (triggered) {
                  askUserTriggered = true;
                }
              } catch (error) {
                codexLog.warn({ err: error }, "Error in MCP completion callback");
              }
            }
          }

          if (item.type === "command_execution" && itemCompleted && statusCallback) {
            const command = item.command.slice(0, 100);
            const exitInfo =
              typeof item.exit_code === "number" ? `(exit ${item.exit_code})` : "";
            codexLog.info(`COMMAND: ${command}`);
            await statusCallback("tool", formatCodexToolStatus("bash", command, exitInfo || undefined));
          }

          if (item.type === "file_change" && itemCompleted && statusCallback) {
            const firstPath = item.changes[0]?.path;
            const count = item.changes.length;
            if (firstPath) {
              const suffix = count > 1 ? `(+${count - 1} more)` : "";
              codexLog.info(`FILE: ${firstPath}`);
              await statusCallback("tool", formatCodexToolStatus("file", firstPath, suffix || undefined));
            }
          }

          if (item.type === "web_search" && itemCompleted && statusCallback) {
            codexLog.info(`SEARCH: ${item.query}`);
            await statusCallback("tool", formatCodexToolStatus("search", item.query));
          }

          if (item.type === "error" && statusCallback) {
            codexLog.info(`ERROR: ${item.message}`);
            await statusCallback("tool", `Error: ${item.message}`);
          }

          if (item.type === "todo_list" && statusCallback && item.items.length > 0) {
            codexLog.info(`TODO LIST: ${item.items.length} items`);
            await statusCallback(
              "tool",
              `Todo: ${item.items.length} item${item.items.length > 1 ? "s" : ""}`
            );
          }
        }

        // Break out of event loop if ask_user was triggered
        if (askUserTriggered) {
          codexLog.info("Ask user triggered, breaking event loop");
          break;
        }

        // Handle turn completed - capture token usage
        if (
          (event.type === "turn.completed" || event.type === "turn_completed") &&
          "usage" in event &&
          event.usage
        ) {
          this.lastUsage = event.usage;
          codexLog.info(
            `Codex usage: in=${event.usage.input_tokens} out=${event.usage.output_tokens}`
          );
          queryCompleted = true;
        }

        // Handle errors
        if (event.type === "turn.failed") {
          const errorMsg = event.error?.message || "Unknown turn failure";
          throw new Error(`Codex event error: ${errorMsg}`);
        }
        if (event.type === "turn_failed") {
          throw new Error(`Codex event error: ${event.error || "Unknown turn failure"}`);
        }
        if (event.type === "error") {
          throw new Error(`Codex stream error: ${event.message || "Unknown stream failure"}`);
        }
        if (event.type === "thread_error") {
          const errorMsg = event.error || "Unknown error";
          throw new Error(`Codex event error: ${errorMsg}`);
        }
      }

      if (stalled && !queryCompleted && !askUserTriggered) {
        const stallError = new Error(
          `Codex event stream stalled for ${EVENT_STREAM_STALL_TIMEOUT_MS}ms before completion`
        );
        this.lastError = stallError.message.slice(0, 100);
        this.lastErrorTime = new Date();
        throw stallError;
      }

      // Emit any segments that did not get an explicit item.completed event
      if (statusCallback) {
        for (const [segmentId, text] of [...segmentText.entries()].sort(([a], [b]) => a - b)) {
          if (!text || completedSegments.has(segmentId)) {
            continue;
          }
          await statusCallback("segment_end", text, segmentId);
        }
      }

      // Detect empty response (in=0 out=0) — typically means the resumed thread
      // is stale or expired. Throw so the caller can retry with a fresh session.
      const combinedResponse = getCombinedResponse().trim();
      if (!combinedResponse && this.lastUsage) {
        const u = this.lastUsage;
        if (u.input_tokens === 0 && u.output_tokens === 0) {
          codexLog.warn(
            "Empty Codex response detected (in=0 out=0) — thread likely stale, clearing for retry"
          );
          this.threadId = null;
          this.thread = null;
          if (statusCallback) {
            await statusCallback("done", "");
          }
          throw new Error("Empty response from stale session");
        }
      }

      if (statusCallback) {
        await statusCallback("done", "");
      }

      this.lastActivity = new Date();
      this.lastError = null;
      this.lastErrorTime = null;

      this.lastAssistantMessage = combinedResponse || null;
      if (combinedResponse) {
        this.pushRecentMessage("assistant", combinedResponse);
      }
      // Save session for resumption later (after updating rolling buffer).
      const title = userMessage.length > 50 ? userMessage.slice(0, 47) + "..." : userMessage;
      this.saveSession(title);
      return combinedResponse || "No response from Codex.";
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const errorLower = errorMessage.toLowerCase();
      const isCancellation =
        errorLower.includes("abort") || errorLower.includes("cancel");

      if (isCancellation && this.stopRequested) {
        codexLog.warn(`Suppressed Codex cancellation after stop request: ${errorMessage}`);
      } else {
        codexLog.error({ err: error }, "Error sending message to Codex");
        this.lastError = errorMessage.slice(0, 100);
        this.lastErrorTime = new Date();
      }
      throw error;
    } finally {
      this.isQueryRunning = false;
      this.queryStarted = null;
    }
  }

  /**
   * Save current thread to multi-session history.
   */
  saveSession(title?: string): void {
    if (!this.threadId) return;

    try {
      // Load existing session history
      const history = this.loadSessionHistory();

      const previewParts: string[] = [];
      if (this.lastMessage) {
        previewParts.push(`You: ${this.lastMessage}`);
      }
      if (this.lastAssistantMessage) {
        previewParts.push(`Assistant: ${this.lastAssistantMessage}`);
      }
      const previewRaw = previewParts.join("\n");
      const preview =
        previewRaw.length > 280 ? `${previewRaw.slice(0, 277)}...` : previewRaw;

      // Create new session entry
      const newSession: SavedSession = {
        session_id: this.threadId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: title || "Codex session",
        ...(preview ? { preview } : {}),
        ...(this.recentMessages.length > 0 ? { recentMessages: this.recentMessages } : {}),
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.threadId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last MAX_CODEX_SESSIONS
      history.sessions = history.sessions.slice(0, MAX_CODEX_SESSIONS);

      // Save
      Bun.write(CODEX_SESSION_FILE, JSON.stringify(history, null, 2));
      codexLog.info({ sessionId: this.threadId }, `Codex session saved: ${this.threadId!.slice(0, 8)}...`);
    } catch (error) {
      codexLog.warn({ err: error }, "Failed to save Codex session");
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(CODEX_SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(CODEX_SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved Codex sessions for display.
   */
  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    // Filter to only sessions for current working directory
    return history.sessions.filter(
      (s) => !s.working_dir || s.working_dir === WORKING_DIR
    );
  }

  /**
   * Get Codex sessions from app-server (same source as Codex CLI picker),
   * merged with local fallback history.
   */
  async getSessionListLive(maxSessions = 50): Promise<SavedSession[]> {
    const localSessions = this.getSessionList();
    const liveSessions = await fetchConversationsFromAppServer(maxSessions);
    const merged = uniqBySessionId([...liveSessions, ...localSessions]);

    return merged
      .filter((s) => !s.working_dir || s.working_dir === WORKING_DIR)
      .sort((a, b) => {
        const left = Date.parse(a.saved_at || "") || 0;
        const right = Date.parse(b.saved_at || "") || 0;
        return right - left;
      })
      .slice(0, maxSessions);
  }

  /**
   * Resume a specific session by ID.
   */
  async resumeSession(sessionId: string): Promise<[success: boolean, message: string]> {
    const history = this.loadSessionHistory();
    let sessionData =
      history.sessions.find((s) => s.session_id === sessionId) || null;

    if (!sessionData) {
      const liveSessions = await this.getSessionListLive();
      sessionData =
        liveSessions.find((s) => s.session_id === sessionId) || null;
    }

    if (!sessionData) {
      return [false, `Codex session not found: ${sessionId.slice(0, 8)}...`];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [
        false,
        `Codex session for different directory: ${sessionData.working_dir}`,
      ];
    }

    try {
      await this.resumeThread(sessionId);
      this.recentMessages = sessionData.recentMessages || [];
      this.saveSession(sessionData.title);
      codexLog.info(
        `Resumed Codex session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
      );
      return [true, `Resumed Codex session: "${sessionData.title}"`];
    } catch (error) {
      return [false, `Failed to resume session: ${String(error).slice(0, 100)}`];
    }
  }

  /**
   * Resume the most recent persisted session.
   */
  async resumeLast(): Promise<[success: boolean, message: string]> {
    const sessions = await this.getSessionListLive();
    if (sessions.length === 0) {
      return [false, "No saved Codex sessions"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }

  /**
   * Kill the session (clear thread).
   */
  async kill(): Promise<void> {
    this.thread = null;
    this.threadId = null;
    this.systemPromptPrepended = false;

    // Clear thread linkage but keep user model preferences.
    saveCodexPrefs({
      model: this._model,
      reasoningEffort: this._reasoningEffort,
      createdAt: new Date().toISOString(),
    });

    codexLog.info("Codex session cleared");
  }

  /**
   * Get current thread ID.
   */
  getThreadId(): string | null {
    return this.threadId;
  }

  /**
   * Check if a thread is active.
   */
  get isActive(): boolean {
    return this.thread !== null && this.threadId !== null;
  }

  /**
   * Check if a Codex query is currently running.
   */
  get isRunning(): boolean {
    return this.isQueryRunning;
  }

  /**
   * Timestamp when the current query started.
   */
  get runningSince(): Date | null {
    return this.queryStarted;
  }
}

// Global Codex session instance
export const codexSession = new CodexSession();

// Export functions for external use
export { mapThinkingToReasoningEffort };
