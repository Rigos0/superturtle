import type { Context } from "grammy";
import { codexSession } from "./codex-session";
import {
  DEFAULT_CODEX_EFFORT,
  type CodexEffortLevel,
} from "./config";
import { getAvailableCodexModels } from "./codex-session";
import type { DriverRunSource } from "./drivers/types";
import type {
  RecentMessage,
  SavedSession,
  StatusCallback,
} from "./types";

export type EffortLevel = CodexEffortLevel;

export const EFFORT_DISPLAY: Record<EffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export function getAvailableModels() {
  return getAvailableCodexModels();
}

export class ClaudeSession {
  private processingDepth = 0;
  private interruptRequested = false;
  private _typingController: { stop: () => void } | null = null;
  private sessionIdOverride: string | null | undefined;
  private conversationTitleOverride: string | null | undefined;
  currentTool: string | null = null;
  lastTool: string | null = null;

  get model(): string {
    return codexSession.model;
  }

  set model(value: string) {
    codexSession.model = value;
  }

  get effort(): EffortLevel {
    return codexSession.reasoningEffort;
  }

  set effort(value: EffortLevel) {
    codexSession.reasoningEffort = value;
  }

  get activeDriver(): "claude" | "codex" {
    return "codex";
  }

  set activeDriver(_value: "claude" | "codex") {
    // Codex-only runtime; driver switching no longer exists.
  }

  get sessionId(): string | null {
    return this.sessionIdOverride !== undefined
      ? this.sessionIdOverride
      : codexSession.getThreadId();
  }

  set sessionId(value: string | null) {
    this.sessionIdOverride = value;
  }

  get isActive(): boolean {
    return codexSession.isActive;
  }

  get isRunning(): boolean {
    return codexSession.isRunning || this.processingDepth > 0;
  }

  get queryStarted(): Date | null {
    return codexSession.runningSince;
  }

  get lastActivity(): Date | null {
    return codexSession.lastActivity;
  }

  set lastActivity(value: Date | null) {
    codexSession.lastActivity = value;
  }

  get lastError(): string | null {
    return codexSession.lastError;
  }

  set lastError(value: string | null) {
    codexSession.lastError = value;
  }

  get lastErrorTime(): Date | null {
    return codexSession.lastErrorTime;
  }

  set lastErrorTime(value: Date | null) {
    codexSession.lastErrorTime = value;
  }

  get lastUsage(): { input_tokens: number; output_tokens: number } | null {
    return codexSession.lastUsage;
  }

  set lastUsage(value: { input_tokens: number; output_tokens: number } | null) {
    codexSession.lastUsage = value;
  }

  get lastMessage(): string | null {
    return codexSession.lastMessage;
  }

  set lastMessage(value: string | null) {
    codexSession.lastMessage = value;
  }

  get lastAssistantMessage(): string | null {
    return codexSession.lastAssistantMessage;
  }

  set lastAssistantMessage(value: string | null) {
    codexSession.lastAssistantMessage = value;
  }

  get recentMessages(): RecentMessage[] {
    return codexSession.recentMessages;
  }

  set recentMessages(value: RecentMessage[]) {
    codexSession.recentMessages = value;
  }

  get conversationTitle(): string | null {
    if (this.conversationTitleOverride !== undefined) {
      return this.conversationTitleOverride;
    }
    const source = this.lastMessage?.trim() || "";
    if (!source) return null;
    return source.length > 50 ? `${source.slice(0, 47)}...` : source;
  }

  set conversationTitle(value: string | null) {
    this.conversationTitleOverride = value;
  }

  get typingController(): { stop: () => void } | null {
    return this._typingController;
  }

  set typingController(value: { stop: () => void } | null) {
    this._typingController = value;
  }

  startProcessing(): () => void {
    this.processingDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.processingDepth = Math.max(0, this.processingDepth - 1);
    };
  }

  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback?: StatusCallback,
    chatId = 0,
    _ctx?: Context,
    source: DriverRunSource = "text"
  ): Promise<string> {
    return codexSession.sendMessage(
      message,
      statusCallback,
      this.model,
      this.effort,
      undefined,
      source,
      userId,
      username,
      chatId
    );
  }

  async stop(): Promise<"stopped" | "pending" | false> {
    return codexSession.stop();
  }

  clearStopRequested(): void {
    codexSession.clearStopRequested();
  }

  get isStopRequested(): boolean {
    return codexSession.isStopRequested;
  }

  forceResetRunState(): void {
    this.processingDepth = 0;
    codexSession.forceResetRunState();
  }

  async kill(): Promise<void> {
    this.processingDepth = 0;
    this.sessionIdOverride = undefined;
    this.conversationTitleOverride = undefined;
    await codexSession.kill();
  }

  getSessionList(): SavedSession[] {
    return codexSession.getSessionList();
  }

  async resumeSession(sessionId: string): Promise<[boolean, string]> {
    return codexSession.resumeSession(sessionId);
  }

  async resumeLast(): Promise<[boolean, string]> {
    return codexSession.resumeLast();
  }

  stopTyping(): void {
    this._typingController?.stop();
    this._typingController = null;
  }

  markInterrupt(): void {
    this.interruptRequested = true;
  }

  consumeInterruptFlag(): boolean {
    const flagged = this.interruptRequested;
    this.interruptRequested = false;
    return flagged;
  }
}

export const session = new ClaudeSession();

if (!session.effort) {
  session.effort = DEFAULT_CODEX_EFFORT;
}
