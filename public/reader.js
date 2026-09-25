import { buildCardCandidates, pickCard, sharedNoteIdSet } from "./card-logic.js";

const state = {
  books: [],
  chunks: [],
  annotations: [],
  bookId: null,
  chunkId: null,
  chunk: null,
  quote: "",
  quoteOffset: null,
  selectedQuote: "",
  selectedQuoteOffset: null,
  activeAnnotationId: null,
  cardCandidates: [],
  cardIndex: 0,
  lastFinish: null,
  toastTimer: null,
  refreshInFlight: false,
  composing: false,
  replyDrafts: {},
  replyTargetId: null,
};

const $ = (id) => document.getElementById(id);
const authTokenKey = "co-reading-auth-token";
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  localStorage.setItem(authTokenKey, urlToken);
  history.replaceState(null, "", location.pathname + location.hash);
}

async function api(path, options = {}) {
  const token = localStorage.getItem(authTokenKey);
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Light Markdown-ish formatting for annotation bodies (zero dependencies). */
function formatNote(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
}

// Images kept by `import_epub.py --keep-images` appear in chunk text as [[img:assets/<file>]].
const IMAGE_TOKEN_RE = /\[\[img:([^\]\n]+?)\]\]/g;

function assetUrl(relPath, bookId = state.bookId) {
  const encodedPath = String(relPath).split("/").map(encodeURIComponent).join("/");
  return `/api/books/${encodeURIComponent(bookId || "")}/asset/${encodedPath}`;
}

