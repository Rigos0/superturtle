/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions by spawning the `claude`
 * CLI as a subprocess with --output-format stream-json. This uses Claude Code
 * directly (the official product) rather than the Agent SDK.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  CLAUDE_CLI_AVAILABLE,
  CLAUDE_CLI_PATH,
  CODEX_AVAILABLE,
  MCP_SERVERS,
  META_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  TOKEN_PREFIX,
  IPC_DIR,
  WORKING_DIR,
} from "./config";
import { formatToolStatus } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingBotControlRequests,
  checkPendingPinoLogsRequests,
  checkPendingSendTurtleRequests,
} from "./handlers/streaming";
import { checkCommandSafety, isPathAllowed } from "./security";
import type {
  RecentMessage,
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";
import { claudeLog } from "./logger";
import type { DriverRunSource } from "./drivers/types";
import { appendTurnLogEntry, type TurnLogStatus, type TurnLogUsage } from "./turn-log";
import { buildInjectedArtifacts, readClaudeMdSnapshot } from "./injected-artifacts";
import { buildSavedSessionHistory, buildTurnLogHistory, toRecentMessages } from "./session-history";
import {
  acknowledgeMetaAgentInboxItems,
  buildMetaAgentInboxPrompt,
  injectMetaAgentInboxIntoPrompt,
  listPendingMetaAgentInboxItems,
  shouldInjectMetaAgentInbox,
} from "./conductor-inbox";

// Stream-json event types from claude CLI
interface StreamJsonEvent {
  type: string;
  session_id?: string;
  message?: {
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  usage?: TokenUsage;
  [key: string]: unknown;
}

const CLAUDE_FALLBACK_ALLOWED_TOOLS = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "TodoWrite",
  "WebSearch",
  "ToolSearch",
  "KillShell",
  "AskUserQuestion",
  "Skill",
  "SlashCommand",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
] as const;

const CLAUDE_BOT_MCP_ALLOWED_TOOLS = [
  "mcp__send-turtle__send_turtle",
  "mcp__bot-control__bot_control",
  "mcp__bot-control__ask_user",
  "mcp__bot-control__pino_logs",
] as const;

function splitAllowedTools(raw: string | undefined): string[] {
  return (raw || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeAllowedTools(...toolGroups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return [...new Set(toolGroups.flat().filter(Boolean))];
}

function getClaudeFallbackAllowedTools(): string[] {
  const tools = [
    ...CLAUDE_FALLBACK_ALLOWED_TOOLS,
    ...(Object.keys(MCP_SERVERS).length > 0 ? CLAUDE_BOT_MCP_ALLOWED_TOOLS : []),
    ...splitAllowedTools(process.env.CLAUDE_ALLOWED_TOOLS_EXTRA),
  ];
  return [...new Set(tools)];
}

function parseClaudeInitTools(output: string): string[] | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as { type?: string; subtype?: string; tools?: unknown };
      if (
        parsed.type === "system" &&
        parsed.subtype === "init" &&
        Array.isArray(parsed.tools)
      ) {
        return parsed.tools.filter((tool): tool is string => typeof tool === "string");
      }
    } catch {
      // Ignore non-JSON lines from the probe and keep scanning.
    }
  }
  return null;
}

const discoveredClaudeAllowedTools = new Map<string, string[]>();

