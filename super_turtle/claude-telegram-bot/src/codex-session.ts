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
  BOT_DIR,
  CODEX_META_BOOTSTRAP_PROMPT,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  MCP_SERVERS,
  META_CODEX_APPROVAL_POLICY,
  META_CODEX_NETWORK_ACCESS,
  META_CODEX_SANDBOX_MODE,
  TOKEN_PREFIX,
} from "./config";
import { formatCodexToolStatus } from "./formatting";
import type { StatusCallback, McpCompletionCallback, RecentMessage, SavedSession, SessionHistory } from "./types";
import { codexLog } from "./logger";
import type { DriverRunSource } from "./drivers/types";
import { appendTurnLogEntry, type TurnLogStatus, type TurnLogUsage } from "./turn-log";
import { buildInjectedArtifacts, readClaudeMdSnapshot } from "./injected-artifacts";
import type { InjectedArtifact } from "./injected-artifacts";
import {
  acknowledgeMetaAgentInboxItems,
  buildMetaAgentInboxPrompt,
  injectMetaAgentInboxIntoPrompt,
  listPendingMetaAgentInboxItems,
  shouldInjectMetaAgentInbox,
} from "./conductor-inbox";
import { buildExternalSessionHistory, buildSavedSessionHistory, buildTurnLogHistory, toRecentMessages } from "./session-history";

// Prefs file for Codex (separate from Claude)
const CODEX_PREFS_FILE = `/tmp/codex-telegram-${TOKEN_PREFIX}-prefs.json`;
const CODEX_SESSION_FILE = `/tmp/codex-telegram-${TOKEN_PREFIX}-session.json`;
const MAX_CODEX_SESSIONS = 5;
const MAX_RECENT_MESSAGES = 10;
const MAX_MESSAGE_TEXT = 500;
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

