import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { resolve } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
const encoder = new TextEncoder();

function makeClaudeResponseProcess(sessionId: string, text: string): ReturnType<typeof Bun.spawn> {
  const output =
    `${JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text }],
      },
    })}\n` +
    `${JSON.stringify({
      type: "result",
      session_id: sessionId,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    })}\n`;

  const encoded = encoder.encode(output);

  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    pid: 99999,
    kill: () => {},
    exited: Promise.resolve(0),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

async function loadSessionModule() {
  const sessionPath = resolve(import.meta.dir, "session.ts");
  return import(`${sessionPath}?tool-discovery=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
  delete process.env.CLAUDE_TOOL_DISCOVERY_TIMEOUT_MS;
  rmSync("/tmp/claude-telegram-test-token-sessions.json", { force: true });
  rmSync("/tmp/claude-telegram-test-token-prefs.json", { force: true });
});

describe("ClaudeSession tool discovery", () => {
  it("falls back when the tool discovery probe times out", async () => {
    process.env.CLAUDE_TOOL_DISCOVERY_TIMEOUT_MS = "1234";

    let probeOptions: Record<string, unknown> | undefined;
    let allowedToolsArg = "";

    Bun.spawnSync = ((cmd: unknown, options?: unknown) => {
      probeOptions = options as Record<string, unknown>;
      return {
        stdout: new Uint8Array(),
        stderr: encoder.encode("probe timed out"),
        exitCode: null,
        success: false,
        signalCode: "SIGKILL",
      } as unknown as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    Bun.spawn = ((cmd: unknown, _options?: unknown) => {
      const args = cmd as string[];
      const flagIndex = args.indexOf("--allowedTools");
      allowedToolsArg = flagIndex === -1 ? "" : String(args[flagIndex + 1] || "");
      return makeClaudeResponseProcess("session-timeout-fallback", "Fallback worked");
    }) as typeof Bun.spawn;

    const { ClaudeSession } = await loadSessionModule();
    const session = new ClaudeSession();

    const response = await session.sendMessageStreaming(
      "hello",
      "tester",
      123,
      async () => {}
    );

    expect(response).toBe("Fallback worked");
    expect(probeOptions?.timeout).toBe(1234);
    expect(probeOptions?.killSignal).toBe("SIGKILL");
    expect(allowedToolsArg).toContain("Read");
    expect(allowedToolsArg).toContain("WebSearch");
  });

  it("caches fallback tools after a timed-out probe", async () => {
    let probeCalls = 0;
    let runCalls = 0;

    Bun.spawnSync = (() => {
      probeCalls += 1;
      return {
        stdout: new Uint8Array(),
        stderr: encoder.encode("probe timed out"),
        exitCode: null,
        success: false,
        signalCode: "SIGKILL",
      } as unknown as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    Bun.spawn = (() => {
      runCalls += 1;
      return makeClaudeResponseProcess("session-cached-fallback", `response ${runCalls}`);
    }) as typeof Bun.spawn;

    const { ClaudeSession } = await loadSessionModule();
    const session = new ClaudeSession();

    await session.sendMessageStreaming("one", "tester", 123, async () => {});
    await session.sendMessageStreaming("two", "tester", 123, async () => {});

    expect(probeCalls).toBe(1);
    expect(runCalls).toBe(2);
  });
});
