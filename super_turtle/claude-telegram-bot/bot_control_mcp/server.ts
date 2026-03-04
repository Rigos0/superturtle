#!/usr/bin/env bun
/**
 * Bot Control MCP Server — lets Claude trigger bot-level actions.
 *
 * Actions: usage, switch_model, new_session, list_sessions, resume_session.
 *
 * Uses file-based IPC with polling:
 *   1. Writes request to /tmp/bot-control-{uuid}.json  (status: "pending")
 *   2. Bot's streaming handler picks it up, executes, writes result back (status: "completed")
 *   3. This server polls the file until the result appears (100ms intervals, 10s timeout)
 *   4. Returns result text to Claude
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpLog } from "../src/logger";

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const IPC_DIR = process.env.SUPERTURTLE_IPC_DIR || "/tmp";

const VALID_ACTIONS = [
  "usage",
  "switch_model",
  "switch_driver",
  "new_session",
  "list_sessions",
  "resume_session",
  "restart",
] as const;

type Action = (typeof VALID_ACTIONS)[number];
const VALID_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "all",
] as const;

type Level = (typeof VALID_LEVELS)[number];
const botControlLog = mcpLog.child({ tool: "bot_control", server: "bot-control" });

// Create the MCP server
const server = new Server(
  { name: "bot-control", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bot_control",
      description: [
        "Control the Telegram bot: check usage, switch model, manage sessions.",
        "Available actions:",
        '  "usage"          — fetch Claude subscription usage (rate-limit bars)',
        '  "switch_model"   — change model and/or effort level. params: { model?: string, effort?: string }',
        '                     models: "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"',
        '                     effort: "low", "medium", "high"',
        '  "switch_driver"  — switch active driver. params: { driver: "claude" | "codex" }',
        '  "new_session"    — kill current session, start fresh',
        '  "list_sessions"  — list saved sessions (id, title, date)',
        '  "resume_session" — resume a past session. params: { session_id: string }',
        '  "restart"        — restart the bot process',
      ].join("\n"),
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: VALID_ACTIONS as unknown as string[],
            description: "The bot action to perform",
          },
          params: {
            type: "object",
            description: "Optional parameters for the action",
            properties: {
              model: { type: "string", description: "Model identifier for switch_model" },
              effort: { type: "string", description: "Effort level for switch_model (low/medium/high)" },
              driver: { type: "string", description: "Driver for switch_driver (claude/codex)" },
              session_id: { type: "string", description: "Session ID for resume_session" },
            },
          },
        },
        required: ["action"],
      },
    },
    {
      name: "ask_user",
      description:
        "Present options to the user as tappable inline buttons in Telegram. IMPORTANT: After calling this tool, STOP and wait. Do NOT add any text after calling this tool - the user will tap a button and their choice becomes their next message. Just call the tool and end your turn.",
      inputSchema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "List of options for the user to choose from (2-6 options recommended)",
            minItems: 2,
            maxItems: 10,
          },
        },
        required: ["question", "options"],
      },
    },
    {
      name: "pino_logs",
      description: [
        "Fetch recent Pino logs from the Telegram bot.",
        "Use 'levels' for exact levels (e.g., [\"error\",\"warn\"]).",
        "Use 'level' for minimum severity (e.g., \"info\" includes warn/error).",
      ].join("\n"),
      inputSchema: {
        type: "object" as const,
        properties: {
          level: {
            type: "string",
            enum: VALID_LEVELS as unknown as string[],
            description: "Minimum severity (default: error).",
          },
          levels: {
            type: "array",
            items: { type: "string", enum: VALID_LEVELS as unknown as string[] },
            description: "Exact levels to include (overrides level).",
          },
          limit: {
            type: "integer",
            description: "Max number of log entries to return (default: 50).",
            minimum: 1,
            maximum: MAX_LIMIT,
          },
          module: {
            type: "string",
            description: "Optional module filter (e.g., claude, streaming, bot).",
          },
        },
      },
    },
  ],
}));

/**
 * Poll a request file until the bot writes a result back.
 */