async function saveCodexPrefs(prefs: CodexPrefs): Promise<void> {
  try {
    await Bun.write(CODEX_PREFS_FILE, JSON.stringify(prefs, null, 2));
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
    return "Codex SDK is unavailable. Run `bun install` in the bot directory.";
  }
  return `Failed to initialize Codex SDK: ${message.slice(0, 160)}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeTranscriptText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractMessageTextFromContent(
  content: unknown,
  itemType: "input_text" | "output_text"
): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && "type" in item && item.type === itemType)
    .map((item) => normalizeTranscriptText((item as { text?: unknown }).text))
    .join("");
}

function stripMetaPrompt(text: string): {
  text: string;
  artifact: string | null;
} {
  const match = text.match(/^<system-instructions>\n([\s\S]*?)\n<\/system-instructions>\n\n?/);
  if (!match) {
    return { text, artifact: null };
  }
  return {
    text: text.slice(match[0].length),
    artifact: match[1] || "",
  };
}

function stripDatePrefix(text: string): {
  text: string;
  artifact: string | null;
} {
  const match = text.match(/^(\[Current date\/time:[^\n]*\]\n\n)/);
  if (!match) {
    return { text, artifact: null };
  }
  const prefix = match[1] ?? "";
  return {
    text: text.slice(prefix.length),
    artifact: prefix || null,
  };
}

export function parseCodexTranscript(
  sessionId: string,
  transcriptText: string,
  path: string | null = null
): CodexTranscriptData {
  const messages: CodexTranscriptMessage[] = [];
  let bootstrapPromptText: string | null = null;
  let datePrefixText: string | null = null;

  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type !== "response_item") continue;
    const payload = parsed.payload;
    if (!payload || typeof payload !== "object") continue;
    if ((payload as { type?: unknown }).type !== "message") continue;

    const role = (payload as { role?: unknown }).role;
    const content = (payload as { content?: unknown }).content;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";

    if (role === "user") {
      const rawText = extractMessageTextFromContent(content, "input_text");
      if (!rawText) continue;
      const meta = stripMetaPrompt(rawText);
      if (!bootstrapPromptText && meta.artifact) {
        bootstrapPromptText = meta.artifact;
      }
      const dated = stripDatePrefix(meta.text);
      if (!datePrefixText && dated.artifact) {
        datePrefixText = dated.artifact;
      }
      const cleaned = dated.text.trim();
      if (!cleaned) continue;
      messages.push({
        role: "user",
        text: cleaned,
        timestamp,
      });
      continue;
    }

    if (role === "assistant") {
      const text = extractMessageTextFromContent(content, "output_text").trim();
      if (!text) continue;
      messages.push({
        role: "assistant",
        text,
        timestamp,
      });
    }
  }

  const injectedArtifacts: InjectedArtifact[] = [];
  if (bootstrapPromptText) {
    injectedArtifacts.push({
      id: "codex-bootstrap-prompt",
      label: "Codex bootstrap prompt",
      order: 20,
      text: bootstrapPromptText,
      applied: true,
    });
  }
  if (datePrefixText) {
    injectedArtifacts.push({
      id: "date-prefix",
      label: "Date/time prefix",
      order: 30,
      text: datePrefixText,
      applied: true,
    });
  }

  return {
    sessionId,
    path,
    messages,
    injectedArtifacts,
    metaSharedLoaded: bootstrapPromptText !== null,
    datePrefixApplied: datePrefixText !== null,
  };
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
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();

  for (const [name, config] of Object.entries(MCP_SERVERS)) {
    if ("command" in config && "args" in config) {
      const resolvedCommand = config.command === "bun" ? bunPath : config.command;
      const env = config.env ? { ...config.env } : {};
      if (envPath && !env.PATH) {
        env.PATH = envPath;
      }
      if (chatId) {
        env.TELEGRAM_CHAT_ID = chatId;
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
  id?: string;
  conversationId?: string;
  name?: string | null;
  preview?: string;
  timestamp?: string | number | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  cwd?: string;
};

type AppServerConversationListResponse = {
  data?: AppServerConversation[];
  items?: AppServerConversation[];
  nextCursor?: string | null;
};

type AppServerThreadReadResponse = {
  thread?: {
    id?: string;
    path?: string | null;
    cwd?: string;
  } | null;
};

export interface CodexTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface CodexTranscriptData {
  sessionId: string;
  path: string | null;
  messages: CodexTranscriptMessage[];
  injectedArtifacts: InjectedArtifact[];
  metaSharedLoaded: boolean;
  datePrefixApplied: boolean;
}

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
    BOT_DIR,
    "scripts/codex-yolo-wrapper.sh"
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

async function fetchTranscriptPathFromAppServer(sessionId: string): Promise<string | null> {
  const result = await requestAppServer<AppServerThreadReadResponse>(
    "thread/read",
    { threadId: sessionId }
  );
  const thread = result?.thread;
  if (!thread || typeof thread.path !== "string" || thread.path.length === 0) {
    return null;
  }
  if (thread.cwd && thread.cwd !== WORKING_DIR) {
    return null;
  }
  return thread.path;
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

    const rawNextCursor: string | null | undefined = result.nextCursor;
    const nextCursor: string | null = typeof rawNextCursor === "string" && rawNextCursor.length > 0
      ? rawNextCursor
      : null;
    cursor = nextCursor;
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

  const normalizeTimestamp = (value: string | number | null | undefined): string | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 1e12 ? value : value * 1000;
      return new Date(ms).toISOString();
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
    }
    return null;
  };

  while (sessions.length < maxSessions) {
    const pageSize = Math.min(25, maxSessions - sessions.length);
    const result: AppServerConversationListResponse | null =
      await requestAppServer<AppServerConversationListResponse>(
        "thread/list",
        {
          cursor,
          limit: pageSize,
        }
      );

    const items = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.items)
        ? result.items
        : null;

    if (!items) {
      break;
    }

    for (const item of items) {
      const sessionId =
        typeof item?.id === "string"
          ? item.id
          : typeof item?.conversationId === "string"
            ? item.conversationId
            : null;
      if (!item || !sessionId) continue;
      if (item.cwd && item.cwd !== WORKING_DIR) continue;

      const preview = (item.preview || "").trim();
      const firstLine =
        preview.split("\n")[0]?.trim()
        || (typeof item.name === "string" ? item.name.trim() : "")
        || "Codex session";
      const savedAt =
        normalizeTimestamp(item.updatedAt)
        || normalizeTimestamp(item.timestamp)
        || normalizeTimestamp(item.createdAt)
        || new Date().toISOString();
      sessions.push({
        session_id: sessionId,
        saved_at: savedAt,
        working_dir: item.cwd || WORKING_DIR,
        title: firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine,
        ...(preview ? { preview } : {}),
      });
    }

    const rawNextCursor: string | null | undefined = result?.nextCursor;
    const nextCursor: string | null = typeof rawNextCursor === "string" && rawNextCursor.length > 0
      ? rawNextCursor
      : null;
    cursor = nextCursor;
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
  private _isProcessing = false;
  private queryStarted: Date | null = null;
  lastActivity: Date | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastMessage: string | null = null;
  lastAssistantMessage: string | null = null;
  lastUsage: { input_tokens: number; output_tokens: number } | null = null;
  recentMessages: RecentMessage[] = []; // Rolling buffer for resume preview

  /** Push a user or assistant message into the rolling buffer. */
  pushRecentMessage(role: "user" | "assistant", text: string): void {
    const truncated = text.length > MAX_MESSAGE_TEXT
      ? text.slice(0, MAX_MESSAGE_TEXT - 3) + "..."
      : text;
    this.recentMessages.push({
      role,
      text: truncated,
      timestamp: new Date().toISOString(),
    });
    if (this.recentMessages.length > MAX_RECENT_MESSAGES) {
      this.recentMessages = this.recentMessages.slice(-MAX_RECENT_MESSAGES);
    }
  }

  private hydrateRecentMessages(messages: CodexTranscriptMessage[]): void {
    this.recentMessages = toRecentMessages(
      buildExternalSessionHistory({
        source: "codex-jsonl",
        messages,
      })!,
      MAX_RECENT_MESSAGES,
      MAX_MESSAGE_TEXT
    );
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    this.lastMessage = lastUser?.text || null;
    this.lastAssistantMessage = lastAssistant?.text || null;
  }

  async getSessionTranscript(sessionId: string): Promise<CodexTranscriptData | null> {
    const transcriptPath = await fetchTranscriptPathFromAppServer(sessionId);
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return null;
    }

    try {
      const transcriptText = readFileSync(transcriptPath, "utf-8");
      return parseCodexTranscript(sessionId, transcriptText, transcriptPath);
    } catch (error) {
      codexLog.warn({ err: error, sessionId, transcriptPath }, "Failed to load Codex transcript");
      return null;
    }
  }

  get model(): string { return this._model; }
  set model(value: string) {
    this._model = value;
    void saveCodexPrefs({
      threadId: this.threadId || undefined,
      model: this._model,
      reasoningEffort: this._reasoningEffort,
      createdAt: new Date().toISOString(),
    });
  }

  get reasoningEffort(): CodexEffortLevel { return this._reasoningEffort; }
  set reasoningEffort(value: CodexEffortLevel) {
    this._reasoningEffort = value;
    void saveCodexPrefs({
      threadId: this.threadId || undefined,
      model: this._model,
      reasoningEffort: this._reasoningEffort,
      createdAt: new Date().toISOString(),
    });
  }

  constructor() {
    // Load preferences
    const prefs = loadCodexPrefs();
    this._model = prefs.model || DEFAULT_CODEX_MODEL;
    this._reasoningEffort = (prefs.reasoningEffort as CodexEffortLevel) || DEFAULT_CODEX_EFFORT;

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
    if (this.isQueryRunning) {
      this.stopRequested = true;
      if (this.abortController) {
        this.abortController.abort();
        codexLog.info("Codex stop requested - aborting current query");
        return "stopped";
      }
      codexLog.info("Codex stop requested - will cancel before query starts");
      return "pending";
    }

    if (this._isProcessing) {
      this.stopRequested = true;
      codexLog.info("Codex stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  clearStopRequested(): void {
    this.stopRequested = false;
  }

  get isStopRequested(): boolean {
    return this.stopRequested;
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

      this.threadId = this.thread.id || null;
      this.systemPromptPrepended = false; // Reset bootstrap state for new thread

      codexLog.info(
        { sessionId: this.threadId },
        this.threadId
          ? `Started new Codex thread: ${this.threadId.slice(0, 8)}...`
          : "Started new Codex thread without immediate thread ID; awaiting stream event"
      );

      // Save thread ID for persistence
      await saveCodexPrefs({
        threadId: this.threadId || undefined,
        createdAt: new Date().toISOString(),
        model: threadModel,
        reasoningEffort: threadEffort,
      });
      await this.upsertTrackedSession("Active Codex session");
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
      this.systemPromptPrepended = true; // Resumed thread already contains its earlier bootstrap turn

      codexLog.info({ sessionId: threadId }, `Resumed Codex thread: ${threadId.slice(0, 8)}...`);
      await this.upsertTrackedSession();
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
   * On new-thread bootstrap turns, prepends the Codex Telegram bootstrap prompt.
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
    mcpCompletionCallback?: McpCompletionCallback,
    source: DriverRunSource = "text",
    userId = 0,
    username = "unknown",
    chatId = 0
  ): Promise<string> {
    const turnStartedAt = new Date();
    const sessionIdAtStart = this.threadId;
    const turnModel = model || this._model;
    const turnEffort = reasoningEffort || this._reasoningEffort;
    const claudeMdSnapshot = readClaudeMdSnapshot(WORKING_DIR);
    const claudeMdLoaded = claudeMdSnapshot.loaded;
    let messageToSend = userMessage;
    let datePrefixApplied = false;
    let metaPromptAppliedThisTurn = false;
    let metaAgentInboxText = "";
    let metaAgentInboxItemIds: string[] = [];
    let turnStatus: TurnLogStatus = "completed";
    let turnError: string | null = null;
    let turnResponse: string | null = null;
    let turnUsage: CodexUsage | null = null;

    try {
      // Acquire processing lock immediately to prevent TOCTOU races.
      if (this._isProcessing || this.isQueryRunning) {
        throw new Error("Codex session is already processing a query");
      }

      // Track pre-query lifecycle time so isRunning() remains true even before
      // isQueryRunning flips on. This prevents premature deferred-queue drains.
      this._isProcessing = true;

      if (!this.thread) {
        await this.startNewThread(model, reasoningEffort);
        if (!this.thread) {
          throw new Error("Failed to create Codex thread");
        }
      }

      // Store for debugging
      this.lastMessage = userMessage;
      this.pushRecentMessage("user", userMessage);

      // Prepend bootstrap prompt and date/time prefix on thread bootstrap turns.
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
        datePrefixApplied = true;
        if (CODEX_META_BOOTSTRAP_PROMPT) {
          messageToSend = `<system-instructions>
${CODEX_META_BOOTSTRAP_PROMPT}
</system-instructions>

${messageToSend}`;
          metaPromptAppliedThisTurn = true;
        }
        this.systemPromptPrepended = true;
      }

      if (chatId && shouldInjectMetaAgentInbox(source)) {
        const inboxItems = listPendingMetaAgentInboxItems({ chatId });
        if (inboxItems.length > 0) {
          metaAgentInboxText = buildMetaAgentInboxPrompt(inboxItems);
          metaAgentInboxItemIds = inboxItems.map((item) => item.id);
          messageToSend = injectMetaAgentInboxIntoPrompt(messageToSend, metaAgentInboxText);
        }
      }

      // Check if stop was requested during processing phase.
      if (this.stopRequested) {
        codexLog.info("Codex query cancelled before starting (stop was requested during processing)");
        this.stopRequested = false;
        throw new Error("Query cancelled");
      }

      // Create abort controller for cancellation and mark query as running.
      this.abortController = new AbortController();
      this.queryStarted = new Date();
      this.isQueryRunning = true;

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

        if ((event.type === "thread.started" || event.type === "thread_started") && event.thread_id) {
          if (this.threadId !== event.thread_id) {
            this.threadId = event.thread_id;
            await saveCodexPrefs({
              threadId: this.threadId,
              createdAt: new Date().toISOString(),
              model: turnModel,
              reasoningEffort: turnEffort,
            });
            await this.upsertTrackedSession("Active Codex session");
            codexLog.info(
              { sessionId: this.threadId },
              `Captured Codex thread ID from stream: ${this.threadId.slice(0, 8)}...`
            );
          }
          continue;
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
          turnUsage = event.usage;
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
      if (!combinedResponse && turnUsage) {
        const u = turnUsage;
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
      await this.saveSession(title);
      turnResponse = combinedResponse || "No response from Codex.";
      return turnResponse;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      turnError = errorMessage.slice(0, 4000);
      const errorLower = errorMessage.toLowerCase();
      const isCancellation =
        errorLower.includes("abort") || errorLower.includes("cancel");

      if (isCancellation && this.stopRequested) {
        codexLog.warn(`Suppressed Codex cancellation after stop request: ${errorMessage}`);
        turnStatus = "cancelled";
      } else {
        codexLog.error({ err: error }, "Error sending message to Codex");
        this.lastError = errorMessage.slice(0, 100);
        this.lastErrorTime = new Date();
        turnStatus = isCancellation ? "cancelled" : "error";
      }
      throw error;
    } finally {
      this.isQueryRunning = false;
      this._isProcessing = false;
      this.queryStarted = null;

      const completedAt = new Date();
      const usage: TurnLogUsage | null = turnUsage
        ? {
            inputTokens: turnUsage.input_tokens,
            outputTokens: turnUsage.output_tokens,
            cacheReadInputTokens: turnUsage.cached_input_tokens,
          }
        : null;

      const turnEntry = appendTurnLogEntry({
        driver: "codex",
        source,
        sessionId: this.threadId || sessionIdAtStart,
        userId,
        username,
        chatId,
        model: turnModel,
        effort: turnEffort,
        originalMessage: userMessage,
        effectivePrompt: messageToSend,
        injectedArtifacts: buildInjectedArtifacts({
          source,
          effectivePrompt: messageToSend,
          originalMessage: userMessage,
          datePrefixApplied,
          metaPromptApplied: metaPromptAppliedThisTurn,
          claudeMdLoaded,
          claudeMdText: claudeMdSnapshot.text,
          metaPromptText: CODEX_META_BOOTSTRAP_PROMPT,
          metaPromptArtifactId: "codex-bootstrap-prompt",
          metaPromptLabel: "Codex bootstrap prompt",
          metaAgentInboxText,
        }),
        injections: {
          datePrefixApplied,
          metaPromptApplied: metaPromptAppliedThisTurn,
          cronScheduledPromptApplied: source === "cron_scheduled",
          backgroundSnapshotPromptApplied: source === "background_snapshot",
        },
        context: {
          claudeMdLoaded,
          metaSharedLoaded: CODEX_META_BOOTSTRAP_PROMPT.length > 0,
        },
        startedAt: turnStartedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        elapsedMs: Math.max(0, completedAt.getTime() - turnStartedAt.getTime()),
        status: turnStatus,
        response: turnResponse,
        error: turnError,
        usage,
      });

      if (turnStatus === "completed" && metaAgentInboxItemIds.length > 0) {
        acknowledgeMetaAgentInboxItems({
          itemIds: metaAgentInboxItemIds,
          driver: "codex",
          turnId: turnEntry.id,
          sessionId: turnEntry.sessionId,
        });
      }
    }
  }

  private buildSessionEntry(
    existing: SavedSession | null,
    titleOverride?: string,
    savedAtOverride?: string
  ): SavedSession | null {
    if (!this.threadId) return null;

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

    return {
      session_id: this.threadId,
      saved_at: savedAtOverride || this.lastActivity?.toISOString() || new Date().toISOString(),
      working_dir: WORKING_DIR,
      title: titleOverride || existing?.title || this.lastMessage || "Codex session",
      ...(preview
        ? { preview }
        : existing?.preview
          ? { preview: existing.preview }
          : {}),
      ...(this.recentMessages.length > 0
        ? { recentMessages: this.recentMessages }
        : existing?.recentMessages && existing.recentMessages.length > 0
          ? { recentMessages: existing.recentMessages }
          : {}),
    };
  }

  private async upsertTrackedSession(titleOverride?: string): Promise<void> {
    if (!this.threadId) return;

    try {
      const history = this.loadSessionHistory();
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.threadId
      );
      const existing = existingIndex !== -1 ? history.sessions[existingIndex]! : null;
      const newSession = this.buildSessionEntry(existing, titleOverride);
      if (!newSession) return;

      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        history.sessions.unshift(newSession);
      }

      history.sessions = history.sessions.slice(0, MAX_CODEX_SESSIONS);
      await Bun.write(CODEX_SESSION_FILE, JSON.stringify(history, null, 2));
      codexLog.info({ sessionId: this.threadId }, `Codex session saved: ${this.threadId!.slice(0, 8)}...`);
    } catch (error) {
      codexLog.warn({ err: error }, "Failed to save Codex session");
    }
  }

  /**
   * Save current thread to multi-session history.
   */
  saveSession(title?: string): Promise<void> {
    return this.upsertTrackedSession(title);
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
      const transcript = await this.getSessionTranscript(sessionId);
      const resumeHistory =
        (transcript
          ? buildExternalSessionHistory({
              source: "codex-jsonl",
              path: transcript.path,
              messages: transcript.messages,
              injectedArtifacts: transcript.injectedArtifacts,
              context: {
                metaSharedLoaded: transcript.metaSharedLoaded,
                datePrefixApplied: transcript.datePrefixApplied,
              },
            })
          : null)
        || buildTurnLogHistory("codex", sessionId)
        || buildSavedSessionHistory(sessionData);
      if (resumeHistory) {
        this.recentMessages = toRecentMessages(
          resumeHistory,
          MAX_RECENT_MESSAGES,
          MAX_MESSAGE_TEXT
        );
        const lastUser = [...resumeHistory.messages].reverse().find((message) => message.role === "user");
        const lastAssistant = [...resumeHistory.messages].reverse().find((message) => message.role === "assistant");
        this.lastMessage = lastUser?.text || null;
        this.lastAssistantMessage = lastAssistant?.text || null;
      } else {
        this.recentMessages = sessionData.recentMessages || [];
        const lastUser = [...this.recentMessages].reverse().find((message) => message.role === "user");
        const lastAssistant = [...this.recentMessages].reverse().find((message) => message.role === "assistant");
        this.lastMessage = lastUser?.text || null;
        this.lastAssistantMessage = lastAssistant?.text || null;
      }
      this.lastActivity = new Date();
      await this.saveSession(sessionData.title);
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
    // Persist the linked thread before clearing so /resume remains stable
    // across driver switches and explicit resets.
    await this.saveSession();
    this.thread = null;
    this.threadId = null;
    this.systemPromptPrepended = false;

    // Clear thread linkage but keep user model preferences.
    await saveCodexPrefs({
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
   * Get the current active Codex session as a normalized snapshot for observability.
   */
  getActiveSessionSnapshot(): SavedSession | null {
    if (!this.threadId) return null;

    const existing =
      this.loadSessionHistory().sessions.find((session) => session.session_id === this.threadId)
      || null;
    return this.buildSessionEntry(
      existing,
      existing?.title || this.lastMessage || "Active Codex session",
      this.lastActivity?.toISOString() || existing?.saved_at || new Date().toISOString()
    );
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
    return this.isQueryRunning || this._isProcessing;
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
