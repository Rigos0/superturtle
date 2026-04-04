#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { mcpLog } from "../src/logger";

const notionLog = mcpLog.child({ tool: "notion", server: "notion-mcp" });
const NOTION_API_BASE_URL = "https://api.notion.com";
const NOTION_API_VERSION = process.env.NOTION_API_VERSION?.trim() || "2025-09-03";

type NotionToolName =
  | "get_me"
  | "search"
  | "retrieve_page"
  | "retrieve_page_markdown"
  | "create_page"
  | "update_page_markdown";

const TOOL_DEFINITIONS: Array<{
  name: NotionToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "get_me",
    description: "Return the current Notion integration/user identity.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description: "Search pages and databases visible to the integration.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        page_size: { type: "number" },
      },
    },
  },
  {
    name: "retrieve_page",
    description: "Retrieve raw metadata for a Notion page.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "retrieve_page_markdown",
    description: "Retrieve a page and return a simple markdown rendering of its child blocks.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "create_page",
    description: "Create a child page under a parent page, with optional markdown content.",
    inputSchema: {
      type: "object",
      properties: {
        parent_page_id: { type: "string" },
        title: { type: "string" },
        markdown: { type: "string" },
      },
      required: ["parent_page_id", "title"],
    },
  },
  {
    name: "update_page_markdown",
    description: "Append markdown content to an existing Notion page.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        markdown: { type: "string" },
      },
      required: ["page_id", "markdown"],
    },
  },
];

const server = new Server(
  {
    name: "notion-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOL_DEFINITIONS.filter((tool) => isToolAllowed(tool.name)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name as NotionToolName;
  if (!isKnownTool(name)) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  if (!isToolAllowed(name)) {
    throw new Error(`Tool not allowed: ${name}`);
  }

  const args = (request.params.arguments || {}) as Record<string, unknown>;

  if (name === "get_me") {
    return textResult(JSON.stringify(await notionRequest("/v1/users/me"), null, 2));
  }

  if (name === "search") {
    const body: Record<string, unknown> = {
      page_size: readOptionalInt(args.page_size, 10),
    };
    const query = readOptionalString(args.query);
    if (query) {
      body.query = query;
    }
    return textResult(JSON.stringify(await notionRequest("/v1/search", { method: "POST", body }), null, 2));
  }

  if (name === "retrieve_page") {
    const pageId = readRequiredString(args.page_id, "page_id");
    return textResult(JSON.stringify(await notionRequest(`/v1/pages/${pageId}`), null, 2));
  }

  if (name === "retrieve_page_markdown") {
    const pageId = readRequiredString(args.page_id, "page_id");
    const [page, blocks] = await Promise.all([
      notionRequest(`/v1/pages/${pageId}`),
      listBlockChildren(pageId),
    ]);
    const title = extractPageTitle(page);
    const markdown = renderBlocksToMarkdown(blocks);
    return textResult(`${title ? `# ${title}\n\n` : ""}${markdown}`.trim());
  }

  if (name === "create_page") {
    const parentPageId = readRequiredString(args.parent_page_id, "parent_page_id");
    const title = readRequiredString(args.title, "title");
    const markdown = readOptionalString(args.markdown);
    const payload = await notionRequest("/v1/pages", {
      method: "POST",
      body: {
        parent: {
          type: "page_id",
          page_id: parentPageId,
        },
        properties: {
          title: {
            title: [{ type: "text", text: { content: title } }],
          },
        },
        ...(markdown ? { children: markdownToBlocks(markdown) } : {}),
      },
    });
    return textResult(JSON.stringify(payload, null, 2));
  }

  if (name === "update_page_markdown") {
    const pageId = readRequiredString(args.page_id, "page_id");
    const markdown = readRequiredString(args.markdown, "markdown");
    const payload = await notionRequest(`/v1/blocks/${pageId}/children`, {
      method: "PATCH",
      body: {
        children: markdownToBlocks(markdown),
      },
    });
    return textResult(JSON.stringify(payload, null, 2));
  }

  throw new Error(`Unhandled tool: ${name}`);
});

async function notionRequest(path: string, init: { method?: string; body?: unknown } = {}) {
  const accessToken = requireNotionAccessToken();
  const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
    body: init.body ? JSON.stringify(init.body) : undefined,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    method: init.method || "GET",
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `Notion request failed with ${response.status}`);
  }

  return await response.json();
}

async function listBlockChildren(blockId: string) {
  const response = (await notionRequest(`/v1/blocks/${blockId}/children?page_size=100`)) as {
    results?: Array<Record<string, unknown>>;
  };
  return Array.isArray(response.results) ? response.results : [];
}

function renderBlocksToMarkdown(blocks: Array<Record<string, unknown>>) {
  return blocks
    .map((block) => renderBlockToMarkdown(block))
    .filter(Boolean)
    .join("\n\n");
}

function renderBlockToMarkdown(block: Record<string, unknown>) {
  const type = readOptionalString(block.type);
  if (!type) {
    return "";
  }

  const payload = isObject(block[type]) ? block[type] : null;
  const richText = Array.isArray(payload?.rich_text) ? payload.rich_text : [];
  const text = richText.map(readRichTextItem).join("").trim();

  switch (type) {
    case "heading_1":
      return text ? `# ${text}` : "";
    case "heading_2":
      return text ? `## ${text}` : "";
    case "heading_3":
      return text ? `### ${text}` : "";
    case "bulleted_list_item":
      return text ? `- ${text}` : "";
    case "numbered_list_item":
      return text ? `1. ${text}` : "";
    case "to_do":
      return text ? `- [ ] ${text}` : "";
    case "quote":
      return text ? `> ${text}` : "";
    case "code":
      return text ? `\`\`\`\n${text}\n\`\`\`` : "";
    case "paragraph":
    default:
      return text;
  }
}

function readRichTextItem(item: unknown) {
  if (!isObject(item)) {
    return "";
  }
  const plainText = readOptionalString(item.plain_text);
  return plainText || "";
}

function markdownToBlocks(markdown: string) {
  return markdown
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const text = stripMarkdownPrefix(chunk);
      return {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content: text,
              },
            },
          ],
        },
      };
    });
}

function extractPageTitle(page: unknown) {
  if (!isObject(page) || !isObject(page.properties)) {
    return "";
  }

  for (const value of Object.values(page.properties)) {
    if (!isObject(value) || value.type !== "title" || !Array.isArray(value.title)) {
      continue;
    }

    const title = value.title.map(readRichTextItem).join("").trim();
    if (title) {
      return title;
    }
  }

  return "";
}

function stripMarkdownPrefix(value: string) {
  return value.replace(/^(#{1,6}\s+|[-*]\s+|1\.\s+|>\s+)/, "");
}

function requireNotionAccessToken() {
  const token = (process.env.NOTION_API_TOKEN || "").trim();
  if (!token) {
    throw new Error("NOTION_API_TOKEN is required");
  }
  return token;
}

function isKnownTool(value: string): value is NotionToolName {
  return TOOL_DEFINITIONS.some((tool) => tool.name === value);
}

function isToolAllowed(tool: NotionToolName) {
  const raw = process.env.NOTION_MCP_ALLOWED_TOOLS?.trim();
  if (!raw) {
    return true;
  }

  const allowed = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  return allowed.has(tool);
}

function readRequiredString(value: unknown, field: string) {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readOptionalInt(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  notionLog.info({ action: "startup" }, "Notion MCP server running on stdio");
}

main().catch((error) => {
  notionLog.error({ err: error, action: "startup" }, "Notion MCP server failed");
  process.exitCode = 1;
});
