import type { Context } from "grammy";
import type { Message } from "grammy/types";

export type TerminalOutputKind = "final_success" | "final_artifact";

export interface TerminalOutputEntry {
  messages: Message[];
  resend: (ctx: Context, notify: boolean) => Promise<Message[]>;
  replaceExisting: boolean;
  kind: TerminalOutputKind;
  progressSummary: string | null;
}

export class TerminalOutputPlan {
  private outputs: TerminalOutputEntry[] = [];

  getLatestOutput(): TerminalOutputEntry | null {
    return this.outputs[this.outputs.length - 1] || null;
  }

  getOutputs(): TerminalOutputEntry[] {
    return this.outputs;
  }

  hasArtifactOutputs(): boolean {
    return this.outputs.some((output) => output.kind === "final_artifact");
  }

  queueSuccess(output: TerminalOutputEntry): void {
    if (this.hasArtifactOutputs()) {
      return;
    }
    this.outputs = [output];
  }

  appendArtifact(output: TerminalOutputEntry): void {
    const preservedArtifacts = this.outputs.filter(
      (existing) => existing.kind === "final_artifact"
    );
    preservedArtifacts.push(output);
    this.outputs = preservedArtifacts;
  }
}
