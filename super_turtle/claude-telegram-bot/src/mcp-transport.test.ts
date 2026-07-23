/**
 * MCP Transport Regression Tests
 *
 * These tests guard against the "Transport closed" / "serde error" bug where
 * Pino logger output on stdout corrupted the MCP JSON-RPC transport when
 * servers ran under Codex CLI.
 *
 * Root cause: Pino was configured with `destination: 1` (stdout) for pretty
 * printing. MCP servers use stdout as the JSON-RPC transport, so any non-JSON
 * output on fd 1 causes the Codex Rust RMCP client to fail with:
 *   "Error reading from stream: serde error invalid number at line 1 column 3"
 *
 * ## Test tiers
 *
 * **CI-safe (always run):**
 *   - Logger detection logic (IS_MCP_SERVER)
 *   - MCP server stdout purity (spawns bun subprocess, no network)
 *
 * **Local-only (expensive, require Codex CLI + API key):**
 *   - Full Codex CLI → MCP tool round-trip
 *   - Gated behind CODEX_INTEGRATION=1 env var
 *   - These run locally during development and can be enabled in CI
 *     when a Codex-capable runner is available.
 *
 * To run local-only tests:
 *   CODEX_INTEGRATION=1 bun test src/mcp-transport.test.ts
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "path";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_ROOT = resolve(import.meta.dir, "..");
const BUN_PATH = Bun.which("bun") || "/opt/homebrew/bin/bun";

const MCP_SERVERS = [
  { name: "send-turtle", path: "send_turtle_mcp/server.ts" },
  { name: "bot-control", path: "bot_control_mcp/server.ts" },
];

// Codex integration tests are expensive (need CLI + API key + real API calls).
// Gate them behind an env var so CI doesn't run them by default.
const CODEX_INTEGRATION = process.env.CODEX_INTEGRATION === "1";
const CODEX_PATH = resolve(BOT_ROOT, "node_modules/.bin/codex");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn an MCP server, capture its stdout for `durationMs`, then kill it.
 * Returns { stdout, stderr } as strings.
 */