/** Image tokens with their [start, end) offsets; a token alone on its line is a figure. */
function imageTokens(text) {
  const tokens = [];
  for (const match of String(text || "").matchAll(IMAGE_TOKEN_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineBreak = text.indexOf("\n", end);
    const line = text.slice(lineStart, lineBreak < 0 ? text.length : lineBreak);
    tokens.push({ start, end, path: match[1].trim(), block: !line.replace(IMAGE_TOKEN_RE, "").trim() });
  }
  return tokens;
}

function imageHtml(token) {
  return `<img class="${token.block ? "book-figure" : "book-inline"}" src="${escapeHtml(assetUrl(token.path))}" alt="" loading="lazy">`;
}

/** Escape text[start:end) and turn the image tokens inside it into <img> tags. */
function renderTextRange(text, start, end, tokens) {
  let html = "";
  let cursor = start;
  for (const token of tokens) {
    if (token.start < cursor || token.end > end) continue;
    html += escapeHtml(text.slice(cursor, token.start)) + imageHtml(token);
    cursor = token.end;
  }
  return html + escapeHtml(text.slice(cursor, end));
}

/** Quote text for margins and previews, with images shown small and inline. */
function quoteHtml(quote) {
  const text = String(quote || "");
  return renderTextRange(text, 0, text.length, imageTokens(text).map((token) => ({ ...token, block: false })));
}

/** Chunk text as the reader shows it (tokens removed) plus each character's offset in the chunk. */
function displayText(text) {
  let display = "";
  const offsets = [];
  let cursor = 0;
  const copy = (from, to) => {
    display += text.slice(from, to);
    for (let index = from; index < to; index += 1) offsets.push(index);
  };
  for (const token of imageTokens(text)) {
    copy(cursor, token.start);
    cursor = token.end;
  }
  copy(cursor, text.length);
  return { display, offsets };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      const size = 0x8000;
      for (let index = 0; index < bytes.length; index += size) {
        binary += String.fromCharCode(...bytes.subarray(index, index + size));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function scrollToPanel(selector) {
  if (!isMobileLayout()) return;
  requestAnimationFrame(() => {
    document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  state.toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 2400);
}

function formatIdentity(author) {
  const value = String(author || "unknown").toLowerCase();
  if (value === "user" || value === "koshi") return "you";
  if (value === "claude") return "Claude";
  return value;
}

function replyClass(reply, root) {
  const sameAuthor = String(reply.author || "").toLowerCase() === String(root.author || "").toLowerCase();
  return sameAuthor ? "reply root-author" : "reply other-author";
}

function repliesFor(parentId, notes) {
  return notes.filter((item) => item.parentId === parentId);
}

function replyCount(parentId, notes, seen = new Set()) {
  if (seen.has(parentId)) return 0;
  seen.add(parentId);
  return repliesFor(parentId, notes).reduce((count, reply) => count + 1 + replyCount(reply.id, notes, seen), 0);
}

function renderReply(reply, root, notes, depth = 1, seen = new Set()) {
  if (!reply.id || seen.has(reply.id)) return "";
  const nextSeen = new Set(seen);
  nextSeen.add(reply.id);
  const children = repliesFor(reply.id, notes);
  const visibleDepth = Math.min(depth, 4);
  return `<div class="${replyClass(reply, root)}" style="--reply-depth: ${visibleDepth}">
    <p class="reply-body">${formatNote(reply.note)}</p>
    <div class="note-meta">${escapeHtml(formatIdentity(reply.author))} · ${escapeHtml(reply.kind || "reply")}
      <button type="button" class="reply-to" data-reply-to="${escapeHtml(reply.id)}">Reply</button>
    </div>
    ${state.replyTargetId === reply.id ? replyFormHtml(reply.id, "Reply to this...") : ""}
    ${
      children.length
        ? `<div class="reply-children">${children
            .map((child) => renderReply(child, root, notes, depth + 1, nextSeen))
            .join("")}</div>`
        : ""
    }
  </div>`;
}

function replyFormHtml(parentId, placeholder) {
  const draft = state.replyDrafts[parentId] || "";
  return `<form class="reply-form" data-parent-id="${escapeHtml(parentId)}">
      <textarea rows="2" placeholder="${escapeHtml(placeholder)}">${escapeHtml(draft)}</textarea>
      <button type="submit" class="primary-button">Reply</button>
    </form>`;
}

function renderThread(note, notes) {
  const replies = repliesFor(note.id, notes);
  return `<div class="thread">
    ${replies.map((reply) => renderReply(reply, note, notes, 1, new Set([note.id]))).join("")}
    ${replyFormHtml(note.id, "Reply in this margin...")}
  </div>`;
}

function renderInlineNote(note, notes) {
  return `<aside class="inline-note" data-note-id="${escapeHtml(note.id)}">
    <p class="inline-note-kicker">${escapeHtml(formatIdentity(note.author))} · ${escapeHtml(note.kind || "note")}</p>
    <p class="note-body">${formatNote(note.note)}</p>
    ${renderThread(note, notes)}
  </aside>`;
}

function renderBooks() {
  $("books").innerHTML = state.books
    .map((book) => {
      const total = book.chunkCount || 0;
      const read = book.chunksRead || 0;
      const pct = total ? Math.round((read / total) * 100) : 0;
      return `<div class="book-row ${book.bookId === state.bookId ? "active" : ""}">
        <button class="book" data-book="${escapeHtml(book.bookId)}">
          <span class="book-title">${escapeHtml(book.title || book.bookId)}</span>
          <span class="book-meta">${escapeHtml(book.author || "Unknown author")} · ${read}/${total} · ${book.annotationCount || 0} notes</span>
          <span class="progress"><span style="width: ${pct}%"></span></span>
        </button>
        <button class="book-delete" data-delete-book="${escapeHtml(book.bookId)}" title="Delete this book">Delete</button>
      </div>`;
    })
    .join("");
}

function renderChunks() {
  $("chunks").innerHTML = state.chunks
    .map(
      (chunk) => `<button class="chunk ${chunk.id === state.chunkId ? "active" : ""}" data-chunk="${escapeHtml(chunk.id)}">
        <span class="chunk-title">${escapeHtml(chunk.title)}</span>
        <span class="chunk-meta">${escapeHtml(chunk.id)} · ${chunk.read ? "read" : "unread"} · ${chunk.annotationCount || 0} notes</span>
      </button>`,
    )
    .join("");
}

function renderText() {
  if (!state.chunk) return;
  const text = state.chunk.text || "";
  const tokens = imageTokens(text);
  const notes = state.annotations.filter((item) => item.chunkId === state.chunkId);
  const sharedIds = sharedNoteIdSet(notes);
  const highlights = [];
  const occupied = [];
  const rootNotes = notes
    .filter((item) => !item.parentId && item.quote)
    .sort((a, b) => {
      const left = Number.isInteger(a.quoteOffset) ? a.quoteOffset : text.indexOf(a.quote);
      const right = Number.isInteger(b.quoteOffset) ? b.quoteOffset : text.indexOf(b.quote);
      return left - right;
    });
  for (const note of rootNotes) {
    const quote = String(note.quote || "");
    const requestedOffset = Number(note.quoteOffset);
    const start =
      Number.isInteger(requestedOffset) && requestedOffset >= 0 && text.slice(requestedOffset, requestedOffset + quote.length) === quote
        ? requestedOffset
        : text.indexOf(quote);
    if (!quote || start < 0) continue;
    let from = start;
    let end = start + quote.length;
    // Never cut an image token in half: widen the highlight to whole tokens.
    for (const token of tokens) {
      if (token.start < from && from < token.end) from = token.start;
      if (token.start < end && end < token.end) end = token.end;
    }
    if (occupied.some((range) => from < range.end && end > range.start)) continue;
    occupied.push({ start: from, end });
    highlights.push({ start: from, end, note, shared: sharedIds.has(note.id) });
  }

  let html = "";
  let cursor = 0;
  for (const highlight of highlights) {
    html += renderTextRange(text, cursor, highlight.start, tokens);
    const quote = renderTextRange(text, highlight.start, highlight.end, tokens);
    const bookmark = highlight.shared ? `<span class="shared-bookmark" title="这里有两个人的折痕。">此处有回声</span>` : "";
    html += `<mark class="${highlight.note.id === state.activeAnnotationId ? "active" : ""} ${highlight.shared ? "shared" : ""}" data-note-id="${escapeHtml(highlight.note.id)}" title="${escapeHtml(highlight.note.note)}">${quote}</mark>${bookmark}${
      highlight.note.id === state.activeAnnotationId ? renderInlineNote(highlight.note, notes) : ""
    }`;
    cursor = highlight.end;
  }
  html += renderTextRange(text, cursor, text.length, tokens);
  $("text").innerHTML = html;
  bindMarkActions();
}

function bindMarkActions() {
  document.querySelectorAll("mark[data-note-id]").forEach((mark) => {
    const open = (event) => {
      event.stopPropagation();
      activateAnnotation(mark.dataset.noteId, { scroll: true });
    };
    mark.addEventListener("click", open);
    mark.addEventListener("touchend", open);
  });
}

function renderAnnotations() {
  const notes = state.annotations.filter((item) => item.chunkId === state.chunkId);
  const roots = notes.filter((item) => !item.parentId);
  const openCount = state.annotations.filter((item) => item.author === "user" && (item.status || "open") === "open")
    .length;

  $("margins").innerHTML = roots
    .map((note) => {
      const replies = replyCount(note.id, notes);
      const expanded = note.id === state.activeAnnotationId;
      const isShared = sharedNoteIdSet(notes).has(note.id);
      return `<article class="note-card ${(note.status || "") === "open" ? "open" : ""} ${expanded ? "active" : ""}" data-note-id="${escapeHtml(note.id)}" tabindex="0">
        ${isShared ? `<p class="shared-line">这里有两个人的折痕。</p>` : ""}
        <p class="note-quote">${quoteHtml(note.quote)}</p>
        <p class="note-body">${formatNote(note.note)}</p>
        <div class="note-meta">${escapeHtml(formatIdentity(note.author))} · ${escapeHtml(note.kind || "note")} · ${escapeHtml(note.status || "published")}${replies ? ` · ${replies} replies` : ""}</div>
        ${
          expanded
            ? renderThread(note, notes)
            : ""
        }
      </article>`;
    })
    .join("");

  $("submit-notes").disabled = openCount === 0;
  $("submit-notes").textContent = openCount ? `Send ${openCount} to Claude` : "Send to Claude";
  $("status").textContent = openCount
    ? `${openCount} private note${openCount === 1 ? "" : "s"} waiting.`
    : "Private notes stay local until you send them.";
}

function currentBook() {
  return state.books.find((item) => item.bookId === state.bookId) || {};
}

function currentChunkMeta() {
  return state.chunks.find((item) => item.id === state.chunkId) || state.chunk?.chunk || {};
}

function refreshCards({ finish = null, show = false } = {}) {
  const chunkAnnotations = state.annotations.filter((item) => item.chunkId === state.chunkId);
  state.cardCandidates = buildCardCandidates({
    book: currentBook(),
    chunk: { ...currentChunkMeta(), text: state.chunk?.text || "" },
    annotations: chunkAnnotations,
    finish,
  });
  if (state.cardIndex >= state.cardCandidates.length) state.cardIndex = 0;
  $("show-card").disabled = state.cardCandidates.length === 0;
  $("show-card").textContent = state.cardCandidates.length ? `Cards ${state.cardCandidates.length}` : "Cards";
  if (show && state.cardCandidates.length) {
    openCardPanel();
  } else {
    renderCardPanel();
  }
}

function renderCardPanel() {
  const card = pickCard(state.cardCandidates, state.cardIndex);
  $("card-panel").hidden = !card || $("card-panel").hidden;
  if (!card) {
    $("card-preview").innerHTML = "";
    return;
  }
  $("card-preview").innerHTML = renderReadingCard(card);
}

function seededRandom(seed) {
  let value = (Number(seed) || 1) >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function readingCardArt(card) {
  const random = seededRandom(card.artSeed || 1);
  if (card.art === "ripple") {
    const centers = [
      [25 + random() * 18, 20 + random() * 18],
      [58 + random() * 18, 48 + random() * 18],
      [22 + random() * 14, 72 + random() * 12],
    ];
    const circles = centers
      .flatMap(([cx, cy], groupIndex) =>
        Array.from({ length: groupIndex === 1 ? 4 : 3 }, (_, index) => {
          const radius = 8 + index * (6 + random() * 3) + random() * 2;
          const opacity = 0.035 + random() * 0.06;
          return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(3)}" />`;
        }),
      )
      .join("");
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="0.36">${circles}</g></svg>`;
  }
  if (card.art === "stardust") {
    const dots = Array.from({ length: 64 }, () => {
      const cx = 7 + random() * 86;
      const cy = 8 + random() * 80;
      const radius = 0.08 + random() * 0.24;
      const opacity = 0.18 + random() * 0.42;
      return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(3)}" />`;
    }).join("");
    const bright = Array.from({ length: 7 }, () => {
      const cx = 12 + random() * 76;
      const cy = 12 + random() * 72;
      const opacity = 0.22 + random() * 0.26;
      return `<path d="M ${(cx - 0.9).toFixed(2)} ${cy.toFixed(2)} L ${(cx + 0.9).toFixed(2)} ${cy.toFixed(2)} M ${cx.toFixed(2)} ${(cy - 0.9).toFixed(2)} L ${cx.toFixed(2)} ${(cy + 0.9).toFixed(2)}" opacity="${opacity.toFixed(3)}" />`;
    }).join("");
    const lines = Array.from({ length: 5 }, () => {
      const x1 = 8 + random() * 84;
      const y1 = 10 + random() * 76;
      const x2 = x1 + (random() - 0.5) * 12;
      const y2 = y1 + (random() - 0.5) * 12;
      return `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}" opacity="0.07" />`;
    }).join("");
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><g fill="currentColor">${dots}</g><g fill="none" stroke="currentColor" stroke-width="0.14">${lines}${bright}</g></svg>`;
  }
  const lines = Array.from({ length: 14 }, () => {
    const x = 8 + random() * 84;
    const drift = (random() - 0.5) * 10;
    const opacity = 0.06 + random() * 0.14;
    return `<path d="M ${x.toFixed(2)} 3 C ${(x + drift).toFixed(2)} 30 ${(x - drift).toFixed(2)} 62 ${x.toFixed(2)} 97" opacity="${opacity.toFixed(3)}" />`;
  }).join("");
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="0.32">${lines}</g></svg>`;
}

function renderReadingCard(card) {
  return `<article class="ritual-card ${escapeHtml(card.variant)} art-${escapeHtml(card.art || "fold")} ${escapeHtml(cardSizeClass(card))}">
    <div class="card-art">${readingCardArt(card)}</div>
    <div class="card-content">
      <p class="card-kicker">${escapeHtml(card.kicker)}</p>
      <h3>${escapeHtml(card.title)}</h3>
      <p class="card-subtitle">${escapeHtml(card.subtitle)}</p>
      <blockquote>${escapeHtml(card.quote)}</blockquote>
      <div class="card-voices ${card.rightText ? "" : "single"}">
        <section>
          <span>${escapeHtml(card.leftLabel)}</span>
          <p>${escapeHtml(card.leftText)}</p>
        </section>
        ${
          card.rightText
            ? `<section>
                <span>${escapeHtml(card.rightLabel)}</span>
                <p>${escapeHtml(card.rightText)}</p>
              </section>`
            : ""
        }
      </div>
      <footer>${escapeHtml(card.footer)}</footer>
    </div>
  </article>`;
}

function cardSizeClass(card) {
  const totalLength = [card.quote, card.leftText, card.rightText, card.note]
    .filter(Boolean)
    .join("")
    .length;
  if (totalLength < 120) return "card-compact";
  if (totalLength > 360) return "card-tall";
  return "card-standard";
}

function openCardPanel() {
  if (!state.cardCandidates.length) return;
  $("card-panel").hidden = false;
  renderCardPanel();
}

function updateSelectionAction() {
  const selection = window.getSelection();
  const details = selectionDetails(selection);
  state.selectedQuote = details?.quote || "";
  state.selectedQuoteOffset = details?.quoteOffset ?? null;
  $("note-selection").disabled = !state.selectedQuote || !state.bookId || !state.chunkId;
}

function elementForNode(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + Math.max(needle.length, 1);
  }
  return count;
}

function findOccurrence(haystack, needle, occurrence) {
  let index = -1;
  let from = 0;
  for (let current = 0; current <= occurrence; current += 1) {
    index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    from = index + Math.max(needle.length, 1);
  }
  return index;
}

function selectionDetails(selection) {
  if (!selection || selection.rangeCount === 0 || !state.chunk?.text) return null;
  const rawQuote = selection.toString();
  const quote = rawQuote.trim();
  if (!quote) return null;

  const range = selection.getRangeAt(0);
  const textEl = $("text");
  const startEl = elementForNode(range.startContainer);
  const endEl = elementForNode(range.endContainer);
  if (!startEl || !endEl) return null;
  if (!textEl.contains(range.commonAncestorContainer) || !textEl.contains(startEl) || !textEl.contains(endEl)) return null;
  if (startEl.closest(".inline-note, .shared-bookmark") || endEl.closest(".inline-note, .shared-bookmark")) return null;

  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(textEl);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const occurrence = countOccurrences(prefixRange.toString(), quote);
  const text = state.chunk.text;
  if (!text.includes("[[img:")) {
    const quoteOffset = findOccurrence(text, quote, occurrence);
    return {
      quote,
      quoteOffset: quoteOffset >= 0 ? quoteOffset : null,
    };
  }
  // Rendered images carry no text, so match against the text without tokens and map back:
  // the saved quote keeps any image tokens it spans, and quoteOffset points into the chunk.
  const { display, offsets } = displayText(text);
  const displayOffset = findOccurrence(display, quote, occurrence);
  if (displayOffset < 0) return { quote, quoteOffset: null };
  const start = offsets[displayOffset];
  const end = offsets[displayOffset + quote.length - 1] + 1;
  return { quote: text.slice(start, end), quoteOffset: start };
}

async function loadBooks() {
  state.books = await api("/api/books");
  renderBooks();
}

async function selectBook(bookId) {
  state.bookId = bookId;
  state.chunkId = null;
  state.chunk = null;
  state.activeAnnotationId = null;
  state.replyDrafts = {};
  state.chunks = await api(`/api/books/${encodeURIComponent(bookId)}/chunks`);
  state.annotations = await api(`/api/annotations?bookId=${encodeURIComponent(bookId)}`);
  const book = state.books.find((item) => item.bookId === bookId);
  $("book-meta").textContent = book?.author || "Unknown author";
  $("book-title").textContent = book?.title || bookId;
  $("chunk-file").textContent = "No chapter selected";
  $("chunk-title").textContent = "Open a chapter to start reading";
  $("text").innerHTML = `<p class="empty">Choose a chapter. Highlight text to leave a note for Claude.</p>`;
  $("mark-read").disabled = true;
  $("continue-reading").disabled = false;
  document.body.classList.add("has-book");
  document.body.classList.remove("has-chunk");
  state.replyTargetId = null;
  setLocationHash();
  renderBooks();
  renderChunks();
  renderAnnotations();
  scrollToPanel(".chapters");
}

function clearBookSelection() {
  state.bookId = null;
  state.chunkId = null;
  state.chunk = null;
  state.annotations = [];
  state.chunks = [];
  state.activeAnnotationId = null;
  state.cardCandidates = [];
  state.replyDrafts = {};
  state.replyTargetId = null;
  setLocationHash();
  $("book-meta").textContent = "Choose a book";
  $("book-title").textContent = "Reading shelf";
  $("chunk-file").textContent = "No chapter selected";
  $("chunk-title").textContent = "Open a chapter to start reading";
  $("text").innerHTML = `<p class="empty">Select a book and chapter. Highlight text to leave a note for Claude.</p>`;
  $("mark-read").disabled = true;
  $("continue-reading").disabled = true;
  $("show-card").disabled = true;
  document.body.classList.remove("has-book", "has-chunk");
  renderChunks();
  renderAnnotations();
}

async function deleteBookFromShelf(bookId) {
  const book = state.books.find((item) => item.bookId === bookId);
  const label = book?.title || bookId;
  if (!confirm(`Delete "${label}" from this library?\n\nThe files and related notes will be archived under data/trash.`)) return;

  const result = await api(`/api/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
  $("status").textContent = result.message || `Deleted ${label}.`;
  await loadBooks();
  if (state.bookId === bookId) clearBookSelection();
  renderBooks();
}

async function selectChunk(chunkId) {
  state.chunkId = chunkId;
  state.activeAnnotationId = null;
  state.replyTargetId = null;
  state.chunk = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
  setLocationHash();
  state.lastFinish = null;
  $("chunk-file").textContent = state.chunk.chunk.id;
  $("chunk-title").textContent = state.chunk.chunk.title;
  $("mark-read").disabled = false;
  $("continue-reading").disabled = false;
  document.body.classList.add("has-chunk");
  renderChunks();
  renderText();
  renderAnnotations();
  refreshCards();
  $("text").scrollTop = 0;
  scrollToPanel(".reader");
}

// #/book/<bookId>/<chunkId> keeps the open book and chapter across reloads.
function setLocationHash() {
  const parts = ["#", "book", state.bookId, state.chunkId].filter(Boolean).map((part, index) => (index > 1 ? encodeURIComponent(part) : part));
  const hash = state.bookId ? parts.join("/") : "";
  if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

async function restoreFromHash() {
  const match = location.hash.match(/^#\/book\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return;
  const [bookId, chunkId] = [match[1], match[2]].map((part) => (part ? decodeURIComponent(part) : null));
  if (!state.books.some((book) => book.bookId === bookId)) return;
  await selectBook(bookId);
  if (chunkId && state.chunks.some((chunk) => chunk.id === chunkId)) await selectChunk(chunkId);
}

function openNoteForm(quote) {
  state.quote = quote.trim();
  state.quoteOffset = state.selectedQuote === state.quote ? state.selectedQuoteOffset : null;
  if (!state.bookId || !state.chunkId || !state.quote) return;
  $("quote-preview").innerHTML = quoteHtml(state.quote);
  $("note").value = "";
  $("note-form").hidden = false;
  $("note").focus();
}

function activateAnnotation(noteId, { scroll = false } = {}) {
  state.activeAnnotationId = noteId;
  renderText();
  renderAnnotations();
  if (scroll) {
    document.querySelector(`.inline-note[data-note-id="${CSS.escape(noteId)}"], .note-card[data-note-id="${CSS.escape(noteId)}"]`)?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }
}

function isEditingDraft() {
  const active = document.activeElement;
  return Boolean(
    state.composing ||
      active?.matches?.("textarea, input") ||
      active?.closest?.(".reply-form, .note-form"),
  );
}

async function refreshCurrent({ force = false } = {}) {
  if (state.refreshInFlight) return;
  if (!force && isEditingDraft()) return;
  state.refreshInFlight = true;
  try {
    await loadBooks();
    if (state.bookId) {
      if (!state.books.some((book) => book.bookId === state.bookId)) {
        clearBookSelection();
        $("status").textContent = "This book was deleted from the active library.";
        return;
      }
      state.chunks = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks`);
      state.annotations = await api(`/api/annotations?bookId=${encodeURIComponent(state.bookId)}`);
      renderBooks();
      renderChunks();
      renderText();
      renderAnnotations();
      refreshCards();
    }
  } finally {
    state.refreshInFlight = false;
  }
}

