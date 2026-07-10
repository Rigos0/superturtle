import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const sessionPath = resolve(import.meta.dir, "session.ts");
const marker = "__SESSION_DEFAULTS__=";

async function probeClaudeSession(envOverrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
    CODEX_ENABLED: "true",
    CODEX_CLI_AVAILABLE_OVERRIDE: "true",
  };

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const script = `
    const { rmSync, writeFileSync } = await import("fs");
    const prefsFile = "/tmp/claude-telegram-test-token-prefs.json";
    rmSync(prefsFile, { force: true });
    ${envOverrides.CLAUDE_PREFS_JSON ? `writeFileSync(prefsFile, ${JSON.stringify(envOverrides.CLAUDE_PREFS_JSON)});` : ""}
    const mod = await import(${JSON.stringify(sessionPath)} + "?probe=" + Date.now() + Math.random());
    console.log(${JSON.stringify(marker)} + JSON.stringify({
      model: mod.session.model,
      effort: mod.session.effort,
      effortDisplay: mod.EFFORT_DISPLAY,
      activeDriver: mod.session.activeDriver,
    }));
  `;

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

  const payloadLine = stdout.split("\n").find((line) => line.startsWith(marker));
  return {
    exitCode,
    stderr,
    payload: payloadLine ? JSON.parse(payloadLine.slice(marker.length)) as {
      model: string;
      effort: string;
      effortDisplay: Record<string, string>;
      activeDriver: string;
    } : null,
  };
}

describe("ClaudeSession env defaults", () => {
  it("uses configured Claude defaults when no saved prefs exist", async () => {
    const result = await probeClaudeSession({
      DEFAULT_CLAUDE_MODEL: "claude-sonnet-5",
      DEFAULT_CLAUDE_EFFORT: "medium",
      MAIN_PROVIDER: "codex",
      CLAUDE_PREFS_JSON: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.payload?.model).toBe("claude-sonnet-5");
    expect(result.payload?.effort).toBe("medium");
    expect(result.payload?.effortDisplay.medium).toBe("Medium (default)");
    expect(result.payload?.activeDriver).toBe("codex");
  });

  it("keeps saved Claude prefs authoritative over env defaults", async () => {
    const result = await probeClaudeSession({
      DEFAULT_CLAUDE_MODEL: "claude-sonnet-5",
      DEFAULT_CLAUDE_EFFORT: "low",
      MAIN_PROVIDER: "codex",
      CLAUDE_PREFS_JSON: JSON.stringify({
        model: "claude-opus-4-8",
        effort: "high",
        activeDriver: "claude",
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.payload?.model).toBe("claude-opus-4-8");
    expect(result.payload?.effort).toBe("high");
    expect(result.payload?.effortDisplay.low).toBe("Low (default)");
    expect(result.payload?.activeDriver).toBe("claude");
  });
});
