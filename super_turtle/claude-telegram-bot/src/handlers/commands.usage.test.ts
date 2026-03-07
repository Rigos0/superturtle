import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= resolve(import.meta.dir, "../../../..");

const { formatUnifiedUsage } = await import("./commands");

type UsageProbePayload = {
  replyCount: number;
  replyText: string;
  parseMode?: string;
  codexFetchCalls: number;
  usageFetchCalls: number;
};

type UsageProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: UsageProbePayload | null;
};

const commandsPath = resolve(import.meta.dir, "commands.ts");
const marker = "__USAGE_PROBE__=";

type UsageProbeOptions = {
  securityMode?: "success" | "fail";
  fileAccessToken?: string;
  securityAccessToken?: string;
  botToken?: string;
  usageHttpStatus?: number;
};

async function probeUsage(
  codexEnabled: "true" | "false",
  opts: UsageProbeOptions = {}
): Promise<UsageProbeResult> {
  const securityMode = opts.securityMode || "success";
  const fileAccessToken = opts.fileAccessToken || "local-claude-token-for-tests";
  const securityAccessToken = opts.securityAccessToken || "keychain-claude-token-for-tests";
  const botToken = opts.botToken || "test-token";
  const usageHttpStatus = opts.usageHttpStatus ?? 200;
  const isolatedHome = mkdtempSync(join(tmpdir(), "usage-probe-home-"));
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: resolve(import.meta.dir, "../../../.."),
    CODEX_ENABLED: codexEnabled,
    HOME: isolatedHome,
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const modulePath = ${JSON.stringify(commandsPath)};

    const fs = require("fs");
    const path = require("path");
    const homeDir = process.env.HOME || "/tmp";
    const credPath = path.join(homeDir, ".config", "claude-code", "credentials.json");
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: ${JSON.stringify(fileAccessToken)} },
    }));

    let codexFetchCalls = 0;
    let usageFetchCalls = 0;

    const originalSpawnSync = Bun.spawnSync;
    const originalSpawn = Bun.spawn;

    Bun.spawnSync = (cmd, opts) => {
      if (Array.isArray(cmd) && cmd[0] === "security") {
        if (${JSON.stringify(securityMode)} === "fail") {
          return {
            stdout: Buffer.from(""),
            stderr: Buffer.from("security: not found"),
            success: false,
            exitCode: 1,
          };
        }
        // Mock security find-generic-password for Claude token
        return {
          stdout: Buffer.from(JSON.stringify({
            claudeAiOauth: { accessToken: ${JSON.stringify(securityAccessToken)} },
          })),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        };
      }

      // Fallback to original if not mocked
      return originalSpawnSync(cmd, opts);
    };

    Bun.spawn = (cmd, opts) => {
      const cmdPath = Array.isArray(cmd) ? cmd[0] : cmd;

      if (cmdPath && cmdPath.includes("codex") && Array.isArray(cmd) && cmd[1] === "app-server") {
        // Mock codex app-server JSON-RPC responses
        codexFetchCalls += 1;

        // Combine all responses into a single newline-delimited JSON output
        const initResponse = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
        const rateLimitsResponse = JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 70,
                windowDurationMins: 300,
                resetsAt: Math.floor(Date.now() / 1000) + 5400,
              },
              secondary: {
                usedPercent: 60,
                windowDurationMins: 10080,
                resetsAt: Math.floor(Date.now() / 1000) + 172800,
              },
              planType: "pro",
            },
          },
        });

        const encoder = new TextEncoder();
        const fullOutput = encoder.encode(initResponse + "\\n" + rateLimitsResponse + "\\n");

        let dataReturned = false;

        return {
          stdin: {
            write: () => {},
            end: () => {},
          },
          stdout: {
            getReader: () => ({
              read: async () => {
                if (!dataReturned) {
                  dataReturned = true;
                  return { done: false, value: fullOutput };
                }
                return { done: true, value: undefined };
              },
              releaseLock: () => {},
            }),
          },
          kill: () => {},
        };
      }

      // Fallback to original if not mocked
      return originalSpawn(cmd, opts);
    };

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.includes("api.anthropic.com/api/oauth/usage")) {
        usageFetchCalls += 1;
        if (${usageHttpStatus} !== 200) {
          return new Response(
            JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }),
            { status: ${usageHttpStatus} }
          );
        }
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 42, resets_at: "2026-02-25T18:00:00Z" },
          }),
          { status: 200 }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const { handleUsage } = await import(modulePath);

    const replies = [];
    const ctx = {
      from: { id: 123 },
      reply: async (text, extra) => {
        replies.push({ text, parseMode: extra?.parse_mode });
      },
    };

    await handleUsage(ctx);

    const payload = {
      replyCount: replies.length,
      replyText: replies[0]?.text || "",
      parseMode: replies[0]?.parseMode,
      codexFetchCalls,
      usageFetchCalls,
    };

    console.log(marker + JSON.stringify(payload));
  `;

  try {
    const proc = Bun.spawn({
      cmd: ["bun", "--no-env-file", "-e", script],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const payloadLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(marker));

    const payload = payloadLine
      ? (JSON.parse(payloadLine.slice(marker.length)) as UsageProbePayload)
      : null;

    return { exitCode, stdout, stderr, payload };
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

describe("formatUnifiedUsage", () => {
  it("shows unknown Claude status when usage lines are empty", () => {
    const output = formatUnifiedUsage([], [], false);

    expect(output).toContain("❓ <b>Claude Code</b>");
    expect(output).toContain("<i>No usage data available</i>");
    expect(output).toContain("❓ <b>Status:</b> Claude usage data unavailable");
    expect(output).not.toContain("✅ <b>Claude Code</b>");
  });

  it("shows unknown Codex status and partial summary when Codex data is empty", () => {
    const output = formatUnifiedUsage(["▓▓▓░░░░ 42% Session"], [], true);

    expect(output).toContain("❓ <b>Codex</b>");
    expect(output).toContain("<i>No quota data available</i>");
    expect(output).toContain("❓ <b>Status:</b> Partial data — check above");
    expect(output).not.toContain("✅ <b>Status:</b> All services operating normally");
  });

  it("escapes Codex plan type in HTML output", () => {
    const output = formatUnifiedUsage(
      ["▓▓▓░░░░ 42% Session"],
      ["__CODEX_PLAN_TYPE__<script>alert(1)</script>", "<code>████░░░░░░</code> 70% window"],
      true
    );

    expect(output).toContain("<b>Codex (&lt;script&gt;alert(1)&lt;/script&gt;)</b>");
    expect(output).not.toContain("<b>Codex (<script>alert(1)</script>)</b>");
  });
});

describe("/usage command with CODEX_ENABLED variations", () => {
  it("returns Claude section only when CODEX_ENABLED=false", async () => {
    const result = await probeUsage("false");
    if (result.exitCode !== 0) {
      throw new Error(`Probe failed (CODEX_ENABLED=false):\n${result.stderr || result.stdout}`);
    }
    expect(result.payload).not.toBeNull();
    expect(result.payload?.replyCount).toBe(1);
    expect(result.payload?.parseMode).toBe("HTML");
    expect(result.payload?.replyText).toContain("<b>Claude Code</b>");
    expect(result.payload?.replyText).not.toContain("<b>Codex</b>");
    expect(result.payload?.replyText).toContain("✅ <b>Status:</b> Claude Code operating normally");
    expect(result.payload?.codexFetchCalls).toBe(0);
    expect(result.payload?.usageFetchCalls).toBeGreaterThan(0);
  });

  it("returns Claude and Codex sections with status indicators when CODEX_ENABLED=true", async () => {
    const result = await probeUsage("true");
    if (result.exitCode !== 0) {
      throw new Error(`Probe failed (CODEX_ENABLED=true):\n${result.stderr || result.stdout}`);
    }
    expect(result.payload).not.toBeNull();
    expect(result.payload?.replyCount).toBe(1);
    expect(result.payload?.parseMode).toBe("HTML");
    expect(result.payload?.replyText).toContain("<b>Claude Code</b>");
    expect(result.payload?.replyText).toContain("<b>Codex (pro)</b>");
    expect(result.payload?.replyText).toMatch(/\d+%.*window/);
    expect(result.payload?.replyText).toContain("Resets");

    const hasStatusIndicator = result.payload?.replyText.includes("✅ <b>Status:</b>") ||
                                result.payload?.replyText.includes("⚠️ <b>Status:</b>") ||
                                result.payload?.replyText.includes("🔴 <b>Status:</b>");
    expect(hasStatusIndicator).toBe(true);
    expect(result.payload?.codexFetchCalls).toBeGreaterThan(0);
    expect(result.payload?.usageFetchCalls).toBeGreaterThan(0);
  });

  it("falls back to credentials file when keychain lookup fails", async () => {
    const result = await probeUsage("false", { securityMode: "fail" });
    if (result.exitCode !== 0) {
      throw new Error(`Probe failed (security fallback):\n${result.stderr || result.stdout}`);
    }
    expect(result.payload).not.toBeNull();
    expect(result.payload?.replyCount).toBe(1);
    expect(result.payload?.replyText).toContain("<b>Claude Code</b>");
    expect(result.payload?.replyText).toContain("✅ <b>Status:</b> Claude Code operating normally");
    expect(result.payload?.replyText).not.toContain("No usage data available");
    expect(result.payload?.usageFetchCalls).toBeGreaterThan(0);
  });

  it("ignores known test tokens in non-test runtime", async () => {
    const result = await probeUsage("false", {
      securityMode: "fail",
      fileAccessToken: "test-claude-token",
      botToken: "real-telegram-token",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Probe failed (test-token guard):\n${result.stderr || result.stdout}`);
    }
    expect(result.payload).not.toBeNull();
    expect(result.payload?.replyCount).toBe(1);
    expect(result.payload?.replyText).toContain("No usage data available");
    expect(result.payload?.usageFetchCalls).toBe(0);
  });

  it("surfaces Claude usage API rate-limit instead of empty usage", async () => {
    const result = await probeUsage("false", { usageHttpStatus: 429 });
    if (result.exitCode !== 0) {
      throw new Error(`Probe failed (rate-limit handling):\n${result.stderr || result.stdout}`);
    }
    expect(result.payload).not.toBeNull();
    expect(result.payload?.replyCount).toBe(1);
    expect(result.payload?.replyText).toContain("Usage API is rate-limited right now");
    expect(result.payload?.replyText).toContain("❓ <b>Status:</b> Claude usage data unavailable");
    expect(result.payload?.usageFetchCalls).toBeGreaterThan(0);
  });
});
