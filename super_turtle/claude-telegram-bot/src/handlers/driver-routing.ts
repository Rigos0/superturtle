import type { Context } from "grammy";
import { getCurrentDriver, getDriver } from "../drivers/registry";
import type { DriverId, DriverRunSource } from "../drivers/types";
import { CTL_PATH } from "../config";
import { session } from "../session";
import { codexSession } from "../codex-session";
import type { StatusCallback } from "../types";
import { isSpawnOrchestrationToolStatus } from "./streaming";
import { streamLog } from "../logger";

export interface DriverMessageInput {
  message: string;
  source: DriverRunSource;
  username: string;
  userId: number;
  chatId: number;
  ctx: Context;
  statusCallback: StatusCallback;
}

const MAX_RETRIES = 1;
const STOP_SETTLE_TIMEOUT_MS = 300;
const STOP_SETTLE_POLL_MS = 25;
let backgroundRunDepth = 0;
let backgroundRunPreempted = false;
let executingDriverId: DriverId | null = null;
const routingLog = streamLog.child({ handler: "driver-routing" });

function buildStallRecoveryPrompt(originalMessage: string): string {
  return `The previous response stream stalled before completion while handling this request.
Continue from current repository/runtime state and finish the task safely.
Before making changes, verify what already happened (for example existing files, running processes, or prior command effects).
Do not blindly repeat side-effecting operations that may have already succeeded.

Original request:
${originalMessage}`;
}

function buildSpawnOrchestrationRecoveryPrompt(originalMessage: string): string {
  return `The previous response stream stalled after SubTurtle spawn orchestration.
Continue from current repository/runtime state and finish the task safely.
Before taking any side-effecting action:
1) Run ${CTL_PATH} list and treat already-running SubTurtles as successfully spawned.
2) If any intended SubTurtles are missing, spawn only the missing ones.
3) Never re-run spawn commands for names that already exist or are running.
4) Report exact running names and any missing/failed names.

Original request:
${originalMessage}`;
}

export function isLikelyQuotaOrLimitError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("quota") ||
    text.includes("usage") ||
    text.includes("rate limit") ||
    text.includes("limit reached") ||
    text.includes("insufficient")
  );
}

export function isLikelyCancellationError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return text.includes("abort") || text.includes("cancel");
}

export function beginBackgroundRun(): void {
  backgroundRunDepth += 1;
}

export function endBackgroundRun(): void {
  backgroundRunDepth = Math.max(0, backgroundRunDepth - 1);
  if (backgroundRunDepth === 0) {
    backgroundRunPreempted = false;
  }
}

export function isBackgroundRunActive(): boolean {
  return backgroundRunDepth > 0;
}

export function wasBackgroundRunPreempted(): boolean {
  return backgroundRunPreempted;
}

export function getExecutingDriverId(): DriverId | null {
  return executingDriverId;
}

export function setExecutingDriverForTests(driverId: DriverId | null): void {
  executingDriverId = driverId;
}

export async function runMessageWithActiveDriver(
  input: DriverMessageInput
): Promise<string> {
  return runMessageWithDriver("codex", input);
}

export async function runMessageWithDriver(
  driverId: DriverId,
  input: DriverMessageInput
): Promise<string> {
  const driver = getDriver();
  let message = input.message;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let sawToolUse = false;
    let sawSpawnOrchestration = false;

    const trackingStatusCallback: StatusCallback = async (
      type,
      content,
      segmentId
    ) => {
      if (type === "tool") {
        sawToolUse = true;
        if (isSpawnOrchestrationToolStatus(content)) {
          sawSpawnOrchestration = true;
        }
      }
      await input.statusCallback(type, content, segmentId);
    };

    try {
      const previousExecutingDriverId = executingDriverId;
      executingDriverId = driverId;
      try {
        return await driver.runMessage({
          ...input,
          message,
          statusCallback: trackingStatusCallback,
        });
      } finally {
        executingDriverId = previousExecutingDriverId;
      }
    } catch (error) {
      routingLog.warn(
        {
          err: error,
          driverId,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          sawToolUse,
          sawSpawnOrchestration,
          chatId: input.chatId,
          userId: input.userId,
        },
        "Driver run attempt failed"
      );
      if (attempt >= MAX_RETRIES) {
        throw error;
      }

      if (driver.isStallError(error)) {
        if (sawSpawnOrchestration) {
          routingLog.info(
            { driverId, attempt: attempt + 1, action: "stall_spawn_orchestration_recovery" },
            "Applying spawn-orchestration recovery prompt"
          );
          message = buildSpawnOrchestrationRecoveryPrompt(message);
          continue;
        }

        if (!sawToolUse) {
          routingLog.info(
            { driverId, attempt: attempt + 1, action: "stall_kill_session_retry" },
            "Stall without tool use: killing driver session before retry"
          );
          await driver.kill();
        } else {
          routingLog.info(
            { driverId, attempt: attempt + 1, action: "stall_continuation_retry" },
            "Stall after tool use: continuing with recovery prompt"
          );
          message = buildStallRecoveryPrompt(message);
        }
        continue;
      }

      if (driver.isCrashError(error) && !sawToolUse) {
        routingLog.info(
          { driverId, attempt: attempt + 1, action: "crash_kill_session_retry" },
          "Crash without tool use: killing driver session before retry"
        );
        await driver.kill();
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unexpected driver retry state");
}

export function isActiveDriverSessionActive(): boolean {
  return getCurrentDriver().getStatusSnapshot().isActive;
}

export function getDriverAuditType(baseType: string): string {
  return `${baseType}_CODEX`;
}

export function isAnyDriverRunning(): boolean {
  return codexSession.isRunning || session.isRunning;
}

async function waitForDriversToBecomeIdle(timeoutMs = STOP_SETTLE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAnyDriverRunning()) {
      return true;
    }
    await Bun.sleep(STOP_SETTLE_POLL_MS);
  }
  return !isAnyDriverRunning();
}

function forceResetStuckDriverState(): void {
  if (session.isRunning) {
    session.forceResetRunState();
  }
  if (codexSession.isRunning) {
    codexSession.forceResetRunState();
  }
}

export async function preemptBackgroundRunForUserPriority(): Promise<boolean> {
  if (!isBackgroundRunActive()) {
    return false;
  }

  backgroundRunPreempted = true;
  const stopResult = await stopActiveDriverQuery();
  if (stopResult) {
    await Bun.sleep(100);
    return true;
  }
  return false;
}

export async function stopActiveDriverQuery(): Promise<"stopped" | "pending" | false> {
  const current = getCurrentDriver();
  const stopResult = await current.stop();

  if (!stopResult) {
    return false;
  }

  if (stopResult === "pending") {
    return stopResult;
  }

  const idle = await waitForDriversToBecomeIdle();
  if (!idle) {
    routingLog.warn(
      {
        activeDriver: "codex",
        stopResult,
        codexRunning: codexSession.isRunning,
        facadeRunning: session.isRunning,
      },
      "Driver stop did not settle; force-resetting stuck run state"
    );
    forceResetStuckDriverState();
  }

  return stopResult;
}
