import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearPendingDocuments,
  consumePendingDocuments,
  peekPendingDocuments,
  stagePendingDocuments,
} from "./pending-document-inputs";

describe("pending document inputs", () => {
  const chatId = 123;

  beforeEach(() => {
    clearPendingDocuments(chatId);
  });

  it("stages and consumes document paths by chat", () => {
    const batch = stagePendingDocuments(chatId, ["/tmp/a.pdf"]);
    expect(batch.paths).toEqual(["/tmp/a.pdf"]);
    expect(peekPendingDocuments(chatId)?.paths).toEqual(["/tmp/a.pdf"]);

    stagePendingDocuments(chatId, ["/tmp/b.xlsx", "/tmp/c.docx"]);
    expect(peekPendingDocuments(chatId)?.paths).toEqual([
      "/tmp/a.pdf",
      "/tmp/b.xlsx",
      "/tmp/c.docx",
    ]);

    expect(consumePendingDocuments(chatId)?.paths).toEqual([
      "/tmp/a.pdf",
      "/tmp/b.xlsx",
      "/tmp/c.docx",
    ]);
    expect(peekPendingDocuments(chatId)).toBeNull();
  });
});
