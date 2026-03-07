import { describe, expect, it } from "bun:test";
import {
  contentToString,
  extractLocalCommandStdout,
  findLatestContextOutput,
} from "./context-command";

const wrapStdout = (body: string): string =>
  `prefix <local-command-stdout>\n${body}\n</local-command-stdout> suffix`;

const toJsonl = (entries: unknown[]): string => entries.map((entry) => JSON.stringify(entry)).join("\n");

describe("contentToString()", () => {
  it("returns string content as-is", () => {
    expect(contentToString("hello")).toBe("hello");
  });

  it("joins text entries from array content", () => {
    expect(
      contentToString([
        { type: "text", text: "first line" },
        { type: "image", text: "ignored" },
        { type: "text", text: "second line" },
        { foo: "bar" },
      ])
    ).toBe("first line\nsecond line");
  });

  it("returns null for null, undefined, or arrays without text entries", () => {
    expect(contentToString(null)).toBeNull();
    expect(contentToString(undefined)).toBeNull();
    expect(contentToString([{ type: "image", text: "nope" }])).toBeNull();
  });
});

describe("extractLocalCommandStdout()", () => {
  it("extracts trimmed content between local-command-stdout tags", () => {
    const extracted = extractLocalCommandStdout(
      "before <local-command-stdout>\nContext Usage: 57%\n</local-command-stdout> after"
    );
    expect(extracted).toBe("Context Usage: 57%");
  });

  it("returns null when tags are missing", () => {
    expect(extractLocalCommandStdout("Context Usage: 57%")).toBeNull();
  });

  it("returns null for malformed tags", () => {
    expect(extractLocalCommandStdout("<local-command-stdout>missing close")).toBeNull();
    expect(
      extractLocalCommandStdout("</local-command-stdout><local-command-stdout>wrong order")
    ).toBeNull();
  });
});

describe("findLatestContextOutput()", () => {
  it("finds the most recent qualifying context output", () => {
    const startedAtMs = Date.parse("2026-02-01T12:00:05.000Z");
    const sessionLog = toJsonl([
      {
        timestamp: "2026-02-01T12:00:00.000Z",
        message: { content: wrapStdout("Context Usage: 11%") },
      },
      {
        timestamp: "2026-02-01T12:00:03.000Z",
        message: { content: "not context output" },
      },
      {
        timestamp: "2026-02-01T12:00:04.000Z",
        message: { content: wrapStdout("Context Usage: 42%") },
      },
    ]);

    expect(findLatestContextOutput(sessionLog, startedAtMs)).toBe("Context Usage: 42%");
  });

  it("returns null when no context output is found", () => {
    const sessionLog = toJsonl([
      { timestamp: "2026-02-01T12:00:00.000Z", message: { content: "plain text" } },
      { timestamp: "2026-02-01T12:00:01.000Z", message: { content: "<local-command-stdout>done</local-command-stdout>" } },
    ]);

    expect(findLatestContextOutput(sessionLog, Date.parse("2026-02-01T12:00:05.000Z"))).toBeNull();
  });

  it("finds context output in newer CLI format (top-level content, type=system)", () => {
    const startedAtMs = Date.parse("2026-02-01T12:00:05.000Z");
    const sessionLog = toJsonl([
      {
        type: "system",
        subtype: "local_command",
        timestamp: "2026-02-01T12:00:04.000Z",
        content: wrapStdout("Context Usage: 55%"),
      },
    ]);

    expect(findLatestContextOutput(sessionLog, startedAtMs)).toBe("Context Usage: 55%");
  });

  it("falls back to the latest matching output even if timestamps are old", () => {
    const startedAtMs = Date.parse("2026-02-01T12:00:10.000Z");
    const sessionLog = toJsonl([
      {
        timestamp: "2026-02-01T12:00:00.000Z",
        message: { content: wrapStdout("Context Usage: 8%") },
      },
      {
        timestamp: "2026-02-01T12:00:01.000Z",
        message: { content: wrapStdout("Context Usage: 9%") },
      },
    ]);

    expect(findLatestContextOutput(sessionLog, startedAtMs)).toBe("Context Usage: 9%");
  });
});
