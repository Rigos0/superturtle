import { describe, expect, it } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.SUPER_TURTLE_PROJECT_DIR ||= process.cwd();

const { CodexSession } = await import("./codex-session");

describe("CodexSession Phase D", () => {
  it("prepends current date/time on first message only", async () => {
    const codex = new CodexSession();
    let firstSentMessage = "";
    let secondSentMessage = "";

    const fakeThread = {
      id: "thread-date-prefix",
      run: async () => ({ finalResponse: "", usage: null }),
      runStreamed: async (message: string) => {
        if (!firstSentMessage) {
          firstSentMessage = message;
        } else {
          secondSentMessage = message;
        }
        return {
          events: (async function* () {
            yield {
              type: "item_completed",
              item: {
                type: "agent_message",
                message: {
                  content: [{ type: "text", text: "ok" }],
                },
              },
            };
            yield { type: "turn_completed", usage: { input_tokens: 1, output_tokens: 1 } };
          })(),
        };
      },
    };

    (codex as any).thread = fakeThread;
    (codex as any).threadId = "thread-date-prefix";
    (codex as any).systemPromptPrepended = false;

    await codex.sendMessage("first");
    await codex.sendMessage("second");

    expect(firstSentMessage).toContain("[Current date/time: ");
    expect(firstSentMessage).toContain("]\n\n");
    expect(firstSentMessage).toContain("first");
    expect(secondSentMessage).toBe("second");

    await codex.kill();
  });

  it("captures usage from turn_completed and streams final text", async () => {
    const codex = new CodexSession();
    let passedSignal: AbortSignal | undefined;

    const fakeThread = {
      id: "thread-phase-d",
      run: async () => ({ finalResponse: "", usage: null }),
      runStreamed: async (_message: string, options?: { signal?: AbortSignal }) => {
        passedSignal = options?.signal;
        return {
          events: (async function* () {
            yield {
              type: "item_completed",
              item: {
                type: "agent_message",
                message: {
                  content: [{ type: "text", text: "Hello from Codex" }],
                },
              },
            };
            yield {
              type: "turn_completed",
              usage: {
                input_tokens: 123,
                output_tokens: 45,
              },
            };
          })(),
        };
      },
    };

    (codex as any).thread = fakeThread;
    (codex as any).threadId = "thread-phase-d";
    (codex as any).systemPromptPrepended = true;

    const statuses: Array<{ type: string; content: string; segmentId?: number }> = [];
    const response = await codex.sendMessage("test", async (type, content, segmentId) => {
      statuses.push({ type, content, segmentId });
    });

    expect(response).toBe("Hello from Codex");
    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(codex.lastUsage).toEqual({ input_tokens: 123, output_tokens: 45 });
    expect(statuses.some((entry) => entry.type === "segment_end")).toBe(true);
    expect(statuses.some((entry) => entry.type === "done")).toBe(true);

    await codex.kill();
  });

  it("aborts running turns when stop is requested", async () => {
    const codex = new CodexSession();

    let aborted = false;
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      aborted = true;
    });

    (codex as any).abortController = abortController;
    (codex as any).isQueryRunning = true;

    const result = await codex.stop();

    expect(result).toBe("stopped");
    expect(aborted).toBe(true);

    await codex.kill();
  });

  it("force-reset clears stuck Codex run state without dropping the linked thread", () => {
    const codex = new CodexSession();

    let aborted = false;
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      aborted = true;
    });

    (codex as any).abortController = abortController;
    (codex as any).isQueryRunning = true;
    (codex as any)._isProcessing = true;
    (codex as any).stopRequested = true;
    (codex as any).thread = { id: "thread-keep" };
    (codex as any).threadId = "thread-keep";

    codex.forceResetRunState();

    expect(aborted).toBe(true);
    expect(codex.isRunning).toBe(false);
    expect(codex.isActive).toBe(true);
  });
});
