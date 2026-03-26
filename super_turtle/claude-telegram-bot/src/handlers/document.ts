/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs and text files with media group buffering.
 * PDF extraction uses pdftotext CLI (macOS: brew install poppler, Linux: apt install poppler-utils)
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogAuth,
  auditLogError,
  auditLogRateLimit,
  generateRequestId,
  startTypingIndicator,
} from "../utils";
import { getDriverAuditType, isActiveDriverSessionActive, runMessageWithActiveDriver } from "./driver-routing";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { isAudioFile, processAudioFile } from "./audio";
import { eventLog, streamLog } from "../logger";
import { getTeleportRemoteUnsupportedMessage, isTeleportRemoteRuntime } from "../teleport";
import { stagePendingDocuments, type PendingDocumentBatch } from "../pending-document-inputs";

const documentLog = streamLog.child({ handler: "document" });

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Supported Office document extensions
const OFFICE_EXTENSIONS = [".docx", ".pptx", ".xlsx"];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const docPath = `${TEMP_DIR}/${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(docPath, buffer);

  return docPath;
}

/**
 * Extract text from a document.
 */
async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction using pdftotext CLI (install: brew install poppler)
  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      documentLog.error({ err: error, filePath, mimeType }, "PDF parsing failed");
      return "[PDF parsing failed - ensure pdftotext is installed: macOS: brew install poppler | Ubuntu/Debian: sudo apt install poppler-utils | Fedora: sudo dnf install poppler-utils]";
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  // Modern Office files
  if (
    extension === ".docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const text = await extractDocxText(filePath);
    return text.slice(0, 100000);
  }

  if (
    extension === ".pptx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    const text = await extractPptxText(filePath);
    return text.slice(0, 100000);
  }

  if (
    extension === ".xlsx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    const text = await extractXlsxText(filePath);
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#xA;/gi, "\n")
    .replace(/&#10;/g, "\n")
    .replace(/&#x9;/gi, "\t")
    .replace(/&#9;/g, "\t");
}

function stripXmlText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n\n")
      .replace(/<\/a:p>/g, "\n\n")
      .replace(/<\/a:tr>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function unzipFileEntry(filePath: string, entryPath: string): Promise<string> {
  const result = await Bun.$`unzip -p ${filePath} ${entryPath}`.quiet();
  return result.text();
}

async function listZipEntries(filePath: string, pattern: string): Promise<string[]> {
  const result = await Bun.$`unzip -Z1 ${filePath} ${pattern}`.quiet();
  return result
    .text()
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

async function extractDocxText(filePath: string): Promise<string> {
  try {
    const xml = await unzipFileEntry(filePath, "word/document.xml");
    const text = stripXmlText(xml);
    return text || "[DOCX document contains no extractable text]";
  } catch (error) {
    documentLog.error({ err: error, filePath }, "DOCX parsing failed");
    return "[DOCX parsing failed]";
  }
}

async function extractPptxText(filePath: string): Promise<string> {
  try {
    const slideEntries = await listZipEntries(filePath, "ppt/slides/slide*.xml");
    if (slideEntries.length === 0) {
      return "[PPTX presentation contains no slide text]";
    }

    const slides: string[] = [];
    for (const [index, entry] of slideEntries.entries()) {
      const xml = await unzipFileEntry(filePath, entry);
      const text = stripXmlText(xml);
      if (text) {
        slides.push(`--- Slide ${index + 1} ---\n${text}`);
      }
    }

    return slides.length > 0
      ? slides.join("\n\n")
      : "[PPTX presentation contains no extractable slide text]";
  } catch (error) {
    documentLog.error({ err: error, filePath }, "PPTX parsing failed");
    return "[PPTX parsing failed]";
  }
}

function getXmlAttr(tag: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}="([^"]*)"`, "i").exec(tag);
  return match?.[1] || null;
}

function columnLettersToIndex(cellRef: string | null): number {
  if (!cellRef) return 0;
  const letters = (cellRef.match(/^[A-Z]+/i)?.[0] || "").toUpperCase();
  if (!letters) return 0;
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
}