async function pollForResult(filepath: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const text = await Bun.file(filepath).text();
      const data = JSON.parse(text);

      if (data.status === "completed") {
        // Clean up the request file
        try {
          const { unlinkSync } = await import("fs");
          unlinkSync(filepath);
        } catch { /* best-effort cleanup */ }
        return data.result || "Done (no result data).";
      }

      if (data.status === "error") {
        try {
          const { unlinkSync } = await import("fs");
          unlinkSync(filepath);
        } catch { /* best-effort cleanup */ }
        return `Error: ${data.error || "unknown error"}`;
      }
    } catch {
      // File might not exist yet or be mid-write — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return "Timed out waiting for bot to process the request. The bot may be busy.";
}

function requireChatId(toolName: string): string {
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!chatId) {
    throw new Error(
      `${toolName} requires TELEGRAM_CHAT_ID in MCP server env (missing chat context)`
    );
  }
  return chatId;
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ask_user") {
    const args = request.params.arguments as {
      question?: string;
      options?: string[];
    };

    const question = args.question || "";
    const options = args.options || [];

    if (!question || !options || options.length < 2) {
      throw new Error("question and at least 2 options required");
    }

    // Generate request ID and get chat context from environment
    const requestUuid = crypto.randomUUID().slice(0, 8);
    const chatId = requireChatId("ask_user");

    // Write request file for the bot to pick up
    const requestData = {
      request_id: requestUuid,
      question,
      options,
      status: "pending",
      chat_id: chatId,
      created_at: new Date().toISOString(),
    };

    const requestFile = `${IPC_DIR}/ask-user-${requestUuid}.json`;
    await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

    return {
      content: [
        {
          type: "text" as const,
          text: "[Buttons sent to user. STOP HERE - do not output any more text. Wait for user to tap a button.]",
        },
      ],
    };
  }

  if (request.params.name === "pino_logs") {
    const args = request.params.arguments as {
      level?: string;
      levels?: string[];
      limit?: number;
      module?: string;
    };

    const level = (args.level || "error") as Level;
    const levels =
      args.levels?.filter((item) => VALID_LEVELS.includes(item as Level)) || [];
    const limit = Math.max(
      1,
      Math.min(Number(args.limit || DEFAULT_LIMIT), MAX_LIMIT),
    );
    const moduleFilter = args.module ? String(args.module) : undefined;

    if (!VALID_LEVELS.includes(level)) {
      throw new Error(
        `Invalid level: ${level}. Valid: ${VALID_LEVELS.join(", ")}`,
      );
    }

    const requestUuid = crypto.randomUUID().slice(0, 8);
    const chatId = requireChatId("pino_logs");

    const requestData = {
      request_id: requestUuid,
      level,
      levels,
      limit,
      module: moduleFilter,
      status: "pending",
      chat_id: chatId,
      created_at: new Date().toISOString(),
    };

    const requestFile = `${IPC_DIR}/pino-logs-${requestUuid}.json`;
    await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

    const result = await pollForResult(requestFile);

    return {
      content: [{ type: "text" as const, text: result }],
    };
  }

  if (request.params.name !== "bot_control") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as {
    action?: string;
    params?: Record<string, string>;
  };

  const action = args.action as Action;
  if (!action || !VALID_ACTIONS.includes(action)) {
    throw new Error(
      `Invalid action: ${action}. Valid: ${VALID_ACTIONS.join(", ")}`,
    );
  }

  const requestUuid = crypto.randomUUID().slice(0, 8);
  const chatId = requireChatId("bot_control");

  const requestData = {
    request_id: requestUuid,
    action,
    params: args.params || {},
    status: "pending",
    chat_id: chatId,
    created_at: new Date().toISOString(),
  };

  const requestFile = `${IPC_DIR}/bot-control-${requestUuid}.json`;
  await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

  // Poll for the bot to process and write a result
  const result = await pollForResult(requestFile);

  return {
    content: [{ type: "text" as const, text: result }],
  };
});

// Run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  botControlLog.info({ action: "startup" }, "Bot Control MCP server running on stdio");
}

main().catch((error) => {
  botControlLog.error({ err: error, action: "startup" }, "Bot Control MCP server failed");
  process.exitCode = 1;
});
