#!/usr/bin/env node
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotatePassage,
  collectCard,
  continueReading,
  dataDir,
  dismissCard,
  getProgress,
  listCardInbox,
  listCardCollection,
  listCards,
  listAnnotations,
  listBooks,
  listChunks,
  listSubmissions,
  markRead,
  readCard,
  readChunk,
  readSubmission,
  replyToAnnotation,
  searchChunks,
  submitUserNotes,
} from "./store.js";
import {
  appendImportPart,
  beginImport,
  cancelImport,
  finishImport,
  importBook,
} from "./importer.js";
import { renderCardImageContent, saveCardImage } from "./card-renderer.js";

const protocolVersion = "2024-11-05";

export const tools = [
  {
    name: "reading_list_books",
    description: "List imported books with progress and annotation counts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { title: "List Books", readOnlyHint: true },
  },
  {
    name: "reading_list_chunks",
    description: "List chunks for a book in reading order.",
    inputSchema: {
      type: "object",
      required: ["bookId"],
      properties: { bookId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "List Chunks", readOnlyHint: true },
  },
  {
    name: "reading_read_chunk",
    description: "Read one book chunk and return prevId/nextId.",
    inputSchema: {
      type: "object",
      required: ["bookId", "chunkId"],
      properties: { bookId: { type: "string" }, chunkId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Read Chunk", readOnlyHint: true },
  },
  {
    name: "reading_continue",
    description:
      "Continue reading from the next unread chunk. If bookId is omitted, use the most recently read book.",
    inputSchema: {
      type: "object",
      properties: { bookId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Continue Reading", readOnlyHint: true },
  },
  {
    name: "reading_search_chunks",
    description: "Search book chunks by keyword.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        bookId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Search Chunks", readOnlyHint: true },
  },
  {
    name: "reading_import_book",
    description:
      "Import one EPUB or TXT file from base64 content into the reading library. Use this for files small enough for one MCP request.",
    inputSchema: {
      type: "object",
      required: ["filename", "dataBase64"],
      properties: {
        filename: { type: "string" },
        dataBase64: { type: "string" },
        format: { type: "string", enum: ["epub", "txt", "text", "md", "markdown"] },
        bookId: { type: "string" },
        title: { type: "string" },
        author: { type: "string" },
        maxChars: { type: "number" },
        headingRegex: { type: "string" },
        minSectionChars: { type: "number" },
        overwrite: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Import Book" },
  },
  {
    name: "reading_import_begin",
    description:
      "Start a chunked EPUB/TXT import. Use this when the file is too large for one reading_import_book request.",
    inputSchema: {
      type: "object",
      required: ["filename"],
      properties: {
        filename: { type: "string" },
        format: { type: "string", enum: ["epub", "txt", "text", "md", "markdown"] },
        expectedBytes: { type: "number" },
        bookId: { type: "string" },
        title: { type: "string" },
        author: { type: "string" },
        maxChars: { type: "number" },
        headingRegex: { type: "string" },
        minSectionChars: { type: "number" },
        overwrite: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Begin Import" },
  },
  {
    name: "reading_import_part",
    description: "Append one base64 file part to an active chunked import.",
    inputSchema: {
      type: "object",
      required: ["uploadId", "dataBase64"],
      properties: {
        uploadId: { type: "string" },
        dataBase64: { type: "string" },
        index: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Import Part" },
  },
  {
    name: "reading_import_finish",
    description: "Finish a chunked import and add the uploaded EPUB/TXT to the reading library.",
    inputSchema: {
      type: "object",
      required: ["uploadId"],
      properties: { uploadId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Finish Import" },
  },
  {
    name: "reading_import_cancel",
    description: "Cancel a chunked import and delete its temporary upload file.",
    inputSchema: {
      type: "object",
      required: ["uploadId"],
      properties: { uploadId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Cancel Import" },
  },
  {
    name: "reading_annotate_passage",
    description: "Write a Claude margin annotation anchored to a quote in a chunk. Human private notes should be created through the HTTP reader API, not this MCP tool.",
    inputSchema: {
      type: "object",
      required: ["bookId", "chunkId", "quote", "note"],
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        quote: { type: "string" },
        note: { type: "string" },
        kind: { type: "string" },
        mood: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        parentId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Annotate Passage" },
  },
  {
    name: "reading_list_annotations",
    description: "List annotations, optionally filtered by book, chunk, kind, or author.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        kind: { type: "string" },
        author: { type: "string" },
        status: { type: "string" },
        parentId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "List Annotations", readOnlyHint: true },
  },
  {
    name: "reading_submit_user_notes",
    description:
      "Submit open user notes for Claude review. By default, include each chunk's full text once per session and mark notes submitted so they are not sent again.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        sessionId: { type: "string" },
        contextMode: {
          type: "string",
          enum: ["chunk-once-per-session", "chunk-always", "notes-only"],
        },
        includeContext: { type: "boolean" },
        forceChunkContext: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Submit User Notes" },
  },
  {
    name: "reading_list_submissions",
    description: "List human note submission batches that have been shared with Claude.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        sessionId: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "List Submissions", readOnlyHint: true },
  },
  {
    name: "reading_read_submission",
    description: "Read one human note submission batch including notes and context.",
    inputSchema: {
      type: "object",
      required: ["submissionId"],
      properties: { submissionId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Read Submission", readOnlyHint: true },
  },
  {
    name: "reading_reply_to_annotation",
    description: "Attach a Claude reply under an existing user or Claude annotation.",
    inputSchema: {
      type: "object",
      required: ["parentId", "note"],
      properties: {
        parentId: { type: "string" },
        note: { type: "string" },
        kind: { type: "string" },
        mood: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        bookId: { type: "string" },
        chunkId: { type: "string" },
        quote: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Reply To Annotation" },
  },
  {
    name: "reading_mark_read",
    description: "Mark a chunk as read and update last-read progress.",
    inputSchema: {
      type: "object",
      required: ["bookId", "chunkId"],
      properties: { bookId: { type: "string" }, chunkId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Mark Read" },
  },
  {
    name: "reading_card_inbox",
    description: "Show unread collected reading-card prompts, like a small bookmark inbox.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Reading Card Inbox", readOnlyHint: true },
  },
  {
    name: "reading_card_collection",
    description: "Browse collected reading cards as a paginated collection without opening every image.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Reading Card Collection", readOnlyHint: true },
  },
  {
    name: "reading_open_card",
    description: "Open one collected reading card and return it as an image for Claude to view.",
    inputSchema: {
      type: "object",
      required: ["cardId"],
      properties: { cardId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Open Reading Card", readOnlyHint: true },
  },
  {
    name: "reading_save_card",
    description: "Render one collected reading card to a local image file and return its absolute path.",
    inputSchema: {
      type: "object",
      required: ["cardId"],
      properties: { cardId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Save Reading Card" },
  },
  {
    name: "reading_dismiss_card",
    description: "Dismiss one collected reading card from the card inbox without deleting it.",
    inputSchema: {
      type: "object",
      required: ["cardId"],
      properties: { cardId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Dismiss Reading Card" },
  },
  {
    name: "reading_list_cards",
    description: "List collected ritual reading cards/bookmarks for completed sections or shared margin moments.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        source: { type: "string" },
        scope: { type: "string", enum: ["section", "book"] },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "List Reading Cards", readOnlyHint: true },
  },
  {
    name: "reading_collect_card",
    description: "Collect a small ritual reading card/bookmark so it can be revisited later.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        bookTitle: { type: "string" },
        chunkTitle: { type: "string" },
        title: { type: "string" },
        subtitle: { type: "string" },
        kicker: { type: "string" },
        quote: { type: "string" },
        note: { type: "string" },
        footer: { type: "string" },
        art: { type: "string", enum: ["fold", "ripple", "stardust", "lastfold"] },
        variant: { type: "string" },
        scope: { type: "string", enum: ["section", "book"] },
        source: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Collect Reading Card" },
  },
  {
    name: "reading_get_progress",
    description: "Get reading progress for one book or all books.",
    inputSchema: {
      type: "object",
      properties: { bookId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Get Progress", readOnlyHint: true },
  },
];

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textContent(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function imageContent({ text, image }) {
  return {
    content: [
      { type: "text", text },
      image,
    ],
  };
}

export async function callTool(name, args = {}) {
  switch (name) {
    case "reading_list_books":
      return textContent(await listBooks());
    case "reading_list_chunks":
      return textContent(await listChunks(args.bookId));
    case "reading_read_chunk":
      return textContent(await readChunk(args.bookId, args.chunkId));
    case "reading_continue":
      return textContent(await continueReading(args));
    case "reading_search_chunks":
      return textContent(await searchChunks(args));
    case "reading_import_book":
      return textContent(await importBook(args));
    case "reading_import_begin":
      return textContent(await beginImport(args));
    case "reading_import_part":
      return textContent(await appendImportPart(args));
    case "reading_import_finish":
      return textContent(await finishImport(args));
    case "reading_import_cancel":
      return textContent(await cancelImport(args));
    case "reading_annotate_passage":
      return textContent(await annotatePassage({ ...args, author: "claude", status: "published" }));
    case "reading_list_annotations":
      return textContent(await listAnnotations(args));
    case "reading_submit_user_notes":
      return textContent(await submitUserNotes(args));
    case "reading_list_submissions":
      return textContent(await listSubmissions(args));
    case "reading_read_submission":
      return textContent(await readSubmission(args.submissionId));
    case "reading_reply_to_annotation":
      return textContent(await replyToAnnotation({ ...args, author: "claude", status: "published" }));
    case "reading_mark_read":
      return textContent(await markRead(args.bookId, args.chunkId));
    case "reading_card_inbox":
      return textContent(await listCardInbox(args));
    case "reading_card_collection":
      return textContent(await listCardCollection(args));
    case "reading_open_card": {
      const card = await readCard(args.cardId);
      return imageContent({
        text: `${card.kicker || "收获了一枚回声书签"}\n${card.title || card.bookTitle || "Reading card"}`,
        image: renderCardImageContent(card),
      });
    }
    case "reading_save_card": {
      const card = await readCard(args.cardId);
      const saved = saveCardImage(card, path.join(dataDir, "card-exports"));
      return textContent({
        cardId: card.id,
        ...saved,
        hint: "Attach or send this local file path from the host environment when your client supports file sending.",
      });
    }
    case "reading_dismiss_card":
      return textContent(await dismissCard(args.cardId));
    case "reading_list_cards":
      return textContent(await listCards(args));
    case "reading_collect_card":
      return textContent(await collectCard({ ...args, createdBy: "claude" }));
    case "reading_get_progress":
      return textContent(await getProgress(args.bookId));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return null;

  if (message.method === "initialize") {
    return result(message.id, {
      protocolVersion,
      serverInfo: { name: "co-reading-mcp", version: "0.1.0" },
      capabilities: { tools: {} },
      instructions:
        `Use this server as a shared co-reading surface. ` +
        `Claude can import EPUB/TXT uploads, continue reading, read chunked books, search passages, track progress, leave margin annotations, ` +
        `reply under user notes, and call reading_submit_user_notes when the human sends staged notes. ` +
        `Reading actions may return cardNotification when a bookmark card is waiting; open it with reading_open_card, save it to a local file with reading_save_card, or clear it with reading_dismiss_card. Use reading_card_collection to browse cards by pages without loading every image. ` +
        `Use reading_import_book for small uploads, or reading_import_begin/part/finish for large files. ` +
        `If this server is running through src/server-sse.js, the same process can also serve the human reader at /, REST API at /api/*, SSE MCP at /sse, and JSON-RPC POST at /mcp. ` +
        `Data dir: ${dataDir}`,
    });
  }

  if (message.method === "notifications/initialized") {
    return null;
  }

  if (message.method === "tools/list") {
    return result(message.id, { tools });
  }

  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params || {};
    return result(message.id, await callTool(name, args || {}));
  }

  return error(message.id, -32601, `Method not found: ${message.method}`);
}

export function startStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const response = await handle(JSON.parse(line));
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      let id = null;
      try {
        id = JSON.parse(line).id ?? null;
      } catch {
        // Keep id null for parse errors.
      }
      output.write(`${JSON.stringify(error(id, -32000, err.message || String(err)))}\n`);
    }
  });

  return rl;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
