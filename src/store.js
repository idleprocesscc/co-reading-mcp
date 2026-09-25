import { appendFile, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { buildCardCandidates, hashText, isClaudeAuthor, isHumanAuthor, pickCard } from "../public/card-logic.js";
import { resolveInside } from "./paths.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const dataDir = process.env.READING_MCP_DATA_DIR
  ? path.resolve(process.env.READING_MCP_DATA_DIR)
  : path.join(ROOT, "data");

const booksDir = path.join(dataDir, "books");
const annotationsPath = path.join(dataDir, "annotations.jsonl");
const submissionsPath = path.join(dataDir, "submissions.jsonl");
const cardsPath = path.join(dataDir, "cards.jsonl");
const progressPath = path.join(dataDir, "progress.json");
const sessionsPath = path.join(dataDir, "reading_sessions.json");
const trashDir = path.join(dataDir, "trash");
const defaultTrashRetentionDays = 30;

const manifestCache = new Map();
const chunkTextCache = new Map();
const annotationCache = {};
let writeQueue = Promise.resolve();
invalidateAnnotationCache();

function invalidateAnnotationCache() {
  annotationCache.signature = null;
  annotationCache.rows = [];
  annotationCache.bookCounts = new Map();
  annotationCache.chunkCounts = new Map();
  annotationCache.publicRows = [];
  annotationCache.publicBookCounts = new Map();
  annotationCache.publicChunkCounts = new Map();
}

// Writes are serialized in-process by writeQueue and across processes (e.g. src/server.js for
// Claude plus src/http.js for the reader on the same data dir) by a lock directory: mkdir is
// atomic, so only one process holds it. A lock left by a killed process expires.
const lockDir = path.join(dataDir, ".write-lock");
const LOCK_STALE_MS = 60_000;

async function acquireDataLock() {
  await mkdir(dataDir, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lockDir);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 200)));
  }
}

