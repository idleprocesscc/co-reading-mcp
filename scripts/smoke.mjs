import { execFileSync, spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "co-reading-mcp-"));
await cp(path.join(root, "data.example"), tempDataDir, { recursive: true });
const tempEpub = path.join(tempDataDir, "spine-demo.epub");
const singleItemEpub = path.join(tempDataDir, "single-item-demo.epub");
execFileSync(
  "python3",
  ["-", tempEpub],
  {
    input: `
import sys, zipfile
epub = sys.argv[1]
with zipfile.ZipFile(epub, "w") as zf:
    zf.writestr("mimetype", "application/epub+zip")
    zf.writestr("META-INF/container.xml", """<?xml version='1.0'?>
<container xmlns='urn:oasis:names:tc:opendocument:xmlns:container' version='1.0'>
  <rootfiles><rootfile full-path='OPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles>
</container>""")
    zf.writestr("OPS/content.opf", """<?xml version='1.0'?>
<package xmlns='http://www.idpf.org/2007/opf' version='3.0'>
  <metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Spine Demo</dc:title><dc:creator>Smoke Test</dc:creator></metadata>
  <manifest>
    <item id='nav' href='nav.xhtml' media-type='application/xhtml+xml' properties='nav'/>
    <item id='c1' href='chapter1.xhtml' media-type='application/xhtml+xml'/>
    <item id='c2' href='chapter2.xhtml' media-type='application/xhtml+xml'/>
  </manifest>
  <spine><itemref idref='c1'/><itemref idref='c2'/></spine>
</package>""")
    zf.writestr("OPS/nav.xhtml", """<html xmlns='http://www.w3.org/1999/xhtml'><body><nav><ol>
      <li><a href='chapter1.xhtml'>Chapter One</a></li>
      <li><a href='chapter2.xhtml'>Chapter Two</a></li>
    </ol></nav></body></html>""")
    zf.writestr("OPS/chapter1.xhtml", """<html xmlns='http://www.w3.org/1999/xhtml'><body><h1>Fallback One</h1>
      <p>First chapter paragraph with enough text to require a split when the max chars value is intentionally tiny.</p>
      <p>Another paragraph that should remain under Chapter One rather than the whole book title.</p>
    </body></html>""")
    zf.writestr("OPS/chapter2.xhtml", """<html xmlns='http://www.w3.org/1999/xhtml'><body><h1>Fallback Two</h1>
      <p>Second chapter text should keep its own spine boundary and chapter title.</p>
    </body></html>""")
`,
    encoding: "utf8",
  },
);
execFileSync("python3", [
  path.join(root, "scripts/import_epub.py"),
  tempEpub,
  "--out",
  path.join(tempDataDir, "books"),
  "--book-id",
  "spine-demo",
  "--max-chars",
  "90",
]);
const importedManifest = JSON.parse(
  await readFile(path.join(tempDataDir, "books", "spine-demo", "manifest.json"), "utf8"),
);
if (!importedManifest.chunks.some((chunk) => chunk.sectionTitle === "Chapter One")) {
  throw new Error("EPUB import did not preserve first spine section title");
}
if (!importedManifest.chunks.some((chunk) => chunk.sectionTitle === "Chapter Two")) {
  throw new Error("EPUB import did not preserve second spine section title");
}
if (importedManifest.chunks.some((chunk) => chunk.title.startsWith("Spine Demo Part"))) {
  throw new Error("EPUB import used whole-book Part titles instead of section titles");
}
execFileSync(
  "python3",
  ["-", singleItemEpub],
  {
    input: `
import sys, zipfile
epub = sys.argv[1]
with zipfile.ZipFile(epub, "w") as zf:
    zf.writestr("mimetype", "application/epub+zip")
    zf.writestr("META-INF/container.xml", """<?xml version='1.0'?>
<container xmlns='urn:oasis:names:tc:opendocument:xmlns:container' version='1.0'>
  <rootfiles><rootfile full-path='OPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles>
</container>""")
    zf.writestr("OPS/content.opf", """<?xml version='1.0'?>
<package xmlns='http://www.idpf.org/2007/opf' version='3.0'>
  <metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Single Item Demo</dc:title></metadata>
  <manifest><item id='all' href='all.xhtml' media-type='application/xhtml+xml'/></manifest>
  <spine><itemref idref='all'/></spine>
</package>""")
    zf.writestr("OPS/all.xhtml", """<html xmlns='http://www.w3.org/1999/xhtml'><body>
      <h1>Inner Chapter One</h1><p>The first internal chapter lives inside one XHTML spine item.</p>
      <h1>Inner Chapter Two</h1><p>The second internal chapter should become its own section.</p>
    </body></html>""")
`,
    encoding: "utf8",
  },
);
execFileSync("python3", [
  path.join(root, "scripts/import_epub.py"),
  singleItemEpub,
  "--out",
  path.join(tempDataDir, "books"),
  "--book-id",
  "single-item-demo",
]);
const singleItemManifest = JSON.parse(
  await readFile(path.join(tempDataDir, "books", "single-item-demo", "manifest.json"), "utf8"),
);
if (!singleItemManifest.chunks.some((chunk) => chunk.sectionTitle === "Inner Chapter One")) {
  throw new Error("single-spine EPUB import did not split first internal heading");
}
if (!singleItemManifest.chunks.some((chunk) => chunk.sectionTitle === "Inner Chapter Two")) {
  throw new Error("single-spine EPUB import did not split second internal heading");
}
const tempTxt = path.join(tempDataDir, "heading-demo.txt");
await writeFile(
  tempTxt,
  [
    "Chapter One",
    "",
    "First chapter paragraph. It should keep its own title.",
    "",
    "Chapter Two",
    "",
    "Second chapter paragraph. It should become another section.",
  ].join("\n"),
  "utf8",
);
execFileSync("python3", [
  path.join(root, "scripts/import_text.py"),
  tempTxt,
  "--title",
  "Heading Demo",
  "--out",
  path.join(tempDataDir, "books"),
  "--book-id",
  "heading-demo",
  "--heading-regex",
  "^Chapter\\s+\\w+",
]);
const txtManifest = JSON.parse(
  await readFile(path.join(tempDataDir, "books", "heading-demo", "manifest.json"), "utf8"),
);
if (!txtManifest.chunks.some((chunk) => chunk.sectionTitle === "Chapter One")) {
  throw new Error("TXT import did not preserve first regex heading");
}
if (!txtManifest.chunks.some((chunk) => chunk.sectionTitle === "Chapter Two")) {
  throw new Error("TXT import did not preserve second regex heading");
}
await mkdir(path.join(tempDataDir, "books", "bad-book"), { recursive: true });
await writeFile(
  path.join(tempDataDir, "books", "bad-book", "manifest.json"),
  `${JSON.stringify({
    bookId: "bad-book",
    title: "Bad Book",
    chunks: [{ id: "ch00", title: "Bad", order: 0, path: "../../outside.txt" }],
  })}\n`,
  "utf8",
);
await writeFile(
  path.join(tempDataDir, "progress.json"),
  `${JSON.stringify(
    {
      "demo-book": {
        lastChunkId: "ch00",
        lastReadAt: "2026-05-22T00:00:00.000Z",
        readChunkIds: ["ch00"],
      },
      "anthropic-guidelines": {
        lastChunkId: "ch00",
        lastReadAt: "2026-05-22T00:00:01.000Z",
        readChunkIds: ["ch00", "missing-old-chunk"],
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const server = spawn(process.execPath, [path.join(root, "src/server.js")], {
  env: {
    ...process.env,
    READING_MCP_DATA_DIR: tempDataDir,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
let stdoutBuffer = "";

server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";
  for (const line of lines.filter(Boolean)) {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function contentJson(response) {
  return JSON.parse(response.result.content[0].text);
}

async function appendLocalUserNote({ id, note }) {
  await appendFile(
    path.join(tempDataDir, "annotations.jsonl"),
    `${JSON.stringify({
      id,
      bookId: "anthropic-guidelines",
      chunkId: "ch00",
      quote: "Claude is trained by Anthropic",
      note,
      author: "user",
      kind: "note",
      status: "open",
      parentId: null,
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

await request("initialize", {});
const list = await request("tools/call", { name: "reading_list_books", arguments: {} });
const read = await request("tools/call", {
  name: "reading_read_chunk",
  arguments: { bookId: "anthropic-guidelines", chunkId: "ch00" },
});
const search = await request("tools/call", {
  name: "reading_search_chunks",
  arguments: { bookId: "anthropic-guidelines", query: "values" },
});
const continueAnthropic = await request("tools/call", {
  name: "reading_continue",
  arguments: { bookId: "anthropic-guidelines" },
});
const importText = [
  "Chapter Alpha",
  "",
  "Alpha imported from a single MCP base64 payload.",
  "",
  "Chapter Beta",
  "",
  [
    "Beta imported from a single MCP base64 payload.",
    "This section carries enough text to behave like a real chapter rather than a title page.",
    "It gives the ritual card rule enough signal to keep a resonant margin note after completion.",
    "The smoke test uses it to prove that chapter completion can create a quiet bookmark card.",
  ].join(" "),
].join("\n");
const mcpImport = await request("tools/call", {
  name: "reading_import_book",
  arguments: {
    filename: "mcp-import.txt",
    dataBase64: Buffer.from(importText, "utf8").toString("base64"),
    bookId: "mcp-import",
    title: "MCP Import",
    headingRegex: "^Chapter\\s+\\w+",
  },
});
const chunkedImportText = [
  "Section One",
  "",
  "Chunked import part one.",
  "",
  "Section Two",
  "",
  "Chunked import part two.",
].join("\n");
const chunkedBytes = Buffer.from(chunkedImportText, "utf8");
const chunkedBegin = await request("tools/call", {
  name: "reading_import_begin",
  arguments: {
    filename: "chunked-import.txt",
    bookId: "chunked-import",
    title: "Chunked Import",
    headingRegex: "^Section\\s+\\w+",
    expectedBytes: chunkedBytes.length,
  },
});
const chunkedUploadId = contentJson(chunkedBegin).uploadId;
const splitAt = Math.ceil(chunkedBytes.length / 2);
const chunkedPartA = await request("tools/call", {
  name: "reading_import_part",
  arguments: {
    uploadId: chunkedUploadId,
    dataBase64: chunkedBytes.subarray(0, splitAt).toString("base64"),
    index: 0,
  },
});
const chunkedPartB = await request("tools/call", {
  name: "reading_import_part",
  arguments: {
    uploadId: chunkedUploadId,
    dataBase64: chunkedBytes.subarray(splitAt).toString("base64"),
    index: 1,
  },
});
const chunkedFinish = await request("tools/call", {
  name: "reading_import_finish",
  arguments: { uploadId: chunkedUploadId },
});
const markImportFirst = await request("tools/call", {
  name: "reading_mark_read",
  arguments: { bookId: "mcp-import", chunkId: "ch00" },
});
const importResonance = await request("tools/call", {
  name: "reading_annotate_passage",
  arguments: {
    bookId: "mcp-import",
    chunkId: "ch01",
    quote: "Beta imported from a single MCP base64 payload.",
    note: "This imported section is worth keeping as a completion card.",
    kind: "resonance",
  },
});
const markImportDone = await request("tools/call", {
  name: "reading_mark_read",
  arguments: { bookId: "mcp-import", chunkId: "ch01" },
});
const collectedCard = await request("tools/call", {
  name: "reading_collect_card",
  arguments: {
    bookId: "mcp-import",
    chunkId: "ch01",
    kicker: "收获了一枚回声书签",
    title: "MCP Import",
    quote: "Beta imported from a single MCP base64 payload.",
    note: "A smoke-test card from the margin.",
    art: "stardust",
    source: "smoke",
  },
});
const listedCards = await request("tools/call", {
  name: "reading_list_cards",
  arguments: { bookId: "mcp-import" },
});
const cardInbox = await request("tools/call", {
  name: "reading_card_inbox",
  arguments: { bookId: "mcp-import" },
});
const cardCollection = await request("tools/call", {
  name: "reading_card_collection",
  arguments: { bookId: "mcp-import", limit: 10, offset: 0 },
});
const openedCard = await request("tools/call", {
  name: "reading_open_card",
  arguments: { cardId: contentJson(collectedCard).id },
});
const savedCard = await request("tools/call", {
  name: "reading_save_card",
  arguments: { cardId: contentJson(collectedCard).id },
});
const dismissedCard = await request("tools/call", {
  name: "reading_dismiss_card",
  arguments: { cardId: contentJson(collectedCard).id },
});
const dismissedInbox = await request("tools/call", {
  name: "reading_card_inbox",
  arguments: { bookId: "mcp-import" },
});
const badImportBookId = await request("tools/call", {
  name: "reading_import_book",
  arguments: {
    filename: "bad-import.txt",
    dataBase64: Buffer.from("Bad import", "utf8").toString("base64"),
    bookId: "../bad-import",
    title: "Bad Import",
  },
});
const hiddenBeforeSubmit = await request("tools/call", {
  name: "reading_list_annotations",
  arguments: { parentId: null, author: "user" },
});
const firstSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "anthropic-guidelines", sessionId: "session-a" },
});
const visibleAfterSubmit = await request("tools/call", {
  name: "reading_list_annotations",
  arguments: { parentId: null, author: "user", status: "submitted" },
});
const mcpSpoofNote = await request("tools/call", {
  name: "reading_annotate_passage",
  arguments: {
    bookId: "anthropic-guidelines",
    chunkId: "ch00",
    quote: "Claude is trained by Anthropic",
    note: "MCP attempted to create a user-private note.",
    author: "user",
    status: "open",
  },
});
await appendLocalUserNote({
  id: "ann_smoke_user_same_session",
  note: "Another local user note in the same chunk.",
});
const sameSessionSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "anthropic-guidelines", sessionId: "session-a" },
});
await appendLocalUserNote({
  id: "ann_smoke_user_new_session",
  note: "A later note after changing sessions.",
});
const newSessionSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "anthropic-guidelines", sessionId: "session-b" },
});
const secondSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "anthropic-guidelines", sessionId: "session-b" },
});
const reply = await request("tools/call", {
  name: "reading_reply_to_annotation",
  arguments: { parentId: "ann_guidelines_user_001", note: "Claude can answer in the margin." },
});
const replies = await request("tools/call", {
  name: "reading_list_annotations",
  arguments: { parentId: "ann_guidelines_user_001" },
});
const submissionsList = await request("tools/call", {
  name: "reading_list_submissions",
  arguments: { bookId: "anthropic-guidelines" },
});
const firstSubmission = contentJson(submissionsList)[0];
const submissionDetail = await request("tools/call", {
  name: "reading_read_submission",
  arguments: { submissionId: firstSubmission?.id },
});
const badBookPath = await request("tools/call", {
  name: "reading_read_chunk",
  arguments: { bookId: "../../..", chunkId: "ch00" },
});
const badChunkPath = await request("tools/call", {
  name: "reading_read_chunk",
  arguments: { bookId: "bad-book", chunkId: "ch00" },
});
const badMarkRead = await request("tools/call", {
  name: "reading_mark_read",
  arguments: { bookId: "anthropic-guidelines", chunkId: "missing-chunk" },
});