$("books").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-book]");
  if (deleteButton) {
    deleteBookFromShelf(deleteButton.dataset.deleteBook).catch(showError);
    return;
  }
  const button = event.target.closest("[data-book]");
  if (button) selectBook(button.dataset.book).catch(showError);
});

$("chunks").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chunk]");
  if (button) selectChunk(button.dataset.chunk).catch(showError);
});

$("text").addEventListener("mouseup", () => {
  updateSelectionAction();
});

$("text").addEventListener("touchend", () => {
  setTimeout(updateSelectionAction, 80);
});

$("text").addEventListener("click", (event) => {
  const mark = event.target.closest("mark[data-note-id]");
  if (mark) activateAnnotation(mark.dataset.noteId, { scroll: true });
});

document.addEventListener("selectionchange", updateSelectionAction);

$("cancel-note").addEventListener("click", () => {
  $("note-form").hidden = true;
});

$("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = $("note").value.trim();
  if (!note) return;
  await api("/api/annotations", {
    method: "POST",
    body: {
      bookId: state.bookId,
      chunkId: state.chunkId,
      quote: state.quote,
      quoteOffset: state.quoteOffset,
      note,
      kind: "note",
    },
  });
  $("note-form").hidden = true;
  window.getSelection()?.removeAllRanges();
  updateSelectionAction();
  await refreshCurrent({ force: true });
});