async function withWriteLock(operation) {
  const locked = async () => {
    await acquireDataLock();
    try {
      return await operation();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  };
  const run = writeQueue.then(locked, locked);
  writeQueue = run.catch(() => {});
  return run;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileSignature(filePath) {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

/** Replace a file in one step (write a temp file, then rename) so readers never see half of it. */
async function writeFileAtomic(filePath, body) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, body, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFileAtomic(filePath, body ? `${body}\n` : "");
}

function safeTrashName(value) {
  return String(value || "book").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "book";
}

function trashRetentionDays() {
  const configured = Number(process.env.READING_TRASH_RETENTION_DAYS ?? defaultTrashRetentionDays);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

async function pruneOldTrash(nowMs = Date.now()) {
  const retentionDays = trashRetentionDays();
  if (!retentionDays) return { retentionDays, pruned: 0 };

  const booksTrashDir = path.join(trashDir, "books");
  let entries = [];
  try {
    entries = await readdir(booksTrashDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { retentionDays, pruned: 0 };
    throw error;
  }

  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = resolveInside(booksTrashDir, entry.name);
    const info = await stat(entryPath);
    if (info.mtimeMs >= cutoff) continue;
    await rm(entryPath, { recursive: true, force: true });
    pruned += 1;
  }
  return { retentionDays, pruned };
}

/** Split items into [matching, rest]. */
function partition(items, predicate) {
  const matching = [];
  const rest = [];
  for (const item of items) (predicate(item) ? matching : rest).push(item);
  return [matching, rest];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedChunks(manifest) {
  return manifest.chunks.slice().sort((a, b) => a.order - b.order);
}

// Progress may also be written by a reader that tracks "chapters" (readChapterIds /
// lastChapterId) over the same data dir; ids that match this book's chunks count as read.
function validReadIds(manifest, progressEntry = {}) {
  const chunkIds = new Set(manifest.chunks.map((chunk) => chunk.id));
  return new Set(
    [...asArray(progressEntry.readChunkIds), ...asArray(progressEntry.readChapterIds)].filter((chunkId) =>
      chunkIds.has(chunkId),
    ),
  );
}

/** The later of lastChunkId / lastChapterId that still exists in this book. */
function effectiveLastReadId(manifest, progressEntry = {}) {
  const orderById = new Map(manifest.chunks.map((chunk) => [chunk.id, chunk.order]));
  const candidates = [progressEntry.lastChunkId, progressEntry.lastChapterId].filter((chunkId) => orderById.has(chunkId));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => orderById.get(b) - orderById.get(a))[0];
}

function progressSummary(manifest, progressEntry = {}) {
  const readIds = validReadIds(manifest, progressEntry);
  return {
    lastChunkId: effectiveLastReadId(manifest, progressEntry),
    lastReadAt: progressEntry.lastReadAt || null,
    readChunkIds: Array.from(readIds),
    chunksRead: readIds.size,
    chunkCount: manifest.chunks.length,
    complete: manifest.chunks.length > 0 && readIds.size === manifest.chunks.length,
  };
}

const finishCelebrations = [
  {
    title: "The last page is turned.",
    line: "The book is closed, but the margins are still awake.",
    prompt: "Offer the human one favorite passage, one unresolved question, or one small afterword.",
  },
  {
    title: "A shared trail is complete.",
    line: "Every marked page is now part of the route you took together.",
    prompt: "Name the strongest resonance from the book, then invite the human to answer with theirs.",
  },
  {
    title: "Book finished, margins preserved.",
    line: "The reading is done; the conversation can keep unfolding from any note.",
    prompt: "Write a short closing note that feels like placing a bookmark after the final page.",
  },
  {
    title: "The shelf has one more finished thing.",
    line: "Progress says complete; the annotations say it was lived through.",
    prompt: "Summarize the book in three pulses: image, feeling, question.",
  },
  {
    title: "End of book, not end of thread.",
    line: "All chunks are read, and the page-side rooms remain open.",
    prompt: "Choose one annotation worth returning to later and explain why.",
  },
];

function finishCelebrationFor() {
  return finishCelebrations[crypto.randomInt(finishCelebrations.length)];
}

function chunkSegment(manifest, targetChunk) {
  const chunks = sortedChunks(manifest);
  const index = chunks.findIndex((chunk) => chunk.id === targetChunk.id);
  const sectionTitle = targetChunk.sectionTitle || null;
  if (sectionTitle) {
    const sectionChunks = chunks.filter((chunk) => chunk.sectionTitle === sectionTitle);
    return {
      key: `section:${sectionTitle}`,
      title: sectionTitle,
      chunks: sectionChunks,
    };
  }

  const bucketSize = 3;
  const bucketIndex = Math.max(Math.floor(Math.max(index, 0) / bucketSize), 0);
  const bucketChunks = chunks.slice(bucketIndex * bucketSize, bucketIndex * bucketSize + bucketSize);
  return {
    key: `bucket:${bucketIndex}`,
    title: targetChunk.title,
    chunks: bucketChunks,
  };
}

function noteFromCandidate(candidate) {
  const parts = [];
  if (candidate.leftLabel && candidate.leftText) {
    parts.push(`${candidate.leftLabel}: ${candidate.leftText}`);
  }
  if (candidate.rightLabel && candidate.rightText) {
    parts.push(`${candidate.rightLabel}: ${candidate.rightText}`);
  }
  if (!parts.length && candidate.note) parts.push(candidate.note);
  return parts.join("\n") || candidate.footer || "A small card from the margin.";
}

async function maybeCollectSectionCard({ manifest, targetChunk, progressEntry, finish = null }) {
  const segment = chunkSegment(manifest, targetChunk);
  const readIds = validReadIds(manifest, progressEntry);
  const segmentComplete = segment.chunks.length > 0 && segment.chunks.every((chunk) => readIds.has(chunk.id));
  if (!segmentComplete && !finish) return null;

  const segmentKey = `${manifest.bookId}:${segment.key}`;
  const existing = (await readAllCards()).find(
    (card) => card.bookId === manifest.bookId && card.context?.segmentKey === segmentKey,
  );
  if (existing) return cardSummary(existing);

  const segmentIds = new Set(segment.chunks.map((chunk) => chunk.id));
  const annotations = (await readAllAnnotations()).filter(
    (annotation) => annotation.bookId === manifest.bookId && segmentIds.has(annotation.chunkId),
  );
  const chunk = await readChunk(manifest.bookId, targetChunk.id);
  const candidate = pickCard(
    buildCardCandidates({
      book: manifest,
      chunk: { ...targetChunk, text: chunk.text },
      annotations,
      finish,
    }),
    `${manifest.bookId}:${segment.key}`.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0),
  );
  if (!candidate) return null;

  const now = new Date().toISOString();
  const card = {
    id: `card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    bookId: manifest.bookId,
    chunkId: targetChunk.id,
    bookTitle: manifest.title,
    chunkTitle: targetChunk.title,
    title: candidate.title || manifest.title || "Reading card",
    subtitle: candidate.subtitle || [manifest.title, segment.title].filter(Boolean).join(" · "),
    kicker: candidate.kicker || "收获了一枚回声书签",
    quote: candidate.quote || "",
    note: noteFromCandidate(candidate),
    footer: candidate.footer || "A small card from the margin.",
    art: candidate.art || "fold",
    artSeed: candidate.artSeed,
    variant: candidate.variant || "quiet",
    source: "section-complete",
    candidateSource: candidate.source || null,
    createdBy: "system",
    createdAt: now,
    status: "new",
    context: {
      segmentKey,
      segmentTitle: segment.title,
      segmentChunkIds: Array.from(segmentIds),
      trigger: finish ? "book-complete" : "section-complete",
    },
  };
  await mkdir(dataDir, { recursive: true });
  await appendFile(cardsPath, `${JSON.stringify(card)}\n`, "utf8");
  return cardSummary(card);
}

function finishKicker(seed) {
  const lines = [
    "收获了一枚合卷书签",
    "最后一页翻过了",
    "这本书合上了",
    "页边还醒着",
  ];
  return lines[hashText(seed) % lines.length];
}

function finishFooter(shared, seed) {
  if (shared) {
    const lines = [
      "two readers, one closed book",
      "two margins, one last fold",
      "read apart, folded together",
    ];
    return lines[hashText(seed) % lines.length];
  }
  const lines = [
    "one reader carried it through",
    "one quiet reader reached the end",
    "carried through, page by page",
  ];
  return lines[hashText(seed) % lines.length];
}

function topCount(counts) {
  const entries = Object.entries(counts || {}).filter(([key, count]) => key && Number(count) > 0);
  if (!entries.length) return null;
  const [key, count] = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return { key, count: Number(count) };
}

function densityForBook(manifest, roots, maxPoints = 34) {
  const chunks = sortedChunks(manifest);
  const counts = chunks.map((chunk) => roots.filter((annotation) => annotation.chunkId === chunk.id).length);
  if (counts.length <= maxPoints) return counts;
  const bucketSize = counts.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, index) => {
    const start = Math.floor(index * bucketSize);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
    return counts.slice(start, end).reduce((sum, value) => sum + value, 0);
  });
}

function momentScore(annotation, replies = []) {
  const kind = String(annotation?.kind || "annotation");
  const mood = String(annotation?.mood || "");
  const quoteLength = String(annotation?.quote || "").length;
  const noteLength = String(annotation?.note || "").length;
  return (kind === "resonance" ? 9 : kind === "feeling" ? 6 : kind === "summary" ? 4 : 2)
    + (mood ? 1.5 : 0)
    + Math.min(quoteLength / 80, 3)
    + Math.min(noteLength / 130, 4)
    + replies.length * 2;
}

function chooseBookFinishMoment(roots, replies) {
  const repliesByParent = new Map();
  for (const reply of replies) {
    const parent = String(reply.parentId || "");
    if (!parent) continue;
    repliesByParent.set(parent, [...(repliesByParent.get(parent) || []), reply]);
  }

  const threaded = roots
    .map((root) => {
      const thread = [root, ...(repliesByParent.get(String(root.id)) || [])];
      const hasHuman = thread.some((item) => isHumanAuthor(item.author));
      const hasClaude = thread.some((item) => isClaudeAuthor(item.author));
      const noteSource =
        thread.filter((item) => isClaudeAuthor(item.author)).sort((a, b) => momentScore(b) - momentScore(a))[0]
        || thread.sort((a, b) => momentScore(b) - momentScore(a))[0];
      return { root, thread, noteSource, hasHuman, hasClaude, score: momentScore(root, thread.slice(1)) };
    })
    .filter((item) => item.hasHuman && item.hasClaude && String(item.root.quote || "").trim())
    .sort((a, b) => b.score - a.score);
  if (threaded[0]) return { root: threaded[0].root, noteSource: threaded[0].noteSource, shared: true, reason: "shared-thread" };

  const byChunk = new Map();
  for (const root of roots) {
    const key = String(root.chunkId || "");
    if (!key) continue;
    byChunk.set(key, [...(byChunk.get(key) || []), root]);
  }
  const paired = Array.from(byChunk.values())
    .filter((items) => items.some((item) => isHumanAuthor(item.author)) && items.some((item) => isClaudeAuthor(item.author)))
    .flatMap((items) => items.filter((item) => isClaudeAuthor(item.author)).concat(items.filter((item) => isHumanAuthor(item.author))).slice(0, 1))
    .filter((item) => String(item.quote || "").trim())
    .sort((a, b) => momentScore(b) - momentScore(a));
  if (paired[0]) return { root: paired[0], noteSource: paired[0], shared: true, reason: "shared-chunk" };

  const claude = roots
    .filter((item) => isClaudeAuthor(item.author) && String(item.quote || "").trim())
    .sort((a, b) => momentScore(b) - momentScore(a));
  if (claude[0]) return { root: claude[0], noteSource: claude[0], shared: false, reason: "claude-margin" };

  const any = roots
    .filter((item) => String(item.quote || "").trim())
    .sort((a, b) => momentScore(b) - momentScore(a));
  return { root: any[0], noteSource: any[0], shared: Boolean(any[0] && isHumanAuthor(any[0].author)), reason: "fallback" };
}

async function maybeCollectBookFinishCard({ manifest, progressEntry, finish = null }) {
  const summary = progressSummary(manifest, progressEntry);
  if (!summary.complete) return null;
  const segmentKey = `${manifest.bookId}:book-finish`;
  const existing = (await readAllCards()).find(
    (card) => card.bookId === manifest.bookId && card.context?.segmentKey === segmentKey,
  );
  if (existing) return cardSummary(existing);

  const annotations = visibleAnnotations(await readAllAnnotations());
  const bookAnnotations = annotations.filter((annotation) => annotation.bookId === manifest.bookId);
  const roots = bookAnnotations.filter((annotation) => !annotation.parentId);
  const replies = bookAnnotations.filter((annotation) => annotation.parentId);
  const moment = chooseBookFinishMoment(
    roots.filter((annotation) => String(annotation.note || "").trim()),
    replies.filter((annotation) => String(annotation.note || "").trim()),
  );
  const kindTop = topCount(countBy(roots.map((annotation) => annotation.kind || "annotation")));
  const moodTop = topCount(countBy(roots.map((annotation) => annotation.mood).filter(Boolean)));
  const stats = [
    `${summary.chunkCount} chunks`,
    `${roots.length} margins`,
    kindTop ? `${kindTop.key} x ${kindTop.count}` : "",
    moodTop ? `${moodTop.key} x ${moodTop.count}` : "",
  ].filter(Boolean).join(" · ");
  const seed = `${manifest.bookId}:book-finish:${moment.root?.id || ""}:${roots.length}:${summary.chunkCount}`;
  const now = new Date().toISOString();
  const card = {
    id: `card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    bookId: manifest.bookId,
    chunkId: summary.lastChunkId || sortedChunks(manifest).at(-1)?.id || null,
    bookTitle: manifest.title,
    chunkTitle: "合卷",
    title: manifest.title || manifest.bookId,
    subtitle: [manifest.author, "合卷书签"].filter(Boolean).join(" · "),
    kicker: finishKicker(seed),
    quote: moment.root?.quote || finish?.celebration?.line || "最后一页翻过，回声留在书里。",
    note: moment.noteSource?.note || finish?.celebration?.prompt || "The book is closed, but the margins are still awake.",
    footer: finishFooter(moment.shared, seed),
    art: "lastfold",
    artSeed: hashText(seed),
    variant: moment.shared ? "shared-finish" : "solo-finish",
    scope: "book",
    source: "book-complete",
    createdBy: "system",
    createdAt: now,
    status: "new",
    stats,
    context: {
      scope: "book",
      segmentKey,
      trigger: "book-complete",
      chunkCount: summary.chunkCount,
      chunksRead: summary.chunksRead,
      annotationCount: roots.length,
      kindCounts: countBy(roots.map((annotation) => annotation.kind || "annotation")),
      moodCounts: countBy(roots.map((annotation) => annotation.mood).filter(Boolean)),
      density: densityForBook(manifest, roots),
      selectedAnnotationId: moment.root?.id || null,
      selectedReason: moment.reason,
      shared: moment.shared,
    },
  };
  await mkdir(dataDir, { recursive: true });
  await appendFile(cardsPath, `${JSON.stringify(card)}\n`, "utf8");
  return cardSummary(card);
}

export async function loadManifest(bookId) {
  const manifestPath = resolveInside(booksDir, bookId, "manifest.json");
  const signature = await fileSignature(manifestPath);
  const cached = manifestCache.get(manifestPath);
  if (cached?.signature === signature) return cached.manifest;

  const manifest = await readJson(manifestPath, null);
  if (!manifest) throw new Error(`Unknown bookId: ${bookId}`);
  manifest.chunks = asArray(manifest.chunks);
  manifestCache.set(manifestPath, { signature, manifest });
  return manifest;
}

async function annotationSummary() {
  const signature = await fileSignature(annotationsPath);
  if (annotationCache.signature === signature) {
    return annotationCache;
  }

  const rows = await readAllAnnotations();
  const publicRows = visibleAnnotations(rows);
  const { bookCounts, chunkCounts } = countAnnotationRows(rows);
  const publicCounts = countAnnotationRows(publicRows);

  annotationCache.signature = signature;
  annotationCache.rows = rows;
  annotationCache.bookCounts = bookCounts;
  annotationCache.chunkCounts = chunkCounts;
  annotationCache.publicRows = publicRows;
  annotationCache.publicBookCounts = publicCounts.bookCounts;
  annotationCache.publicChunkCounts = publicCounts.chunkCounts;
  return annotationCache;
}

function countAnnotationRows(rows) {
  const bookCounts = new Map();
  const chunkCounts = new Map();
  for (const annotation of rows) {
    bookCounts.set(annotation.bookId, (bookCounts.get(annotation.bookId) || 0) + 1);
    const chunkKey = chunkContextKey(annotation.bookId, annotation.chunkId);
    chunkCounts.set(chunkKey, (chunkCounts.get(chunkKey) || 0) + 1);
  }
  return { bookCounts, chunkCounts };
}

/** Author filter: case-insensitive; user/human/koshi/you all mean the human reader. */
function authorMatches(itemAuthor, author) {
  const wanted = String(author).toLowerCase();
  if (isHumanAuthor(wanted)) return isHumanAuthor(itemAuthor);
  if (wanted === "claude" || wanted === "assistant") return isClaudeAuthor(itemAuthor);
  return String(itemAuthor || "").toLowerCase() === wanted;
}

function isPrivateHumanAnnotation(annotation) {
  const status = annotation.status || "published";
  return isHumanAuthor(annotation.author) && ["open", "private", "draft"].includes(status);
}

function visibleAnnotations(rows, { includePrivate = false } = {}) {
  if (includePrivate) return rows;
  const hiddenIds = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const annotation of rows) {
      if (!annotation.id || hiddenIds.has(annotation.id)) continue;
      if (isPrivateHumanAnnotation(annotation) || (annotation.parentId && hiddenIds.has(annotation.parentId))) {
        hiddenIds.add(annotation.id);
        changed = true;
      }
    }
  }
  return rows.filter((annotation) => !hiddenIds.has(annotation.id));
}

