import { afterEach, describe, expect, it } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

async function loadSessionModule() {
  return import(`./session.ts?thinking-keywords-test=${Date.now()}-${Math.random()}`);
}

function mockToolDiscovery() {
  Bun.spawnSync = ((_cmd: unknown, _opts?: unknown) => {
    const initLine = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["Bash", "Edit", "Write"],
    });

    return {
      stdout: new TextEncoder().encode(`${initLine}\n`),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>;
  }) as typeof Bun.spawnSync;
}

afterEach(() => {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
});

describe("ClaudeSession keyword thinking removal", () => {
  it("does not add thinking flags or placeholder statuses for keyword-like messages", async () => {
    let spawnArgs: string[] = [];
    mockToolDiscovery();

    Bun.spawn = ((cmd: unknown, _opts?: unknown) => {
      spawnArgs = Array.isArray(cmd) ? [...cmd] : [];

      const output = [
        JSON.stringify({
          type: "assistant",
          session_id: "session-thinking-removed",
          message: {
            content: [{ type: "text", text: "Normal response" }],
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-thinking-removed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        }),
      ].join("\n") + "\n";

      const encoded = new TextEncoder().encode(output);
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
        pid: 99997,
        kill: () => {},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const { ClaudeSession } = await loadSessionModule();
    const session = new ClaudeSession();
    const statusTypes: string[] = [];

    try {
      const response = await session.sendMessageStreaming(
        "please ultrathink about this",
        "tester",
        123,
        async (type: string) => {
          statusTypes.push(type);
        }
      );

      expect(response).toBe("Normal response");
      expect(spawnArgs).not.toContain("--max-thinking-tokens");
      expect(statusTypes).not.toContain("thinking_start");
    } finally {
      await session.kill();
    }
  });
});