$("note-selection").addEventListener("click", () => {
  const quote = state.selectedQuote || window.getSelection()?.toString() || "";
  openNoteForm(quote);
});

$("margins").addEventListener("click", (event) => {
  if (event.target.closest("textarea, button, .reply-form, .thread")) return;
  const card = event.target.closest(".note-card[data-note-id]");
  if (card) activateAnnotation(card.dataset.noteId);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-reply-to]");
  if (!button) return;
  const replyId = button.dataset.replyTo;
  state.replyTargetId = state.replyTargetId === replyId ? null : replyId;
  renderText();
  renderAnnotations();
  if (state.replyTargetId) {
    document.querySelector(`.reply-form[data-parent-id="${CSS.escape(replyId)}"] textarea`)?.focus();
  }
});

// Book images: figures at half their pixel width (EPUB art is usually 2x), tall inline images
// (fractions) get more line height, and a missing file leaves a small marker instead.
document.addEventListener(
  "load",
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.matches(".book-figure, .book-inline")) return;
    if (img.classList.contains("book-figure") && img.naturalWidth) img.style.width = `${Math.round(img.naturalWidth / 2)}px`;
    if (img.classList.contains("book-inline") && img.naturalHeight > 90) img.classList.add("tall");
  },
  true,
);
document.addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.matches(".book-figure, .book-inline")) return;
    const marker = document.createElement("span");
    marker.className = "image-missing";
    marker.textContent = "[image]";
    img.replaceWith(marker);
  },
  true,
);