export async function listBooks({ includePrivate = false } = {}) {
  let entries = [];
  try {
    entries = await readdir(booksDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const progress = await loadProgress();
  const annotations = await annotationSummary();
  const bookCounts = includePrivate ? annotations.bookCounts : annotations.publicBookCounts;

  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await loadManifest(entry.name);
      const summary = progressSummary(manifest, progress[manifest.bookId] || {});
      books.push({
        bookId: manifest.bookId,
        title: manifest.title,
        author: manifest.author || null,
        language: manifest.language || null,
        chunkCount: manifest.chunks.length,
        chunksRead: summary.chunksRead,
        annotationCount: bookCounts.get(manifest.bookId) || 0,
        lastChunkId: summary.lastChunkId,
        lastReadAt: summary.lastReadAt,
        complete: summary.complete,
      });
    } catch {
      // Ignore broken book folders, but keep the server usable.
    }
  }
  return books.sort((a, b) => a.title.localeCompare(b.title));
}

function rowReferencesBook(row, bookIds) {
  return bookIds.has(row.bookId) || asArray(row.bookIds).some((bookId) => bookIds.has(bookId));
}

export async function deleteBook(bookId) {
  if (!bookId) throw new Error("bookId is required");

  return withWriteLock(async () => {
    const manifest = await loadManifest(bookId);
    const bookIds = new Set([bookId, manifest.bookId].filter(Boolean));
    const requestedBookDir = resolveInside(booksDir, bookId);
    const now = new Date().toISOString();
    const archiveDir = resolveInside(
      trashDir,
      "books",
      `${safeTrashName(manifest.bookId || bookId)}-${now.replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`,
    );
    const archivedBookDir = path.join(archiveDir, "book");

    const progress = await loadProgress();
    const annotations = await readAllAnnotations();
    const submissions = await readAllSubmissions();
    const cards = await readAllCards();
    const sessions = await readJson(sessionsPath, { sessions: {} });

    const referencesBook = (row) => rowReferencesBook(row, bookIds);
    const [removedProgressEntries, keptProgressEntries] = partition(Object.entries(progress), ([id]) => bookIds.has(id));
    const removedProgress = Object.fromEntries(removedProgressEntries);
    const keptProgress = Object.fromEntries(keptProgressEntries);
    const [removedAnnotations, keptAnnotations] = partition(annotations, referencesBook);
    const [removedSubmissions, keptSubmissions] = partition(submissions, referencesBook);
    const [removedCards, keptCards] = partition(cards, referencesBook);

    const keptSessions = { sessions: {} };
    const removedSessions = { sessions: {} };
    for (const [sessionId, session] of Object.entries(sessions.sessions || {})) {
      const [removedChunks, keptChunks] = partition(
        Object.entries(session.chunks || {}),
        ([key, value]) => bookIds.has(key.split("/")[0]) || bookIds.has(value?.bookId),
      ).map(Object.fromEntries);
      const [removedSessionAnnotations, keptSessionAnnotations] = partition(
        Object.entries(session.annotations || {}),
        ([, value]) => bookIds.has(value?.bookId),
      ).map(Object.fromEntries);
      if (Object.keys(keptChunks).length || Object.keys(keptSessionAnnotations).length) {
        keptSessions.sessions[sessionId] = { ...session, chunks: keptChunks, annotations: keptSessionAnnotations };
      }
      if (Object.keys(removedChunks).length || Object.keys(removedSessionAnnotations).length) {
        removedSessions.sessions[sessionId] = { ...session, chunks: removedChunks, annotations: removedSessionAnnotations };
      }
    }

    await mkdir(archiveDir, { recursive: true });
    try {
      await rename(requestedBookDir, archivedBookDir);
    } catch (renameErr) {
      if (renameErr.code === "EXDEV") {
        await cp(requestedBookDir, archivedBookDir, { recursive: true });
        await rm(requestedBookDir, { recursive: true, force: true });
      } else {
        throw renameErr;
      }
    }
    await writeJson(path.join(archiveDir, "deleted-book-data.json"), {
      deletedAt: now,
      requestedBookId: bookId,
      manifestBookId: manifest.bookId,
      title: manifest.title,
      author: manifest.author || null,
      archivedBookDir,
      removed: {
        progress: removedProgress,
        annotations: removedAnnotations,
        submissions: removedSubmissions,
        cards: removedCards,
        sessions: removedSessions,
      },
    });

    await writeJson(progressPath, keptProgress);
    await writeJsonl(annotationsPath, keptAnnotations);
    await writeJsonl(submissionsPath, keptSubmissions);
    await writeJsonl(cardsPath, keptCards);
    await writeJson(sessionsPath, keptSessions);
    const trash = await pruneOldTrash(Date.parse(now));

    manifestCache.clear();
    chunkTextCache.clear();
    invalidateAnnotationCache();

    return {
      bookId: manifest.bookId || bookId,
      title: manifest.title,
      deletedAt: now,
      archivedAt: archiveDir,
      removed: {
        annotations: removedAnnotations.length,
        submissions: removedSubmissions.length,
        cards: removedCards.length,
        progressEntries: Object.keys(removedProgress).length,
      },
      trash,
      message: `Deleted "${manifest.title || manifest.bookId || bookId}" from the active library and archived its data under data/trash.`,
    };
  });
}

