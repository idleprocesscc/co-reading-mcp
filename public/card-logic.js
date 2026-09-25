const humanAuthors = new Set(["user", "human", "koshi", "you"]);

export const sharedBookmarkLines = [
  "这里有两个人的折痕。",
  "此处有回声。",
];

const quietChapterPatterns = [
  /^(contents?|table of contents|copyright|title page|cover|toc)$/i,
  /^(目录|版权页|书名页|封面|版权|目录页)$/,
  /(作者|译者).{0,4}(注|说明|按语|序)/,
  /(author|translator).{0,12}(note|preface|foreword)/i,
  /(acknowledg|appendix|bibliography|references)/i,
  /(致谢|附录|参考文献|索引|出版说明|译后记|后记|前言|序言)/,
];

export function isHumanAuthor(author) {
  return humanAuthors.has(String(author || "").toLowerCase());
}

export function isClaudeAuthor(author) {
  const value = String(author || "").toLowerCase();
  return !isHumanAuthor(value) && (!value || value === "claude" || value === "assistant");
}

export function normalizeForOverlap(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function compactText(value, max = 120) {
  // Cards can't show book images; keep a small mark where a [[img:...]] token was.
  const text = String(value || "")
    .replace(/\[\[img:[^\]\n]+\]\]/g, "▣")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

export function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function isLowSignalChunk(chunk = {}) {
  const title = String(chunk.title || chunk.id || "");
  const text = String(chunk.text || "");
  if (quietChapterPatterns.some((pattern) => pattern.test(title.trim()))) return true;
  if (text.replace(/\s+/g, "").length < 180) return true;
  return false;
}

export function quotesOverlap(left = "", right = "") {
  const a = normalizeForOverlap(left);
  const b = normalizeForOverlap(right);
  if (a.length < 8 || b.length < 8) return false;
  return a.includes(b) || b.includes(a);
}

export function rootAnnotations(annotations = []) {
  return annotations.filter((annotation) => !annotation.parentId && annotation.quote && annotation.note);
}

export function findSharedMoments(annotations = []) {
  const roots = rootAnnotations(annotations);
  const human = roots.filter((annotation) => isHumanAuthor(annotation.author));
  const claude = roots.filter((annotation) => isClaudeAuthor(annotation.author));
  const moments = [];
  for (const userNote of human) {
    for (const claudeNote of claude) {
      if (!quotesOverlap(userNote.quote, claudeNote.quote)) continue;
      const quote = userNote.quote.length <= claudeNote.quote.length ? userNote.quote : claudeNote.quote;
      moments.push({
        id: `${userNote.id}:${claudeNote.id}`,
        quote,
        userNote,
        claudeNote,
      });
    }
  }
  return moments;
}

export function sharedNoteIdSet(annotations = []) {
  const ids = new Set();
  for (const moment of findSharedMoments(annotations)) {
    ids.add(moment.userNote.id);
    ids.add(moment.claudeNote.id);
  }
  return ids;
}

export function buildCardCandidates({ book = {}, chunk = {}, annotations = [], finish = null } = {}) {
  const candidates = [];
  const shared = findSharedMoments(annotations);
  const lowSignal = isLowSignalChunk(chunk);
  for (const [index, moment] of shared.entries()) {
    candidates.push({
      id: `shared-${moment.id}-${index}`,
      variant: index % 2 === 0 ? "crease" : "echo",
      art: index % 2 === 0 ? "fold" : "ripple",
      artSeed: hashText(`${moment.userNote.id}:${moment.claudeNote.id}:${moment.quote}`),
      kicker: index % 2 === 0 ? sharedBookmarkLines[0] : sharedBookmarkLines[1],
      title: "Shared Margin",
      subtitle: [book.title, chunk.title].filter(Boolean).join(" · "),
      quote: compactText(moment.quote, 150),
      leftLabel: "Claude",
      leftText: compactText(moment.claudeNote.note, 130),
      rightLabel: "You",
      rightText: compactText(moment.userNote.note, 130),
      footer: "Read together, once at the same sentence.",
      source: "shared",
    });
  }

  if (finish && !lowSignal) {
    candidates.push({
      id: `finish-${book.bookId || book.id || "book"}`,
      variant: "finish",
      art: "fold",
      artSeed: hashText(`${book.bookId || book.id || book.title}:finish`),
      kicker: finish.celebration?.title || "Book finished, margins preserved.",
      title: book.title || "Finished book",
      subtitle: book.author || "",
      quote: finish.celebration?.line || "The book is closed, but the margins are still awake.",
      leftLabel: "Progress",
      leftText: `${finish.chunkCount || finish.chunksRead || ""}${finish.chunkCount ? " chunks" : ""}`.trim(),
      rightLabel: "Margins",
      rightText: `${finish.annotationCount || 0} notes`,
      footer: finish.celebration?.prompt || "Choose one sentence to carry forward.",
      source: "finish",
    });
  }

  const visibleRoots = rootAnnotations(annotations).filter((annotation) => !isHumanAuthor(annotation.author) || annotation.status === "submitted");
  const resonant = visibleRoots.find((annotation) => ["resonance", "feeling", "annotation"].includes(annotation.kind || "annotation"));
  if (resonant && !lowSignal) {
    candidates.push({
      id: `quiet-${resonant.id}`,
      variant: "quiet",
      art: "stardust",
      artSeed: hashText(`${resonant.id}:${resonant.quote}`),
      kicker: "A note worth keeping",
      title: book.title || "Co-Reading",
      subtitle: chunk.title || "",
      quote: compactText(resonant.quote, 150),
      leftLabel: isClaudeAuthor(resonant.author) ? "Claude" : "You",
      leftText: compactText(resonant.note, 150),
      rightLabel: "",
      rightText: "",
      footer: "A small card from the margin.",
      source: "quiet",
    });
  }

  return candidates;
}

export function pickCard(candidates = [], seed = Date.now()) {
  if (!candidates.length) return null;
  const value = Math.abs(Number(seed) || 0);
  return candidates[value % candidates.length];
}
