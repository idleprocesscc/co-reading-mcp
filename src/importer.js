import { access, appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveInside } from "./paths.js";
import { archiveReplacedBook, dataDir, restoreReplacedBook, withWriteLock } from "./store.js";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const booksDir = path.join(dataDir, "books");
const uploadsDir = path.join(dataDir, "uploads");
// Importers write here first; a finished book is renamed into books/ (same volume, so it's atomic).
const stagingDir = path.join(dataDir, ".import-staging");
const maxImportBytes = Number(process.env.READING_IMPORT_MAX_BYTES || 25_000_000);
const maxImportOutputBytes = Number(process.env.READING_IMPORT_MAX_OUTPUT_BYTES || 10_000_000);
const uploadSessions = new Map();
let importQueue = Promise.resolve();
const STALE_UPLOAD_MS = 60 * 60 * 1000; // 1 hour

async function cleanupStaleDirs(parentDir) {
  try {
    const entries = await readdir(parentDir).catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
      const dir = path.join(parentDir, entry);
      try {
        const info = await stat(dir);
        if (info.isDirectory() && now - info.mtimeMs > STALE_UPLOAD_MS) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch { /* ignore per-entry errors */ }
    }
  } catch { /* dir may not exist yet */ }
}

cleanupStaleDirs(uploadsDir);
cleanupStaleDirs(stagingDir);

function withImportLock(operation) {
  const run = importQueue.then(operation, operation);
  importQueue = run.catch(() => {});
  return run;
}

function safeBookId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = String(value).trim();
  if (!/^[A-Za-z0-9._\-\u4e00-\u9fff]+$/u.test(id) || id.includes("..")) {
    throw new Error("bookId may only contain letters, numbers, CJK characters, dot, dash, or underscore");
  }
  return id;
}

const MAX_HEADING_REGEX_LENGTH = 200;

function validateHeadingRegex(value) {
  if (!value) return null;
  const regex = String(value);
  if (regex.length > MAX_HEADING_REGEX_LENGTH) {
    throw new Error(`headingRegex exceeds ${MAX_HEADING_REGEX_LENGTH} characters`);
  }
  return regex;
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
    headingRegex: validateHeadingRegex(input.headingRegex),
    minSectionChars: positiveInteger(input.minSectionChars, "minSectionChars"),
    overwrite: input.overwrite === true,
    keepImages: input.keepImages === true,
  };
}

function alreadyExistsError(bookId) {
  return new Error(`Book already exists: ${bookId}. Pass overwrite: true to replace it.`);
}

function importerArgs(filePath, outDir, options) {
  const script = options.format === "epub" ? "scripts/import_epub.py" : "scripts/import_text.py";
  const args = [path.join(ROOT, script), filePath, "--out", outDir];

  // An EPUB names itself (dc:title, dc:creator) and import_epub.py falls back to the file name;
  // passing the file name as --title would hide the real title (and turn it into the author).
  const title = options.title || (options.format === "txt" ? titleFromFilename(options.filename) : null);
  if (title) args.push("--title", title);

  if (options.author) args.push("--author", options.author);
  if (options.bookId) args.push("--book-id", options.bookId);
  if (options.maxChars) args.push("--max-chars", String(options.maxChars));
  if (options.format === "epub" && options.keepImages) args.push("--keep-images");
  if (options.format === "txt" && options.headingRegex) {
    args.push("--heading-regex", options.headingRegex);
    if (options.minSectionChars) args.push("--min-section-chars", String(options.minSectionChars));
  }

  return args;
}

function importedBookDir(stdout, outDir) {
  const importedPath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!importedPath) throw new Error("Import script did not report an output directory");

  const bookDir = path.resolve(ROOT, importedPath);
  const relative = path.relative(path.resolve(outDir), bookDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error("Import script returned a directory outside its output folder");
  }
  return bookDir;
}

async function readManifestAt(bookDir) {
  return JSON.parse(await readFile(path.join(bookDir, "manifest.json"), "utf8"));
}

async function listFilesRecursive(dir, prefix = "") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(path.join(dir, entry.name), relative)));
    else files.push(entry.isFile() ? relative : `${relative}\0special`); // symlinks etc. never match
  }
  return files.sort();
}

/** The manifest minus what differs between two imports of the same file. */
function comparableManifest(buffer) {
  try {
    const { bookId, createdAt, ...rest } = JSON.parse(buffer.toString("utf8"));
    if (rest.source && typeof rest.source === "object") rest.source = { ...rest.source, fileName: undefined };
    return JSON.stringify(rest);
  } catch {
    return null;
  }
}

/** True when two book folders hold the same text, chunking, metadata, and assets. */
async function sameBookContent(dirA, dirB) {
  let filesA;
  let filesB;
  try {
    [filesA, filesB] = await Promise.all([listFilesRecursive(dirA), listFilesRecursive(dirB)]);
  } catch {
    return false;
  }
  if (filesA.join("\n") !== filesB.join("\n")) return false;
  for (const relative of filesA) {
    const [a, b] = await Promise.all([readFile(path.join(dirA, relative)), readFile(path.join(dirB, relative))]);
    if (relative === "manifest.json") {
      const comparable = comparableManifest(a);
      if (comparable === null || comparable !== comparableManifest(b)) return false;
    } else if (!a.equals(b)) {
      return false;
    }
  }
  return true;
}

