import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildPendingConnectionChangeSuccessText,
  drainPendingConnectionChangeNotifications,
  parsePendingConnectionChangeNotification,
} from "./connection-change-notifications";

describe("connection change notifications", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("formats a concise success message", () => {
    expect(
      buildPendingConnectionChangeSuccessText({
        label: "Token Vault",
      })
    ).toBe("✅ Your Token Vault change is now live.");
  });

  it("drains queued notifications in requested order and deletes them after sending", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "superturtle-connection-changes-"));
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(
      join(tempDir, "second.json"),
      JSON.stringify(
        {
          action: "updated",
          id: "second",
          label: "GitHub",
          requested_at: "2026-04-05T10:00:01.000Z",
          source: "connector.github",
          version: 1,
        },
        null,
        2
      ) + "\n"
    );
    writeFileSync(
      join(tempDir, "first.json"),
      JSON.stringify(
        {
          action: "updated",
          id: "first",
          label: "Token Vault",
          requested_at: "2026-04-05T10:00:00.000Z",
          source: "token-vault",
          version: 1,
        },
        null,
        2
      ) + "\n"
    );

    const sendMessage = mock(async (_chatId: number, _text: string) => {});
    const result = await drainPendingConnectionChangeNotifications({
      chatId: 4242,
      directory: tempDir,
      sendMessage,
    });

    expect(result).toEqual({ sent: 2 });
    expect(sendMessage.mock.calls).toEqual([
      [4242, "✅ Your Token Vault change is now live."],
      [4242, "✅ Your GitHub change is now live."],
    ]);
    expect(() => readFileSync(join(tempDir!, "first.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(tempDir!, "second.json"), "utf-8")).toThrow();
  });

  it("keeps valid notifications when no Telegram target exists and removes expired ones", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "superturtle-connection-changes-"));
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(
      join(tempDir, "stale.json"),
      JSON.stringify(
        {
          action: "updated",
          id: "stale",
          label: "GitHub",
          requested_at: "2026-04-04T09:00:00.000Z",
          source: "connector.github",
          version: 1,
        },
        null,
        2
      ) + "\n"
    );
    writeFileSync(
      join(tempDir, "fresh.json"),
      JSON.stringify(
        {
          action: "updated",
          id: "fresh",
          label: "Notion",
          requested_at: "2026-04-05T09:30:00.000Z",
          source: "connector.notion",
          version: 1,
        },
        null,
        2
      ) + "\n"
    );

    const sendMessage = mock(async (_chatId: number, _text: string) => {});
    const result = await drainPendingConnectionChangeNotifications({
      chatId: null,
      directory: tempDir,
      now: () => Date.parse("2026-04-05T10:00:00.000Z"),
      sendMessage,
    });

    expect(result).toEqual({ sent: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(() => readFileSync(join(tempDir!, "stale.json"), "utf-8")).toThrow();
    expect(parsePendingConnectionChangeNotification(JSON.parse(readFileSync(join(tempDir!, "fresh.json"), "utf-8")))).toEqual({
      action: "updated",
      id: "fresh",
      label: "Notion",
      requested_at: "2026-04-05T09:30:00.000Z",
      source: "connector.notion",
      version: 1,
    });
  });
});
