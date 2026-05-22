import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "co-reading-mcp-"));
await cp(path.join(root, "data.example"), tempDataDir, { recursive: true });
const tempEpub = path.join(tempDataDir, "spine-demo.epub");
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

await request("initialize", {});
const list = await request("tools/call", { name: "reading_list_books", arguments: {} });
const read = await request("tools/call", {
  name: "reading_read_chunk",
  arguments: { bookId: "demo-book", chunkId: "ch00" },
});
const search = await request("tools/call", {
  name: "reading_search_chunks",
  arguments: { bookId: "demo-book", query: "margin" },
});
const firstSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "demo-book", sessionId: "session-a" },
});
const sameSessionNote = await request("tools/call", {
  name: "reading_annotate_passage",
  arguments: {
    bookId: "demo-book",
    chunkId: "ch00",
    quote: "The reader can mark a sentence",
    note: "Another local user note in the same chunk.",
    author: "user",
    status: "open",
  },
});
const sameSessionSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "demo-book", sessionId: "session-a" },
});
const newSessionNote = await request("tools/call", {
  name: "reading_annotate_passage",
  arguments: {
    bookId: "demo-book",
    chunkId: "ch00",
    quote: "The reader can mark a sentence",
    note: "A later note after changing sessions.",
    author: "user",
    status: "open",
  },
});
const newSessionSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "demo-book", sessionId: "session-b" },
});
const secondSubmit = await request("tools/call", {
  name: "reading_submit_user_notes",
  arguments: { bookId: "demo-book", sessionId: "session-b" },
});
const reply = await request("tools/call", {
  name: "reading_reply_to_annotation",
  arguments: { parentId: "ann_demo_user_001", note: "Claude can answer in the margin." },
});
const replies = await request("tools/call", {
  name: "reading_list_annotations",
  arguments: { parentId: "ann_demo_user_001" },
});
const badBookPath = await request("tools/call", {
  name: "reading_read_chunk",
  arguments: { bookId: "../../..", chunkId: "ch00" },
});
const badChunkPath = await request("tools/call", {
  name: "reading_read_chunk",
  arguments: { bookId: "bad-book", chunkId: "ch00" },
});

server.kill();
await rm(tempDataDir, { recursive: true, force: true });

if (!list.result?.content?.[0]?.text.includes("demo-book")) {
  throw new Error("reading_list_books did not return demo-book");
}
if (!read.result?.content?.[0]?.text.includes("A Small Lamp")) {
  throw new Error("reading_read_chunk did not return chunk text");
}
if (!search.result?.content?.[0]?.text.includes("margin")) {
  throw new Error("reading_search_chunks did not return a margin snippet");
}
if (contentJson(firstSubmit).count !== 1) {
  throw new Error("reading_submit_user_notes did not submit the open user note");
}
if (!contentJson(firstSubmit).context.chunks[0]?.text.includes("A Small Lamp")) {
  throw new Error("first session submit did not include chunk text");
}
if (!contentJson(sameSessionNote).id) {
  throw new Error("reading_annotate_passage did not create the same-session user note");
}
if (contentJson(sameSessionSubmit).context.chunks.length !== 0) {
  throw new Error("same-session submit repeated chunk text");
}
if (contentJson(sameSessionSubmit).context.omittedChunks[0]?.reason !== "already-sent-in-session") {
  throw new Error("same-session submit did not explain omitted chunk context");
}
if (!contentJson(newSessionNote).id) {
  throw new Error("reading_annotate_passage did not create the new-session user note");
}
if (!contentJson(newSessionSubmit).context.chunks[0]?.text.includes("A Small Lamp")) {
  throw new Error("new-session submit did not re-include chunk text");
}
if (contentJson(secondSubmit).count !== 0) {
  throw new Error("reading_submit_user_notes submitted the same note twice");
}
if (!reply.result?.content?.[0]?.text.includes('"parentId": "ann_demo_user_001"')) {
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

console.log("smoke ok");
