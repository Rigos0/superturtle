import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type CleanupProbePayload = {
  threw: boolean;
  isRunning: boolean;
  isProcessing: boolean;
  hasTypingController: boolean;
};

type CleanupProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: CleanupProbePayload | null;
};

const textHandlerPath = resolve(import.meta.dir, "text.ts");
const sessionPath = resolve(import.meta.dir, "../session.ts");
const marker = "__HANDLE_TEXT_CLEANUP_PROBE__=";

async function probeCleanupOnReplyFailure(): Promise<CleanupProbeResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    SUPER_TURTLE_PROJECT_DIR: process.cwd(),
    HOME: process.env.HOME || "/tmp",
  };

  const script = `
    const marker = ${JSON.stringify(marker)};
    const textHandlerPath = ${JSON.stringify(textHandlerPath)};
    const sessionPath = ${JSON.stringify(sessionPath)};

    const { handleText } = await import(textHandlerPath);
    const { session } = await import(sessionPath);
    session.activeDriver = "claude";

    const chat = { id: 123, type: "private" };
    const ctx = {
      from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
      chat,
      message: {
        text: "run a task",
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat,
      },
      reply: async () => {
        throw new Error("reply failed");
      },
      replyWithChatAction: async () => {},
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
    };

    const original = session.sendMessageStreaming;
    session.sendMessageStreaming = async () => {
      throw new Error("driver failed");
    };

    let threw = false;
    try {
      await handleText(ctx);
    } catch {
      threw = true;
    } finally {
      session.sendMessageStreaming = original;
    }

    const payload = {
      threw,
      isRunning: session.isRunning,
      isProcessing: Boolean((session as unknown as { _isProcessing: boolean })._isProcessing),
      hasTypingController: Boolean((session as unknown as { _typingController: unknown })._typingController),
    };
    console.log(marker + JSON.stringify(payload));
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

  const payloadLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(marker));

  const payload = payloadLine
    ? (JSON.parse(payloadLine.slice(marker.length)) as CleanupProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("handleText cleanup", () => {
  it("clears processing state even when error-path reply fails", async () => {
    const result = await probeCleanupOnReplyFailure();
    if (result.exitCode !== 0) {
      throw new Error(
        `Cleanup probe failed:\\n${result.stderr || result.stdout}`
      );
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.threw).toBe(true);
    expect(result.payload?.isRunning).toBe(false);
    expect(result.payload?.isProcessing).toBe(false);
    expect(result.payload?.hasTypingController).toBe(false);
  });
});