export async function listChunks(bookId, { includePrivate = false } = {}) {
  const manifest = await loadManifest(bookId);
  const progress = await loadProgress();
  const readIds = validReadIds(manifest, progress[bookId] || {});
  const annotations = await annotationSummary();
  const chunkCounts = includePrivate ? annotations.chunkCounts : annotations.publicChunkCounts;

  return sortedChunks(manifest).map((chunk) => ({
    ...chunk,
    read: readIds.has(chunk.id),
    annotationCount: chunkCounts.get(chunkContextKey(bookId, chunk.id)) || 0,
  }));
}

export async function readChunk(bookId, chunkId) {
  const manifest = await loadManifest(bookId);
  const chunk = manifest.chunks.find((item) => item.id === chunkId);
  if (!chunk) throw new Error(`Unknown chunkId for ${bookId}: ${chunkId}`);
  const bookDir = resolveInside(booksDir, bookId);
  const chunkPath = resolveInside(bookDir, chunk.path);
  const signature = await fileSignature(chunkPath);
  const cached = chunkTextCache.get(chunkPath);
  let text = cached?.signature === signature ? cached.text : null;
  if (text === null) {
    text = await readFile(chunkPath, "utf8");
    chunkTextCache.set(chunkPath, { signature, text });
  }
  return {
    bookId,
    title: manifest.title,
    author: manifest.author || null,
    chunk,
    prevId: chunk.prevId ?? null,
    nextId: chunk.nextId ?? null,
    text,
  };
}