function parseSharedStrings(xml: string): string[] {
  const items: string[] = [];
  const siMatches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g);
  for (const match of siMatches) {
    const text = stripXmlText(match[1] || "");
    items.push(text);
  }
  return items;
}

async function extractXlsxText(filePath: string): Promise<string> {
  try {
    const workbookXml = await unzipFileEntry(filePath, "xl/workbook.xml");
    const workbookRelsXml = await unzipFileEntry(filePath, "xl/_rels/workbook.xml.rels");
    let sharedStrings: string[] = [];

    try {
      sharedStrings = parseSharedStrings(await unzipFileEntry(filePath, "xl/sharedStrings.xml"));
    } catch {
      sharedStrings = [];
    }

    const relMap = new Map<string, string>();
    for (const match of workbookRelsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const attrs = match[1] || "";
      const id = getXmlAttr(attrs, "Id");
      const target = getXmlAttr(attrs, "Target");
      if (id && target) {
        relMap.set(id, target);
      }
    }

    const sheets: string[] = [];
    for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
      const attrs = match[1] || "";
      const name = decodeXmlEntities(getXmlAttr(attrs, "name") || "Sheet");
      const relId = getXmlAttr(attrs, "r:id");
      const target = relId ? relMap.get(relId) : null;
      if (!target) continue;

      const sheetXml = await unzipFileEntry(filePath, `xl/${target.replace(/^\/+/, "")}`);
      const rows: string[] = [];

      for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const rowXml = rowMatch[1] || "";
        const cells = new Map<number, string>();

        for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const cellAttrs = cellMatch[1] || "";
          const cellBody = cellMatch[2] || "";
          const cellRef = getXmlAttr(cellAttrs, "r");
          const cellType = getXmlAttr(cellAttrs, "t");
          const colIndex = columnLettersToIndex(cellRef);

          let value = "";
          if (cellType === "s") {
            const sharedIndex = Number.parseInt(cellBody.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "", 10);
            value = Number.isFinite(sharedIndex) ? (sharedStrings[sharedIndex] || "") : "";
          } else if (cellType === "inlineStr") {
            value = stripXmlText(cellBody);
          } else {
            value = decodeXmlEntities(cellBody.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "");
          }

          const trimmed = value.replace(/\r/g, "").trim();
          if (trimmed) {
            cells.set(colIndex, trimmed);
          }
        }

        if (cells.size === 0) continue;
        const width = Math.max(...cells.keys()) + 1;
        const rowValues = Array.from({ length: width }, (_, index) => cells.get(index) || "");
        rows.push(rowValues.join("\t").replace(/\t+$/g, ""));
      }

      if (rows.length > 0) {
        sheets.push(`--- Sheet: ${name} ---\n${rows.join("\n")}`);
      }
    }

    return sheets.length > 0
      ? sheets.join("\n\n")
      : "[XLSX workbook contains no extractable cell text]";
  } catch (error) {
    documentLog.error({ err: error, filePath }, "XLSX parsing failed");
    return "[XLSX parsing failed]";
  }
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false })
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(
  extractDir: string
): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = `${extractDir}/${relativePath}`;
    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    // Check if it's a directory
    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file.
 */