document.addEventListener("keydown", (event) => {
  if (!state.chunk || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target.closest?.("textarea, input, select, [contenteditable]")) return;
  const targetId = event.key === "ArrowLeft" ? state.chunk.prevId : event.key === "ArrowRight" ? state.chunk.nextId : null;
  if (!targetId) return;
  event.preventDefault();
  selectChunk(targetId).catch(showError);
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".reply-form");
  if (!form) return;
  event.preventDefault();
  event.stopPropagation();
  const textarea = form.querySelector("textarea");
  const note = textarea.value.trim();
  if (!note) return;
  const savedNoteId = state.activeAnnotationId;
  await api("/api/replies", {
    method: "POST",
    body: {
      parentId: form.dataset.parentId,
      note,
      author: "user",
      kind: "reply",
    },
  });
  textarea.value = "";
  delete state.replyDrafts[form.dataset.parentId];
  state.replyTargetId = null;
  state.activeAnnotationId = savedNoteId;
  await refreshCurrent({ force: true });
  if (savedNoteId) activateAnnotation(savedNoteId);
});

document.addEventListener("input", (event) => {
  const textarea = event.target.closest("textarea");
  const form = event.target.closest(".reply-form");
  if (!textarea || !form) return;
  state.replyDrafts[form.dataset.parentId] = textarea.value;
});

