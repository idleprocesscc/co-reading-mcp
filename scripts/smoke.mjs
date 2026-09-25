import { execFileSync, spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const imageEpub = path.join(tempDataDir, "image-demo.epub");
execFileSync(
  "python3",
  ["-", imageEpub],
  {
    input: `
import sys, zipfile
epub = sys.argv[1]
png = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
with zipfile.ZipFile(epub, "w") as zf:
    zf.writestr("mimetype", "application/epub+zip")
    zf.writestr("META-INF/container.xml", """<?xml version='1.0'?>
<container xmlns='urn:oasis:names:tc:opendocument:xmlns:container' version='1.0'>
  <rootfiles><rootfile full-path='OEBPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles>
</container>""")
    zf.writestr("OEBPS/content.opf", """<?xml version='1.0'?>
<package xmlns='http://www.idpf.org/2007/opf' version='3.0'>
  <metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Image Demo</dc:title></metadata>
  <manifest>
    <item id='cover' href='Text/cover.xhtml' media-type='application/xhtml+xml'/>
    <item id='c1' href='Text/c1.xhtml' media-type='application/xhtml+xml'/>
    <item id='c2' href='Text/c2.xhtml' media-type='application/xhtml+xml'/>
  </manifest>
  <spine><itemref idref='cover'/><itemref idref='c1'/><itemref idref='c2'/></spine>
</package>""")
    zf.writestr("OEBPS/Text/cover.xhtml", "<html><body><div><img src='../Images/cover.jpg'/></div></body></html>")
    zf.writestr("OEBPS/Text/c1.xhtml", """<html><body><h1>Motion</h1>
      <p>It can be written as:</p><div class='equation_img'><img src='../Images/eq%201.png'/></div>
      <p>where <img src='../Images/f.png'/> is the force and t<sup>2</sup> meets l<sub>1</sub>.</p></body></html>""")
    zf.writestr("OEBPS/Text/c2.xhtml", "<html><body><h1>Energy</h1>" + "".join(
        f"<p>Paragraph {i} about energy, long enough to split this section into parts.</p>"
        + (f"<div><img src='../Images/e{i}.png'/></div>" if i % 2 else "") for i in range(8)) + "</body></html>")
    for name in ["cover.jpg", "eq 1.png", "f.png"] + [f"e{i}.png" for i in range(1, 8, 2)]:
        zf.writestr("OEBPS/Images/" + name, png)
`,
    encoding: "utf8",
  },
);
for (const [bookId, extra] of [["image-demo-text", []], ["image-demo", ["--keep-images"]]]) {
  execFileSync("python3", [
    path.join(root, "scripts/import_epub.py"),
    imageEpub,
    "--out",
    path.join(tempDataDir, "books"),
    "--book-id",
    bookId,
    "--max-chars",
    "200",
    ...extra,
  ], { stdio: ["ignore", "ignore", "ignore"] });
}
const imageTextManifest = JSON.parse(
  await readFile(path.join(tempDataDir, "books", "image-demo-text", "manifest.json"), "utf8"),
);
const imageManifest = JSON.parse(await readFile(path.join(tempDataDir, "books", "image-demo", "manifest.json"), "utf8"));
const chunkShape = (manifest) => manifest.chunks.map(({ id, title, sectionTitle, sourcePath }) => ({ id, title, sectionTitle, sourcePath }));
if (JSON.stringify(chunkShape(imageTextManifest)) !== JSON.stringify(chunkShape(imageManifest))) {
  throw new Error("--keep-images changed chunk ids, titles, or section boundaries");
}
if (imageManifest.chunks.length < 3 || !imageManifest.chunks.some((chunk) => chunk.sectionPartCount > 1)) {
  throw new Error("image EPUB smoke fixture did not exercise a split section");
}
const imageChunkTexts = await Promise.all(
  imageManifest.chunks.map((chunk) => readFile(path.join(tempDataDir, "books", "image-demo", chunk.path), "utf8")),
);
const imageTokens = imageChunkTexts.join("\n").match(/\[\[img:assets\/[^\]]+\]\]/g) || [];
if (imageTokens.length !== 7) {
  throw new Error(`--keep-images wrote ${imageTokens.length} image tokens, expected 7`);
}
if (!imageChunkTexts[0].includes("Motion\n\n[[img:assets/cover.jpg]]")) {
  throw new Error("--keep-images did not fold the image-only cover page into the next section");
}
if (!imageChunkTexts[0].includes("written as:\n\n[[img:assets/eq-1.png]]\n\nwhere [[img:assets/f.png]] is the force")) {
  throw new Error("--keep-images did not keep block and inline image positions");
}
if (!imageChunkTexts[0].includes("t² meets l₁")) {
  throw new Error("--keep-images did not convert sup/sub to Unicode");
}
for (const token of imageTokens) {
  await readFile(path.join(tempDataDir, "books", "image-demo", token.slice(6, -2)));
}
const imageTextChunkTexts = await Promise.all(
  imageTextManifest.chunks.map((chunk) => readFile(path.join(tempDataDir, "books", "image-demo-text", chunk.path), "utf8")),
);
if (imageTextChunkTexts.some((text) => text.includes("[[img:"))) {
  throw new Error("EPUB import without --keep-images wrote image tokens");
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
const deleteWithoutConfirm = await request("tools/call", {
  name: "reading_delete_book",
  arguments: { bookId: "chunked-import", confirm: false },
});
const deleteChunkedImport = await request("tools/call", {
  name: "reading_delete_book",
  arguments: { bookId: "chunked-import", confirm: true },
});
const booksAfterMcpDelete = await request("tools/call", { name: "reading_list_books", arguments: {} });
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
const replyId = contentJson(reply).id;
const nestedReply = await request("tools/call", {
  name: "reading_reply_to_annotation",
  arguments: { parentId: replyId, note: "Claude can also answer a reply in the same thread." },
});
const replies = await request("tools/call", {
  name: "reading_list_annotations",
  arguments: { parentId: "ann_guidelines_user_001" },
});
const nestedReplies = await request("tools/call", {
  name: "reading_list_annotations",
  arguments: { parentId: replyId },
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
const repeatedQuote = "Anthropic";
const firstRepeatedOffset = httpChunk.text.indexOf(repeatedQuote);
const secondRepeatedOffset = httpChunk.text.indexOf(repeatedQuote, firstRepeatedOffset + repeatedQuote.length);
const httpOffsetNote = await fetchJson("/api/annotations", {
  method: "POST",
  body: {
    bookId: "anthropic-guidelines",
    chunkId: "ch00",
    quote: repeatedQuote,
    quoteOffset: secondRepeatedOffset,
    note: "HTTP reader offset note.",
  },
});
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
const httpReplyToClaude = await fetchJson("/api/replies", {
  method: "POST",
  body: {
    parentId: "ann_guidelines_001",
    note: "HTTP reader reply to Claude should remain staged.",
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
const httpImportNote = await fetchJson("/api/annotations", {
  method: "POST",
  body: {
    bookId: "http-import",
    chunkId: "ch00",
    quote: "Imported through the REST API.",
    note: "Delete smoke note.",
  },
});
await fetchJson("/api/mark-read", {
  method: "POST",
  body: { bookId: "http-import", chunkId: "ch00" },
});
const httpImportCard = await fetchJson("/api/cards", {
  method: "POST",
  body: {
    bookId: "http-import",
    chunkId: "ch00",
    title: "Delete Smoke Card",
    quote: "Imported through the REST API.",
    note: "Delete smoke card.",
  },
});
const httpDeleteBook = await fetchJson("/api/books/http-import", { method: "DELETE" });
const httpBooksAfterDelete = await fetchJson("/api/books");
const httpDeletedProgress = await fetchJson("/api/progress?bookId=http-import");
const httpDeletedAnnotations = await fetchJson("/api/annotations?bookId=http-import");
const httpDeletedCards = await fetchJson("/api/cards?bookId=http-import");
const readerHtml = await fetch(`http://127.0.0.1:${httpPort}/`);

function rawRequest(port, method, rawPath, headers = {}) {
  // http.request keeps the path as written, unlike fetch(), so traversal attempts reach the server.
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const httpImageImport = await fetchJson("/api/import", {
  method: "POST",
  body: {
    filename: "image-demo.epub",
    dataBase64: (await readFile(imageEpub)).toString("base64"),
    bookId: "http-image-demo",
    maxChars: 200,
    keepImages: true,
  },
});
const httpImageChunk = await fetchJson("/api/books/http-image-demo/chunks/ch00");
if (!httpImageImport.keepImages || !httpImageChunk.text.includes("[[img:assets/eq-1.png]]")) {
  throw new Error("HTTP import did not pass keepImages through to the EPUB importer");
}
const assetPath = "/api/books/http-image-demo/asset/assets/eq-1.png";
const assetGet = await rawRequest(httpPort, "GET", assetPath);
const assetHead = await rawRequest(httpPort, "HEAD", assetPath);
const assetCached = await rawRequest(httpPort, "GET", assetPath, { "if-none-match": assetGet.headers.etag });
const assetMissing = await rawRequest(httpPort, "GET", "/api/books/http-image-demo/asset/assets/nope.png");
const assetUnknownBook = await rawRequest(httpPort, "GET", "/api/books/no-such-book/asset/assets/eq-1.png");
const assetOutsideAssets = await rawRequest(httpPort, "GET", "/api/books/http-image-demo/asset/manifest.json");
const assetTraversals = await Promise.all(
  [
    "/api/books/http-image-demo/asset/../manifest.json",
    "/api/books/http-image-demo/asset/assets/../../../progress.json",
    "/api/books/http-image-demo/asset/assets/%2e%2e/manifest.json",
    "/api/books/http-image-demo/asset/assets%2F..%2Fmanifest.json",
    "/api/books/..%2Fhttp-image-demo/asset/assets/eq-1.png",
  ].map((rawPath) => rawRequest(httpPort, "GET", rawPath)),
);
await symlink(
  path.join(tempDataDir, "progress.json"),
  path.join(tempDataDir, "books", "http-image-demo", "assets", "escape.png"),
);
const assetSymlinkEscape = await rawRequest(httpPort, "GET", "/api/books/http-image-demo/asset/assets/escape.png");
if (
  assetGet.status !== 200 ||
  assetGet.headers["content-type"] !== "image/png" ||
  assetGet.headers["cache-control"] !== "private, max-age=604800" ||
  assetGet.headers["x-content-type-options"] !== "nosniff" ||
  !assetGet.headers.etag ||
  !assetGet.body.subarray(1, 4).equals(Buffer.from("PNG"))
) {
  throw new Error(`Asset route did not serve the image correctly (${assetGet.status})`);
}
if (assetHead.status !== 200 || assetHead.body.length !== 0 || assetHead.headers["content-length"] !== String(assetGet.body.length)) {
  throw new Error("Asset route did not answer HEAD");
}
if (assetCached.status !== 304 || assetCached.body.length !== 0) {
  throw new Error(`Asset route did not answer If-None-Match with 304 (${assetCached.status})`);
}
if (assetMissing.status !== 404 || assetUnknownBook.status !== 404 || assetOutsideAssets.status !== 404) {
  throw new Error("Asset route did not 404 missing files, unknown books, or files outside assets/");
}
if (assetTraversals.some((response) => response.status !== 400)) {
  throw new Error(`Asset route did not refuse traversal: ${assetTraversals.map((response) => response.status).join(",")}`);
}
if (assetSymlinkEscape.status !== 403) {
  throw new Error(`Asset route followed a symlink out of assets/ (${assetSymlinkEscape.status})`);
}
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
const sseTokenRedirect = await fetch(`http://127.0.0.1:${ssePort}/?token=smoke-token`, {
  redirect: "manual",
});
const sseCookie = sseTokenRedirect.headers.get("set-cookie") || "";
const sseReaderAuthorized = await fetch(`http://127.0.0.1:${ssePort}/`, {
  headers: { cookie: sseCookie },
});
const sseCssWithCookie = await fetch(`http://127.0.0.1:${ssePort}/reader.css`, {
  headers: { cookie: sseCookie },
});
const sseApiUnauthorized = await fetch(`http://127.0.0.1:${ssePort}/api/books`);
const sseUnauthorizedMcp = await fetch(`http://127.0.0.1:${ssePort}/mcp`);
const sseMetadata = await fetch(`http://127.0.0.1:${ssePort}/.well-known/oauth-protected-resource/mcp`);
const sseApiBooks = await fetchJson("/api/books", {
  baseUrl: `http://127.0.0.1:${ssePort}`,
  headers: { Authorization: "Bearer smoke-token" },
});
const sseAssetNoAuth = await rawRequest(ssePort, "GET", assetPath);
const sseAssetWrongToken = await rawRequest(ssePort, "GET", assetPath, { authorization: "Bearer wrong-token" });
const sseAssetBearer = await rawRequest(ssePort, "GET", assetPath, { authorization: "Bearer smoke-token" });
const sseAssetCookie = await rawRequest(ssePort, "GET", assetPath, { cookie: sseCookie.split(";")[0] });
if (sseAssetNoAuth.status !== 401 || sseAssetWrongToken.status !== 401) {
  throw new Error("SSE process served a book asset without MCP_AUTH_TOKEN");
}
if (sseAssetBearer.status !== 200 || sseAssetCookie.status !== 200) {
  throw new Error("SSE process did not serve a book asset with bearer or reader cookie auth");
}
const sseMcpGet = await fetch(`http://127.0.0.1:${ssePort}/mcp`, {
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
if (!deleteWithoutConfirm.error?.message.includes("confirm: true")) {
  throw new Error("reading_delete_book did not require explicit confirmation");
}
if (
  contentJson(deleteChunkedImport).bookId !== "chunked-import" ||
  !contentJson(deleteChunkedImport).archivedAt ||
  contentJson(deleteChunkedImport).trash?.retentionDays !== 30
) {
  throw new Error("reading_delete_book did not archive a deleted book");
}
if (contentJson(booksAfterMcpDelete).some((book) => book.bookId === "chunked-import")) {
  throw new Error("reading_delete_book kept deleted book in list_books");
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
if (!nestedReply.result?.content?.[0]?.text.includes(`"parentId": "${replyId}"`)) {
  throw new Error("reading_reply_to_annotation did not attach a nested reply");
}
if (!nestedReplies.result?.content?.[0]?.text.includes("Claude can also answer a reply")) {
  throw new Error("reading_list_annotations did not find the nested reply");
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
if (httpOffsetNote.quoteOffset !== secondRepeatedOffset) {
  throw new Error("HTTP API did not preserve explicit quoteOffset for repeated text");
}
if (!httpNote.id) {
  throw new Error("HTTP API did not create a user note");
}
if (httpReply.parentId !== httpNote.id || httpReply.kind !== "reply") {
  throw new Error("HTTP API did not attach a reply");
}
if (httpReplyToClaude.parentId !== "ann_guidelines_001" || httpReplyToClaude.status !== "open") {
  throw new Error("HTTP reader replies to Claude annotations should stay staged until submit");
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
if (!httpImportNote.id || !httpImportCard.id) {
  throw new Error("HTTP API did not create delete smoke fixtures");
}
if (httpDeleteBook.bookId !== "http-import" || !httpDeleteBook.archivedAt) {
  throw new Error("HTTP API did not delete and archive a book");
}
if (httpBooksAfterDelete.some((book) => book.bookId === "http-import")) {
  throw new Error("HTTP API kept a deleted book in the active library");
}
if (httpDeletedProgress !== null || httpDeletedAnnotations.length !== 0 || httpDeletedCards.length !== 0) {
  throw new Error("HTTP API did not remove deleted book state from active records");
}
if (!readerHtml.ok || !(await readerHtml.text()).includes("Co-Reading")) {
  throw new Error("HTTP reader did not serve the web UI");
}
if (sseReaderHtml.status !== 401) {
  throw new Error("SSE process did not protect reader UI with MCP_AUTH_TOKEN");
}
if (sseTokenRedirect.status !== 302) {
  throw new Error("SSE process did not 302-redirect ?token URL to strip token from address bar");
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
if (sseUnauthorizedMcp.status !== 401 || !sseUnauthorizedMcp.headers.get("www-authenticate")?.includes("oauth-protected-resource")) {
  throw new Error("SSE process did not advertise MCP resource metadata on unauthorized MCP requests");
}
if (!sseMetadata.ok || (await sseMetadata.json()).resource !== `http://127.0.0.1:${ssePort}/mcp`) {
  throw new Error("SSE process did not serve MCP protected resource metadata");
}
if (!sseApiBooks.some((book) => book.bookId === "anthropic-guidelines")) {
  throw new Error("SSE process did not serve authenticated REST API");
}
if (sseMcpGet.status !== 405 || sseMcpGet.headers.get("allow") !== "POST") {
  throw new Error("SSE process did not return a connector-friendly GET /mcp response");
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
