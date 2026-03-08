import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { DriverRunSource } from "./drivers/types";
import { SCHEDULED_PROMPT_INSTRUCTION } from "./cron-scheduled-prompt";

export type InjectedArtifactId =
  | "claude-md"
  | "meta-prompt"
  | "codex-bootstrap-prompt"
  | "date-prefix"
  | "cron-scheduled"
  | "background-snapshot";

export interface InjectedArtifact {
  id: InjectedArtifactId;
  label: string;
  order: number;
  text: string;
  applied: boolean;
}

export type ClaudeMdSnapshot = {
  loaded: boolean;
  text: string;
};

export function readClaudeMdSnapshot(workingDir: string): ClaudeMdSnapshot {
  const path = join(workingDir, "CLAUDE.md");
  if (!existsSync(path)) {
    return { loaded: false, text: "" };
  }
  try {
    return {
      loaded: true,
      text: readFileSync(path, "utf-8"),
    };
  } catch {
    return { loaded: true, text: "" };
  }
}

function extractDatePrefix(prompt: string): string {
  const match = prompt.match(
    /^(?:<system-instructions>\n[\s\S]*?\n<\/system-instructions>\n\n)?(\[Current date\/time:[^\n]*\]\n\n)/
  );
  return match?.[1] || "";
}

export function buildInjectedArtifacts(params: {
  source: DriverRunSource;
  effectivePrompt: string;
  originalMessage: string;
  datePrefixApplied: boolean;
  metaPromptApplied: boolean;
  claudeMdLoaded: boolean;
  claudeMdText: string;
  metaPromptText: string;
  metaPromptArtifactId?: InjectedArtifactId;
  metaPromptLabel?: string;
}): InjectedArtifact[] {
  const artifacts: InjectedArtifact[] = [];

  if (params.claudeMdLoaded) {
    artifacts.push({
      id: "claude-md",
      label: "CLAUDE.md context",
      order: 10,
      text: params.claudeMdText,
      applied: true,
    });
  }

  if (params.metaPromptApplied && params.metaPromptText.length > 0) {
    artifacts.push({
      id: params.metaPromptArtifactId || "meta-prompt",
      label: params.metaPromptLabel || "Meta system prompt",
      order: 20,
      text: params.metaPromptText,
      applied: true,
    });
  }

  if (params.datePrefixApplied) {
    artifacts.push({
      id: "date-prefix",
      label: "Date/time prefix",
      order: 30,
      text: extractDatePrefix(params.effectivePrompt),
      applied: true,
    });
  }

  if (
    params.source === "cron_scheduled" ||
    params.effectivePrompt.includes(SCHEDULED_PROMPT_INSTRUCTION)
  ) {
    artifacts.push({
      id: "cron-scheduled",
      label: "Cron scheduled instruction",
      order: 40,
      text: SCHEDULED_PROMPT_INSTRUCTION,
      applied: true,
    });
  }

  if (params.source === "background_snapshot") {
    artifacts.push({
      id: "background-snapshot",
      label: "Background snapshot prompt",
      order: 50,
      text: params.originalMessage,
      applied: true,
    });
  }

  return artifacts.sort((left, right) => left.order - right.order);
}