document.addEventListener("compositionstart", (event) => {
  if (!event.target.closest?.(".reply-form, .note-form")) return;
  state.composing = true;
});

document.addEventListener("compositionend", (event) => {
  if (!event.target.closest?.(".reply-form, .note-form")) return;
  state.composing = false;
});

$("submit-notes").addEventListener("click", async () => {
  const result = await api("/api/submit-notes", {
    method: "POST",
    body: {
      bookId: state.bookId,
      sessionId: "reader",
      contextMode: "chunk-once-per-session",
    },
  });
  await refreshCurrent({ force: true });
  $("status").textContent = result.submissionId
    ? `Shared ${result.count} note${result.count === 1 ? "" : "s"} with Claude. Submission ${result.submissionId}.`
    : result.message || "No private notes to share.";
});

$("mark-read").addEventListener("click", async () => {
  const result = await api("/api/mark-read", {
    method: "POST",
    body: { bookId: state.bookId, chunkId: state.chunkId },
  });
  state.lastFinish = result.finish || null;
  await refreshCurrent({ force: true });
  refreshCards({ finish: state.lastFinish, show: Boolean(state.lastFinish) });
  if (!state.lastFinish && state.cardCandidates.some((card) => card.source === "shared")) {
    showToast("收获了一枚回声书签");
  }
});

