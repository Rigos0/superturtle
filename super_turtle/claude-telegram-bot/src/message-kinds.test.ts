import { describe, expect, it } from "bun:test";
import {
  classifyCodexToolCompletionMessage,
  classifyDriverStatusMessage,
  OutboundMessageKind,
} from "./message-kinds";

describe("classifyDriverStatusMessage()", () => {
  it("classifies progress-bearing driver status events", () => {
    expect(classifyDriverStatusMessage("thinking")).toBe(
      OutboundMessageKind.InteractiveProgress
    );
    expect(classifyDriverStatusMessage("tool")).toBe(
      OutboundMessageKind.InteractiveProgress
    );
    expect(classifyDriverStatusMessage("text")).toBe(
      OutboundMessageKind.InteractiveProgress
    );
  });

  it("classifies segment completion as interactive final output", () => {
    expect(classifyDriverStatusMessage("segment_end")).toBe(
      OutboundMessageKind.InteractiveFinal
    );
  });

  it("returns null for done because it is a lifecycle event, not a message", () => {
    expect(classifyDriverStatusMessage("done")).toBeNull();
  });
});

describe("classifyCodexToolCompletionMessage()", () => {
  it("classifies known Codex MCP side-effect tools", () => {
    expect(classifyCodexToolCompletionMessage("ask_user")).toBe(
      OutboundMessageKind.InteractiveSideEffect
    );
    expect(classifyCodexToolCompletionMessage("send-image")).toBe(
      OutboundMessageKind.InteractiveSideEffect
    );
    expect(classifyCodexToolCompletionMessage("send_file")).toBe(
      OutboundMessageKind.InteractiveSideEffect
    );
    expect(classifyCodexToolCompletionMessage("send_turtle")).toBe(
      OutboundMessageKind.InteractiveSideEffect
    );
    expect(classifyCodexToolCompletionMessage("bot_control")).toBe(
      OutboundMessageKind.InteractiveSideEffect
    );
    expect(classifyCodexToolCompletionMessage("pino_logs")).toBe(
      OutboundMessageKind.InteractiveSideEffect
    );
  });

  it("returns null for unclassified tools", () => {
    expect(classifyCodexToolCompletionMessage("shell")).toBeNull();
  });
});
