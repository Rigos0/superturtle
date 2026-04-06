import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.SUPER_TURTLE_PROJECT_DIR ||= resolve(import.meta.dir, "../../../..");

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

async function probeUsage(): Promise<UsageProbeResult> {
  const isolatedHome = mkdtempSync(join(tmpdir(), "usage-probe-home-"));
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    SUPER_TURTLE_PROJECT_DIR: resolve(import.meta.dir, "../../../.."),
    HOME: isolatedHome,
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const modulePath = ${JSON.stringify(commandsPath)};

    let codexFetchCalls = 0;
    let usageFetchCalls = 0;
    const originalSpawn = Bun.spawn;

    Bun.spawn = (cmd, opts) => {
      const cmdPath = Array.isArray(cmd) ? cmd[0] : cmd;

      if (cmdPath && cmdPath.includes("codex") && Array.isArray(cmd) && cmd[1] === "app-server") {
        codexFetchCalls += 1;

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

      return originalSpawn(cmd, opts);
    };

    globalThis.fetch = async () => {
      usageFetchCalls += 1;
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

    console.log(
      marker +
        JSON.stringify({
          replyCount: replies.length,
          replyText: replies[0]?.text || "",
          parseMode: replies[0]?.parseMode,
          codexFetchCalls,
          usageFetchCalls,
        })
    );
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
  it("shows unknown Codex status when quota data is empty", () => {
    const output = formatUnifiedUsage([]);

    expect(output).toContain("❓ <b>Codex</b>");
    expect(output).toContain("<i>No quota data available</i>");
  });

  it("escapes Codex plan type in HTML output", () => {
    const output = formatUnifiedUsage([
      "__CODEX_PLAN_TYPE__<script>alert(1)</script>",
      "<code>████░░░░░░</code> 70% window",
    ]);

    expect(output).toContain("<b>Codex (&lt;script&gt;alert(1)&lt;/script&gt;)</b>");
    expect(output).not.toContain("<b>Codex (<script>alert(1)</script>)</b>");
  });
});

describe("/usage command", () => {
  it("returns Codex quota output with status indicators", async () => {
    const result = await probeUsage();
    if (result.exitCode !== 0) {
      throw new Error(`Probe failed:\n${result.stderr || result.stdout}`);
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replyCount).toBe(1);
    expect(result.payload?.parseMode).toBe("HTML");
    expect(result.payload?.replyText).toContain("<b>Codex (pro)</b>");
    expect(result.payload?.replyText).toMatch(/\d+%.*window/);
    expect(result.payload?.replyText).toContain("Resets");

    const hasStatusIndicator =
      result.payload?.replyText.includes("✅ <b>Status:</b>") ||
      result.payload?.replyText.includes("⚠️ <b>Status:</b>") ||
      result.payload?.replyText.includes("🔴 <b>Status:</b>");
    expect(hasStatusIndicator).toBe(true);
    expect(result.payload?.codexFetchCalls).toBeGreaterThan(0);
    expect(result.payload?.usageFetchCalls).toBe(0);
  });
});