async function processArchive(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  requestId?: string
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Show extraction progress
  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    // Extract archive
    documentLog.info({ userId, username, chatId, fileName }, "Extracting archive");
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    documentLog.info(
      { userId, username, chatId, fileName, fileCount: tree.length, readableFileCount: contents.length },
      "Archive extracted"
    );

    // Update status
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
      { parse_mode: "HTML" }
    );

    // Build prompt
    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const prompt = caption
      ? `Archive: ${fileName}\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n\n---\n\n${caption}`
      : `Please analyze this archive (${fileName}):\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}`;

    // Set conversation title (if new session)
    if (!isActiveDriverSessionActive()) {
      const rawTitle = caption || `[Archivio: ${fileName}]`;
      const title =
        rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
      session.conversationTitle = title;
    }

    // Create streaming state
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    const response = await runMessageWithActiveDriver({
      message: prompt,
      source: "archive",
      username,
      userId,
      chatId,
      ctx,
      statusCallback,
    });

    await auditLog(
      userId,
      username,
      getDriverAuditType("ARCHIVE"),
      `[${fileName}] ${caption || ""}`,
      response,
      { request_id: requestId, chat_id: chatId }
    );

    // Cleanup
    await Bun.$`rm -rf ${extractDir}`.quiet();

    // Delete status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }
  } catch (error) {
    documentLog.error({ err: error, userId, username, chatId, fileName }, "Archive processing failed");
    await auditLogError(
      userId,
      username,
      String(error).slice(0, 200),
      "processArchive",
      { request_id: requestId, chat_id: chatId }
    );
    // Delete status message on error
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    await ctx.reply(
      `❌ Failed to process archive: ${String(error).slice(0, 100)}`
    );
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process documents with Claude.
 */
async function processDocuments(
  ctx: Context,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  requestId?: string
): Promise<void> {
  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build prompt
  let prompt: string;
  if (documents.length === 1) {
    const doc = documents[0]!;
    prompt = caption
      ? `Document: ${doc.name}\n\nContent:\n${doc.content}\n\n---\n\n${caption}`
      : `Please analyze this document (${doc.name}):\n\n${doc.content}`;
  } else {
    const docList = documents
      .map((d, i) => `--- Document ${i + 1}: ${d.name} ---\n${d.content}`)
      .join("\n\n");
    prompt = caption
      ? `${documents.length} Documents:\n\n${docList}\n\n---\n\n${caption}`
      : `Please analyze these ${documents.length} documents:\n\n${docList}`;
  }

  // Set conversation title (if new session)
  if (!isActiveDriverSessionActive()) {
    const docName = documents[0]?.name || "[Documento]";
    const rawTitle = caption || `[Documento: ${docName}]`;
    const title =
      rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
    session.conversationTitle = title;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await runMessageWithActiveDriver({
      message: prompt,
      source: "document",
      username,
      userId,
      chatId,
      ctx,
      statusCallback,
    });

    await auditLog(
      userId,
      username,
      getDriverAuditType("DOCUMENT"),
      `[${documents.length} docs] ${caption || ""}`,
      response,
      { request_id: requestId, chat_id: chatId }
    );
  } catch (error) {
    await auditLogError(
      userId,
      username,
      String(error).slice(0, 200),
      "processDocuments",
      { request_id: requestId, chat_id: chatId }
    );
    await handleProcessingError(ctx, error, state.toolMessages);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process document paths by extracting text and calling processDocuments.
 */
async function processDocumentPaths(
  ctx: Context,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  requestId?: string
): Promise<void> {
  // Extract text from all documents
  const documents: Array<{ path: string; name: string; content: string }> = [];

  for (const path of paths) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      documentLog.error(
        { err: error, userId, username, chatId, path },
        "Failed to extract document from media group"
      );
    }
  }

  if (documents.length === 0) {
    await ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  await processDocuments(ctx, documents, caption, userId, username, chatId, requestId);
}

export async function processPendingDocumentBatch(
  ctx: Context,
  batch: PendingDocumentBatch,
  instruction: string,
  userId: number,
  username: string,
  chatId: number,
  requestId?: string
): Promise<void> {
  await processDocumentPaths(
    ctx,
    batch.paths,
    instruction,
    userId,
    username,
    chatId,
    requestId
  );
}

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const requestId = generateRequestId("document");
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await auditLogAuth(userId, username, false, {
      request_id: requestId,
      source: "document",
      chat_id: chatId,
    });
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  if (isTeleportRemoteRuntime()) {
    await ctx.reply(getTeleportRemoteUnsupportedMessage());
    return;
  }

  eventLog.info({
    event: "user.message.document",
    requestId,
    userId,
    username,
    chatId,
    fileName: doc.file_name || null,
    mimeType: doc.mime_type || null,
    fileSize: doc.file_size || null,
    mediaGroupId: mediaGroupId || null,
  });

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isOfficeFile =
    OFFICE_EXTENSIONS.includes(extension) ||
    doc.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    doc.mime_type === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const isArchiveFile = isArchive(fileName);

  // Check if it's an audio file sent as a document
  if (!isPdf && !isText && !isOfficeFile && !isArchiveFile && isAudioFile(fileName, doc.mime_type)) {
    documentLog.info(
      { userId, username, chatId, fileName, msgType: "audio-document" },
      "Received audio document"
    );

    // Rate limit check
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!, {
        request_id: requestId,
        source: "audio-document",
        chat_id: chatId,
      });
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Download and process as audio
    let docPath: string;
    try {
      docPath = await downloadDocument(ctx);
    } catch (error) {
      documentLog.error(
        { err: error, userId, username, chatId, fileName },
        "Failed to download audio document"
      );
      await ctx.reply("❌ Failed to download audio file.");
      return;
    }

    await processAudioFile(
      ctx,
      docPath,
      ctx.message?.caption,
      userId,
      username,
      chatId,
      requestId
    );
    return;
  }

  if (!isPdf && !isText && !isOfficeFile && !isArchiveFile) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, archives (${ARCHIVE_EXTENSIONS.join(
          ", "
        )}), Office (${OFFICE_EXTENSIONS.join(", ")}), ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  // 4. Download document
  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    documentLog.error({ err: error, userId, username, chatId, fileName }, "Failed to download document");
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Archive files - process separately (no media group support)
  if (isArchiveFile) {
    documentLog.info(
      { userId, username, chatId, fileName, msgType: "archive" },
      "Received archive document"
    );
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!, {
        request_id: requestId,
        source: "archive",
        chat_id: chatId,
      });
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    await processArchive(
      ctx,
      docPath,
      fileName,
      ctx.message?.caption,
      userId,
      username,
      chatId,
      requestId
    );
    return;
  }

  if (!mediaGroupId && !ctx.message?.caption?.trim()) {
    const batch = stagePendingDocuments(chatId, [docPath]);
    await ctx.reply(
      batch.paths.length === 1
        ? "📄 File received. Send a text message with instructions and I'll analyze it then."
        : `📄 File added. You now have ${batch.paths.length} pending files. Send a text message with instructions when ready.`
    );
    return;
  }

  // 6. Single document - process immediately
  if (!mediaGroupId) {
    documentLog.info(
      { userId, username, chatId, fileName, msgType: "document" },
      "Received document"
    );
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!, {
        request_id: requestId,
        source: "document",
        chat_id: chatId,
      });
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    try {
      const content = await extractText(docPath, doc.mime_type);
      await processDocuments(
        ctx,
        [{ path: docPath, name: fileName, content }],
        ctx.message?.caption,
        userId,
        username,
        chatId,
        requestId
      );
    } catch (error) {
      documentLog.error(
        { err: error, userId, username, chatId, fileName },
        "Failed to extract document"
      );
      await ctx.reply(
        `❌ Failed to process document: ${String(error).slice(0, 100)}`
      );
      await auditLogError(
        userId,
        username,
        String(error).slice(0, 200),
        "handleDocument.extractText",
        { request_id: requestId, chat_id: chatId }
      );
    }
    return;
  }

  // 7. Media group - buffer with timeout
  await documentBuffer.addToGroup(
    mediaGroupId,
    docPath,
    ctx,
    userId,
    username,
    (gctx, paths, caption, gUserId, gUsername, gChatId) =>
      caption?.trim()
        ? processDocumentPaths(gctx, paths, caption, gUserId, gUsername, gChatId, requestId)
        : (async () => {
            const batch = stagePendingDocuments(gChatId, paths);
            await gctx.reply(
              batch.paths.length === paths.length
                ? `📄 Received ${paths.length} files. Send a text message with instructions and I'll analyze them together.`
                : `📄 Added ${paths.length} files. You now have ${batch.paths.length} pending files. Send a text message with instructions when ready.`
            );
          })()
  );
}

export const __test__ = {
  extractText,
  extractDocxText,
  extractPptxText,
  stripXmlText,
};
