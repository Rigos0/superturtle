import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type HandleTextProbePayload = {
  replies: string[];
  chatActions: string[];
};

type HandleTextProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: HandleTextProbePayload | null;
};

const textHandlerPath = resolve(import.meta.dir, "text.ts");
const sessionPath = resolve(import.meta.dir, "../session.ts");
const marker = "__HANDLE_TEXT_PROBE__=";

async function probeHandleText(silent: boolean): Promise<HandleTextProbeResult> {
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

    const replies = [];
    const chatActions = [];
    const chat = { id: 123, type: "private" };
    const ctx = {
      from: { id: 123, username: "tester", is_bot: false, first_name: "Tester" },
      chat,
      message: {
        text: "status update",
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat,
      },
      reply: async (text) => {
        replies.push(text);
        return {
          message_id: replies.length,
          chat,
          text,
        };
      },
      replyWithChatAction: async (action) => {
        chatActions.push(action);
      },
      api: {
        editMessageText: async () => {},
        deleteMessage: async () => {},
      },
    };

    const original = session.sendMessageStreaming;
    session.sendMessageStreaming = async (_message, _username, _userId, statusCallback) => {
      await statusCallback("text", "SubTurtle still progressing", 0);
      await statusCallback("segment_end", "SubTurtle still progressing", 0);
      await statusCallback("done", "");
      return "SubTurtle still progressing";
    };

    try {
      if (${JSON.stringify(silent)}) {
        await handleText(ctx, { silent: true });
      } else {
        await handleText(ctx);
      }
    } finally {
      session.sendMessageStreaming = original;
    }

    const payload = { replies, chatActions };
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
    ? (JSON.parse(payloadLine.slice(marker.length)) as HandleTextProbePayload)
    : null;

  return { exitCode, stdout, stderr, payload };
}

describe("handleText silent mode", () => {
  it("keeps non-silent text flow unchanged", async () => {
    const result = await probeHandleText(false);
    if (result.exitCode !== 0) {
      throw new Error(
        `Non-silent handleText probe failed:\n${result.stderr || result.stdout}`
      );
    }

    expect(result.payload).not.toBeNull();
    expect(
      result.payload?.replies.some((entry) =>
        entry.includes("SubTurtle still progressing")
      )
    ).toBe(true);
  });

  it("suppresses non-notable silent responses", async () => {
    const result = await probeHandleText(true);
    if (result.exitCode !== 0) {
      throw new Error(
        `Silent handleText probe failed:\n${result.stderr || result.stdout}`
      );
    }

    expect(result.payload).not.toBeNull();
    expect(result.payload?.replies).toHaveLength(0);
    expect(result.payload?.chatActions).toContain("typing");
  });
});