const MAX_ID_SUFFIX = 1000;

/**
 * Move a finished import from staging into books/. Without overwrite this never changes or
 * removes an existing book: identical content is a no-op, and a different book whose id was
 * derived from its title (no bookId given) gets the first free "<id>-N". Runs inside the data
 * lock, so two processes can't claim the same id.
 */
async function placeImportedBook(stagedDir, options) {
  await mkdir(booksDir, { recursive: true });
  const manifest = await readManifestAt(stagedDir);
  // The importer names the folder after the bookId it chose (the given one, or a slug of the title).
  const wantedId = path.basename(stagedDir);
  const target = resolveInside(booksDir, wantedId);

  if (!(await exists(target))) {
    await rename(stagedDir, target);
    return { status: "imported", bookId: wantedId, manifest };
  }
  if (await sameBookContent(stagedDir, target)) {
    return { status: "unchanged", bookId: wantedId, manifest: await readManifestAt(target) };
  }
  if (options.overwrite) {
    const archived = await archiveReplacedBook(wantedId, { title: manifest.title, source: manifest.source || null });
    try {
      await rename(stagedDir, target);
    } catch (error) {
      await restoreReplacedBook(wantedId, archived);
      throw error;
    }
    return { status: "replaced", bookId: wantedId, manifest, archivedAt: archived.archiveDir };
  }
  if (options.bookId) throw alreadyExistsError(wantedId);

  for (let suffix = 2; suffix <= MAX_ID_SUFFIX; suffix += 1) {
    const candidateId = `${wantedId}-${suffix}`;
    const candidate = resolveInside(booksDir, candidateId);
    if (await exists(candidate)) {
      if (await sameBookContent(stagedDir, candidate)) {
        return { status: "unchanged", bookId: candidateId, manifest: await readManifestAt(candidate) };
      }
      continue;
    }
    manifest.bookId = candidateId;
    await writeFile(path.join(stagedDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(stagedDir, candidate);
    return { status: "imported-new-id", bookId: candidateId, manifest, existingBookId: wantedId };
  }
  throw new Error(`Too many books already use the id ${wantedId}; pass a bookId.`);
}

function importMessage(placed) {
  const { manifest } = placed;
  const chunks = `${manifest.chunks?.length || 0} chunks`;
  switch (placed.status) {
    case "unchanged":
      return `${manifest.title} is already in the library as ${placed.bookId} with identical content; nothing changed.`;
    case "imported-new-id":
      return `Imported ${manifest.title} (${chunks}) as ${placed.bookId}: a different book already uses the id ${placed.existingBookId}, so that one was left as it was.`;
    case "replaced":
      return `Replaced ${placed.bookId} with ${manifest.title} (${chunks}). The previous version is archived under data/trash; notes and progress stay attached to the same chunk ids.`;
    default:
      return `Imported ${manifest.title} (${chunks}).`;
  }
}

async function runImport(filePath, options) {
  // Refuse early so a clash costs nothing; placeImportedBook checks again under the data lock.
  if (options.bookId && !options.overwrite && (await exists(resolveInside(booksDir, options.bookId)))) {
    throw alreadyExistsError(options.bookId);
  }

  await mkdir(stagingDir, { recursive: true });
  const outDir = await mkdtemp(path.join(stagingDir, "import-"));
  try {
    const args = importerArgs(filePath, outDir, options);
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(process.platform === "win32" ? "python" : "python3", args, {
        cwd: ROOT,
        maxBuffer: maxImportOutputBytes,
        timeout: 60_000,
      });
      stdout = result.stdout || "";
      stderr = result.stderr || "";
    } catch (error) {
      const message = [error.message, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(message || "Import script failed");
    }

    if (stderr.trim()) process.stderr.write(stderr);
    const stagedDir = importedBookDir(stdout, outDir);
    const placed = await withWriteLock(() => placeImportedBook(stagedDir, options));
    const { manifest } = placed;
    const firstChunk = manifest.chunks?.[0] || null;
    const lastChunk = manifest.chunks?.[manifest.chunks.length - 1] || null;
    return {
      bookId: placed.bookId,
      title: manifest.title,
      author: manifest.author || null,
      chunkCount: manifest.chunks?.length || 0,
      firstChunkId: firstChunk?.id || null,
      lastChunkId: lastChunk?.id || null,
      source: manifest.source || null,
      keepImages: options.format === "epub" && options.keepImages,
      status: placed.status,
      ...(placed.existingBookId ? { existingBookId: placed.existingBookId } : {}),
      ...(placed.archivedAt ? { archivedAt: placed.archivedAt } : {}),
      message: importMessage(placed),
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
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
