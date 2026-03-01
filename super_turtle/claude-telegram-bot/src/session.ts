/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  CLAUDE_CLI_AVAILABLE,
  CODEX_AVAILABLE,
  MCP_SERVERS,
  META_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
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

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
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

const PREFS_FILE = "/tmp/claude-telegram-prefs.json";

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

function savePrefs(prefs: UserPrefs): void {
  try {
    Bun.write(PREFS_FILE, JSON.stringify(prefs, null, 2));
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
    savePrefs({ model: this._model, effort: this._effort, activeDriver: this._activeDriver });
  }

  get effort(): EffortLevel { return this._effort; }
  set effort(value: EffortLevel) {
    this._effort = value;
    savePrefs({ model: this._model, effort: this._effort, activeDriver: this._activeDriver });
  }

  get activeDriver(): "claude" | "codex" { return this._activeDriver; }
  set activeDriver(value: "claude" | "codex") {
    this._activeDriver = value;
    savePrefs({ model: this._model, effort: this._effort, activeDriver: this._activeDriver });
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
      savePrefs({
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

  private abortController: AbortController | null = null;
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
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      claudeLog.info("Stop requested - aborting current query");
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
    ctx?: Context
  ): Promise<string> {
    // Acquire the query lock IMMEDIATELY to prevent TOCTOU races.
    // Without this, two callers can both check isRunning (false), then both
    // enter this method and resume the same session concurrently — producing
    // ghost responses (in=0 out=0) and stalls.
    this.isQueryRunning = true;

    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
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

    // Store latest user message for session previews.
    this.lastMessage = message;
    this.pushRecentMessage("user", message);

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: this.model,
      cwd: WORKING_DIR,
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: META_PROMPT || undefined,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
      ...(this.effort !== "high" && { extraArgs: { effort: this.effort } }),
    };

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
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

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

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
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      });

      // Process streaming response with stall detection. If the SDK stream stops
      // yielding events without closing, break out and flush accumulated text.
      const iterator = queryInstance[Symbol.asyncIterator]();
      const stallTimeoutSentinel = Symbol("event-stream-stall-timeout");

      while (true) {
        const iteratorNext = iterator.next();
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const activeTimeout = toolActive ? TOOL_ACTIVE_STALL_TIMEOUT_MS : EVENT_STREAM_STALL_TIMEOUT_MS;
        const nextResult = await Promise.race<
          IteratorResult<SDKMessage> | typeof stallTimeoutSentinel
        >([
          iteratorNext,
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
            `Event stream stalled for ${activeTimeout}ms (tool_active=${toolActive}); aborting stream and flushing partial response`
          );
          this.abortController?.abort();
          break;
        }

        if (nextResult.done) {
          break;
        }

        const event = nextResult.value;
        // Check for abort
        if (this.stopRequested) {
          claudeLog.info("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          claudeLog.info({ sessionId: this.sessionId }, `GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession();
        }

        // Handle different message types
        if (event.type === "assistant") {
          // Reset tool-active flag when we receive a new assistant message
          // (tool results come as separate events before the next assistant message)
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
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  claudeLog.warn({ reason, tool: "Bash" }, `BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
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
                    throw new Error(`File access blocked: ${filePath}`);
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

              // Don't show tool status for MCP tools that handle their own output
              if (
                !toolName.startsWith("mcp__ask-user") &&
                !toolName.startsWith("mcp__send-turtle") &&
                !toolName.startsWith("mcp__bot-control") &&
                !toolName.startsWith("mcp__pino-logs")
              ) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
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
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Check for pending send_turtle requests after send-turtle MCP tool
              if (toolName.startsWith("mcp__send-turtle") && ctx && chatId) {
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
              if (toolName.startsWith("mcp__bot-control") && chatId) {
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
              if (toolName.startsWith("mcp__pino-logs") && chatId) {
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
            if (block.type === "text") {
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
            break;
          }
        }

        // Result message
        if (event.type === "result") {
          claudeLog.info("Response complete");
          queryCompleted = true;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            claudeLog.info(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
        }
      }

      if (stalled) {
        claudeLog.info("Stall recovery activated; continuing with partial response flush");
      }

      // V1 query completes automatically when the generator ends
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
      this.abortController = null;
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
      return "[Waiting for user selection]";
    }

    // Detect empty response (in=0 out=0) — typically means the resumed session
    // is stale or expired. Throw so the caller can retry with a fresh session.
    const responseText = responseParts.join("");
    if (!responseText && this.lastUsage) {
      const u = this.lastUsage;
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
    this.saveSession();
    return responseText || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
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
  saveSession(): void {
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
      Bun.write(SESSION_FILE, JSON.stringify(history, null, 2));
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
    this.recentMessages = sessionData.recentMessages || [];

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
