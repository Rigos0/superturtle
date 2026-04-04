import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadManagedRuntimeConnectorServers } from "./managed-runtime-connectors";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.SUPERTURTLE_GITHUB_MCP_SERVER_BIN;
  delete process.env.SUPERTURTLE_GITHUB_MCP_ACCESS_TOKEN;
  delete process.env.SUPERTURTLE_LINEAR_MCP_URL;
  delete process.env.SUPERTURTLE_LINEAR_MCP_ACCESS_TOKEN;
  delete process.env.SUPERTURTLE_LINEAR_MCP_TOOLS;
  delete process.env.SUPER_TURTLE_DIR;
});

describe("loadManagedRuntimeConnectorServers", () => {
  it("resolves local stdio connectors from the managed runtime manifest", () => {
    const projectRoot = createManagedProject({
      connectors: {
        github: {
          transport: "local_stdio",
          server_name: "github",
          command_env: "SUPERTURTLE_GITHUB_MCP_SERVER_BIN",
          args: ["stdio"],
          env_map: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "SUPERTURTLE_GITHUB_MCP_ACCESS_TOKEN",
          },
          auth_injection: "env_token",
          readiness: "ready",
          capability_profile: {
            mode: "read_write",
            allowedTools: ["get_me"],
          },
        },
      },
    });

    process.env.SUPERTURTLE_GITHUB_MCP_SERVER_BIN = "/home/user/.local/bin/github-mcp-server";
    process.env.SUPERTURTLE_GITHUB_MCP_ACCESS_TOKEN = "ghu_test_token";

    expect(loadManagedRuntimeConnectorServers(projectRoot)).toEqual({
      github: {
        command: "/home/user/.local/bin/github-mcp-server",
        args: ["stdio"],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "ghu_test_token",
        },
      },
    });
  });

  it("resolves remote http connectors from the managed runtime manifest", () => {
    const projectRoot = createManagedProject({
      connectors: {
        linear: {
          transport: "remote_http",
          server_name: "linear",
          url_env: "SUPERTURTLE_LINEAR_MCP_URL",
          access_token_env: "SUPERTURTLE_LINEAR_MCP_ACCESS_TOKEN",
          tools_header_env: "SUPERTURTLE_LINEAR_MCP_TOOLS",
          auth_injection: "bearer_header",
          readiness: "ready",
          capability_profile: {
            mode: "read_write",
            allowedTools: ["list_issues"],
          },
        },
      },
    });

    process.env.SUPERTURTLE_LINEAR_MCP_URL = "https://mcp.linear.app/sse";
    process.env.SUPERTURTLE_LINEAR_MCP_ACCESS_TOKEN = "linear-token";
    process.env.SUPERTURTLE_LINEAR_MCP_TOOLS = "list_issues,issue";

    expect(loadManagedRuntimeConnectorServers(projectRoot)).toEqual({
      linear: {
        type: "http",
        url: "https://mcp.linear.app/sse",
        headers: {
          Authorization: "Bearer linear-token",
          "X-MCP-Tools": "list_issues,issue",
        },
      },
    });
  });

  it("skips connectors that are not ready", () => {
    const projectRoot = createManagedProject({
      connectors: {
        notion: {
          transport: "local_stdio",
          server_name: "notion",
          command_env: "SUPERTURTLE_NOTION_MCP_SERVER_BIN",
          auth_injection: "env_token",
          readiness: "needs_setup",
          capability_profile: {
            mode: "read_only",
          },
        },
      },
    });

    expect(loadManagedRuntimeConnectorServers(projectRoot)).toEqual({});
  });

  it("resolves working_dir_env into stdio cwd", () => {
    const projectRoot = createManagedProject({
      connectors: {
        notion: {
          transport: "local_stdio",
          server_name: "notion",
          command_env: "SUPERTURTLE_NOTION_MCP_COMMAND",
          args: ["run", "claude-telegram-bot/notion_mcp/server.ts"],
          working_dir_env: "SUPER_TURTLE_DIR",
          env_map: {
            NOTION_API_TOKEN: "SUPERTURTLE_NOTION_MCP_ACCESS_TOKEN",
          },
          auth_injection: "env_token",
          readiness: "ready",
          capability_profile: {
            mode: "read_write",
            allowedTools: ["get_me"],
          },
        },
      },
    });

    process.env.SUPERTURTLE_NOTION_MCP_COMMAND = "bun";
    process.env.SUPERTURTLE_NOTION_MCP_ACCESS_TOKEN = "secret-notion-token";
    process.env.SUPER_TURTLE_DIR = "/home/user/app/node_modules/superturtle";

    expect(loadManagedRuntimeConnectorServers(projectRoot)).toEqual({
      notion: {
        command: "bun",
        args: ["run", "claude-telegram-bot/notion_mcp/server.ts"],
        cwd: "/home/user/app/node_modules/superturtle",
        env: {
          NOTION_API_TOKEN: "secret-notion-token",
        },
      },
    });
  });
});

function createManagedProject(manifest: Record<string, unknown>) {
  const projectRoot = mkdtempSync(join(tmpdir(), "managed-runtime-connectors-"));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, ".superturtle"), { recursive: true });
  writeFileSync(join(projectRoot, ".superturtle", "managed-runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return projectRoot;
}
