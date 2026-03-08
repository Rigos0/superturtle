import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const originalSpawn = Bun.spawn;
const actualConfig = await import("./config");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-conductor-inbox-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function makeSpawnOutput(lines: unknown[]): {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
} {
  const output = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const encoded = new TextEncoder().encode(output);

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  return { stdout, stderr };
}

async function loadSessionModule(tempDir: string, tag: string) {
  const mockedConfig = {
    ...actualConfig,
    WORKING_DIR: tempDir,
    SUPERTURTLE_DATA_DIR: join(tempDir, ".superturtle"),
    SESSION_FILE: join(tempDir, `.claude-session-history-${tag}.json`),
  };

  mock.module("./config", () => mockedConfig);
  const conductorInboxModule = await import(
    `./conductor-inbox.ts?session-conductor-inbox=${tag}-${Date.now()}-${Math.random()}`
  );
  mock.module("./conductor-inbox", () => conductorInboxModule);

  return import(`./session.ts?session-conductor-inbox=${tag}-${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  Bun.spawn = originalSpawn;
  mock.restore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("ClaudeSession conductor inbox delivery", () => {
  it("injects pending background events into the next interactive turn and acknowledges them on success", async () => {
    const tempDir = makeTempDir();
    const chatId = 424242;
    const inboxPath = join(tempDir, ".superturtle", "state", "inbox", "inbox_success.json");
    writeJson(inboxPath, {
      kind: "meta_agent_inbox_item",
      schema_version: 1,
      id: "inbox_success",
      chat_id: chatId,
      worker_name: "worker-success",
      run_id: "run-success",
      priority: "notable",
      category: "completion_requested",
      title: "SubTurtle worker-success completed",
      text: "Lifecycle: completed",
      delivery_state: "pending",
      created_at: "2026-03-08T12:00:00Z",
      updated_at: "2026-03-08T12:00:00Z",
      delivery: {},
      metadata: {},
    });

    let capturedPrompt = "";
    Bun.spawn = ((cmd: unknown, _opts?: unknown) => {
      const argv = Array.isArray(cmd) ? cmd : [];
      const promptIndex = argv.findIndex((value) => value === "-p");
      capturedPrompt =
        promptIndex >= 0 && typeof argv[promptIndex + 1] === "string"
          ? String(argv[promptIndex + 1])
          : "";

      const { stdout, stderr } = makeSpawnOutput([
        {
          type: "assistant",
          session_id: "session-inbox-success",
          message: {
            content: [{ type: "text", text: "Handled background event." }],
          },
        },
        {
          type: "result",
          session_id: "session-inbox-success",
          usage: { input_tokens: 4, output_tokens: 6 },
        },
      ]);

      return {
        stdout,
        stderr,
        pid: 99996,
        kill: () => {},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const { ClaudeSession } = await loadSessionModule(tempDir, "success");
    const session = new ClaudeSession();

    const response = await session.sendMessageStreaming(
      "Continue with the user request",
      "tester",
      123,
      async () => {},
      chatId
    );

    expect(response).toBe("Handled background event.");
    expect(capturedPrompt).toContain("<background-events>");
    expect(capturedPrompt).toContain("SubTurtle worker-success completed");
    expect(capturedPrompt).toContain("Continue with the user request");

    const updatedInboxItem = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(updatedInboxItem.delivery_state).toBe("acknowledged");
    expect(updatedInboxItem.delivery.acknowledged_by_driver).toBe("claude");
    expect(updatedInboxItem.delivery.acknowledged_by_turn_id).toBeTruthy();
  });

  it("leaves pending background events unacknowledged when the interactive turn fails", async () => {
    const tempDir = makeTempDir();
    const chatId = 515151;
    const inboxPath = join(tempDir, ".superturtle", "state", "inbox", "inbox_error.json");
    writeJson(inboxPath, {
      kind: "meta_agent_inbox_item",
      schema_version: 1,
      id: "inbox_error",
      chat_id: chatId,
      worker_name: "worker-error",
      run_id: "run-error",
      priority: "critical",
      category: "fatal_error",
      title: "SubTurtle worker-error failed",
      text: "Error: boom",
      delivery_state: "pending",
      created_at: "2026-03-08T12:05:00Z",
      updated_at: "2026-03-08T12:05:00Z",
      delivery: {},
      metadata: {},
    });

    let capturedPrompt = "";
    Bun.spawn = ((cmd: unknown, _opts?: unknown) => {
      const argv = Array.isArray(cmd) ? cmd : [];
      const promptIndex = argv.findIndex((value) => value === "-p");
      capturedPrompt =
        promptIndex >= 0 && typeof argv[promptIndex + 1] === "string"
          ? String(argv[promptIndex + 1])
          : "";

      const { stdout, stderr } = makeSpawnOutput([
        {
          type: "assistant",
          session_id: "session-inbox-error",
          message: {
            content: [{ type: "text", text: "Partial response before failure" }],
          },
        },
      ]);

      return {
        stdout,
        stderr,
        pid: 99995,
        kill: () => {},
        exited: Promise.reject(new Error("claude exploded")),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const { ClaudeSession } = await loadSessionModule(tempDir, "error");
    const session = new ClaudeSession();

    await expect(
      session.sendMessageStreaming(
        "Handle the latest user question",
        "tester",
        123,
        async () => {},
        chatId
      )
    ).rejects.toThrow("claude exploded");

    expect(capturedPrompt).toContain("<background-events>");
    expect(capturedPrompt).toContain("SubTurtle worker-error failed");
    expect(capturedPrompt).toContain("Handle the latest user question");

    const updatedInboxItem = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(updatedInboxItem.delivery_state).toBe("pending");
    expect(updatedInboxItem.delivery.acknowledged_at).toBeUndefined();
  });

  it("keeps pending background events deliverable after switching back to Claude and changing model", async () => {
    const tempDir = makeTempDir();
    const chatId = 616161;
    const inboxPath = join(tempDir, ".superturtle", "state", "inbox", "inbox_claude_model_switch.json");
    writeJson(inboxPath, {
      kind: "meta_agent_inbox_item",
      schema_version: 1,
      id: "inbox_claude_model_switch",
      chat_id: chatId,
      worker_name: "worker-claude-model-switch",
      run_id: "run-claude-model-switch",
      priority: "notable",
      category: "milestone_reached",
      title: "SubTurtle worker-claude-model-switch milestone",
      text: "Milestone items: Ship preview",
      delivery_state: "pending",
      created_at: "2026-03-08T12:10:00Z",
      updated_at: "2026-03-08T12:10:00Z",
      delivery: {},
      metadata: {},
    });

    let capturedPrompt = "";
    let capturedArgv: string[] = [];
    Bun.spawn = ((cmd: unknown, _opts?: unknown) => {
      capturedArgv = Array.isArray(cmd) ? cmd.map((value) => String(value)) : [];
      const promptIndex = capturedArgv.findIndex((value) => value === "-p");
      capturedPrompt =
        promptIndex >= 0 && typeof capturedArgv[promptIndex + 1] === "string"
          ? String(capturedArgv[promptIndex + 1])
          : "";

      const { stdout, stderr } = makeSpawnOutput([
        {
          type: "assistant",
          session_id: "session-inbox-claude-switch",
          message: {
            content: [{ type: "text", text: "Claude handled the switched-driver background event." }],
          },
        },
        {
          type: "result",
          session_id: "session-inbox-claude-switch",
          usage: { input_tokens: 6, output_tokens: 7 },
        },
      ]);

      return {
        stdout,
        stderr,
        pid: 99994,
        kill: () => {},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const { ClaudeSession, getAvailableModels } = await loadSessionModule(tempDir, "model-switch");
    const claude = new ClaudeSession();
    const targetModel =
      getAvailableModels().find((model: { value: string }) => model.value !== claude.model)?.value ||
      "claude-sonnet-4-6";

    claude.activeDriver = "codex";
    claude.activeDriver = "claude";
    claude.model = targetModel;

    const response = await claude.sendMessageStreaming(
      "Continue the user conversation after the worker update",
      "tester",
      123,
      async () => {},
      chatId
    );

    expect(response).toBe("Claude handled the switched-driver background event.");
    expect(capturedArgv).toContain("--model");
    expect(capturedArgv[capturedArgv.indexOf("--model") + 1]).toBe(targetModel);
    expect(capturedPrompt).toContain("<background-events>");
    expect(capturedPrompt).toContain("SubTurtle worker-claude-model-switch milestone");
    expect(capturedPrompt).toContain("Continue the user conversation after the worker update");

    const updatedInboxItem = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(updatedInboxItem.delivery_state).toBe("acknowledged");
    expect(updatedInboxItem.delivery.acknowledged_by_driver).toBe("claude");
  });
});