function getClaudeAllowedTools(claudeBin: string): string[] {
  const fallbackTools = getClaudeFallbackAllowedTools();
  const probeArgs = [
    claudeBin,
    "-p",
    "ok",
    "--verbose",
    "--output-format",
    "stream-json",
    "--setting-sources",
    "user,project",
  ];
  if (Object.keys(MCP_SERVERS).length > 0) {
    probeArgs.push("--mcp-config", MCP_CONFIG_FILE);
  }

  const cacheKey = JSON.stringify(probeArgs);
  const cached = discoveredClaudeAllowedTools.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const probe = Bun.spawnSync(probeArgs, {
      cwd: WORKING_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(probe.stdout);
    const discovered = parseClaudeInitTools(stdout);
    const resolved = discovered
      ? mergeAllowedTools(discovered, fallbackTools)
      : fallbackTools;

    if (!discovered) {
      claudeLog.warn(
        { exitCode: probe.exitCode },
        "Claude tool discovery did not return an init tool list; using fallback allowlist"
      );
    }

    discoveredClaudeAllowedTools.set(cacheKey, resolved);
    return resolved;
  } catch (error) {
    claudeLog.warn(
      { err: error },
      "Claude tool discovery probe failed; using fallback allowlist"
    );
    discoveredClaudeAllowedTools.set(cacheKey, fallbackTools);
    return fallbackTools;
  }
}

// Write MCP config to a temp JSON file for --mcp-config flag
process.env.SUPERTURTLE_IPC_DIR = IPC_DIR;
const MCP_CONFIG_FILE = `/tmp/superturtle-${TOKEN_PREFIX}-mcp-config.json`;
function writeMcpConfig(chatId?: number): void {
  if (Object.keys(MCP_SERVERS).length === 0) return;

  const scopedServers = Object.fromEntries(
    Object.entries(MCP_SERVERS).map(([name, config]) => {
      if (!("command" in config)) {
        return [name, config];
      }

      const env: Record<string, string> = {
        ...(config.env || {}),
        SUPERTURTLE_IPC_DIR: IPC_DIR,
      };
      if (chatId !== undefined) {
        env.TELEGRAM_CHAT_ID = String(chatId);
      }

      return [name, { ...config, env }];
    })
  );

  try {
    mkdirSync("/tmp", { recursive: true });
    const mcpConfig = { mcpServers: scopedServers };
    writeFileSync(MCP_CONFIG_FILE, JSON.stringify(mcpConfig, null, 2));
  } catch {
    claudeLog.warn("Failed to write MCP config file");
  }
}
writeMcpConfig();

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeQueryError(error: unknown): Error {
  const message = getErrorMessage(error).replace(/\s+/g, " ").trim();
  const compact = message.length > 300 ? `${message.slice(0, 297)}...` : message;
  return new Error(compact);
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */
// Maximum number of sessions to keep in history
const MAX_SESSIONS = 5;
const EVENT_STREAM_STALL_TIMEOUT_MS = (() => {
  const raw = process.env.CLAUDE_EVENT_STREAM_STALL_TIMEOUT_MS;
  if (!raw) return 120_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 120_000;
})();
// Longer patience while a tool is actively executing (SDK emits no events during tool runs)
const TOOL_ACTIVE_STALL_TIMEOUT_MS = (() => {
  const raw = process.env.CLAUDE_TOOL_ACTIVE_STALL_TIMEOUT_MS;
  if (!raw) return 180_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 180_000;
})();

// Model configuration
export type EffortLevel = "low" | "medium" | "high";

export const EFFORT_DISPLAY: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High (default)",
};

const PREFS_FILE = `/tmp/claude-telegram-${TOKEN_PREFIX}-prefs.json`;

interface UserPrefs {
  model: string;
  effort: EffortLevel;
  activeDriver?: "claude" | "codex";
}

function loadPrefs(): Partial<UserPrefs> {
  try {
    const text = readFileSync(PREFS_FILE, "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function savePrefs(prefs: UserPrefs): Promise<void> {
  try {
    await Bun.write(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (error) {
    claudeLog.warn({ err: error }, "Failed to save preferences");
  }
}

// Available models — update when new models are released
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

const AVAILABLE_MODELS: ModelInfo[] = [
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Most capable for complex work" },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Best for everyday tasks" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

export function getAvailableModels(): ModelInfo[] {
  return AVAILABLE_MODELS;
}

export class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  lastAssistantMessage: string | null = null;
  conversationTitle: string | null = null;
  recentMessages: RecentMessage[] = []; // Rolling buffer for resume preview

  private static readonly MAX_RECENT_MESSAGES = 10; // Keep last 10 turns (5 exchanges)
  private static readonly MAX_MESSAGE_TEXT = 500; // Truncate individual messages

  /** Push a user or assistant message into the rolling buffer. */
  pushRecentMessage(role: "user" | "assistant", text: string): void {
    const truncated = text.length > ClaudeSession.MAX_MESSAGE_TEXT
      ? text.slice(0, ClaudeSession.MAX_MESSAGE_TEXT - 3) + "..."
      : text;
    this.recentMessages.push({
      role,
      text: truncated,
      timestamp: new Date().toISOString(),
    });
    // Keep only the last N
    if (this.recentMessages.length > ClaudeSession.MAX_RECENT_MESSAGES) {
      this.recentMessages = this.recentMessages.slice(-ClaudeSession.MAX_RECENT_MESSAGES);
    }
  }

  // Driver selection
  private _activeDriver: "claude" | "codex" = "claude";

  // Model settings (loaded from disk)
  private _model: string;
  private _effort: EffortLevel;

  get model(): string { return this._model; }
  set model(value: string) {
    this._model = value;
    void savePrefs({ model: this._model, effort: this._effort, activeDriver: this._activeDriver });
  }

  get effort(): EffortLevel { return this._effort; }
  set effort(value: EffortLevel) {
    this._effort = value;
    void savePrefs({ model: this._model, effort: this._effort, activeDriver: this._activeDriver });
  }

  get activeDriver(): "claude" | "codex" { return this._activeDriver; }
  set activeDriver(value: "claude" | "codex") {
    this._activeDriver = value;
    void savePrefs({ model: this._model, effort: this._effort, activeDriver: this._activeDriver });
    claudeLog.info({ driver: value }, `Switched to ${value} driver`);
  }

  constructor() {
    const prefs = loadPrefs();
    this._model = prefs.model || "claude-opus-4-6";
    this._effort = prefs.effort || "high";

    const preferredDriver = prefs.activeDriver || "claude";
    let resolvedDriver: "claude" | "codex" = preferredDriver;

    if (resolvedDriver === "codex" && !CODEX_AVAILABLE) {
      resolvedDriver = "claude";
      claudeLog.warn(
        "Saved active driver is codex, but Codex is unavailable; falling back to claude."
      );
    }

    // Claude Code is the default agent for the meta agent.
    // Do NOT auto-fallback to Codex — require explicit user action via /switch.
    if (resolvedDriver === "claude" && !CLAUDE_CLI_AVAILABLE) {
      claudeLog.error(
        "Claude CLI is unavailable. The meta agent requires Claude Code. Install it or set CLAUDE_CLI_PATH."
      );
    }

    this._activeDriver = resolvedDriver;
    if (resolvedDriver !== preferredDriver) {
      void savePrefs({
        model: this._model,
        effort: this._effort,
        activeDriver: this._activeDriver,
      });
    }

    if (prefs.model || prefs.effort || prefs.activeDriver) {
      claudeLog.info(
        { model: this._model, effort: this._effort, driver: this._activeDriver },
        `Loaded preferences: model=${this._model}, effort=${this._effort}, driver=${this._activeDriver}`
      );
    }
  }

  private activeProcess: import("bun").Subprocess | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  // Exposed so the stop handler can kill typing immediately
  private _typingController: { stop: () => void } | null = null;

  set typingController(ctrl: { stop: () => void } | null) {
    this._typingController = ctrl;
  }

  /**
   * Stop the typing indicator immediately (called from stop handler).
   */
  stopTyping(): void {
    if (this._typingController) {
      this._typingController.stop();
      this._typingController = null;
    }
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  get isStopRequested(): boolean {
    return this.stopRequested;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, kill the process
    if (this.isQueryRunning && this.activeProcess) {
      this.stopRequested = true;
      this.activeProcess.kill();
      claudeLog.info("Stop requested - killing claude process");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      claudeLog.info("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    source: DriverRunSource = "text"
  ): Promise<string> {
    const turnStartedAt = new Date();
    const sessionIdAtStart = this.sessionId;
    const claudeMdSnapshot = readClaudeMdSnapshot(WORKING_DIR);
    const claudeMdLoaded = claudeMdSnapshot.loaded;
    let messageToSend = message;
    let metaAgentInboxText = "";
    let metaAgentInboxItemIds: string[] = [];
    let turnStatus: TurnLogStatus = "completed";
    let turnError: string | null = null;
    let turnResponse: string | null = null;
    let turnUsage: TokenUsage | null = null;
    let isNewSession = false;

    try {
    // Acquire the query lock IMMEDIATELY to prevent TOCTOU races.
    // Without this, two callers can both check isRunning (false), then both
    // enter this method and resume the same session concurrently — producing
    // ghost responses (in=0 out=0) and stalls.
    this.isQueryRunning = true;

    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
      writeMcpConfig(chatId);
    }

    isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    if (isNewSession) {
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
      messageToSend = datePrefix + message;
    }

    if (chatId && shouldInjectMetaAgentInbox(source)) {
      const inboxItems = listPendingMetaAgentInboxItems({ chatId });
      if (inboxItems.length > 0) {
        metaAgentInboxText = buildMetaAgentInboxPrompt(inboxItems);
        metaAgentInboxItemIds = inboxItems.map((item) => item.id);
        messageToSend = injectMetaAgentInboxIntoPrompt(messageToSend, metaAgentInboxText);
      }
    }

    // Store latest user message for session previews.
    this.lastMessage = message;
    this.pushRecentMessage("user", message);

    // Build claude CLI args
    const claudeBin = process.env.CLAUDE_CODE_PATH || CLAUDE_CLI_PATH;
    const args: string[] = [
      claudeBin,
      "-p", messageToSend,
      "--verbose",
      "--output-format", "stream-json",
      "--model", this.model,
      "--dangerously-skip-permissions",
      "--allowedTools", getClaudeAllowedTools(claudeBin).join(","),
      "--setting-sources", "user,project",
    ];

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    if (META_PROMPT) {
      args.push("--system-prompt", META_PROMPT);
    }
    if (this.effort !== "high") {
      args.push("--effort", this.effort);
    }
    if (thinkingTokens > 0) {
      args.push("--max-thinking-tokens", String(thinkingTokens));
    }
    for (const dir of ALLOWED_PATHS) {
      args.push("--add-dir", dir);
    }
    if (Object.keys(MCP_SERVERS).length > 0) {
      args.push("--mcp-config", MCP_CONFIG_FILE);
    }

    if (this.sessionId && !isNewSession) {
      claudeLog.info(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (model=${this.model}, effort=${this.effort}, thinking=${thinkingLabel})`
      );
    } else {
      claudeLog.info(
        `STARTING new Claude session (model=${this.model}, effort=${this.effort}, thinking=${thinkingLabel})`
      );
      this.sessionId = null;
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      claudeLog.info(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      this.isQueryRunning = false; // Release the lock before bailing
      throw new Error("Query cancelled");
    }

    // Spawn claude CLI process
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    const proc = Bun.spawn(args, {
      cwd: WORKING_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.activeProcess = proc;

    // Emit thinking placeholder immediately so the user sees feedback
    // before any CLI events arrive (thinking creates a silent gap).
    if (thinkingTokens > 0) {
      await statusCallback("thinking_start", "");
    }

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;
    let stalled = false;
    let toolActive = false; // true between tool_use event and next non-tool event

    try {
      // Read stdout line by line — each line is a JSON event from stream-json
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const stallTimeoutSentinel = Symbol("event-stream-stall-timeout");

      while (true) {
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const activeTimeout = toolActive ? TOOL_ACTIVE_STALL_TIMEOUT_MS : EVENT_STREAM_STALL_TIMEOUT_MS;
        const nextResult = await Promise.race<
          { done: boolean; value?: Uint8Array } | typeof stallTimeoutSentinel
        >([
          reader.read(),
          new Promise<typeof stallTimeoutSentinel>((resolve) => {
            stallTimer = setTimeout(
              () => resolve(stallTimeoutSentinel),
              activeTimeout
            );
          }),
        ]);
        if (stallTimer) {
          clearTimeout(stallTimer);
        }

        if (nextResult === stallTimeoutSentinel) {
          stalled = true;
          claudeLog.warn(
            `Event stream stalled for ${activeTimeout}ms (tool_active=${toolActive}); killing process and flushing partial response`
          );
          proc.kill();
          break;
        }

        if (nextResult.done) {
          break;
        }

        buffer += decoder.decode(nextResult.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: StreamJsonEvent;
          try {
            event = JSON.parse(trimmed);
          } catch {
            claudeLog.warn(`Failed to parse stream-json line: ${trimmed.slice(0, 100)}`);
            continue;
          }

          // Check for abort
          if (this.stopRequested) {
            claudeLog.info("Query aborted by user");
            proc.kill();
            break;
          }

          // Capture session_id from first message
          if (!this.sessionId && event.session_id) {
            this.sessionId = event.session_id;
            claudeLog.info({ sessionId: this.sessionId }, `GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
            await this.saveSession();
          }

          // Handle different message types
          if (event.type === "assistant" && event.message) {
            // Reset tool-active flag when we receive a new assistant message
            toolActive = false;

            for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                claudeLog.info(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              toolActive = true; // Tool is executing — use longer stall patience
              const toolName = block.name || "";
              const toolInput = (block.input || {}) as Record<string, unknown>;

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  claudeLog.warn({ reason, tool: "Bash" }, `BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  continue;
                }
              }

              // Safety check for file operations
              if (["Read", "Write", "Edit"].includes(toolName)) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  // Allow reads from temp paths and .claude directories
                  const isTmpRead =
                    toolName === "Read" &&
                    (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    claudeLog.warn(
                      `BLOCKED: File access outside allowed paths: ${filePath}`
                    );
                    await statusCallback("tool", `Access denied: ${filePath}`);
                    continue;
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              claudeLog.info({ tool: toolName }, `Tool: ${toolDisplay}`);
              const normalizedToolName = toolName.toLowerCase().replace(/-/g, "_");
              const isAskUserTool =
                normalizedToolName === "mcp__ask_user" ||
                normalizedToolName.endsWith("__ask_user");
              const isSendTurtleTool =
                normalizedToolName === "mcp__send_turtle" ||
                normalizedToolName.endsWith("__send_turtle");
              const isBotControlActionTool =
                normalizedToolName === "mcp__bot_control" ||
                normalizedToolName.endsWith("__bot_control");
              const isPinoLogsTool =
                normalizedToolName === "mcp__pino_logs" ||
                normalizedToolName.endsWith("__pino_logs");
              const isBotControlServerTool =
                normalizedToolName.startsWith("mcp__bot_control");

              // Don't show tool status for MCP tools that handle their own output
              if (
                !isAskUserTool &&
                !isSendTurtleTool &&
                !isBotControlServerTool &&
                !isPinoLogsTool
              ) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (isAskUserTool && ctx && chatId) {
                claudeLog.info(
                  { tool: toolName, chatId },
                  "Ask-user tool completed, checking for pending requests"
                );
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    claudeLog.info(
                      { tool: toolName, chatId, attempt: attempt + 1 },
                      "Ask-user buttons sent, ask_user triggered"
                    );
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Check for pending send_turtle requests after send-turtle MCP tool
              if (isSendTurtleTool && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const photoSent = await checkPendingSendTurtleRequests(
                    ctx,
                    chatId
                  );
                  if (photoSent) break;
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Fulfil bot-control requests (usage, model switch, sessions)
              // The MCP server is polling the request file — we execute and write the result back.
              if (isBotControlActionTool && chatId) {
                await new Promise((resolve) => setTimeout(resolve, 200));

                for (let attempt = 0; attempt < 3; attempt++) {
                  const handled = await checkPendingBotControlRequests(
                    this,
                    chatId
                  );
                  if (handled) break;
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Fulfil pino-logs requests (read recent pino log entries).
              if (isPinoLogsTool && chatId) {
                await new Promise((resolve) => setTimeout(resolve, 200));

                for (let attempt = 0; attempt < 3; attempt++) {
                  const handled = await checkPendingPinoLogsRequests(chatId);
                  if (handled) break;
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }
            }

            // Text content
            if (block.type === "text" && block.text) {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            proc.kill();
            break;
          }
        }

          // Result message
          if (event.type === "result") {
            claudeLog.info("Response complete");
            queryCompleted = true;

            // Capture usage if available
            if (event.usage) {
              this.lastUsage = event.usage as TokenUsage;
              turnUsage = event.usage as TokenUsage;
              const u = this.lastUsage;
              claudeLog.info(
                `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                  u.cache_read_input_tokens || 0
                } cache_create=${u.cache_creation_input_tokens || 0}`
              );
            }
          }
        } // end for-each line

        // If stop was requested inside the line loop, break the outer read loop
        if (this.stopRequested || askUserTriggered) {
          break;
        }
      } // end while (reader.read())

      if (stalled) {
        claudeLog.info("Stall recovery activated; continuing with partial response flush");
      }

      // Wait for the process to exit
      await proc.exited;
    } catch (error) {
      const normalizedError = normalizeQueryError(error);
      const errorStr = normalizedError.message.toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");
      const isPostCompletionError = queryCompleted || askUserTriggered;
      const isStallAbort = stalled;

      // Claude CLI may exit non-zero after emitting a completed "result" event.
      // Treat that as success to avoid duplicate retries/errors.
      if (
        (isCleanupError &&
          (isPostCompletionError || this.stopRequested || isStallAbort)) ||
        isStallAbort ||
        isPostCompletionError
      ) {
        claudeLog.warn(
          `Suppressed post-completion error: ${normalizedError.message}`
        );
      } else {
        claudeLog.error({ err: normalizedError }, `Error in query: ${normalizedError.message}`);
        this.lastError = normalizedError.message.slice(0, 100);
        this.lastErrorTime = new Date();
        throw normalizedError;
      }
    } finally {
      this.isQueryRunning = false;
      this.activeProcess = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    // If we hit stall timeout without a completed result, surface it to caller.
    // The caller can then run an explicit continuation pass instead of returning
    // a potentially partial/ambiguous outcome as if it were complete.
    if (stalled && !queryCompleted && !askUserTriggered) {
      const stallError = new Error(
        `Event stream stalled for ${EVENT_STREAM_STALL_TIMEOUT_MS}ms before completion`
      );
      this.lastError = stallError.message.slice(0, 100);
      this.lastErrorTime = new Date();
      throw stallError;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      turnResponse = "[Waiting for user selection]";
      return turnResponse;
    }

    // Detect empty response (in=0 out=0) — typically means the resumed session
    // is stale or expired. Throw so the caller can retry with a fresh session.
    const responseText = responseParts.join("");
    if (!responseText && turnUsage) {
      const u = turnUsage;
      if (u.input_tokens === 0 && u.output_tokens === 0) {
        claudeLog.warn(
          "Empty response detected (in=0 out=0) — session likely stale, clearing for retry"
        );
        // Clear the stale session so the retry starts fresh
        this.sessionId = null;
        await statusCallback("done", "");
        throw new Error("Empty response from stale session");
      }
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    this.lastAssistantMessage = responseText || null;
    if (responseText) {
      this.pushRecentMessage("assistant", responseText);
    }
    // Persist the rolling buffer after each assistant response so /resume previews are fresh.
    await this.saveSession();
    turnResponse = responseText || "No response from Claude.";
    return turnResponse;
  } catch (error) {
    turnError = getErrorMessage(error).slice(0, 4000);
    const errorLower = turnError.toLowerCase();
    turnStatus =
      errorLower.includes("abort") || errorLower.includes("cancel")
        ? "cancelled"
        : "error";
    throw error;
  } finally {
    const completedAt = new Date();
    const usage: TurnLogUsage | null = turnUsage
      ? {
          inputTokens: turnUsage.input_tokens,
          outputTokens: turnUsage.output_tokens,
          cacheReadInputTokens: turnUsage.cache_read_input_tokens,
          cacheCreateInputTokens: turnUsage.cache_creation_input_tokens,
        }
      : null;

      const turnEntry = appendTurnLogEntry({
        driver: "claude",
        source,
        sessionId: this.sessionId || sessionIdAtStart,
      userId,
      username,
      chatId: chatId ?? 0,
      model: this.model,
      effort: this.effort,
      originalMessage: message,
      effectivePrompt: messageToSend,
        injectedArtifacts: buildInjectedArtifacts({
          source,
          effectivePrompt: messageToSend,
          originalMessage: message,
          datePrefixApplied: isNewSession,
          metaPromptApplied: META_PROMPT.length > 0,
          claudeMdLoaded,
          claudeMdText: claudeMdSnapshot.text,
          metaPromptText: META_PROMPT,
          metaAgentInboxText,
        }),
      injections: {
        datePrefixApplied: isNewSession,
        metaPromptApplied: META_PROMPT.length > 0,
        cronScheduledPromptApplied: source === "cron_scheduled",
        backgroundSnapshotPromptApplied: source === "background_snapshot",
      },
      context: {
        claudeMdLoaded,
        metaSharedLoaded: META_PROMPT.length > 0,
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
          driver: "claude",
          turnId: turnEntry.id,
          sessionId: turnEntry.sessionId,
        });
      }
    }
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    // Persist the linked session before clearing so /resume remains stable
    // across driver switches and explicit resets.
    await this.saveSession();
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    this.recentMessages = [];
    claudeLog.info("Session cleared");
  }

  /**
   * Save session to disk for resume after restart.
   * Saves to multi-session history format.
   */
  async saveSession(): Promise<void> {
    if (!this.sessionId) return;

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
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: this.conversationTitle || "Untitled session",
        ...(preview ? { preview } : {}),
        ...(this.recentMessages.length > 0 ? { recentMessages: this.recentMessages } : {}),
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last MAX_SESSIONS
      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      // Save
      await Bun.write(SESSION_FILE, JSON.stringify(history, null, 2));
      claudeLog.info({ sessionFile: SESSION_FILE, sessionId: this.sessionId }, `Session saved to ${SESSION_FILE}`);
    } catch (error) {
      claudeLog.warn({ err: error }, "Failed to save session");
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved sessions for display.
   */
  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    // Filter to only sessions for current working directory
    return history.sessions.filter(
      (s) => !s.working_dir || s.working_dir === WORKING_DIR
    );
  }

  /**
   * Resume a specific session by ID.
   */
  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Session not found"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [
        false,
        `Session belongs to a different directory: ${sessionData.working_dir}`,
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();
    const resumeHistory =
      buildTurnLogHistory("claude", sessionId)
      || buildSavedSessionHistory(sessionData);
    if (resumeHistory) {
      this.recentMessages = toRecentMessages(
        resumeHistory,
        ClaudeSession.MAX_RECENT_MESSAGES,
        ClaudeSession.MAX_MESSAGE_TEXT
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
    void this.saveSession();

    claudeLog.info(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Resumed session: "${sessionData.title}"`,
    ];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "No saved sessions"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }
}

// Global session instance
export const session = new ClaudeSession();
