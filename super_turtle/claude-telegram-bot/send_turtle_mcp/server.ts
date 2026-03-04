#!/usr/bin/env bun
/**
 * Send Turtle MCP Server - Sends Emoji Kitchen turtle stickers as Telegram photos.
 *
 * When Claude calls send_turtle(), this server looks up the Google-hosted
 * Emoji Kitchen image URL from a pre-built combo table, then writes a request
 * file that the Telegram bot monitors and sends as a photo.
 *
 * Uses the official MCP TypeScript SDK for proper protocol compliance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dirname, resolve } from "path";
import { mcpLog } from "../src/logger";

const sendTurtleLog = mcpLog.child({ tool: "send_turtle", server: "send-turtle" });
const IPC_DIR = process.env.SUPERTURTLE_IPC_DIR || "/tmp";

// Load turtle combo lookup table (emoji codepoint → gstatic URL)
const COMBOS_PATH = resolve(dirname(import.meta.path), "turtle-combos.json");
const TURTLE_COMBOS: Record<string, string> = await Bun.file(COMBOS_PATH)
  .json()
  .catch((error) => {
    sendTurtleLog.error({ err: error, action: "load_combos", path: COMBOS_PATH }, "Failed to load turtle combos");
    return {};
  });

sendTurtleLog.info(
  { action: "load_combos", combosLoaded: Object.keys(TURTLE_COMBOS).length },
  "Loaded turtle combinations"
);

/**
 * Normalize an emoji input to the codepoint key format used in our combo table.
 * Handles: unicode characters ("🐢"), hex strings ("1f422"), prefixed ("U+1F422"),
 * and multi-codepoint emoji with variation selectors ("❤️" → "2764-fe0f").
 */
function emojiToCodepoint(input: string): string {
  const trimmed = input.trim();

  // Strip common prefixes
  const stripped = trimmed.replace(/^(U\+|0x)/i, "");

  // If it looks like a hex codepoint (possibly compound like "2764-fe0f"), use it
  if (/^[0-9a-f]+(-[0-9a-f]+)*$/i.test(stripped)) {
    return stripped.toLowerCase();
  }

  // Otherwise treat as unicode character(s) — convert all codepoints
  const codepoints: string[] = [];
  for (const char of trimmed) {
    const cp = char.codePointAt(0);
    if (cp) codepoints.push(cp.toString(16).toLowerCase());
  }

  if (codepoints.length === 0) {
    throw new Error(`Cannot parse emoji: "${input}"`);
  }

  return codepoints.join("-");
}

/**
 * Look up the gstatic URL for a turtle + emoji combo.
 * Tries multiple key formats to maximize match rate.
 */
function lookupCombo(partnerCode: string): string | null {
  // Direct match
  if (TURTLE_COMBOS[partnerCode]) return TURTLE_COMBOS[partnerCode]!;

  // Try without variation selector (fe0f)
  const withoutVS = partnerCode.replace(/-fe0f/g, "");
  if (withoutVS !== partnerCode && TURTLE_COMBOS[withoutVS]) {
    return TURTLE_COMBOS[withoutVS]!;
  }

  // Try with variation selector
  const withVS = partnerCode + "-fe0f";
  if (TURTLE_COMBOS[withVS]) return TURTLE_COMBOS[withVS]!;

  // Try just the base codepoint (first segment)
  const base = partnerCode.split("-")[0]!;
  if (base !== partnerCode && TURTLE_COMBOS[base]) return TURTLE_COMBOS[base]!;

  return null;
}

function requireChatId(): string {
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!chatId) {
    throw new Error(
      "send_turtle requires TELEGRAM_CHAT_ID in MCP server env (missing chat context)"
    );
  }
  return chatId;
}

// Create the MCP server
const server = new Server(
  {
    name: "send-turtle",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Build a human-readable list of some popular combos for the tool description
const POPULAR_EXAMPLES = [
  "😍 (heart eyes)", "🔥 (fire)", "⭐ (star)", "👻 (ghost)",
  "🎃 (pumpkin)", "💋 (kiss)", "🌈 (rainbow)", "💩 (poop)",
  "😎 (sunglasses)", "🐢 (turtle²)", "🎂 (cake)", "☕ (coffee)",
];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send_turtle",
        description:
          `Send an Emoji Kitchen turtle sticker as a photo in the Telegram chat. ` +
          `Combines turtle (🐢) with another emoji into a creative mashup sticker. ` +
          `There are ${Object.keys(TURTLE_COMBOS).length} available combinations. ` +
          `Popular ones: ${POPULAR_EXAMPLES.join(", ")}. ` +
          `Pass the partner emoji and an optional caption.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            emoji: {
              type: "string",
              description:
                'The emoji to combine with turtle — as a unicode character (😍) or hex codepoint (1f60d). If omitted, sends turtle + turtle.',
            },
            caption: {
              type: "string",
              description: "Optional caption text to include with the photo.",
            },
          },
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "send_turtle") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as {
    emoji?: string;
    caption?: string;
  };

  // Default to turtle + turtle if no emoji given
  const partnerCode = args.emoji ? emojiToCodepoint(args.emoji) : "1f422";

  // Look up the Google-hosted URL
  const url = lookupCombo(partnerCode);
  if (!url) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[No turtle combo found for emoji "${args.emoji || "🐢"}" (codepoint: ${partnerCode}). Try a different emoji — there are ${Object.keys(TURTLE_COMBOS).length} combos available.]`,
        },
      ],
    };
  }

  // Generate request ID and get chat context from environment
  const requestUuid = crypto.randomUUID().slice(0, 8);
  const chatId = requireChatId();

  // Write request file for the bot to pick up
  const requestData = {
    request_id: requestUuid,
    url,
    caption: args.caption || "",
    status: "pending",
    chat_id: chatId,
    created_at: new Date().toISOString(),
  };

  const requestFile = `${IPC_DIR}/send-turtle-${requestUuid}.json`;
  await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

  return {
    content: [
      {
        type: "text" as const,
        text: `[Turtle sticker sent to chat: 🐢 + ${args.emoji || "🐢"}]`,
      },
    ],
  };
});

// Run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  sendTurtleLog.info({ action: "startup" }, "Send Turtle MCP server running on stdio");
}

main().catch((error) => {
  sendTurtleLog.error({ err: error, action: "startup" }, "Send Turtle MCP server failed");
  process.exitCode = 1;
});
