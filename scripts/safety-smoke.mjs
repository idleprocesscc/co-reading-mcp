// Data-safety regressions: an import never replaces a book unless asked to, a damaged line
// in annotations.jsonl costs no other note, and the first write of each day snapshots the
// state files. Every test runs its own server process(es) on a fresh copy of data.example.
// Run: node scripts/safety-smoke.mjs  (exit code 1 if any test fails)
import { execFileSync, spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(path.join(os.tmpdir(), "co-reading-safety-"));
const children = new Set();
let nextPort = 20000 + (process.pid % 4000) * 2;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freshDataDir() {
  const dir = await mkdtemp(path.join(workDir, "data-"));
  await cp(path.join(root, "data.example"), dir, { recursive: true });
  return dir;
}

function startMcp(dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(root, "src/server.js")], {
    env: { ...process.env, READING_MCP_DATA_DIR: dataDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", () => {
    for (const resolve of pending.values()) resolve({ error: { message: `server exited\n${stderr}` } });
    pending.clear();
  });
  return {
    /** Call a tool; resolves to the parsed result, or { error } for a JSON-RPC error. */
    async tool(name, args = {}) {
      const id = nextId++;
      const response = await new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
      if (response.error) return { error: response.error.message };
      const text = response.result.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    stderr: () => stderr,
    stop() {
      child.kill();
      children.delete(child);
    },
  };
}

async function startHttp(dataDir) {
  const port = nextPort++;
  const child = spawn(process.execPath, [path.join(root, "src/http.js")], {
    env: { ...process.env, READING_MCP_DATA_DIR: dataDir, READING_HTTP_PORT: String(port), READING_HTTP_STDIO: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  child.stderr.resume();
  async function api(pathname, { method = "GET", body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON (Markdown export); keep the text.
    }
    return { status: response.status, data, contentType: response.headers.get("content-type") || "" };
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await api("/api/books");
      return {
        api,
        stop() {
          child.kill();
          children.delete(child);
        },
      };
    } catch {
      await sleep(50);
    }
  }
  throw new Error("HTTP reader did not start");
}

const EPUB_PY = `
import json, sys, zipfile
out, spec = sys.argv[1], json.loads(sys.argv[2])
meta = ""
if spec.get("title"): meta += "<dc:title>%s</dc:title>" % spec["title"]
if spec.get("creator"): meta += "<dc:creator>%s</dc:creator>" % spec["creator"]
chapters = spec["chapters"]
items = "".join("<item id='c%d' href='c%d.xhtml' media-type='application/xhtml+xml'/>" % (i, i) for i in range(len(chapters)))
refs = "".join("<itemref idref='c%d'/>" % i for i in range(len(chapters)))
with zipfile.ZipFile(out, "w") as zf:
    zf.writestr("mimetype", "application/epub+zip")
    zf.writestr("META-INF/container.xml", "<?xml version='1.0'?><container xmlns='urn:oasis:names:tc:opendocument:xmlns:container' version='1.0'><rootfiles><rootfile full-path='OPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles></container>")
    zf.writestr("OPS/content.opf", "<?xml version='1.0'?><package xmlns='http://www.idpf.org/2007/opf' version='3.0'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'>%s</metadata><manifest>%s</manifest><spine>%s</spine></package>" % (meta, items, refs))
    for i, text in enumerate(chapters):
        zf.writestr("OPS/c%d.xhtml" % i, "<html xmlns='http://www.w3.org/1999/xhtml'><body><h1>Chapter %d</h1><p>%s</p></body></html>" % (i + 1, text))
`;

async function epubBase64(spec) {
  const file = path.join(await mkdtemp(path.join(workDir, "epub-")), "book.epub");
  execFileSync("python3", ["-", file, JSON.stringify(spec)], { input: EPUB_PY, encoding: "utf8" });
  return (await readFile(file)).toString("base64");
}

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const lighthouse = [
  "Chapter One",
  "",
  "The lighthouse keeper counted ships.",
  "",
  "Chapter Two",
  "",
  "Fog came in from the bay.",
  "",
  "Chapter Three",
  "",
  "The lamp went dark at dawn.",
].join("\n");
const headingRegex = "^Chapter \\w+";

async function bookDirs(dataDir) {
  return (await readdir(path.join(dataDir, "books"))).sort();
}

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- A1: imports never silently replace a book ------------------------------------------

test("import: a different book with the same title gets a new id; the first keeps its text and notes", async () => {
  const dataDir = await freshDataDir();
  const mcp = startMcp(dataDir);
  try {
    const first = await mcp.tool("reading_import_book", { filename: "my-book.txt", dataBase64: b64(lighthouse), title: "My Book", headingRegex });
    assert(first.bookId === "my-book" && first.chunkCount === 3, `first import: ${JSON.stringify(first)}`);
    const note = await mcp.tool("reading_annotate_passage", {
      bookId: "my-book",
      chunkId: "ch00",
      quote: "The lighthouse keeper counted ships.",
      note: "Keep me anchored.",
    });
    await mcp.tool("reading_mark_read", { bookId: "my-book", chunkId: "ch02" });

    const second = await mcp.tool("reading_import_book", { filename: "other.txt", dataBase64: b64("A different book about bees."), title: "My Book" });
    assert(!second.error, `second import failed: ${second.error}`);
    assert(second.bookId !== "my-book", `second import replaced the first book (bookId ${second.bookId})`);
    assert(second.status === "imported-new-id" && second.existingBookId === "my-book", `result did not say what happened: ${JSON.stringify(second)}`);

    const chunk = await mcp.tool("reading_read_chunk", { bookId: "my-book", chunkId: "ch00" });
    assert(chunk.text?.includes(note.quote), "first book's ch00 no longer holds the annotated quote");
    const chunkFiles = await readdir(path.join(dataDir, "books", "my-book", "chunks"));
    assert(chunkFiles.length === 3, `first book has ${chunkFiles.length} chunk files, expected 3`);
    const progress = await mcp.tool("reading_get_progress", { bookId: "my-book" });
    assert(progress?.readChunkIds?.includes("ch02"), "first book lost its progress");
    const copy = await mcp.tool("reading_read_chunk", { bookId: second.bookId, chunkId: "ch00" });
    assert(copy.text?.includes("bees"), "second book was not imported under its new id");
  } finally {
    mcp.stop();
  }
});

test("import: browser uploads that share a filename (download.txt) both survive", async () => {
  const dataDir = await freshDataDir();
  const http = await startHttp(dataDir);
  try {
    const a = await http.api("/api/import", { method: "POST", body: { filename: "download.txt", dataBase64: b64("Alpha text from the first download.") } });
    const b = await http.api("/api/import", { method: "POST", body: { filename: "download.txt", dataBase64: b64("Beta text from the second download.") } });
    assert(a.status === 201 && b.status === 201, `imports: ${a.status} ${b.status}`);
    assert(a.data.bookId !== b.data.bookId, `both uploads landed on ${a.data.bookId}`);
    const chunkA = await http.api(`/api/books/${encodeURIComponent(a.data.bookId)}/chunks/ch00`);
    assert(chunkA.data.text?.includes("Alpha"), "the first download's text was replaced");
  } finally {
    http.stop();
  }
});

test("import: re-importing identical content is a no-op and says so", async () => {
  const dataDir = await freshDataDir();
  const mcp = startMcp(dataDir);
  try {
    const args = { filename: "notes.txt", dataBase64: b64(lighthouse), title: "Field Notes", headingRegex };
    const first = await mcp.tool("reading_import_book", args);
    const before = await bookDirs(dataDir);
    const again = await mcp.tool("reading_import_book", args);
    assert(!again.error, `re-import failed: ${again.error}`);
    assert(again.bookId === first.bookId, `re-import moved to ${again.bookId}`);
    assert(again.status === "unchanged", `re-import did not report "unchanged": ${JSON.stringify(again)}`);
    assert(JSON.stringify(await bookDirs(dataDir)) === JSON.stringify(before), "re-import created another book folder");
  } finally {
    mcp.stop();
  }
});

test("import: an explicit bookId that exists is refused without overwrite", async () => {
  const dataDir = await freshDataDir();
  const mcp = startMcp(dataDir);
  try {
    await mcp.tool("reading_import_book", { filename: "a.txt", dataBase64: b64(lighthouse), bookId: "fixed", title: "Fixed", headingRegex });
    const refused = await mcp.tool("reading_import_book", { filename: "b.txt", dataBase64: b64("Other text."), bookId: "fixed", title: "Fixed" });
    assert(refused.error?.includes("already exists") && refused.error.includes("overwrite"), `not refused: ${JSON.stringify(refused)}`);
    const chunk = await mcp.tool("reading_read_chunk", { bookId: "fixed", chunkId: "ch00" });
    assert(chunk.text?.includes("lighthouse"), "refused import still changed the book");
  } finally {
    mcp.stop();
  }
});

test("import: overwrite that fails midway leaves the old book in place", async () => {
  const dataDir = await freshDataDir();
  const mcp = startMcp(dataDir);
  try {
    await mcp.tool("reading_import_book", { filename: "keep.txt", dataBase64: b64(lighthouse), bookId: "keepme", title: "Keep Me", headingRegex });
    const failed = await mcp.tool("reading_import_book", {
      filename: "broken.epub",
      dataBase64: b64("this is not a zip file"),
      bookId: "keepme",
      overwrite: true,
    });
    assert(failed.error, "corrupt EPUB import did not fail");
    const chunk = await mcp.tool("reading_read_chunk", { bookId: "keepme", chunkId: "ch00" });
    assert(chunk.text?.includes("lighthouse"), `old book is gone after a failed overwrite: ${chunk.error || "text changed"}`);
  } finally {
    mcp.stop();
  }
});

test("import: a successful overwrite keeps the old version in trash", async () => {
  const dataDir = await freshDataDir();
  const mcp = startMcp(dataDir);
  try {
    await mcp.tool("reading_import_book", { filename: "v1.txt", dataBase64: b64(lighthouse), bookId: "versioned", title: "Versioned", headingRegex });
    const replaced = await mcp.tool("reading_import_book", {
      filename: "v2.txt",
      dataBase64: b64("Second edition text."),
      bookId: "versioned",
      title: "Versioned",
      overwrite: true,
    });
    assert(replaced.status === "replaced", `overwrite result: ${JSON.stringify(replaced)}`);
    const chunk = await mcp.tool("reading_read_chunk", { bookId: "versioned", chunkId: "ch00" });
    assert(chunk.text?.includes("Second edition"), "overwrite did not install the new text");
    const trashBooks = await readdir(path.join(dataDir, "trash", "books")).catch(() => []);
    let archivedText = "";
    for (const entry of trashBooks) {
      archivedText += await readFile(path.join(dataDir, "trash", "books", entry, "book", "chunks", "ch00.txt"), "utf8").catch(() => "");
    }
    assert(archivedText.includes("lighthouse"), "the replaced version is not recoverable from trash");
  } finally {
    mcp.stop();
  }
});

test("import: web EPUB upload uses the EPUB's own title and author, not the filename", async () => {
  const dataDir = await freshDataDir();
  const http = await startHttp(dataDir);
  try {
    const solaris = await http.api("/api/import", {
      method: "POST",
      body: { filename: "download.epub", dataBase64: await epubBase64({ title: "Solaris", chapters: ["The ocean thinks."] }), keepImages: false },
    });
    assert(solaris.data.title === "Solaris", `title: ${solaris.data.title}`);
    assert(solaris.data.author === null, `author: ${solaris.data.author}`);
    const ubik = await http.api("/api/import", {
      method: "POST",
      body: { filename: "download.epub", dataBase64: await epubBase64({ title: "Ubik", creator: "Philip K. Dick", chapters: ["Spray cans."] }) },
    });
    assert(ubik.data.title === "Ubik" && ubik.data.author === "Philip K. Dick", `metadata ignored: ${ubik.data.title} / ${ubik.data.author}`);
    const untitled = await http.api("/api/import", {
      method: "POST",
      body: { filename: "no-metadata.epub", dataBase64: await epubBase64({ chapters: ["Nothing to see."] }) },
    });
    assert(untitled.data.title === "no-metadata", `filename fallback: ${untitled.data.title}`);
  } finally {
    http.stop();
  }
});

// ---- A2: a damaged annotations.jsonl line costs no other note --------------------------

const tornLine = '{"id":"ann_torn","bookId":"anthropic-guidelines","chunkId":"ch00","quote":"Claude is tra';

test("annotations: a torn last line does not swallow the next note, and the rewrite keeps it aside", async () => {
  const dataDir = await freshDataDir();
  const annotationsPath = path.join(dataDir, "annotations.jsonl");
  await appendFile(annotationsPath, tornLine, "utf8");
  const mcp = startMcp(dataDir);
  try {
    const saved = await mcp.tool("reading_annotate_passage", {
      bookId: "anthropic-guidelines",
      chunkId: "ch00",
      quote: "Claude is trained by Anthropic",
      note: "NEW note after a torn write",
    });
    assert(saved.id, `annotate failed: ${saved.error}`);
    const listed = await mcp.tool("reading_list_annotations", { bookId: "anthropic-guidelines" });
    assert(listed.some((row) => row.id === saved.id), 'tool said "Saved" but the note is not listed');
    assert(saved.warnings?.length, "annotate did not warn about the cut-off line it found");

    // A full rewrite (Send to Claude) must not drop the damaged line or the new note.
    await appendFile(annotationsPath, `${JSON.stringify({ id: "ann_user_open", bookId: "anthropic-guidelines", chunkId: "ch00", quote: "Claude", note: "open", author: "user", status: "open" })}\n`);
    const submitted = await mcp.tool("reading_submit_user_notes", { bookId: "anthropic-guidelines" });
    assert(!submitted.error, `submit failed: ${submitted.error}`);
    const after = await readFile(annotationsPath, "utf8");
    assert((after.match(/NEW note after a torn write/g) || []).length === 1, "the new note is gone after a rewrite");
    const sidecar = await readFile(path.join(dataDir, "annotations.corrupt.jsonl"), "utf8").catch(() => "");
    const quarantined = sidecar.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert(quarantined.some((row) => row.line === tornLine && row.quarantinedAt), "the torn line was not kept in annotations.corrupt.jsonl");
    assert(!after.includes("Claude is tra\""), "the torn line is still in annotations.jsonl after the rewrite");
    assert(submitted.warnings?.length, "submit did not warn that it moved a damaged line aside");
  } finally {
    mcp.stop();
  }
});

test("annotations: a garbage line survives deleteBook's rewrite in the sidecar; neighbours stay", async () => {
  const dataDir = await freshDataDir();
  const annotationsPath = path.join(dataDir, "annotations.jsonl");
  await appendFile(annotationsPath, "garbage that is not json\n", "utf8");
  const mcp = startMcp(dataDir);
  try {
    await mcp.tool("reading_import_book", { filename: "x.txt", dataBase64: b64("Doomed text."), bookId: "doomed", title: "Doomed" });
    await mcp.tool("reading_annotate_passage", { bookId: "doomed", chunkId: "ch00", quote: "Doomed text.", note: "goes with the book" });
    const deleted = await mcp.tool("reading_delete_book", { bookId: "doomed", confirm: true });
    assert(!deleted.error, `delete failed: ${deleted.error}`);
    const after = await readFile(annotationsPath, "utf8");
    assert(after.includes("ann_guidelines_001") && after.includes("ann_guidelines_user_001"), "a neighbouring note was lost");
    const sidecar = await readFile(path.join(dataDir, "annotations.corrupt.jsonl"), "utf8").catch(() => "");
    assert(sidecar.includes("garbage that is not json"), "the unparseable line was dropped instead of kept aside");
  } finally {
    mcp.stop();
  }
});

test("annotations: a note already glued onto a torn line (as older versions wrote it) is still read", async () => {
  const dataDir = await freshDataDir();
  const glued = { id: "ann_glued", bookId: "anthropic-guidelines", chunkId: "ch00", quote: "Claude is trained by Anthropic", note: "glued", author: "claude", status: "published", parentId: null };
  await appendFile(path.join(dataDir, "annotations.jsonl"), `${tornLine}${JSON.stringify(glued)}\n`, "utf8");
  const mcp = startMcp(dataDir);
  try {
    const listed = await mcp.tool("reading_list_annotations", { bookId: "anthropic-guidelines" });
    assert(listed.some((row) => row.id === "ann_glued"), "the glued note is not listed");
    assert(listed.some((row) => row.id === "ann_guidelines_001"), "a neighbouring note is missing");
  } finally {
    mcp.stop();
  }
});

// ---- A3: rolling snapshots -----------------------------------------------------------------

test("snapshots: the first write of the day copies the state files first; later writes leave it", async () => {
  const dataDir = await freshDataDir();
  const original = await readFile(path.join(dataDir, "annotations.jsonl"), "utf8");
  const mcp = startMcp(dataDir);
  try {
    await mcp.tool("reading_annotate_passage", { bookId: "anthropic-guidelines", chunkId: "ch00", quote: "Claude is trained by Anthropic", note: "first write" });
    const snapshotDir = path.join(dataDir, "snapshots", localDay());
    const snapped = await readFile(path.join(snapshotDir, "annotations.jsonl"), "utf8").catch(() => null);
    assert(snapped === original, "no snapshot of annotations.jsonl as it was before the first write");
    for (const name of ["progress.json", "reading_sessions.json"]) {
      const copy = await readFile(path.join(snapshotDir, name), "utf8").catch(() => null);
      assert(copy === (await readFile(path.join(root, "data.example", name), "utf8")), `snapshot is missing ${name}`);
    }
    await mcp.tool("reading_mark_read", { bookId: "anthropic-guidelines", chunkId: "ch01" });
    assert((await readFile(path.join(snapshotDir, "annotations.jsonl"), "utf8")) === original, "a later write changed today's snapshot");
  } finally {
    mcp.stop();
  }
});

test("snapshots: only the newest READING_SNAPSHOT_KEEP are kept; other folders are untouched", async () => {
  const dataDir = await freshDataDir();
  for (const day of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05"]) {
    await mkdir(path.join(dataDir, "snapshots", day), { recursive: true });
  }
  await mkdir(path.join(dataDir, "snapshots", "my-own-backup"), { recursive: true });
  const mcp = startMcp(dataDir, { READING_SNAPSHOT_KEEP: "3" });
  try {
    await mcp.tool("reading_mark_read", { bookId: "anthropic-guidelines", chunkId: "ch01" });
    const left = (await readdir(path.join(dataDir, "snapshots"))).sort();
    const expected = ["2020-01-04", "2020-01-05", localDay(), "my-own-backup"].sort();
    assert(JSON.stringify(left) === JSON.stringify(expected), `snapshots left: ${left.join(", ")}`);
  } finally {
    mcp.stop();
  }
});

test("snapshots: two processes writing at once make one snapshot and lose no note", async () => {
  const dataDir = await freshDataDir();
  const original = await readFile(path.join(dataDir, "annotations.jsonl"), "utf8");
  const a = startMcp(dataDir);
  const b = startMcp(dataDir);
  try {
    const calls = [];
    for (let index = 0; index < 15; index += 1) {
      for (const [name, server] of [["a", a], ["b", b]]) {
        calls.push(
          server.tool("reading_annotate_passage", { bookId: "anthropic-guidelines", chunkId: "ch00", quote: "Claude is trained by Anthropic", note: `concurrent ${name}${index}` }),
        );
      }
    }
    const results = await Promise.all(calls);
    assert(results.every((result) => result.id), `a write failed: ${results.find((result) => !result.id)?.error}`);
    const rows = (await readFile(path.join(dataDir, "annotations.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert(rows.length === 2 + 30, `annotations.jsonl has ${rows.length} rows, expected 32`);
    const snapshots = (await readdir(path.join(dataDir, "snapshots")).catch(() => [])).filter((name) => !name.startsWith("."));
    assert(JSON.stringify(snapshots) === JSON.stringify([localDay()]), `snapshots: ${snapshots.join(", ") || "none"}`);
    assert((await readFile(path.join(dataDir, "snapshots", localDay(), "annotations.jsonl"), "utf8")) === original, "snapshot is not the pre-write state");
  } finally {
    a.stop();
    b.stop();
  }
});

test("export: one book's notes as Markdown (MCP hides open human notes; the reader endpoint shows them)", async () => {
  const dataDir = await freshDataDir();
  const mcp = startMcp(dataDir);
  const http = await startHttp(dataDir);
  try {
    await mcp.tool("reading_reply_to_annotation", { parentId: "ann_guidelines_001", note: "A reply under the demo note." });
    const markdown = await mcp.tool("reading_export_annotations", { bookId: "anthropic-guidelines" });
    assert(typeof markdown === "string" && markdown.startsWith("# The Anthropic Guidelines"), `MCP export: ${JSON.stringify(markdown).slice(0, 200)}`);
    assert(markdown.includes("> Claude is trained by Anthropic") && markdown.includes("This demo margin note"), "export is missing the demo note");
    assert(markdown.includes("A reply under the demo note."), "export is missing the reply");
    assert(!markdown.includes("User note waiting to be sent"), "MCP export exposed an open human note");
    const viaHttp = await http.api("/api/books/anthropic-guidelines/annotations.md");
    assert(viaHttp.status === 200 && viaHttp.contentType.startsWith("text/markdown"), `HTTP export: ${viaHttp.status} ${viaHttp.contentType}`);
    assert(viaHttp.data.includes("User note waiting to be sent"), "reader export left out the human's own note");
  } finally {
    mcp.stop();
    http.stop();
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await Promise.race([fn(), sleep(30_000).then(() => Promise.reject(new Error("timed out after 30s")))]);
    console.log(`ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.message.split("\n")[0]}`);
  }
}
for (const child of children) child.kill();
await rm(workDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${tests.length} safety tests failed` : `\nsafety smoke ok (${tests.length} tests)`);
process.exit(failed ? 1 : 0);
