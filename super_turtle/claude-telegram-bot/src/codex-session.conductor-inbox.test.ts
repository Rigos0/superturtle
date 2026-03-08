import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();
process.env.CODEX_ENABLED ||= "true";
process.env.CODEX_CLI_AVAILABLE_OVERRIDE ||= "true";

const actualConfig = await import("./config");
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-conductor-inbox-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function loadCodexSessionModule(tempDir: string, tag: string) {
  const mockedConfig = {
    ...actualConfig,
    WORKING_DIR: tempDir,
    SUPERTURTLE_DATA_DIR: join(tempDir, ".superturtle"),
  };

  mock.module("./config", () => mockedConfig);
  const conductorInboxModule = await import(
    `./conductor-inbox.ts?codex-session-conductor-inbox=${tag}-${Date.now()}-${Math.random()}`
  );
  mock.module("./conductor-inbox", () => conductorInboxModule);

  return import(
    `./codex-session.ts?codex-session-conductor-inbox=${tag}-${Date.now()}-${Math.random()}`
  );
}

beforeEach(() => {
  const isolatedHome = join(
    tmpdir(),
    `codex-session-conductor-home-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(isolatedHome, { recursive: true });
  process.env.HOME = isolatedHome;
});

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  if (typeof originalHome === "string") {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
});

describe("CodexSession conductor inbox delivery", () => {
  it("injects pending background events into the next interactive Codex turn and acknowledges them on success", async () => {
    const tempDir = makeTempDir();
    const chatId = 626262;
    const inboxPath = join(tempDir, ".superturtle", "state", "inbox", "inbox_codex_success.json");
    writeJson(inboxPath, {
      kind: "meta_agent_inbox_item",
      schema_version: 1,
      id: "inbox_codex_success",
      chat_id: chatId,
      worker_name: "worker-codex",
      run_id: "run-codex",
      priority: "notable",
      category: "completion_requested",
      title: "SubTurtle worker-codex completed",
      text: "Lifecycle: completed",
      delivery_state: "pending",
      created_at: "2026-03-08T12:15:00Z",
      updated_at: "2026-03-08T12:15:00Z",
      delivery: {},
      metadata: {},
    });

    let capturedPrompt = "";
    mock.module("@openai/codex-sdk", () => ({
      Codex: class {
        startThread() {
          return {
            id: "thread-inbox-codex",
            run: async () => ({ finalResponse: "", usage: null }),
            runStreamed: async (message: string) => {
              capturedPrompt = message;
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "thread-inbox-codex" };
                  yield {
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      id: "msg-1",
                      text: "Codex handled background event.",
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 7,
                      output_tokens: 9,
                    },
                  };
                })(),
              };
            },
          };
        }

        resumeThread() {
          throw new Error("not used");
        }
      },
    }));

    const { CodexSession } = await loadCodexSessionModule(tempDir, "success");
    const codex = new CodexSession();

    const response = await codex.sendMessage(
      "Continue with the current user request",
      async () => {},
      undefined,
      undefined,
      undefined,
      "text",
      123,
      "tester",
      chatId
    );

    expect(response).toBe("Codex handled background event.");
    expect(capturedPrompt).toContain("<background-events>");
    expect(capturedPrompt).toContain("SubTurtle worker-codex completed");
    expect(capturedPrompt).toContain("Continue with the current user request");

    const updatedInboxItem = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(updatedInboxItem.delivery_state).toBe("acknowledged");
    expect(updatedInboxItem.delivery.acknowledged_by_driver).toBe("codex");
    expect(updatedInboxItem.delivery.acknowledged_by_turn_id).toBeTruthy();
  });

  it("keeps pending background events deliverable after switching to Codex and changing model", async () => {
    const tempDir = makeTempDir();
    const chatId = 727272;
    const inboxPath = join(tempDir, ".superturtle", "state", "inbox", "inbox_codex_model_switch.json");
    writeJson(inboxPath, {
      kind: "meta_agent_inbox_item",
      schema_version: 1,
      id: "inbox_codex_model_switch",
      chat_id: chatId,
      worker_name: "worker-codex-model-switch",
      run_id: "run-codex-model-switch",
      priority: "critical",
      category: "fatal_error",
      title: "SubTurtle worker-codex-model-switch failed",
      text: "Error: model switch path boom",
      delivery_state: "pending",
      created_at: "2026-03-08T12:20:00Z",
      updated_at: "2026-03-08T12:20:00Z",
      delivery: {},
      metadata: {},
    });

    let capturedPrompt = "";
    const startThreadCalls: Array<{ model?: string; modelReasoningEffort?: string }> = [];
    mock.module("@openai/codex-sdk", () => ({
      Codex: class {
        startThread(options?: { model?: string; modelReasoningEffort?: string }) {
          startThreadCalls.push(options || {});
          return {
            id: "thread-inbox-codex-switch",
            run: async () => ({ finalResponse: "", usage: null }),
            runStreamed: async (message: string) => {
              capturedPrompt = message;
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "thread-inbox-codex-switch" };
                  yield {
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      id: "msg-switch",
                      text: "Codex handled the switched-driver background event.",
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 8,
                      output_tokens: 10,
                    },
                  };
                })(),
              };
            },
          };
        }

        resumeThread() {
          throw new Error("not used");
        }
      },
    }));

    const { CodexSession, getAvailableCodexModels } = await loadCodexSessionModule(tempDir, "model-switch");
    const codex = new CodexSession();
    const targetModel =
      getAvailableCodexModels().find((model: { value: string }) => model.value !== codex.model)?.value ||
      "gpt-5.2-codex";

    codex.model = targetModel;
    codex.reasoningEffort = "high";

    const response = await codex.sendMessage(
      "Continue the user conversation after the worker update",
      async () => {},
      undefined,
      undefined,
      undefined,
      "text",
      123,
      "tester",
      chatId
    );

    expect(response).toBe("Codex handled the switched-driver background event.");
    expect(startThreadCalls[0]?.model).toBe(targetModel);
    expect(startThreadCalls[0]?.modelReasoningEffort).toBe("high");
    expect(capturedPrompt).toContain("<background-events>");
    expect(capturedPrompt).toContain("SubTurtle worker-codex-model-switch failed");
    expect(capturedPrompt).toContain("Continue the user conversation after the worker update");

    const updatedInboxItem = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(updatedInboxItem.delivery_state).toBe("acknowledged");
    expect(updatedInboxItem.delivery.acknowledged_by_driver).toBe("codex");
  });
});