server.kill();
const httpPort = 18000 + (process.pid % 10000);
const httpServer = spawn(process.execPath, [path.join(root, "src/http.js")], {
  env: {
    ...process.env,
    READING_MCP_DATA_DIR: tempDataDir,
    READING_HTTP_PORT: String(httpPort),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let httpNextId = 1;
const httpPending = new Map();
let httpStdoutBuffer = "";
httpServer.stdout.setEncoding("utf8");
httpServer.stdout.on("data", (chunk) => {
  httpStdoutBuffer += chunk;
  const lines = httpStdoutBuffer.split("\n");
  httpStdoutBuffer = lines.pop() || "";
  for (const line of lines.filter(Boolean)) {
    const msg = JSON.parse(line);
    const resolve = httpPending.get(msg.id);
    if (resolve) {
      httpPending.delete(msg.id);
      resolve(msg);
    }
  }
});

function httpMcpRequest(method, params) {
  const id = httpNextId++;
  httpServer.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => httpPending.set(id, resolve));
}

async function fetchJson(pathname, options) {
  const { baseUrl = `http://127.0.0.1:${httpPort}`, headers = {}, ...fetchOptions } = options || {};
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json", ...headers },
    ...fetchOptions,
    body: fetchOptions.body ? JSON.stringify(fetchOptions.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

let httpBooks = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    httpBooks = await fetchJson("/api/books");
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (!httpBooks) throw new Error("HTTP reader API did not start");
const httpMcpInit = await httpMcpRequest("initialize", {});
const httpChunk = await fetchJson("/api/books/anthropic-guidelines/chunks/ch00");
const httpNote = await fetchJson("/api/annotations", {
  method: "POST",
  body: {
    bookId: "anthropic-guidelines",
    chunkId: "ch00",
    quote: "Claude is trained by Anthropic",
    note: "HTTP reader note.",
  },
});
const httpReply = await fetchJson("/api/replies", {
  method: "POST",
  body: {
    parentId: httpNote.id,
    note: "HTTP reader reply.",
    author: "user",
  },
});
const httpCard = await fetchJson("/api/cards", {
  method: "POST",
  body: {
    bookId: "anthropic-guidelines",
    chunkId: "ch00",
    kicker: "这里有两个人的折痕。",
    title: "HTTP Card",
    quote: "Claude is trained by Anthropic",
    note: "HTTP reader collected a card.",
    art: "fold",
  },
});
const httpCards = await fetchJson("/api/cards?bookId=anthropic-guidelines");
const httpCardInbox = await fetchJson("/api/card-inbox?bookId=anthropic-guidelines");
const httpCardCollection = await fetchJson("/api/card-collection?bookId=anthropic-guidelines&limit=1");
const httpCardSvg = await fetch(`http://127.0.0.1:${httpPort}/api/cards/${httpCard.id}/image.svg`);
const httpCardDismiss = await fetchJson(`/api/cards/${httpCard.id}/dismiss`, { method: "POST" });
const httpImport = await fetchJson("/api/import", {
  method: "POST",
  body: {
    filename: "http-import.txt",
    dataBase64: Buffer.from(
      ["HTTP One", "", "Imported through the REST API.", "", "HTTP Two", "", "Also imported."].join("\n"),
      "utf8",
    ).toString("base64"),
    bookId: "http-import",
    title: "HTTP Import",
    headingRegex: "^HTTP\\s+\\w+",
  },
});
const readerHtml = await fetch(`http://127.0.0.1:${httpPort}/`);
httpServer.kill();
const ssePort = httpPort + 1;
const sseServer = spawn(process.execPath, [path.join(root, "src/server-sse.js")], {
  env: {
    ...process.env,
    READING_MCP_DATA_DIR: tempDataDir,
    MCP_SSE_PORT: String(ssePort),
    MCP_SSE_HOST: "127.0.0.1",
    MCP_AUTH_TOKEN: "smoke-token",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

function openSse() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: ssePort,
        path: "/sse",
        headers: { Authorization: "Bearer smoke-token" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE returned ${res.statusCode}`));
          res.resume();
          return;
        }
        resolve({ req, res });
      },
    );
    req.on("error", reject);
  });
}

let sse = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    sse = await openSse();
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (!sse) throw new Error("SSE server did not start");

let sseBuffer = "";
const sseEvents = [];
sse.res.setEncoding("utf8");
sse.res.on("data", (chunk) => {
  sseBuffer += chunk;
  const events = sseBuffer.split("\n\n");
  sseBuffer = events.pop() || "";
  for (const event of events) {
    const type = event.match(/^event: (.+)$/m)?.[1];
    const data = event.match(/^data: (.+)$/m)?.[1];
    if (type && data) sseEvents.push({ type, data });
  }
});

async function waitForSseEvent(type) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const index = sseEvents.findIndex((event) => event.type === type);
    if (index >= 0) return sseEvents.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for SSE event: ${type}`);
}

const endpointEvent = await waitForSseEvent("endpoint");
const endpoint = new URL(endpointEvent.data);
const sseReaderHtml = await fetch(`http://127.0.0.1:${ssePort}/`);
const sseReaderAuthorized = await fetch(`http://127.0.0.1:${ssePort}/?token=smoke-token`);
const sseCookie = sseReaderAuthorized.headers.get("set-cookie") || "";
const sseCssWithCookie = await fetch(`http://127.0.0.1:${ssePort}/reader.css`, {
  headers: { cookie: sseCookie },
});
const sseApiUnauthorized = await fetch(`http://127.0.0.1:${ssePort}/api/books`);
const sseApiBooks = await fetchJson("/api/books", {
  baseUrl: `http://127.0.0.1:${ssePort}`,
  headers: { Authorization: "Bearer smoke-token" },
});
const sseMcpPost = await fetch(`http://127.0.0.1:${ssePort}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: "Bearer smoke-token" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
});
const sseMcpMessage = await sseMcpPost.json();
const ssePost = await fetch(`http://127.0.0.1:${ssePort}${endpoint.pathname}${endpoint.search}`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: "Bearer smoke-token" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
});
const sseMessage = JSON.parse((await waitForSseEvent("message")).data);
sse.req.destroy();
sseServer.kill();
await rm(tempDataDir, { recursive: true, force: true });

if (!list.result?.content?.[0]?.text.includes("anthropic-guidelines")) {
  throw new Error("reading_list_books did not return anthropic-guidelines");
}
if (contentJson(list).find((book) => book.bookId === "anthropic-guidelines")?.chunksRead !== 1) {
  throw new Error("reading_list_books counted stale progress chunk ids");
}
if (!read.result?.content?.[0]?.text.includes("Claude and the mission of Anthropic")) {
  throw new Error("reading_read_chunk did not return chunk text");
}
if (!search.result?.content?.[0]?.text.includes("values")) {
  throw new Error("reading_search_chunks did not return a values snippet");
}
if (contentJson(continueAnthropic).chunk.id !== "ch01") {
  throw new Error("reading_continue did not return the next unread chunk");
}
if (contentJson(mcpImport).bookId !== "mcp-import" || contentJson(mcpImport).chunkCount !== 2) {
  throw new Error("reading_import_book did not import TXT headings");
}
if (!chunkedUploadId) {
  throw new Error("reading_import_begin did not return an uploadId");
}
if (contentJson(chunkedPartA).parts !== 1 || contentJson(chunkedPartB).parts !== 2) {
  throw new Error("reading_import_part did not count chunked upload parts");
}
if (contentJson(chunkedFinish).bookId !== "chunked-import" || contentJson(chunkedFinish).chunkCount !== 2) {
  throw new Error("reading_import_finish did not import chunked TXT upload");
}
if (contentJson(markImportFirst).complete !== false) {
  throw new Error("reading_mark_read marked a partial book complete");
}
if (contentJson(markImportDone).complete !== true || !contentJson(markImportDone).finish?.message.includes("complete")) {
  throw new Error("reading_mark_read did not return a finish ceremony for the final chunk");
}
if (!contentJson(markImportDone).finish?.celebration?.prompt) {
  throw new Error("reading_mark_read did not return a finish celebration prompt");
}
if (!contentJson(importResonance).id || !contentJson(markImportDone).cardNotification?.cardId) {
  throw new Error("reading_mark_read did not generate a card notification at a resonant section completion");
}
if (!contentJson(collectedCard).id || !contentJson(listedCards).some((card) => card.id === contentJson(collectedCard).id)) {
  throw new Error("reading_collect_card/list_cards did not preserve a collected card");
}
if (!contentJson(cardInbox).some((card) => card.id === contentJson(collectedCard).id)) {
  throw new Error("reading_card_inbox did not show a collected card");
}
if (!contentJson(cardCollection).items?.some((card) => card.id === contentJson(collectedCard).id)) {
  throw new Error("reading_card_collection did not page collected cards");
}
if (
  openedCard.result?.content?.[1]?.type !== "image" ||
  !["image/png", "image/svg+xml"].includes(openedCard.result.content[1].mimeType)
) {
  throw new Error("reading_open_card did not return a card image");
}
if (!contentJson(savedCard).path || !["image/png", "image/svg+xml"].includes(contentJson(savedCard).mimeType)) {
  throw new Error("reading_save_card did not write a card image file");
}
if (contentJson(dismissedCard).status !== "dismissed" || contentJson(dismissedInbox).some((card) => card.id === contentJson(collectedCard).id)) {
  throw new Error("reading_dismiss_card did not clear the inbox item");
}
if (!badImportBookId.error?.message.includes("bookId may only contain")) {
  throw new Error("reading_import_book did not reject unsafe bookId");
}
if (contentJson(hiddenBeforeSubmit).length !== 0) {
  throw new Error("reading_list_annotations exposed open human notes before submit");
}
if (contentJson(firstSubmit).count !== 1) {
  throw new Error("reading_submit_user_notes did not submit the open user note");
}
if (!contentJson(visibleAfterSubmit).some((note) => note.id === "ann_guidelines_user_001")) {
  throw new Error("reading_list_annotations did not expose submitted human notes");
}
if (!contentJson(firstSubmit).context.chunks[0]?.text.includes("Claude and the mission of Anthropic")) {
  throw new Error("first session submit did not include chunk text");
}
if (contentJson(mcpSpoofNote).author !== "claude" || contentJson(mcpSpoofNote).status !== "published") {
  throw new Error("reading_annotate_passage allowed MCP to spoof a private human note");
}
if (!contentJson(mcpSpoofNote).annotationIndexInBook || !contentJson(mcpSpoofNote).message.includes("Saved annotation")) {
  throw new Error("reading_annotate_passage did not return annotation index feedback");
}
if (contentJson(sameSessionSubmit).context.chunks.length !== 0) {
  throw new Error("same-session submit repeated chunk text");
}
if (contentJson(sameSessionSubmit).context.omittedChunks[0]?.reason !== "already-sent-in-session") {
  throw new Error("same-session submit did not explain omitted chunk context");
}
if (!contentJson(newSessionSubmit).context.chunks[0]?.text.includes("Claude and the mission of Anthropic")) {
  throw new Error("new-session submit did not re-include chunk text");
}
if (!contentJson(newSessionSubmit).submissionId) {
  throw new Error("reading_submit_user_notes did not create a submission batch id");
}
if (contentJson(secondSubmit).count !== 0) {
  throw new Error("reading_submit_user_notes submitted the same note twice");
}
if (!firstSubmission?.id || !contentJson(submissionDetail).notes?.length) {
  throw new Error("reading_list_submissions/read_submission did not expose submitted batches");
}
if (!reply.result?.content?.[0]?.text.includes('"parentId": "ann_guidelines_user_001"')) {
  throw new Error("reading_reply_to_annotation did not attach to the parent annotation");
}
if (!replies.result?.content?.[0]?.text.includes("Claude can answer in the margin")) {
  throw new Error("reading_list_annotations did not find the attached reply");
}
if (!badBookPath.error?.message.includes("Path escapes data directory")) {
  throw new Error("reading_read_chunk did not reject path traversal bookId");
}
if (!badChunkPath.error?.message.includes("Path escapes data directory")) {
  throw new Error("reading_read_chunk did not reject path traversal chunk path");
}
if (!badMarkRead.error?.message.includes("Unknown chunkId")) {
  throw new Error("reading_mark_read did not reject an unknown chunkId");
}
if (!httpBooks.some((book) => book.bookId === "anthropic-guidelines")) {
  throw new Error("HTTP API did not list anthropic-guidelines");
}
if (httpMcpInit.result?.serverInfo?.name !== "co-reading-mcp") {
  throw new Error("HTTP process did not keep MCP stdio active");
}
if (!httpChunk.text.includes("Claude and the mission of Anthropic")) {
  throw new Error("HTTP API did not read chunk text");
}
if (!httpNote.id) {
  throw new Error("HTTP API did not create a user note");
}
if (httpReply.parentId !== httpNote.id || httpReply.kind !== "reply") {
  throw new Error("HTTP API did not attach a reply");
}
if (!httpCard.id || !httpCards.some((card) => card.id === httpCard.id)) {
  throw new Error("HTTP API did not create/list reading cards");
}
if (!httpCardInbox.some((card) => card.id === httpCard.id)) {
  throw new Error("HTTP API did not show card inbox");
}
if (httpCardCollection.items?.[0]?.id !== httpCard.id) {
  throw new Error("HTTP API did not page card collection");
}
if (!httpCardSvg.ok || !(await httpCardSvg.text()).includes("<svg")) {
  throw new Error("HTTP API did not render card SVG");
}
if (httpCardDismiss.status !== "dismissed") {
  throw new Error("HTTP API did not dismiss reading card");
}
if (httpImport.bookId !== "http-import" || httpImport.chunkCount !== 2) {
  throw new Error("HTTP API did not import a book");
}
if (!readerHtml.ok || !(await readerHtml.text()).includes("Co-Reading")) {
  throw new Error("HTTP reader did not serve the web UI");
}
if (sseReaderHtml.status !== 401) {
  throw new Error("SSE process did not protect reader UI with MCP_AUTH_TOKEN");
}
if (!sseReaderAuthorized.ok || !(await sseReaderAuthorized.text()).includes("Co-Reading")) {
  throw new Error("SSE process did not serve authorized reader UI");
}
if (!sseCookie.includes("co_reading_token=") || !sseCssWithCookie.ok) {
  throw new Error("SSE process did not set a reader auth cookie for static assets");
}
if (sseApiUnauthorized.status !== 401) {
  throw new Error("SSE process did not protect REST API with MCP_AUTH_TOKEN");
}
if (!sseApiBooks.some((book) => book.bookId === "anthropic-guidelines")) {
  throw new Error("SSE process did not serve authenticated REST API");
}
if (!sseMcpPost.ok || sseMcpMessage.result?.serverInfo?.name !== "co-reading-mcp") {
  throw new Error("SSE process did not serve MCP JSON-RPC POST endpoint");
}
if (ssePost.status !== 202) {
  throw new Error("SSE message endpoint did not accept JSON-RPC");
}
if (sseMessage.result?.serverInfo?.name !== "co-reading-mcp") {
  throw new Error("SSE transport did not return MCP initialize response");
}

console.log("smoke ok");
