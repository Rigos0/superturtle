import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const configPath = resolve(import.meta.dir, "telegram-owner.ts");
const workingDir = mkdtempSync(join(tmpdir(), "superturtle-telegram-owner-"));

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

async function runOwnerProbe(script: string) {
  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-owner-token:abc",
      SUPER_TURTLE_PROJECT_DIR: workingDir,
      NODE_ENV: "test",
      BUN_TEST: "1",
      TELEGRAM_ALLOWED_USERS: "",
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

  throw new Error(`Expected JSON output from owner probe. stdout=${stdout}`);
}

describe("telegram owner state", () => {
  it("persists and resolves the claimed Telegram owner", async () => {
    const result = await runOwnerProbe(`
      const owner = await import(${JSON.stringify(configPath)});
      owner.deleteTelegramOwnerStateForTests();
      const claimed = owner.claimTelegramOwnerIfUnclaimed(123456, 123456, "test_claim");
      console.log(JSON.stringify({
        claimed: claimed.claimed,
        persisted: owner.getPersistedTelegramOwner(),
        target: owner.getPrimaryTelegramTarget(),
        users: owner.getAuthorizedTelegramUserIds(),
      }));
    `);

    expect(result.exitCode).toBe(0);
    const parsed = parseLastJsonLine(result.stdout);
    expect(parsed.claimed).toBe(true);
    expect(parsed.persisted.owner_user_id).toBe(123456);
    expect(parsed.persisted.owner_chat_id).toBe(123456);
    expect(parsed.persisted.claim_source).toBe("test_claim");
    expect(parsed.target).toEqual({
      userId: 123456,
      chatId: 123456,
      source: "persisted_owner",
    });
    expect(parsed.users).toEqual([123456]);
  });

  it("ignores an owner file whose token prefix does not match the current bot", async () => {
    const result = await runOwnerProbe(`
      const { writeFileSync } = await import("fs");
      const owner = await import(${JSON.stringify(configPath)});
      owner.deleteTelegramOwnerStateForTests();
      writeFileSync(
        owner.TELEGRAM_OWNER_STATE_PATH,
        JSON.stringify({
          schema_version: 1,
          bot_token_prefix: "different-token",
          owner_user_id: 111,
          owner_chat_id: 111,
          claimed_at: new Date().toISOString(),
          claim_source: "test_mismatch",
        }, null, 2) + "\\n",
        "utf-8"
      );
      owner.clearTelegramOwnerCache();
      console.log(JSON.stringify({
        persisted: owner.getPersistedTelegramOwner(),
        target: owner.getPrimaryTelegramTarget(),
      }));
    `);

    expect(result.exitCode).toBe(0);
    const parsed = parseLastJsonLine(result.stdout);
    expect(parsed.persisted).toBeNull();
    expect(parsed.target).toEqual({
      userId: 123,
      chatId: 123,
      source: "legacy_env",
    });
  });
});
