import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { codexSession } from "../codex-session";
import { SUPERTURTLE_DATA_DIR } from "../config";
import { getAvailableModels, session } from "../session";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();
process.env.CODEX_ENABLED = "false";

const { ALLOWED_USERS } = await import("../config");

const {
  getCommandLines,
  formatModelInfo,
  parseClaudeBacklogItems,
  parseClaudeStateSummary,
  formatBacklogSummary,
  parseCtlListOutput,
  readMainLoopLogTail,
  MAIN_LOOP_LOG_PATH,
  handleNew,
  handleStatus,
  handleCron,
  handleModel,
  handlePinologs,
} = await import("./commands");

type ReplyRecord = {
  text: string;
  extra?: { parse_mode?: string; reply_markup?: unknown };
};

type SwitchCommandProbePayload = {
  activeDriver: string;
  replies: ReplyRecord[];
  startNewThreadCalls: number;
  sessionKillCalls: number;
  codexKillCalls: number;
};

type ResumeProbePayload = {
  replies: ReplyRecord[];
};

type ModelPickerProbePayload = {
  replies: ReplyRecord[];
};

function mockContext(messageText: string): {
  ctx: {
    from: { id: number };
    message: { text: string };
    reply: (text: string, extra?: { parse_mode?: string; reply_markup?: unknown }) => Promise<void>;
  };
  replies: ReplyRecord[];
} {
  const replies: ReplyRecord[] = [];
  const authorizedUserId = ALLOWED_USERS[0] ?? Number((process.env.TELEGRAM_ALLOWED_USERS || "123").split(",")[0]?.trim() || "123");
  return {
    ctx: {
      from: { id: authorizedUserId },
      message: { text: messageText },
      reply: async (text: string, extra?: { parse_mode?: string; reply_markup?: unknown }) => {
        replies.push({ text, extra });
      },
    },
    replies,
  };
}

function mockClaudeCredentialLookupFailure(): () => void {
  const originalSpawnSync = Bun.spawnSync;

  Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
    const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
    if (parts[0] === "security" && parts[1] === "find-generic-password") {
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("mocked keychain miss"),
        success: false,
        exitCode: 1,
      } as ReturnType<typeof Bun.spawnSync>;
    }
    return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
  }) as typeof Bun.spawnSync;

  return () => {
    Bun.spawnSync = originalSpawnSync;
  };
}

const superturtleDataDir = SUPERTURTLE_DATA_DIR;
mkdirSync(superturtleDataDir, { recursive: true });
const originalSessionStopTyping = session.stopTyping;
const originalSessionKill = session.kill;
const originalSessionModel = session.model;
const originalSessionEffort = session.effort;
const originalSessionActiveDriver = session.activeDriver;
const originalCodexKill = codexSession.kill;

