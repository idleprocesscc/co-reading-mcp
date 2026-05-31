import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dataDir } from "./store.js";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const booksDir = path.join(dataDir, "books");
const uploadsDir = path.join(dataDir, "uploads");
const maxImportBytes = Number(process.env.READING_IMPORT_MAX_BYTES || 25_000_000);
const maxImportOutputBytes = Number(process.env.READING_IMPORT_MAX_OUTPUT_BYTES || 10_000_000);
const uploadSessions = new Map();
let importQueue = Promise.resolve();

function withImportLock(operation) {
  const run = importQueue.then(operation, operation);
  importQueue = run.catch(() => {});
  return run;
}

function resolveInside(baseDir, ...parts) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...parts);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Path escapes import directory: ${parts.join("/")}`);
}

function safeBookId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = String(value).trim();
  if (!/^[A-Za-z0-9._\-\u4e00-\u9fff]+$/u.test(id) || id.includes("..")) {
    throw new Error("bookId may only contain letters, numbers, CJK characters, dot, dash, or underscore");
  }
  return id;
}

function extensionFormat(filename, format) {
  const explicit = format ? String(format).toLowerCase().replace(/^\./, "") : "";
  if (["txt", "text", "md", "markdown"].includes(explicit)) return "txt";
  if (explicit === "epub") return "epub";

  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".epub") return "epub";
  if ([".txt", ".text", ".md", ".markdown"].includes(ext)) return "txt";
  throw new Error("Unsupported import format. Use EPUB or TXT.");
}

function safeFilename(filename, format) {
  const fallback = format === "epub" ? "upload.epub" : "upload.txt";
  const base = path.basename(String(filename || fallback)).replace(/[^\w.\-\u4e00-\u9fff ]+/gu, "_");
  const trimmed = base.trim().replace(/^\.+/, "");
  return trimmed || fallback;
}

function titleFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename)).trim();
  return stem || "Imported Book";
}

function positiveInteger(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function normalizeBase64(value) {
  if (!value || typeof value !== "string") throw new Error("dataBase64 is required");
  const body = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  return body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
}

function decodeBase64(value) {
  const normalized = normalizeBase64(value);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("dataBase64 is not valid base64");
  }
  return Buffer.from(normalized, "base64");
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function commonOptions(input = {}) {
  return {
    filename: safeFilename(input.filename, extensionFormat(input.filename, input.format)),
    format: extensionFormat(input.filename, input.format),
    bookId: safeBookId(input.bookId),
    title: input.title ? String(input.title) : null,
    author: input.author ? String(input.author) : null,
    maxChars: positiveInteger(input.maxChars, "maxChars"),
    headingRegex: input.headingRegex ? String(input.headingRegex) : null,
    minSectionChars: positiveInteger(input.minSectionChars, "minSectionChars"),
    overwrite: input.overwrite === true,
  };
}

async function prepareTarget(options) {
  await mkdir(booksDir, { recursive: true });
  if (!options.bookId) return;

  const target = resolveInside(booksDir, options.bookId);
  if (!(await exists(target))) return;
  if (!options.overwrite) {
    throw new Error(`Book already exists: ${options.bookId}. Pass overwrite: true to replace it.`);
  }
  await rm(target, { recursive: true, force: true });
}

function importerArgs(filePath, options) {
  const script = options.format === "epub" ? "scripts/import_epub.py" : "scripts/import_text.py";
  const args = [path.join(ROOT, script), filePath, "--out", booksDir];

  if (options.format === "txt") {
    args.push("--title", options.title || titleFromFilename(options.filename));
  } else {
    args.push("--title", options.title || titleFromFilename(options.filename));
  }

  if (options.author) args.push("--author", options.author);
  if (options.bookId) args.push("--book-id", options.bookId);
  if (options.maxChars) args.push("--max-chars", String(options.maxChars));
  if (options.format === "txt" && options.headingRegex) {
    args.push("--heading-regex", options.headingRegex);
    if (options.minSectionChars) args.push("--min-section-chars", String(options.minSectionChars));
  }

  return args;
}

async function readImportedManifest(stdout) {
  const importedPath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!importedPath) throw new Error("Import script did not report an output directory");

  const bookDir = path.resolve(ROOT, importedPath);
  const relative = path.relative(path.resolve(booksDir), bookDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Import script returned a directory outside data/books");
  }

  return JSON.parse(await readFile(path.join(bookDir, "manifest.json"), "utf8"));
}

async function runImport(filePath, options) {
  await prepareTarget(options);
  const args = importerArgs(filePath, options);
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(process.platform === "win32" ? "python" : "python3", args, {
      cwd: ROOT,
      maxBuffer: maxImportOutputBytes,
    });
    stdout = result.stdout || "";
    stderr = result.stderr || "";
  } catch (error) {
    const message = [error.message, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(message || "Import script failed");
  }

  if (stderr.trim()) process.stderr.write(stderr);
  const manifest = await readImportedManifest(stdout);
  const firstChunk = manifest.chunks?.[0] || null;
  const lastChunk = manifest.chunks?.[manifest.chunks.length - 1] || null;
  return {
    bookId: manifest.bookId,
    title: manifest.title,
    author: manifest.author || null,
    chunkCount: manifest.chunks?.length || 0,
    firstChunkId: firstChunk?.id || null,
    lastChunkId: lastChunk?.id || null,
    source: manifest.source || null,
    message: `Imported ${manifest.title} (${manifest.chunks?.length || 0} chunks).`,
  };
}

export function importLimits() {
  return { maxImportBytes };
}

export async function importBook(input = {}) {
  const options = commonOptions(input);
  const buffer = decodeBase64(input.dataBase64);
  if (!buffer.length) throw new Error("Imported file is empty");
  if (buffer.length > maxImportBytes) {
    throw new Error(`Imported file exceeds ${maxImportBytes} bytes`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "co-reading-import-"));
  const filePath = resolveInside(tempDir, options.filename);
  try {
    await writeFile(filePath, buffer);
    return await withImportLock(() => runImport(filePath, options));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function beginImport(input = {}) {
  const options = commonOptions(input);
  const expectedBytes = positiveInteger(input.expectedBytes, "expectedBytes") || null;
  if (expectedBytes && expectedBytes > maxImportBytes) {
    throw new Error(`Imported file exceeds ${maxImportBytes} bytes`);
  }

  const uploadId = crypto.randomUUID();
  const dir = resolveInside(uploadsDir, uploadId);
  await mkdir(dir, { recursive: true });
  const filePath = resolveInside(dir, options.filename);
  await writeFile(filePath, "");
  uploadSessions.set(uploadId, {
    uploadId,
    options,
    filePath,
    dir,
    expectedBytes,
    bytes: 0,
    parts: 0,
    createdAt: new Date().toISOString(),
  });

  return {
    uploadId,
    filename: options.filename,
    format: options.format,
    maxImportBytes,
    expectedBytes,
    message: "Upload started. Send base64 file parts with reading_import_part, then call reading_import_finish.",
  };
}

export async function appendImportPart({ uploadId, dataBase64, index } = {}) {
  return withImportLock(async () => {
    if (!uploadId) throw new Error("uploadId is required");
    const session = uploadSessions.get(uploadId);
    if (!session) throw new Error(`Unknown uploadId: ${uploadId}`);
    if (index !== undefined && Number(index) !== session.parts) {
      throw new Error(`Unexpected part index ${index}; expected ${session.parts}`);
    }

    const buffer = decodeBase64(dataBase64);
    if (!buffer.length) throw new Error("Import part is empty");
    if (session.bytes + buffer.length > maxImportBytes) {
      throw new Error(`Imported file exceeds ${maxImportBytes} bytes`);
    }

    await appendFile(session.filePath, buffer);
    session.bytes += buffer.length;
    session.parts += 1;
    return {
      uploadId,
      bytes: session.bytes,
      parts: session.parts,
      done: false,
    };
  });
}

export async function finishImport({ uploadId } = {}) {
  return withImportLock(async () => {
    if (!uploadId) throw new Error("uploadId is required");
    const session = uploadSessions.get(uploadId);
    if (!session) throw new Error(`Unknown uploadId: ${uploadId}`);

    const info = await stat(session.filePath);
    if (info.size === 0) throw new Error("Imported file is empty");
    if (session.expectedBytes && info.size !== session.expectedBytes) {
      throw new Error(`Uploaded ${info.size} bytes, expected ${session.expectedBytes}`);
    }

    const result = await runImport(session.filePath, session.options);
    uploadSessions.delete(uploadId);
    await rm(session.dir, { recursive: true, force: true });
    return { uploadId, ...result };
  });
}

export async function cancelImport({ uploadId } = {}) {
  return withImportLock(async () => {
    if (!uploadId) throw new Error("uploadId is required");
    const session = uploadSessions.get(uploadId);
    if (!session) return { uploadId, cancelled: false, message: "Upload was already gone." };
    uploadSessions.delete(uploadId);
    await rm(session.dir, { recursive: true, force: true });
    return { uploadId, cancelled: true };
  });
}