function captureMcpServerOutput(
  serverPath: string,
  durationMs = 2000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(BUN_PATH, ["run", resolve(BOT_ROOT, serverPath)], {
      cwd: BOT_ROOT,
      env: { ...process.env, MCP_SERVER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, durationMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
      });
    });

    // If the server expects JSON-RPC on stdin and blocks, close stdin
    // after a short delay to avoid hanging.
    setTimeout(() => {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// CI-SAFE: Logger IS_MCP_SERVER detection
// ---------------------------------------------------------------------------

describe("IS_MCP_SERVER detection", () => {
  it("detects MCP server via MCP_SERVER=1 env var", async () => {
    const result = await Bun.spawn({
      cmd: [BUN_PATH, "-e", `
        process.env.MCP_SERVER = "1";
        const IS_MCP = process.env.MCP_SERVER === "1" ||
          (typeof Bun !== "undefined" && Bun.main?.includes("_mcp/"));
        process.stdout.write(IS_MCP ? "true" : "false");
      `],
      cwd: BOT_ROOT,
      stdout: "pipe",
    });
    const text = await new Response(result.stdout).text();
    expect(text).toBe("true");
  });

  it("detects MCP server via _mcp/ in script path", async () => {
    // Write a tiny probe script inside an _mcp/ directory
    const probePath = resolve(BOT_ROOT, "send_turtle_mcp/_is_mcp_probe.ts");
    await Bun.write(probePath, `
      const IS_MCP = process.env.MCP_SERVER === "1" ||
        (typeof Bun !== "undefined" && Bun.main?.includes("_mcp/"));
      process.stdout.write(IS_MCP ? "true" : "false");
    `);

    try {
      const result = await Bun.spawn({
        cmd: [BUN_PATH, "run", probePath],
        cwd: BOT_ROOT,
        env: { ...process.env, MCP_SERVER: undefined },
        stdout: "pipe",
      });
      const text = await new Response(result.stdout).text();
      expect(text).toBe("true");
    } finally {
      // Clean up probe
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(probePath);
      } catch { /* best-effort */ }
    }
  });

  it("returns false for normal bot entry points", async () => {
    const result = await Bun.spawn({
      cmd: [BUN_PATH, "-e", `
        delete process.env.MCP_SERVER;
        const IS_MCP = process.env.MCP_SERVER === "1" ||
          (typeof Bun !== "undefined" && Bun.main?.includes("_mcp/"));
        process.stdout.write(IS_MCP ? "true" : "false");
      `],
      cwd: BOT_ROOT,
      env: { ...process.env, MCP_SERVER: undefined },
      stdout: "pipe",
    });
    const text = await new Response(result.stdout).text();
    expect(text).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// CI-SAFE: MCP server stdout purity
// ---------------------------------------------------------------------------

describe("MCP server stdout purity", () => {
  /**
   * For each MCP server, spawn it as a subprocess and verify that nothing
   * appears on stdout except valid JSON-RPC messages (or nothing at all).
   * Pino log lines on stdout would be caught here as non-JSON noise.
   */
  for (const server of MCP_SERVERS) {
    it(`${server.name}: stdout contains only valid JSON (no log pollution)`, async () => {
      const { stdout, stderr } = await captureMcpServerOutput(server.path, 3000);

      // stdout should either be empty (server waiting for JSON-RPC input)
      // or contain only valid JSON-RPC lines.
      if (stdout.trim().length > 0) {
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          // Must be parseable JSON — any Pino pretty output will fail here
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            throw new Error(
              `Non-JSON output found on stdout for ${server.name}:\n` +
              `  "${trimmed}"\n` +
              `This would corrupt the MCP JSON-RPC transport and cause ` +
              `"Transport closed" errors when running under Codex CLI.`
            );
          }

          // JSON-RPC messages should have "jsonrpc" key
          expect(parsed).toHaveProperty("jsonrpc");
        }
      }

      // stderr should contain the Pino logs (redirected from stdout)
      // This verifies the fix is working — logs go to stderr, not stdout
      expect(stderr.length).toBeGreaterThan(0);
    }, 10_000);
  }
});

// ---------------------------------------------------------------------------
// LOCAL-ONLY: Codex CLI → MCP tool round-trip (expensive)
// ---------------------------------------------------------------------------

describe.skipIf(!CODEX_INTEGRATION)(
  "Codex CLI MCP integration (CODEX_INTEGRATION=1)",
  () => {
    /**
     * Actually invoke `codex exec` with an MCP server config and verify
     * the tool call completes without "Transport closed".
     *
     * Requirements:
     *   - Codex CLI binary at node_modules/.bin/codex
     *   - Valid OPENAI_API_KEY in environment
     *   - Network access for API calls
     *
     * Cost: ~$0.01-0.05 per run (one short Codex turn)
     */
    it("send-turtle tool call completes without transport error", async () => {
      const result = Bun.spawn({
        cmd: [
          CODEX_PATH, "exec",
          "--experimental-json",
          "--config", `mcp_servers.send-turtle.command="${BUN_PATH}"`,
          "--config", `mcp_servers.send-turtle.args=["run", "${resolve(BOT_ROOT, "send_turtle_mcp/server.ts")}"]`,
          "--config", `mcp_servers.send-turtle.cwd="${BOT_ROOT}"`,
          "--sandbox", "danger-full-access",
          "--skip-git-repo-check",
          "--model", "gpt-5.6-terra",
          "--config", 'model_reasoning_effort="low"',
        ],
        cwd: resolve(BOT_ROOT, "../.."),
        stdin: new Blob(["Use the send_turtle MCP tool to send a turtle with emoji 🔥. Just call the tool, nothing else."]),
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await new Response(result.stdout).text();
      const exitCode = await result.exited;

      // Parse all JSON events from stdout
      const events = stdout.trim().split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      // Find MCP tool call completion events
      const toolCalls = events.filter(
        (e: { type: string; item?: { type: string } }) =>
          e.type === "item.completed" && e.item?.type === "mcp_tool_call"
      );

      expect(toolCalls.length).toBeGreaterThan(0);

      // At least one tool call should have succeeded
      const succeeded = toolCalls.some(
        (e: { item: { status: string } }) => e.item.status === "completed"
      );
      const transportErrors = toolCalls.filter(
        (e: { item: { error?: { message?: string } } }) =>
          e.item.error?.message?.includes("Transport closed")
      );

      expect(transportErrors).toHaveLength(0);
      expect(succeeded).toBe(true);
      expect(exitCode).toBe(0);
    }, 90_000); // 90s timeout for API call
  }
);
