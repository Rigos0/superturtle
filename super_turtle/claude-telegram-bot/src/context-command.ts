import { homedir } from "os";
import { join } from "path";
import { CLAUDE_CLI_PATH } from "./config";

type ContextResult =
  | { ok: true; markdown: string }
  | { ok: false; error: string };

interface SessionLogEntry {
  timestamp?: string;
  message?: {
    content?: unknown;
  };
}

export function contentToString(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      "text" in item &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

export function extractLocalCommandStdout(text: string): string | null {
  const startTag = "<local-command-stdout>";
  const endTag = "</local-command-stdout>";
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return text.slice(start + startTag.length, end).trim();
}

export function findLatestContextOutput(
  sessionLogText: string,
  startedAtMs: number
): string | null {
  const lines = sessionLogText.split("\n").filter(Boolean);
  let fallback: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    let entry: SessionLogEntry;

    try {
      entry = JSON.parse(line) as SessionLogEntry;
    } catch {
      continue;
    }

    // Context output can appear as entry.message.content (older CLI) or
    // entry.content directly (newer CLI: type=system, subtype=local_command)
    const content = contentToString(entry.message?.content)
      ?? (typeof (entry as Record<string, unknown>).content === "string"
        ? (entry as Record<string, unknown>).content as string
        : null);
    if (!content || !content.includes("<local-command-stdout>")) {
      continue;
    }

    const extracted = extractLocalCommandStdout(content);
    if (!extracted || !extracted.includes("Context Usage")) {
      continue;
    }

    if (!fallback) {
      fallback = extracted;
    }

    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
    if (Number.isFinite(ts) && ts >= startedAtMs - 2000) {
      return extracted;
    }
  }

  return fallback;
}

async function findSessionLogPath(sessionId: string): Promise<string | null> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);

  try {
    for await (const absPath of glob.scan({
      cwd: projectsDir,
      absolute: true,
      followSymlinks: false,
    })) {
      return absPath;
    }
  } catch {
    return null;
  }

  return null;
}

export async function getContextReport(
  sessionId: string,
  workingDir: string
): Promise<ContextResult> {
  const sessionLogPath = await findSessionLogPath(sessionId);
  if (!sessionLogPath) {
    return {
      ok: false,
      error: "Could not locate Claude session log for the active session.",
    };
  }

  const startedAtMs = Date.now();
  const proc = Bun.spawnSync([CLAUDE_CLI_PATH, "-p", "-r", sessionId, "/context"], {
    cwd: workingDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = Buffer.from(proc.stderr).toString("utf-8").trim();

  const file = Bun.file(sessionLogPath);
  const sessionLogText = await file.text();
  const contextMarkdown = findLatestContextOutput(sessionLogText, startedAtMs);

  if (!proc.success && !contextMarkdown) {
    return {
      ok: false,
      error: stderr || "Failed to run Claude /context command.",
    };
  }

  if (!contextMarkdown) {
    return {
      ok: false,
      error: "Context output is not available for this session yet.",
    };
  }

  return { ok: true, markdown: contextMarkdown };
}
