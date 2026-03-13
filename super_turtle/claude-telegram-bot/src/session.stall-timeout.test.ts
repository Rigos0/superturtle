import { afterEach, describe, expect, it } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

afterEach(() => {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
});

describe("ClaudeSession stall timeout", () => {
  it("does not false-trigger during normal streaming responses", async () => {
    // Mock Bun.spawn to return a fake process that emits stream-json lines
    let killed = false;

    Bun.spawn = ((cmd: unknown, _opts?: unknown) => {
      // Build stream-json output lines
      const lines = [
        JSON.stringify({
          type: "assistant",
          session_id: "session-normal-123",
          message: {
            content: [{ type: "text", text: "Normal response" }],
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-normal-123",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        }),
      ];

      const output = lines.join("\n") + "\n";
      const encoder = new TextEncoder();
      const encoded = encoder.encode(output);

      // Create a ReadableStream that emits the data then closes
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });

      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      return {
        stdout,
        stderr,
        pid: 99999,
        kill: () => {
          killed = true;
        },
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    Bun.spawnSync = ((_cmd: unknown, _opts?: unknown) => ({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      exitCode: 1,
      success: false,
      signalCode: null,
    })) as typeof Bun.spawnSync;

    const { ClaudeSession } = await import("./session");
    const session = new ClaudeSession();

    const statuses: Array<{ type: string; content: string; segmentId?: number }> = [];

    try {
      const response = await session.sendMessageStreaming(
        "hello",
        "tester",
        123,
        async (type, content, segmentId) => {
          statuses.push({ type, content, segmentId });
        }
      );

      expect(response).toBe("Normal response");
      expect(killed).toBe(false);
      expect(statuses.some((entry) => entry.type === "segment_end")).toBe(true);
      expect(statuses.some((entry) => entry.type === "done")).toBe(true);
      expect(session.lastUsage).toEqual({ input_tokens: 10, output_tokens: 5 });
    } finally {
      await session.kill();
    }
  });
});
