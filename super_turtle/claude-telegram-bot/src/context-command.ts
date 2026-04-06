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

    const content = contentToString(entry.message?.content);
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

export async function getContextReport(
  _sessionId: string,
  _workingDir: string,
  _model?: string
): Promise<ContextResult> {
  return {
    ok: false,
    error: "/context is not available in the codex-only branch.",
  };
}