async function loadCommandsModuleWithCronJobs(jobs: Array<Record<string, unknown>>) {
  const actualCron = await import("../cron");
  mock.module("../cron", () => ({
    ...actualCron,
    getJobs: () => jobs,
  }));

  return import(`./commands.ts?commands-cron=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  session.stopTyping = originalSessionStopTyping;
  session.kill = originalSessionKill;
  session.model = originalSessionModel;
  session.effort = originalSessionEffort;
  session.activeDriver = originalSessionActiveDriver;
  codexSession.kill = originalCodexKill;
  mock.restore();
});

describe("getCommandLines", () => {
  it("returns slash commands including all known commands", () => {
    const lines = getCommandLines();
    const commands = lines.map((line) => line.split(/\s+/)[0]);

    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith("/"))).toBe(true);

    for (const expected of [
      "/new",
      "/teleport",
      "/model",
      "/switch",
      "/usage",
      "/context",
      "/status",
      "/looplogs",
      "/pinologs",
      "/resume",
      "/sub",
      "/cron",
    ]) {
      expect(commands).toContain(expected);
    }
  });
});

function getInlineKeyboard(reply: ReplyRecord): Array<Array<{ text?: string; callback_data?: string }>> {
  return (
    (reply.extra?.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    })?.inline_keyboard || []
  );
}

function runSwitchNoArgInIsolatedProcess(codexEnabled: boolean): ReplyRecord[] {
  const projectRoot = resolve(import.meta.dir, "../..");
  const script = `
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.CLAUDE_WORKING_DIR = process.cwd();
    process.env.CODEX_ENABLED = ${JSON.stringify(codexEnabled ? "true" : "false")};
    process.env.CODEX_CLI_AVAILABLE_OVERRIDE = ${JSON.stringify(codexEnabled ? "true" : "false")};
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    const { handleSwitch } = await import("./src/handlers/commands.ts");
    const { session } = await import("./src/session.ts");
    session.activeDriver = "claude";
    const replies = [];
    const ctx = {
      from: { id: 123 },
      message: { text: "/switch" },
      reply: async (text, extra) => {
        replies.push({ text, extra });
      },
    };
    await handleSwitch(ctx);
    process.stdout.write(JSON.stringify(replies));
  `;
  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: projectRoot });
  expect(proc.exitCode).toBe(0);
  const combinedOutput = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const jsonStart = combinedOutput.search(/\[\s*\{/);
  expect(jsonStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < combinedOutput.length; i += 1) {
    const ch = combinedOutput[i]!;
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i;
        break;
      }
    }
  }

  expect(jsonEnd).toBeGreaterThanOrEqual(jsonStart);
  const jsonText = combinedOutput.slice(jsonStart, jsonEnd + 1);
  return JSON.parse(jsonText) as ReplyRecord[];
}

function runModelPickerProbeInIsolatedProcess(opts: {
  activeDriver: "claude" | "codex";
  defaultClaudeEffort?: string;
  defaultCodexEffort?: string;
}): ModelPickerProbePayload {
  const projectRoot = resolve(import.meta.dir, "../..");
  const marker = "__MODEL_PICKER_PROBE__=";
  const endMarker = "__MODEL_PICKER_PROBE_END__";
  const script = `
    const { rmSync } = await import("fs");
    rmSync("/tmp/claude-telegram-test-token-prefs.json", { force: true });
    rmSync("/tmp/codex-telegram-test-token-prefs.json", { force: true });
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.CLAUDE_WORKING_DIR = process.cwd();
    process.env.CODEX_ENABLED = "true";
    process.env.CODEX_CLI_AVAILABLE_OVERRIDE = "true";
    ${opts.defaultClaudeEffort ? `process.env.DEFAULT_CLAUDE_EFFORT = ${JSON.stringify(opts.defaultClaudeEffort)};` : ""}
    ${opts.defaultCodexEffort ? `process.env.DEFAULT_CODEX_EFFORT = ${JSON.stringify(opts.defaultCodexEffort)};` : ""}
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    const { handleModel } = await import("./src/handlers/commands.ts");
    const { session } = await import("./src/session.ts");
    const { codexSession } = await import("./src/codex-session.ts");
    session.activeDriver = ${JSON.stringify(opts.activeDriver)};
    const replies = [];
    const ctx = {
      from: { id: 123 },
      message: { text: "/model" },
      reply: async (text, extra) => {
        replies.push({ text, extra });
      },
    };
    await handleModel(ctx);
    process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ replies }) + ${JSON.stringify(endMarker)});
  `;
  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: projectRoot });
  expect(proc.exitCode).toBe(0);
  const combinedOutput = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const markerIndex = combinedOutput.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const endMarkerIndex = combinedOutput.indexOf(endMarker, markerIndex + marker.length);
  expect(endMarkerIndex).toBeGreaterThanOrEqual(0);
  const payloadText = combinedOutput.slice(markerIndex + marker.length, endMarkerIndex).trim();
  return JSON.parse(payloadText) as ModelPickerProbePayload;
}

function runSwitchCommandProbeInIsolatedProcess(opts: {
  command: string;
  codexEnabled: boolean;
  codexCliAvailable?: boolean;
  forceStartThreadFailure?: boolean;
}): SwitchCommandProbePayload {
  const projectRoot = resolve(import.meta.dir, "../..");
  const marker = "__SWITCH_COMMAND_PROBE__=";
  const script = `
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.CLAUDE_WORKING_DIR = process.cwd();
    process.env.CODEX_ENABLED = ${JSON.stringify(opts.codexEnabled ? "true" : "false")};
    process.env.CODEX_CLI_AVAILABLE_OVERRIDE = ${JSON.stringify(
      opts.codexCliAvailable === undefined
        ? (opts.codexEnabled ? "true" : "false")
        : (opts.codexCliAvailable ? "true" : "false")
    )};
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    const originalSpawnSync = Bun.spawnSync;
    Bun.spawnSync = ((cmd, spawnOpts) => {
      const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      if (parts[0] === "security" && parts[1] === "find-generic-password") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from("mocked keychain miss"),
          success: false,
          exitCode: 1,
        };
      }
      return originalSpawnSync(cmd, spawnOpts);
    });

    const originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd, spawnOpts) => {
      const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      if (parts[0] === "codex" && parts[1] === "app-server") {
        return { stdin: null };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const { handleSwitch } = await import("./src/handlers/commands.ts");
    const { session } = await import("./src/session.ts");
    const { codexSession } = await import("./src/codex-session.ts");

    let startNewThreadCalls = 0;
    let sessionKillCalls = 0;
    let codexKillCalls = 0;
    session.stopTyping = () => {};
    session.kill = async () => {
      sessionKillCalls += 1;
    };
    codexSession.kill = async () => {
      codexKillCalls += 1;
    };
    codexSession.startNewThread = async () => {
      startNewThreadCalls += 1;
      if (${opts.forceStartThreadFailure ? "true" : "false"}) {
        throw new Error("forced start failure for test");
      }
    };
    session.activeDriver = "claude";

    const replies = [];
    const ctx = {
      from: { id: 123 },
      message: { text: ${JSON.stringify(opts.command)} },
      reply: async (text, extra) => {
        replies.push({ text: String(text), extra });
      },
    };

    await handleSwitch(ctx);

    process.stdout.write(
      ${JSON.stringify(marker)} +
        JSON.stringify({
          activeDriver: session.activeDriver,
          replies,
          startNewThreadCalls,
          sessionKillCalls,
          codexKillCalls,
        })
    );
  `;

  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: projectRoot });
  expect(proc.exitCode).toBe(0);

  const combinedOutput = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const markerIndex = combinedOutput.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);

  const jsonStart = markerIndex + marker.length;
  const tail = combinedOutput.slice(jsonStart);
  const firstBrace = tail.indexOf("{");
  expect(firstBrace).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let jsonEnd = -1;
  for (let i = firstBrace; i < tail.length; i += 1) {
    const ch = tail[i]!;
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i;
        break;
      }
    }
  }

  expect(jsonEnd).toBeGreaterThanOrEqual(firstBrace);
  const jsonText = tail.slice(firstBrace, jsonEnd + 1);
  return JSON.parse(jsonText) as SwitchCommandProbePayload;
}

function runResumeProbeInIsolatedProcess(opts: {
  activeDriver: "claude" | "codex";
  currentClaudeSessionId: string | null;
  currentCodexSessionId: string | null;
  claudeSessions: Array<{ session_id: string; saved_at: string; working_dir: string; title: string }>;
  codexSessions: Array<{ session_id: string; saved_at: string; working_dir: string; title: string }>;
}): ResumeProbePayload {
  const projectRoot = resolve(import.meta.dir, "../..");
  const marker = "__RESUME_PROBE__=";
  const script = `
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.CLAUDE_WORKING_DIR = process.cwd();
    process.env.CODEX_ENABLED = "true";
    process.env.CODEX_CLI_AVAILABLE_OVERRIDE = "true";
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    const { handleResume } = await import("./src/handlers/commands.ts");
    const { session } = await import("./src/session.ts");
    const { codexSession } = await import("./src/codex-session.ts");

    session.activeDriver = ${JSON.stringify(opts.activeDriver)};
    session.sessionId = ${JSON.stringify(opts.currentClaudeSessionId)};
    session.getSessionList = () => ${JSON.stringify(opts.claudeSessions)};
    codexSession.getThreadId = () => ${JSON.stringify(opts.currentCodexSessionId)};
    codexSession.getSessionListLive = async () => ${JSON.stringify(opts.codexSessions)};
    codexSession.getSessionList = () => ${JSON.stringify(opts.codexSessions)};

    const replies = [];
    const ctx = {
      from: { id: 123 },
      reply: async (text, extra) => {
        replies.push({ text: String(text), extra });
      },
    };

    await handleResume(ctx);
    process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ replies }));
  `;

  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: projectRoot });
  expect(proc.exitCode).toBe(0);

  const combinedOutput = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const markerIndex = combinedOutput.lastIndexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);

  const tail = combinedOutput.slice(markerIndex + marker.length);
  const firstBrace = tail.indexOf("{");
  expect(firstBrace).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let jsonEnd = -1;
  for (let i = firstBrace; i < tail.length; i += 1) {
    const ch = tail[i]!;
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i;
        break;
      }
    }
  }

  expect(jsonEnd).toBeGreaterThanOrEqual(firstBrace);
  const jsonText = tail.slice(firstBrace, jsonEnd + 1);
  return JSON.parse(jsonText) as ResumeProbePayload;
}

describe("formatModelInfo", () => {
  it("maps known model IDs to display names", () => {
    const known = getAvailableModels()[0]!;
    const result = formatModelInfo(known.value, "high");

    expect(result.modelName).toBe(known.displayName);
  });

  it("omits effort string for haiku models", () => {
    const haikuModel = getAvailableModels().find((m) => m.value.includes("haiku"))?.value || "claude-haiku-test";
    const result = formatModelInfo(haikuModel, "high");

    expect(result.effortStr).toBe("");
  });

  it("falls back to raw model string for unknown model IDs", () => {
    const unknown = "unknown-model-id";
    const result = formatModelInfo(unknown, "medium");

    expect(result.modelName).toBe(unknown);
    expect(result.effortStr).toContain("Medium");
  });
});

describe("parseClaudeBacklogItems", () => {
  it("parses checked, unchecked, and current marker items", () => {
    const content = [
      "## Backlog",
      "- [ ] unchecked item",
      "- [x] checked item",
      "- [ ] in progress <- current",
    ].join("\n");

    const items = parseClaudeBacklogItems(content);

    expect(items).toEqual([
      { text: "unchecked item", done: false, current: false },
      { text: "checked item", done: true, current: false },
      { text: "in progress", done: false, current: true },
    ]);
  });

  it("returns empty array for empty content", () => {
    expect(parseClaudeBacklogItems("")).toEqual([]);
  });

  it("returns empty array when Backlog section is missing", () => {
    const content = [
      "## Current Task",
      "Do something",
      "",
      "## End Goal",
      "Ship it",
    ].join("\n");

    expect(parseClaudeBacklogItems(content)).toEqual([]);
  });
});

describe("parseClaudeStateSummary", () => {
  it("extracts current task and backlog progress from well-formed content", () => {
    const content = [
      "## Current Task",
      "- Implement parser tests",
      "",
      "## End Goal with Specs",
      "Cover handlers and pure functions.",
      "",
      "## Backlog",
      "- [x] Read existing test patterns",
      "- [ ] Write parser tests <- current",
      "- [ ] Run test suite",
    ].join("\n");

    const summary = parseClaudeStateSummary(content);

    expect(summary).toEqual({
      currentTask: "Implement parser tests",
      backlogDone: 1,
      backlogTotal: 3,
      backlogCurrent: "Write parser tests",
    });
  });

  it("returns empty fields when sections are missing", () => {
    const summary = parseClaudeStateSummary("## Notes\nNo task or backlog here.");

    expect(summary).toEqual({
      currentTask: "",
      backlogDone: 0,
      backlogTotal: 0,
      backlogCurrent: "",
    });
  });

  it("parses real-world CLAUDE.md content", async () => {
    const statePath = resolve(import.meta.dir, "./__fixtures__/real-world-claude.md");
    const content = await Bun.file(statePath).text();

    const summary = parseClaudeStateSummary(content);

    expect(summary.currentTask.length).toBeGreaterThan(0);
    expect(summary.backlogTotal).toBeGreaterThan(0);
    expect(summary.backlogDone).toBeGreaterThanOrEqual(0);
    expect(summary.backlogDone).toBeLessThanOrEqual(summary.backlogTotal);
  });
});

describe("formatBacklogSummary", () => {
  it("formats progress and current item into readable summary", () => {
    const result = formatBacklogSummary({
      currentTask: "ignored by formatter",
      backlogDone: 2,
      backlogTotal: 5,
      backlogCurrent: "Write parser tests",
    });

    expect(result).toBe("2/5 done • Current: Write parser tests");
  });
});

describe("parseCtlListOutput", () => {
  it("parses real ctl list output with fixed-width columns, skills, and tunnel URL", () => {
    const output = [
      "  docs-agent      running  yolo-codex   (PID 12345)   9m left       Implement parser coverage [skills: [\"frontend\",\"tests\"]]",
      "                 → https://docs-agent.trycloudflare.com",
      "  bugfix-ops      stopped                                             (no task)",
    ].join("\n");

    const turtles = parseCtlListOutput(output);

    expect(turtles).toEqual([
      {
        name: "docs-agent",
        status: "running",
        type: "yolo-codex",
        pid: "12345",
        timeRemaining: "9m",
        task: "Implement parser coverage",
        tunnelUrl: "https://docs-agent.trycloudflare.com",
      },
      {
        name: "bugfix-ops",
        status: "stopped",
        type: "",
        pid: "",
        timeRemaining: "",
        task: "(no task)",
        tunnelUrl: "",
      },
    ]);
  });

  it("parses real running variants for no-timeout and overdue subturtles", () => {
    const output = [
      "  infra-watch     running  yolo-codex-spark (PID 456) no timeout    Investigate flaky CI",
      "  migration       running  slow         (PID 7890) OVERDUE      Finish data migration",
    ].join("\n");

    const turtles = parseCtlListOutput(output);

    expect(turtles).toEqual([
      {
        name: "infra-watch",
        status: "running",
        type: "yolo-codex-spark",
        pid: "456",
        timeRemaining: "no timeout",
        task: "Investigate flaky CI",
        tunnelUrl: "",
      },
      {
        name: "migration",
        status: "running",
        type: "slow",
        pid: "7890",
        timeRemaining: "OVERDUE",
        task: "Finish data migration",
        tunnelUrl: "",
      },
    ]);
  });

  it("returns empty array for empty output", () => {
    expect(parseCtlListOutput("")).toEqual([]);
  });

  it("returns empty array for no-subturtles output", () => {
    expect(parseCtlListOutput("No SubTurtles found.")).toEqual([]);
  });

  it("returns empty array for header-only output", () => {
    const output = "NAME STATUS TYPE PID TIME TASK";
    expect(parseCtlListOutput(output)).toEqual([]);
  });
});

describe("readMainLoopLogTail", () => {
  it("returns ok=true with log text when tail succeeds", () => {
    const expectedText = "line 1\nline 2\n";
    const originalSpawnSync = Bun.spawnSync;
    const spawnedCommands: string[][] = [];

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      spawnedCommands.push(parts);
      if (parts[0] === "tail") {
        return {
          stdout: Buffer.from(expectedText),
          stderr: Buffer.from(""),
          success: true,
          exitCode: 0,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      expect(readMainLoopLogTail()).toMatchObject({ ok: true, text: expectedText });
    } finally {
      Bun.spawnSync = originalSpawnSync;
    }

    expect(spawnedCommands.some((parts) => parts[0] === "tail")).toBe(true);
    expect(spawnedCommands.some((parts) => parts[0] === "tail" && parts.includes("-n"))).toBe(true);
  });

  it("returns ok=false with an error when tail fails", () => {
    const originalSpawnSync = Bun.spawnSync;
    const expectedError = `tail: ${MAIN_LOOP_LOG_PATH}: No such file or directory`;

    Bun.spawnSync = ((cmd: unknown, opts?: unknown) => {
      const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
      if (parts[0] === "tail") {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(expectedError),
          success: false,
          exitCode: 1,
        } as ReturnType<typeof Bun.spawnSync>;
      }
      return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync;

    try {
      expect(readMainLoopLogTail()).toMatchObject({ ok: false, error: expectedError });
    } finally {
      Bun.spawnSync = originalSpawnSync;
    }
  });
});

describe("handlers with mock Context", () => {
  it("handleNew replies with HTML command overview and resets driver sessions", async () => {
    let stopTypingCalls = 0;
    let sessionKillCalls = 0;
    let codexKillCalls = 0;

    session.stopTyping = () => {
      stopTypingCalls += 1;
    };
    session.kill = (async () => {
      sessionKillCalls += 1;
    }) as typeof session.kill;
    codexSession.kill = (async () => {
      codexKillCalls += 1;
    }) as typeof codexSession.kill;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const restoreSpawnSync = mockClaudeCredentialLookupFailure();

    const { ctx, replies } = mockContext("/new");
    try {
      await handleNew(ctx as any);
    } finally {
      globalThis.fetch = originalFetch;
      restoreSpawnSync();
    }

    expect(replies).toHaveLength(1);
    expect(replies[0]!.extra?.parse_mode).toBe("HTML");
    expect(replies[0]!.text).toContain("<b>New session</b>");
    expect(replies[0]!.text).toContain("<b>Commands:</b>");
    expect(replies[0]!.text).toContain("/new - Fresh session");
    expect(replies[0]!.text).toContain("/status - Detailed status");
    expect(replies[0]!.text).toContain("/cron - Scheduled jobs");
    expect(stopTypingCalls).toBe(1);
    expect(sessionKillCalls).toBe(1);
    expect(codexKillCalls).toBe(1);
  });

  it("handleStatus replies with HTML settings overview without resetting sessions", async () => {
    let stopTypingCalls = 0;
    let sessionKillCalls = 0;
    let codexKillCalls = 0;

    session.stopTyping = () => {
      stopTypingCalls += 1;
    };
    session.kill = (async () => {
      sessionKillCalls += 1;
    }) as typeof session.kill;
    codexSession.kill = (async () => {
      codexKillCalls += 1;
    }) as typeof codexSession.kill;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const restoreSpawnSync = mockClaudeCredentialLookupFailure();

    const { ctx, replies } = mockContext("/status");
    try {
      await handleStatus(ctx as any);
    } finally {
      globalThis.fetch = originalFetch;
      restoreSpawnSync();
    }

    expect(replies).toHaveLength(1);
    expect(replies[0]!.extra?.parse_mode).toBe("HTML");
    expect(replies[0]!.text).toContain("<b>Status</b>");
    expect(replies[0]!.text).toContain("<b>Commands:</b>");
    expect(stopTypingCalls).toBe(0);
    expect(sessionKillCalls).toBe(0);
    expect(codexKillCalls).toBe(0);
  });

  it("handleCron shows no-jobs message when cron job list is empty", async () => {
    const { handleCron: isolatedHandleCron } = await loadCommandsModuleWithCronJobs([]);
    const { ctx, replies } = mockContext("/cron");
    await isolatedHandleCron(ctx as any);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.extra?.parse_mode).toBe("HTML");
    expect(replies[0]!.text).toContain("<b>Scheduled Jobs</b>");
    expect(replies[0]!.text).toContain("No jobs scheduled");
  });

  it("handleCron shows jobs with cancel buttons", async () => {
    const now = Date.now();
    const longPrompt = "Run recurring maintenance task with a very long prompt to force truncation";
    const expectedTruncatedPrompt = `${longPrompt.slice(0, 37)}...`;
    const { handleCron: isolatedHandleCron } = await loadCommandsModuleWithCronJobs([
      {
        id: "job-1",
        prompt: "Do a quick status check",
        type: "one-shot",
        interval_ms: null,
        fire_at: now + 5 * 60 * 1000,
        created_at: new Date(now).toISOString(),
      },
      {
        id: "job-2",
        prompt: longPrompt,
        type: "recurring",
        interval_ms: 15 * 60 * 1000,
        fire_at: now + 2 * 60 * 60 * 1000,
        created_at: new Date(now).toISOString(),
      },
    ]);

    const { ctx, replies } = mockContext("/cron");
    await isolatedHandleCron(ctx as any);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.extra?.parse_mode).toBe("HTML");
    expect(replies[0]!.text).toContain("<b>Scheduled Jobs</b>");
    expect(replies[0]!.text).toContain("⏱️ <code>Do a quick status check</code>");
    expect(replies[0]!.text).toContain(`🔁 <code>${expectedTruncatedPrompt}</code>`);

    const keyboard = (replies[0]!.extra?.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    })?.inline_keyboard;
    expect(Array.isArray(keyboard)).toBe(true);
    expect(keyboard?.flat().some((button) => button.callback_data === "cron_cancel:job-1")).toBe(true);
    expect(keyboard?.flat().some((button) => button.callback_data === "cron_cancel:job-2")).toBe(true);
  });

  it("handleCron prefers structured SubTurtle supervision labels", async () => {
    const now = Date.now();
    const { handleCron: isolatedHandleCron } = await loadCommandsModuleWithCronJobs([
      {
        id: "job-structured",
        prompt: "legacy prompt fallback should not be shown",
        type: "recurring",
        interval_ms: 10 * 60 * 1000,
        silent: true,
        job_kind: "subturtle_supervision",
        worker_name: "worker-a",
        supervision_mode: "silent",
        fire_at: now + 60 * 1000,
        created_at: new Date(now).toISOString(),
      },
    ]);

    const { ctx, replies } = mockContext("/cron");
    await isolatedHandleCron(ctx as any);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("🔁 <code>SubTurtle worker-a (silent)</code>");
  });

  it("handleModel replies with inline keyboard model options for Claude", async () => {
    session.activeDriver = "claude";
    session.model = getAvailableModels()[0]!.value;
    session.effort = "high";

    const { ctx, replies } = mockContext("/model");
    await handleModel(ctx as any);

    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.extra?.parse_mode).toBe("HTML");
    expect(reply.text).toContain("<b>Model:</b>");
    expect(reply.text).toContain("Select model or effort level:");

    const keyboard = getInlineKeyboard(reply);
    expect(keyboard.length).toBeGreaterThan(1);

    const callbackData = keyboard.flat().map((button) => button.callback_data || "");
    for (const model of getAvailableModels()) {
      expect(callbackData).toContain(`model:${model.value}`);
    }
    expect(callbackData).toContain("effort:low");
    expect(callbackData).toContain("effort:medium");
    expect(callbackData).toContain("effort:high");
  });

  it("handleModel shows configured default effort labels for Claude and Codex", () => {
    const claudeResult = runModelPickerProbeInIsolatedProcess({
      activeDriver: "claude",
      defaultClaudeEffort: "medium",
    });
    expect(claudeResult.replies[0]?.text).toContain("<b>Effort:</b> Medium (default)");

    const claudeButtons = getInlineKeyboard(claudeResult.replies[0]!);
    expect(claudeButtons.flat().some((button) => button.text?.includes("Medium (default)"))).toBe(true);

    const codexResult = runModelPickerProbeInIsolatedProcess({
      activeDriver: "codex",
      defaultCodexEffort: "low",
    });
    expect(codexResult.replies[0]?.text).toContain("<b>Reasoning Effort:</b> low");

    const codexButtons = getInlineKeyboard(codexResult.replies[0]!);
    expect(codexButtons.flat().some((button) => button.text?.includes("Low (default)"))).toBe(true);
  });

  it("handleResume sorts mixed Claude and Codex sessions globally by saved time", () => {
    const result = runResumeProbeInIsolatedProcess({
      activeDriver: "claude",
      currentClaudeSessionId: null,
      currentCodexSessionId: null,
      claudeSessions: [
        {
          session_id: "claude-old",
          saved_at: "2026-03-07T09:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Claude old",
        },
        {
          session_id: "claude-new",
          saved_at: "2026-03-07T11:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Claude new",
        },
      ],
      codexSessions: [
        {
          session_id: "codex-mid",
          saved_at: "2026-03-07T10:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Codex mid",
        },
        {
          session_id: "codex-newest",
          saved_at: "2026-03-07T12:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Codex newest",
        },
      ],
    });

    expect(result.replies).toHaveLength(1);
    const keyboard = getInlineKeyboard(result.replies[0]!);
    const callbackData = keyboard.flat().map((button) => button.callback_data || "");
    expect(callbackData).toEqual([
      "codex_resume:codex-newest",
      "resume:claude-new",
      "codex_resume:codex-mid",
      "resume:claude-old",
    ]);
  }, 20_000);

  it("handleResume keeps inactive-driver current session visible while hiding active current session", () => {
    const result = runResumeProbeInIsolatedProcess({
      activeDriver: "codex",
      currentClaudeSessionId: "claude-current",
      currentCodexSessionId: "codex-current",
      claudeSessions: [
        {
          session_id: "claude-current",
          saved_at: "2026-03-07T11:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Claude current",
        },
      ],
      codexSessions: [
        {
          session_id: "codex-current",
          saved_at: "2026-03-07T12:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Codex current",
        },
        {
          session_id: "codex-older",
          saved_at: "2026-03-07T10:00:00.000Z",
          working_dir: "/tmp/project",
          title: "Codex older",
        },
      ],
    });

    expect(result.replies).toHaveLength(1);
    const keyboard = getInlineKeyboard(result.replies[0]!);
    const callbackData = keyboard.flat().map((button) => button.callback_data || "");
    expect(callbackData).toContain("resume_current");
    expect(callbackData).toContain("resume:claude-current");
    expect(callbackData).toContain("codex_resume:codex-older");
    expect(callbackData).not.toContain("codex_resume:codex-current");
  }, 20_000);

  it("handlePinologs replies with inline keyboard level options", async () => {
    const { ctx, replies } = mockContext("/pinologs");
    await handlePinologs(ctx as any);

    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.text).toBe("Select log level:");

    const keyboard = getInlineKeyboard(reply);
    expect(keyboard).toEqual([
      [
        { text: "Info", callback_data: "pinologs:info" },
        { text: "Warning", callback_data: "pinologs:warn" },
        { text: "Errors", callback_data: "pinologs:error" },
      ],
    ]);
  });

  it("handleSwitch shows switch buttons when Codex is unavailable", () => {
    const replies = runSwitchNoArgInIsolatedProcess(false);
    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.extra?.parse_mode).toBe("HTML");
    expect(reply.text).toContain("<b>Current driver:</b>");

    const callbackData = getInlineKeyboard(reply).flat().map((button) => button.callback_data || "");
    expect(callbackData).toContain("switch:claude");
    expect(callbackData).toContain("switch:codex_unavailable");
  }, 20_000);

  it("handleSwitch shows Codex button when Codex is available", () => {
    const replies = runSwitchNoArgInIsolatedProcess(true);

    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.extra?.parse_mode).toBe("HTML");
    expect(reply.text).toContain("<b>Current driver:</b>");

    const callbackData = getInlineKeyboard(reply).flat().map((button) => button.callback_data || "");
    expect(callbackData).toContain("switch:claude");
    expect(callbackData).toContain("switch:codex");
    expect(callbackData).not.toContain("switch:codex_unavailable");
  }, 20_000);

  it("handleSwitch /switch codex returns unavailable message when Codex is disabled", () => {
    const result = runSwitchCommandProbeInIsolatedProcess({
      command: "/switch codex",
      codexEnabled: false,
      codexCliAvailable: false,
    });

    expect(result.activeDriver).toBe("claude");
    expect(result.startNewThreadCalls).toBe(0);
    expect(result.sessionKillCalls).toBe(0);
    expect(result.codexKillCalls).toBe(0);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]!.text).toContain("Codex is disabled in config");
  }, 20_000);

  it("handleSwitch /switch codex switches driver and resets sessions when Codex is available", () => {
    const result = runSwitchCommandProbeInIsolatedProcess({
      command: "/switch codex",
      codexEnabled: true,
      codexCliAvailable: true,
    });

    expect(result.activeDriver).toBe("codex");
    expect(result.startNewThreadCalls).toBe(1);
    expect(result.sessionKillCalls).toBe(1);
    expect(result.codexKillCalls).toBe(1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]!.extra?.parse_mode).toBe("HTML");
    expect(result.replies[0]!.text).toContain("Switched to Codex");
  }, 20_000);

  it("handleSwitch /switch codex reports failure when Codex thread start fails", () => {
    const result = runSwitchCommandProbeInIsolatedProcess({
      command: "/switch codex",
      codexEnabled: true,
      codexCliAvailable: true,
      forceStartThreadFailure: true,
    });

    expect(result.activeDriver).toBe("claude");
    expect(result.startNewThreadCalls).toBe(1);
    expect(result.sessionKillCalls).toBe(1);
    expect(result.codexKillCalls).toBe(1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]!.text).toContain("Failed to switch to Codex");
    expect(result.replies[0]!.text).toContain("forced start failure for test");
  }, 20_000);
});