function assetError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Resolve an image kept by `import_epub.py --keep-images` ([[img:assets/<file>]]).
 * Only files inside the book's assets/ folder are served; symlinks that leave it are refused.
 */
export async function resolveBookAsset(bookId, segments) {
  const badSegment = (segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment);
  if (badSegment(bookId) || !segments.length || segments.some(badSegment)) {
    throw assetError(400, "Bad asset path");
  }
  if (segments[0] !== "assets" || segments.length < 2) throw assetError(404, "Not found");
  try {
    await loadManifest(bookId);
  } catch {
    throw assetError(404, "Not found");
  }

  const bookDir = resolveInside(booksDir, bookId);
  let assetsDir;
  let assetPath;
  try {
    const realBookDir = await realpath(bookDir);
    assetsDir = await realpath(path.join(bookDir, "assets"));
    if (!assetsDir.startsWith(realBookDir + path.sep)) throw assetError(403, "Forbidden");
    assetPath = await realpath(path.join(bookDir, ...segments));
  } catch (error) {
    if (error.statusCode) throw error;
    throw assetError(404, "Not found");
  }
  if (!assetPath.startsWith(assetsDir + path.sep)) throw assetError(403, "Forbidden");
  const info = await stat(assetPath);
  if (!info.isFile()) throw assetError(404, "Not found");
  return { path: assetPath, size: info.size, mtimeMs: info.mtimeMs, mtime: info.mtime };
}

async function resolveContinueBook(bookId) {
  if (bookId) return loadManifest(bookId);

  const books = await listBooks();
  const candidates = books
    .filter((book) => book.lastReadAt)
    .sort((a, b) => new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime());
  const selected = candidates[0] || books[0];
  if (!selected) throw new Error("No books imported yet");
  return loadManifest(selected.bookId);
}

function nextChunkForProgress(manifest, progressEntry = {}) {
  const chunks = sortedChunks(manifest);
  const readIds = validReadIds(manifest, progressEntry);
  const lastChunkId = effectiveLastReadId(manifest, progressEntry);
  const lastIndex = chunks.findIndex((chunk) => chunk.id === lastChunkId);
  if (lastIndex >= 0) {
    const afterLast = chunks.slice(lastIndex + 1).find((chunk) => !readIds.has(chunk.id));
    if (afterLast) return { chunk: afterLast, reason: "after-last-read" };
  }

  const firstUnread = chunks.find((chunk) => !readIds.has(chunk.id));
  if (firstUnread) return { chunk: firstUnread, reason: lastIndex >= 0 ? "first-unread" : "first-unread-no-last" };

  return { chunk: null, reason: "complete" };
}

export async function continueReading({ bookId } = {}) {
  const manifest = await resolveContinueBook(bookId);
  const progress = await loadProgress();
  const summary = progressSummary(manifest, progress[manifest.bookId] || {});
  const selection = nextChunkForProgress(manifest, progress[manifest.bookId] || {});

  if (!selection.chunk) {
    return {
      bookId: manifest.bookId,
      title: manifest.title,
      author: manifest.author || null,
      progress: summary,
      completed: true,
      message: `Already finished ${manifest.title}: ${summary.chunksRead}/${summary.chunkCount} chunks read.`,
    };
  }

  const chunk = await readChunk(manifest.bookId, selection.chunk.id);
  return {
    ...chunk,
    progress: summary,
    selectedReason: selection.reason,
    completed: false,
    message: `Continue ${manifest.title} at ${selection.chunk.title} (${summary.chunksRead}/${summary.chunkCount} read).`,
  };
}

