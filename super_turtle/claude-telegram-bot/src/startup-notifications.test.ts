import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  STARTUP_NOTIFICATION_OPENERS,
  buildStartupNotificationMessage,
  buildWarmWelcomeMessage,
  pickStartupNotificationOpener,
} from "./startup-notifications";

const startupNotificationsPath = resolve(import.meta.dir, "startup-notifications.ts");
const workingDir = mkdtempSync(join(tmpdir(), "superturtle-startup-notifications-"));

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

async function runStartupNotificationProbe(script: string) {
  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-startup-token:abc",
      SUPER_TURTLE_PROJECT_DIR: workingDir,
      NODE_ENV: "test",
      BUN_TEST: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

function parseLastJsonLine(stdout: string) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }

  throw new Error(`Expected JSON output from startup notification probe. stdout=${stdout}`);
}

describe("startup notifications", () => {
  it("keeps a pool of 30 startup openers", () => {
    expect(STARTUP_NOTIFICATION_OPENERS).toHaveLength(30);
  });

  it("formats a concise startup message for Codex", () => {
    expect(
      buildStartupNotificationMessage({
        projectName: "agentic",
        driver: "codex",
        randomValue: 0,
      })
    ).toBe("🐢 Turtle process started for agentic. Driver: Codex. Listening for messages.");
  });

  it("formats a concise startup message for Claude", () => {
    expect(
      buildStartupNotificationMessage({
        projectName: "agentic",
        driver: "claude",
        randomValue: 0.9999,
      })
    ).toBe("🐢 Turtle process started for agentic. Driver: Claude. Ready on the wire.");
  });

  it("omits the project label when no friendly project name should be shown", () => {
    expect(
      buildStartupNotificationMessage({
        projectName: null,
        driver: "codex",
        randomValue: 0,
      })
    ).toBe("🐢 Turtle process started. Driver: Codex. Listening for messages.");
  });

  it("clamps opener selection when the random value is out of range", () => {
    expect(pickStartupNotificationOpener(-1)).toBe("Listening for messages.");
    expect(pickStartupNotificationOpener(2)).toBe("Ready on the wire.");
  });

  it("formats a warm welcome message with a basic capability overview", () => {
    const message = buildWarmWelcomeMessage({
      projectName: "agentic",
      driver: "codex",
    });
    expect(message).toContain("Welcome, I am your turtle bot! Working in agentic.");
    expect(message).toContain("spin up SubTurtles for longer tasks");
    expect(message).toContain("handle text, voice, screenshots, photos, documents, and audio");
    expect(message).toContain("Useful commands: /usage, /model, /new, /resume, /sub, /stop");
    expect(message).not.toContain("/switch");
  });

  it("uses a generic warm welcome when the runtime should not expose the workdir", () => {
    expect(
      buildWarmWelcomeMessage({
        projectName: null,
        driver: "codex",
      })
    ).toContain("Welcome, I am your turtle bot!");
  });

  it("persists the one-time startup welcome marker", async () => {
    const result = await runStartupNotificationProbe(`
      const notifications = await import(${JSON.stringify(startupNotificationsPath)});
      notifications.deleteStartupWelcomeStateForTests();
      console.log(JSON.stringify({
        before: notifications.hasSentStartupWelcome(),
      }));
      notifications.markStartupWelcomeSent(123456, 654321, "2026-03-26T08:00:00.000Z");
      console.log(JSON.stringify({
        after: notifications.hasSentStartupWelcome(),
        state: notifications.getStartupWelcomeState(),
      }));
    `);

    expect(result.exitCode).toBe(0);
    const parsed = parseLastJsonLine(result.stdout);
    expect(parsed.after).toBe(true);
    expect(parsed.state).toEqual({
      schema_version: 1,
      bot_token_prefix: "test-startup-token",
      sent_at: "2026-03-26T08:00:00.000Z",
      chat_id: 123456,
      user_id: 654321,
    });
  });
});
