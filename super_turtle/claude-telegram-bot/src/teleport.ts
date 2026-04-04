import {
  SUPERTURTLE_DRIVER,
  SUPERTURTLE_RUNTIME_PROFILE,
  TELEPORT_DISABLED_MESSAGE,
  WORKING_DIR,
} from "./config";

const teleportLib = require("../../bin/e2b-webhook-poc-lib.js");

export type TeleportOwnerMode = "local" | "remote";
export type RuntimeRole = "local" | "teleport-remote";
export type RemoteMode = "control" | "agent";
export type TeleportProgressStage =
  | "preparing"
  | "connecting_sandbox"
  | "creating_sandbox"
  | "configuring_remote"
  | "bootstrapping_auth"
  | "starting_remote"
  | "waiting_ready"
  | "switching_telegram"
  | "verifying_cutover"
  | "releasing_telegram"
  | "verifying_release"
  | "pausing_remote"
  | "done";

export type TeleportProgressEvent = {
  stage: TeleportProgressStage;
  sandboxId?: string;
  remoteMode?: RemoteMode;
};

type TeleportProgressHandler = (event: TeleportProgressEvent) => void | Promise<void>;

export type TeleportState = {
  version: number;
  repoRoot: string;
  ownerMode?: TeleportOwnerMode;
  remoteMode?: RemoteMode;
  remoteDriver?: "codex" | null;
  sandboxId: string;
  host: string;
  port: number;
  timeoutMs: number;
  remoteRoot: string;
  runtimeInstallSpec?: string | null;
  webhookPath: string;
  webhookSecret: string;
  webhookUrl: string;
  healthPath: string;
  healthUrl: string;
  readyPath?: string;
  readyUrl?: string;
  logPath: string;
  pidPath: string;
  updatedAt: string;
};

const HOME_RETURN_GRACE_MS = 30_000;

export const TELEPORT_CONTROL_MESSAGE =
  TELEPORT_DISABLED_MESSAGE;
export const TELEPORT_AGENT_TEXT_ONLY_MESSAGE =
  "This managed runtime currently supports text chat only in this branch.";

export const TELEPORT_REMOTE_CONTROL_ALLOWED_COMMANDS = new Set([
  "home",
  "status",
  "looplogs",
  "pinologs",
  "debug",
  "restart",
  "update",
]);
export const TELEPORT_REMOTE_AGENT_ALLOWED_COMMANDS = new Set([
  "home",
  "status",
  "looplogs",
  "pinologs",
  "debug",
  "restart",
  "stop",
  "update",
]);

export function isTeleportRemoteRuntime(): boolean {
  return SUPERTURTLE_RUNTIME_PROFILE === "managed";
}

export function isTeleportRemoteControlMode(): boolean {
  return false;
}

export function isTeleportRemoteAgentMode(): boolean {
  return isTeleportRemoteRuntime() && SUPERTURTLE_DRIVER === "codex";
}

export function getTeleportRemoteUnsupportedMessage(): string {
  return isTeleportRemoteRuntime() ? TELEPORT_AGENT_TEXT_ONLY_MESSAGE : TELEPORT_CONTROL_MESSAGE;
}

export async function launchTeleportRuntimeForCurrentProject(
  options: {
    remoteMode?: RemoteMode;
    remoteDriver?: "codex";
    onProgress?: TeleportProgressHandler;
  } = {}
): Promise<TeleportState> {
  return teleportLib.launchTeleportRuntime(WORKING_DIR, options);
}

export async function activateTeleportOwnershipForCurrentProject(
  options: { onProgress?: TeleportProgressHandler } = {}
): Promise<{
  state: TeleportState;
  webhookInfo: { result?: { url?: string } };
}> {
  return teleportLib.setRemoteWebhook(WORKING_DIR, options);
}

export async function releaseTeleportOwnershipForCurrentProject(
  options: { onProgress?: TeleportProgressHandler } = {}
): Promise<{
  state: TeleportState | null;
  webhookInfo: { result?: { url?: string } };
}> {
  return teleportLib.clearRemoteWebhook(WORKING_DIR, options);
}

export async function pauseTeleportSandboxForCurrentProject(
  options: { onProgress?: TeleportProgressHandler } = {}
): Promise<TeleportState> {
  return teleportLib.pauseTeleportSandbox(WORKING_DIR, options);
}

export async function reconcileTeleportOwnershipForCurrentProject(): Promise<TeleportState | null> {
  return teleportLib.reconcileTeleportOwnership(WORKING_DIR);
}

export function loadTeleportStateForCurrentProject(): TeleportState | null {
  return teleportLib.loadPocState(WORKING_DIR);
}

export function recentlyReturnedHome(
  state: TeleportState | null,
  nowMs: number = Date.now()
): boolean {
  if (!state || state.ownerMode !== "local" || !state.updatedAt) {
    return false;
  }

  const updatedAtMs = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return nowMs - updatedAtMs >= 0 && nowMs - updatedAtMs <= HOME_RETURN_GRACE_MS;
}