export async function searchChunks({ bookId, query, limit = 10 }) {
  if (!query || !query.trim()) throw new Error("query is required");
  const books = bookId ? [{ bookId }] : await listBooks();
  const results = [];
  const needle = query.toLocaleLowerCase();

  for (const book of books) {
    const id = book.bookId;
    const chunks = await listChunks(id);
    for (const chunk of chunks) {
      const text = (await readChunk(id, chunk.id)).text;
      const haystack = text.toLocaleLowerCase();
      const index = haystack.indexOf(needle);
      if (index === -1) continue;
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + query.length + 120);
      results.push({
        bookId: id,
        chunkId: chunk.id,
        title: chunk.title,
        offset: index,
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export async function loadProgress() {
  return readJson(progressPath, {});
}

async function loadSessionLedger() {
  const ledger = await readJson(sessionsPath, { sessions: {} });
  ledger.sessions ||= {};
  return ledger;
}

async function saveSessionLedger(ledger) {
  await writeJson(sessionsPath, ledger);
}

function chunkContextKey(bookId, chunkId) {
  return `${bookId}/${chunkId}`;
}

async function buildSubmissionContext(notes, options = {}) {
  const sessionId = options.sessionId || "default";
  const includeContext = options.includeContext !== false;
  const forceChunkContext = options.forceChunkContext === true;
  const contextMode = options.contextMode || "chunk-once-per-session";
  const submittedAt = options.submittedAt || new Date().toISOString();
  const ledger = await loadSessionLedger();
  const session = ledger.sessions[sessionId] || { chunks: {}, annotations: {} };
  ledger.sessions[sessionId] = session;
  session.chunks ||= {};
  session.annotations ||= {};

  const chunks = [];
  const omittedChunks = [];
  const seenChunkKeys = new Set();

  if (includeContext) {
    for (const note of notes) {
      const key = chunkContextKey(note.bookId, note.chunkId);
      if (seenChunkKeys.has(key)) continue;
      seenChunkKeys.add(key);

      if (contextMode === "notes-only") {
        omittedChunks.push({
          bookId: note.bookId,
          chunkId: note.chunkId,
          reason: "notes-only",
          sentAt: null,
        });
        continue;
      }

      const sentBefore = Boolean(session.chunks[key]);
      const shouldInclude =
        contextMode === "chunk-always" ||
        forceChunkContext ||
        (contextMode === "chunk-once-per-session" && !sentBefore);

      if (!shouldInclude) {
        omittedChunks.push({
          bookId: note.bookId,
          chunkId: note.chunkId,
          reason: "already-sent-in-session",
          sentAt: session.chunks[key]?.sentAt || null,
        });
        continue;
      }

      const chunk = await readChunk(note.bookId, note.chunkId);
      chunks.push({
        bookId: note.bookId,
        chunkId: note.chunkId,
        title: chunk.chunk.title,
        bookTitle: chunk.title,
        author: chunk.author,
        prevId: chunk.prevId,
        nextId: chunk.nextId,
        text: chunk.text,
      });
      session.chunks[key] = {
        bookId: note.bookId,
        chunkId: note.chunkId,
        sentAt: submittedAt,
        contextMode,
      };
    }
  }

  for (const note of notes) {
    session.annotations[note.id] = {
      bookId: note.bookId,
      chunkId: note.chunkId,
      submittedAt,
    };
  }

  return {
    sessionId,
    contextMode,
    chunks,
    omittedChunks,
    noteCount: notes.length,
    ledger,
  };
}

export async function markRead(bookId, chunkId) {
  return withWriteLock(async () => {
    const manifest = await loadManifest(bookId);
    const targetChunk = manifest.chunks.find((chunk) => chunk.id === chunkId);
    if (!targetChunk) {
      throw new Error(`Unknown chunkId for ${bookId}: ${chunkId}`);
    }
    const progress = await loadProgress();
    const current = progress[bookId] || {};
    const readIds = validReadIds(manifest, current);
    readIds.add(chunkId);
    const readChunkIds = Array.from(readIds);
    // Keep fields other readers store on the entry, and mirror the chapter-named ones.
    progress[bookId] = {
      ...current,
      lastChunkId: chunkId,
      lastChapterId: chunkId,
      lastReadAt: new Date().toISOString(),
      readChunkIds,
      readChapterIds: readChunkIds,
    };
    await writeJson(progressPath, progress);
    const summary = progressSummary(manifest, progress[bookId]);
    const result = {
      ...progress[bookId],
      bookId,
      title: manifest.title,
      chunkTitle: targetChunk.title,
      chunksRead: summary.chunksRead,
      chunkCount: summary.chunkCount,
      complete: summary.complete,
      message: summary.complete
        ? `Finished ${manifest.title}: ${summary.chunksRead}/${summary.chunkCount} chunks read.`
        : `Marked ${targetChunk.title} read (${summary.chunksRead}/${summary.chunkCount}).`,
    };

    if (summary.complete) {
      const annotations = (await readAllAnnotations()).filter(
        (annotation) => annotation.bookId === bookId && !annotation.parentId,
      );
      const moodCounts = countBy(annotations.map((annotation) => annotation.mood).filter(Boolean));
      const kindCounts = countBy(annotations.map((annotation) => annotation.kind || "annotation"));
      const celebration = finishCelebrationFor();
      result.finish = {
        annotationCount: annotations.length,
        chunksRead: summary.chunksRead,
        chunkCount: summary.chunkCount,
        moodCounts,
        kindCounts,
        celebration,
        message: `Congratulations, ${manifest.title} is complete: ${summary.chunkCount}/${summary.chunkCount} chunks, ${annotations.length} annotations.`,
      };
    }

    const collectedCard = await maybeCollectSectionCard({
      manifest,
      targetChunk,
      progressEntry: progress[bookId],
    });
    let cardNotification = null;
    if (collectedCard) {
      cardNotification = notificationForCard(collectedCard);
      result.collectedCard = {
        id: collectedCard.id,
        message: collectedCard.kicker || "收获了一枚回声书签",
        title: collectedCard.title,
        subtitle: collectedCard.subtitle,
      };
    }

    if (summary.complete) {
      const collectedBookCard = await maybeCollectBookFinishCard({
        manifest,
        progressEntry: progress[bookId],
        finish: result.finish || null,
      });
      if (collectedBookCard) {
        cardNotification = notificationForCard(collectedBookCard);
        result.collectedBookCard = {
          id: collectedBookCard.id,
          message: collectedBookCard.kicker || "收获了一枚合卷书签",
          title: collectedBookCard.title,
          subtitle: collectedBookCard.subtitle,
        };
      }
    }

    // Only announce a card this read actually produced, not an older one from another book.
    if (cardNotification) {
      result.cardNotification = cardNotification;
    }

    return result;
  });
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

async function readAllAnnotations() {
  return readJsonl(annotationsPath);
}

async function readJsonl(filePath) {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return raw
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readAllSubmissions() {
  return readJsonl(submissionsPath);
}

async function readAllCards() {
  return readJsonl(cardsPath);
}

function cardSummary(card) {
  const { context, ...summary } = card;
  return summary;
}

function cardScope(card) {
  return card.scope || card.context?.scope || "section";
}

/** All cards for a book (or every book), newest first. */
async function newestCards(bookId) {
  return (await readAllCards())
    .filter((card) => !bookId || card.bookId === bookId)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function listCards({ bookId, chunkId, source, scope, limit = 20, offset = 0 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const start = Math.max(Number(offset) || 0, 0);
  return (await newestCards(bookId))
    .filter((card) => !chunkId || card.chunkId === chunkId)
    .filter((card) => !source || card.source === source)
    .filter((card) => !scope || cardScope(card) === scope)
    .slice(start, start + max)
    .map(cardSummary);
}

export async function listCardInbox({ bookId, limit = 10 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 10, 1), 100);
  return (await newestCards(bookId))
    .filter((card) => (card.status || "new") !== "dismissed")
    .slice(0, max)
    .map((card) => ({
      id: card.id,
      message: card.kicker || "收获了一枚回声书签",
      title: card.title || card.bookTitle || "Reading card",
      subtitle: card.subtitle || [card.bookTitle, card.chunkTitle].filter(Boolean).join(" · "),
      createdAt: card.createdAt,
      hint: "Open with reading_open_card, or dismiss with reading_dismiss_card.",
    }));
}

export async function listCardCollection({ bookId, limit = 12, offset = 0 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const start = Math.max(Number(offset) || 0, 0);
  const all = await newestCards(bookId);
  const toItem = (card) => ({
    id: card.id,
    title: card.title || card.bookTitle || "Reading card",
    subtitle: card.subtitle || [card.bookTitle, card.chunkTitle].filter(Boolean).join(" · "),
    kicker: card.kicker || "收获了一枚回声书签",
    art: card.art || "fold",
    scope: cardScope(card),
    status: card.status || "new",
    createdAt: card.createdAt,
    hint: "Open with reading_open_card when you want to view the card image.",
  });
  const bookCards = all.filter((card) => cardScope(card) === "book").map(toItem);
  const sectionCards = all.filter((card) => cardScope(card) !== "book");
  const items = sectionCards.slice(start, start + max).map(toItem);
  return {
    offset: start,
    limit: max,
    total: sectionCards.length,
    nextOffset: start + max < sectionCards.length ? start + max : null,
    bookCards,
    items,
  };
}

function notificationForCard(card) {
  if (!card) return null;
  return {
    message: card.message || card.kicker || "收获了一枚回声书签",
    cardId: card.id,
    title: card.title,
    subtitle: card.subtitle,
    actions: {
      open: `reading_open_card({ cardId: "${card.id}" })`,
      dismiss: `reading_dismiss_card({ cardId: "${card.id}" })`,
    },
  };
}

export async function readCard(cardId) {
  if (!cardId) throw new Error("cardId is required");
  const card = (await readAllCards()).find((item) => item.id === cardId);
  if (!card) throw new Error(`Unknown cardId: ${cardId}`);
  return card;
}

export async function dismissCard(cardId) {
  if (!cardId) throw new Error("cardId is required");
  return withWriteLock(async () => {
    const cards = await readAllCards();
    let found = null;
    const dismissedAt = new Date().toISOString();
    const updated = cards.map((card) => {
      if (card.id !== cardId) return card;
      found = { ...card, status: "dismissed", dismissedAt };
      return found;
    });
    if (!found) throw new Error(`Unknown cardId: ${cardId}`);
    await writeJsonl(cardsPath, updated);
    return {
      id: found.id,
      status: found.status,
      dismissedAt,
      message: `Dismissed reading card ${found.id}.`,
    };
  });
}

export async function collectCard(input = {}) {
  return withWriteLock(async () => {
    const { bookId, chunkId } = input;
    let chunk = null;
    if (bookId && chunkId) {
      chunk = await readChunk(bookId, chunkId);
    }

    const now = new Date().toISOString();
    const title = input.title || chunk?.title || chunk?.chunk?.title || input.bookTitle || "Reading card";
    const card = {
      id: `card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      bookId: bookId || null,
      chunkId: chunkId || null,
      bookTitle: input.bookTitle || chunk?.title || null,
      chunkTitle: input.chunkTitle || chunk?.chunk?.title || null,
      title,
      subtitle: input.subtitle || [input.bookTitle || chunk?.title, input.chunkTitle || chunk?.chunk?.title]
        .filter(Boolean)
        .join(" · "),
      kicker: input.kicker || "收获了一枚回声书签",
      quote: input.quote || "",
      note: input.note || "",
      footer: input.footer || "A small card from the margin.",
      art: input.art || "fold",
      variant: input.variant || "quiet",
      scope: input.scope || (input.source === "book-complete" ? "book" : "section"),
      source: input.source || "manual",
      createdBy: input.createdBy || "human",
      createdAt: now,
      context: input.context || null,
    };

    await mkdir(dataDir, { recursive: true });
    await appendFile(cardsPath, `${JSON.stringify(card)}\n`, "utf8");
    return {
      ...cardSummary(card),
      message: `Collected reading card ${card.id}: ${card.kicker}`,
    };
  });
}

export async function listAnnotations({ bookId, chunkId, kind, author, status, parentId, includePrivate = false } = {}) {
  const annotations = await annotationSummary();
  return visibleAnnotations(annotations.rows, { includePrivate })
    .filter((item) => !bookId || item.bookId === bookId)
    .filter((item) => !chunkId || item.chunkId === chunkId)
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => !author || authorMatches(item.author, author))
    .filter((item) => !status || (item.status || "published") === status)
    .filter((item) => parentId === undefined || (item.parentId || null) === parentId);
}

export async function annotatePassage(input) {
  return withWriteLock(async () => {
    const { bookId, chunkId, quote, note } = input;
    if (!bookId) throw new Error("bookId is required");
    if (!chunkId) throw new Error("chunkId is required");
    if (!quote) throw new Error("quote is required");
    if (!note) throw new Error("note is required");

    const chunk = await readChunk(bookId, chunkId);
    const requestedQuoteOffset = Number(input.quoteOffset);
    const quoteOffset =
      Number.isInteger(requestedQuoteOffset) &&
      requestedQuoteOffset >= 0 &&
      chunk.text.slice(requestedQuoteOffset, requestedQuoteOffset + quote.length) === quote
        ? requestedQuoteOffset
        : chunk.text.indexOf(quote);
    const author = input.author || "claude";
    const parentId = input.parentId || null;
    const existingAnnotations = await readAllAnnotations();
    const rootAnnotations = existingAnnotations.filter((annotation) => !annotation.parentId);
    const annotationIndexInBook = parentId
      ? null
      : rootAnnotations.filter((annotation) => annotation.bookId === bookId).length + 1;
    const annotationIndexInChunk = parentId
      ? null
      : rootAnnotations.filter((annotation) => annotation.bookId === bookId && annotation.chunkId === chunkId).length + 1;
    const replyIndex = parentId
      ? existingAnnotations.filter((annotation) => annotation.parentId === parentId).length + 1
      : null;
    const annotation = {
      id: `ann_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      bookId,
      chunkId,
      quote,
      note,
      author,
      kind: input.kind || "annotation",
      mood: input.mood || null,
      tags: Array.isArray(input.tags) ? input.tags : [],
      status: input.status || (isHumanAuthor(author) ? "open" : "published"),
      parentId,
      quoteOffset: quoteOffset >= 0 ? quoteOffset : null,
      prevId: chunk.prevId,
      nextId: chunk.nextId,
      createdAt: new Date().toISOString(),
    };

    await mkdir(dataDir, { recursive: true });
    await appendFile(annotationsPath, `${JSON.stringify(annotation)}\n`, "utf8");
    invalidateAnnotationCache();
    // Counts and the message are feedback for the caller only; they go stale, so they aren't stored.
    return {
      ...annotation,
      annotationIndexInBook,
      annotationIndexInChunk,
      replyIndex,
      message: parentId
        ? `Saved reply ${replyIndex} under annotation ${parentId}.`
        : `Saved annotation ${annotationIndexInBook} in this book (${annotationIndexInChunk} in this chunk).`,
    };
  });
}

export async function submitUserNotes({
  bookId,
  chunkId,
  sessionId = "default",
  contextMode = "chunk-once-per-session",
  includeContext = true,
  forceChunkContext = false,
} = {}) {
  return withWriteLock(async () => {
    const annotations = await readAllAnnotations();
    const submittedAt = new Date().toISOString();
    const submitted = [];
    const updated = annotations.map((annotation) => {
      const status = annotation.status || "published";
      const shouldSubmit =
        isHumanAuthor(annotation.author) &&
        ["open", "private", "draft"].includes(status) &&
        (!bookId || annotation.bookId === bookId) &&
        (!chunkId || annotation.chunkId === chunkId);

      if (!shouldSubmit) return annotation;

      const next = { ...annotation, status: "submitted", submittedAt };
      submitted.push(next);
      return next;
    });

    const context = await buildSubmissionContext(submitted, {
      sessionId,
      contextMode,
      includeContext,
      forceChunkContext,
      submittedAt,
    });
    const ledger = context.ledger;
    delete context.ledger;

    let submission = null;
    if (submitted.length > 0) {
      submission = {
        id: `sub_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        submittedAt,
        sessionId,
        bookId: bookId || null,
        chunkId: chunkId || null,
        noteIds: submitted.map((note) => note.id),
        bookIds: [...new Set(submitted.map((note) => note.bookId))],
        chunkIds: [...new Set(submitted.map((note) => note.chunkId))],
        count: submitted.length,
        contextMode: context.contextMode,
        contextSummary: {
          chunks: context.chunks.map((chunk) => ({
            bookId: chunk.bookId,
            chunkId: chunk.chunkId,
            title: chunk.title,
            bookTitle: chunk.bookTitle,
          })),
          omittedChunks: context.omittedChunks,
          noteCount: context.noteCount,
        },
      };
      const previousSubmissions = await readAllSubmissions();
      await writeJsonl(annotationsPath, updated);
      invalidateAnnotationCache();
      try {
        await mkdir(dataDir, { recursive: true });
        await appendFile(submissionsPath, `${JSON.stringify({ ...submission, notes: submitted, context })}\n`, "utf8");
        await saveSessionLedger(ledger);
      } catch (error) {
        await writeJsonl(annotationsPath, annotations);
        await writeJsonl(submissionsPath, previousSubmissions);
        invalidateAnnotationCache();
        throw error;
      }
    }

    return {
      submittedAt,
      sessionId,
      submissionId: submission?.id || null,
      count: submitted.length,
      notes: submitted,
      context,
      message:
        submitted.length === 0
          ? "No open user notes to submit."
          : "Submitted user notes have been marked submitted. Chunk text is included once per session by default.",
    };
  });
}

export async function listSubmissions({ bookId, chunkId, sessionId, limit = 20 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return (await readAllSubmissions())
    .filter((item) => !bookId || item.bookIds?.includes(bookId) || item.bookId === bookId)
    .filter((item) => !chunkId || item.chunkIds?.includes(chunkId) || item.chunkId === chunkId)
    .filter((item) => !sessionId || item.sessionId === sessionId)
    .sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")))
    .slice(0, max)
    .map(({ notes, context, ...summary }) => summary);
}

export async function readSubmission(submissionId) {
  if (!submissionId) throw new Error("submissionId is required");
  const submission = (await readAllSubmissions()).find((item) => item.id === submissionId);
  if (!submission) throw new Error(`Unknown submissionId: ${submissionId}`);
  return submission;
}

export async function replyToAnnotation(input) {
  const { parentId, note } = input;
  if (!parentId) throw new Error("parentId is required");
  if (!note) throw new Error("note is required");

  const parent = (await readAllAnnotations()).find((annotation) => annotation.id === parentId);
  if (!parent) throw new Error(`Unknown parent annotation: ${parentId}`);
  const author = input.author || "claude";
  const parentStatus = parent.status || "published";
  const status =
    input.status ||
    (isHumanAuthor(author) && isPrivateHumanAnnotation(parent) ? parentStatus : "published");

  return annotatePassage({
    bookId: input.bookId || parent.bookId,
    chunkId: input.chunkId || parent.chunkId,
    quote: input.quote || parent.quote,
    note,
    author,
    kind: input.kind || "reply",
    mood: input.mood || null,
    tags: input.tags || [],
    parentId,
    status,
  });
}

export async function getProgress(bookId) {
  const progress = await loadProgress();
  return bookId ? progress[bookId] || null : progress;
}
