import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import type { McpServerConfig } from "./types";
import { logger } from "./logger";

const runtimeLog = logger.child({ module: "managed-runtime-connectors" });
const MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH = ".superturtle/managed-runtime.json";

type ManagedConnectorCapabilityProfile = {
  allowedTools?: string[] | null;
  mode?: "read_only" | "read_write" | null;
};

type ManagedRuntimeManifestConnector =
  | {
      access_token_env: string;
      auth_injection?: "bearer_header";
      capability_profile?: ManagedConnectorCapabilityProfile | null;
      readiness?: "needs_auth" | "needs_setup" | "ready" | "refresh_failed";
      server_name: string;
      tools_header_env?: string | null;
      transport: "remote_http";
      url_env: string;
    }
  | {
      args?: string[];
      auth_injection?: "env_token";
      capability_profile?: ManagedConnectorCapabilityProfile | null;
      command_env: string;
      env_map?: Record<string, string> | null;
      readiness?: "needs_auth" | "needs_setup" | "ready" | "refresh_failed";
      server_name: string;
      transport: "local_stdio";
      working_dir_env?: string | null;
    };

type ManagedRuntimeManifest = {
  connectors?: Record<string, ManagedRuntimeManifestConnector> | null;
};

function readManagedRuntimeManifest(workingDir: string): ManagedRuntimeManifest | null {
  const manifestPath = resolve(workingDir, MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as ManagedRuntimeManifest;
  } catch (error) {
    runtimeLog.warn({ err: error, manifestPath }, "Failed to read managed runtime manifest");
    return null;
  }
}

function buildRemoteHttpServer(
  connector: Extract<ManagedRuntimeManifestConnector, { transport: "remote_http" }>
): McpServerConfig | null {
  const url = process.env[connector.url_env]?.trim();
  const accessToken = process.env[connector.access_token_env]?.trim();
  if (!url || !accessToken) {
    return null;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (connector.tools_header_env) {
    const tools = process.env[connector.tools_header_env]?.trim();
    if (tools) {
      headers["X-MCP-Tools"] = tools;
    }
  }

  return {
    type: "http",
    url,
    headers,
  };
}

function buildLocalStdioServer(
  connector: Extract<ManagedRuntimeManifestConnector, { transport: "local_stdio" }>
): McpServerConfig | null {
  const command = process.env[connector.command_env]?.trim();
  if (!command) {
    return null;
  }

  const env: Record<string, string> = {};
  for (const [targetEnv, sourceEnv] of Object.entries(connector.env_map || {})) {
    const value = process.env[sourceEnv]?.trim();
    if (value) {
      env[targetEnv] = value;
    }
  }

  const cwd = connector.working_dir_env
    ? process.env[connector.working_dir_env]?.trim() || undefined
    : undefined;

  return {
    command,
    ...(connector.args?.length ? { args: connector.args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function loadManagedRuntimeConnectorServers(workingDir: string): Record<string, McpServerConfig> {
  const manifest = readManagedRuntimeManifest(workingDir);
  const connectors = manifest?.connectors;
  if (!connectors) {
    return {};
  }

  const resolved: Record<string, McpServerConfig> = {};
  for (const [name, connector] of Object.entries(connectors)) {
    if (connector.readiness && connector.readiness !== "ready") {
      continue;
    }

    const config =
      connector.transport === "remote_http"
        ? buildRemoteHttpServer(connector)
        : buildLocalStdioServer(connector);
    if (!config) {
      runtimeLog.warn({ connector: name, transport: connector.transport }, "Skipping connector missing runtime env");
      continue;
    }
    resolved[name] = config;
  }

  return resolved;
}