$("continue-reading").addEventListener("click", async () => {
  if (!state.bookId) return;
  const next = await api(`/api/continue?bookId=${encodeURIComponent(state.bookId)}`);
  const chunkId = next?.chunk?.chunk?.id || next?.chunk?.chunkId || next?.chunk?.id;
  if (!chunkId) {
    $("status").textContent = next?.message || "Nothing left to continue.";
    return;
  }
  await selectChunk(chunkId);
});

$("refresh").addEventListener("click", () => refreshCurrent({ force: true }).catch(showError));

$("show-card").addEventListener("click", openCardPanel);

$("card-close").addEventListener("click", () => {
  $("card-panel").hidden = true;
});

$("card-random").addEventListener("click", () => {
  if (!state.cardCandidates.length) return;
  state.cardIndex = (state.cardIndex + 1) % state.cardCandidates.length;
  renderCardPanel();
});

$("import-book").addEventListener("click", () => {
  $("import-file").click();
});

$("import-file").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  $("import-book").disabled = true;
  try {
    const imported = [];
    for (const file of files) {
      $("status").textContent = `Importing ${file.name}...`;
      const manifest = await api("/api/import", {
        method: "POST",
        body: {
          filename: file.name,
          dataBase64: await fileToBase64(file),
          keepImages: $("import-keep-images").checked,
        },
      });
      imported.push(manifest);
    }
    $("status").textContent = files.length === 1 ? `Imported ${files[0].name}.` : `Imported ${files.length} books.`;
    await loadBooks();
    renderBooks();
    if (imported.length === 1 && imported[0]?.bookId) {
      await selectBook(imported[0].bookId);
    }
  } catch (error) {
    showError(error);
  } finally {
    $("import-book").disabled = false;
    event.target.value = "";
  }
});

function showError(error) {
  const msg = error.message || String(error);
  $("status").textContent = msg;
  showToast(msg);
}

loadBooks()
  .then(restoreFromHash)
  .catch(showError);
setInterval(() => {
  if (document.hidden) return;
  refreshCurrent().catch(showError);
}, 5000);
