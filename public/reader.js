import { buildCardCandidates, normalizeForOverlap, pickCard, sharedNoteIdSet } from "./card-logic.js";

const state = {
  books: [],
  chunks: [],
  annotations: [],
  bookId: null,
  chunkId: null,
  chunk: null,
  quote: "",
  selectedQuote: "",
  activeAnnotationId: null,
  cardCandidates: [],
  cardIndex: 0,
  lastFinish: null,
  toastTimer: null,
  refreshInFlight: false,
};

const $ = (id) => document.getElementById(id);
const authTokenKey = "co-reading-auth-token";
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  localStorage.setItem(authTokenKey, urlToken);
  history.replaceState(null, "", location.pathname);
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

function renderReply(reply, root) {
  return `<div class="${replyClass(reply, root)}">
    <p class="reply-body">${formatNote(reply.note)}</p>
    <div class="note-meta">${escapeHtml(formatIdentity(reply.author))} · ${escapeHtml(reply.kind || "reply")}</div>
  </div>`;
}

function renderThread(note, notes) {
  const replies = notes.filter((item) => item.parentId === note.id);
  return `<div class="thread">
    ${replies.map((reply) => renderReply(reply, note)).join("")}
    <form class="reply-form" data-parent-id="${escapeHtml(note.id)}">
      <textarea rows="2" placeholder="Reply in this margin..."></textarea>
      <button type="submit" class="primary-button">Reply</button>
    </form>
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
      return `<button class="book ${book.bookId === state.bookId ? "active" : ""}" data-book="${escapeHtml(book.bookId)}">
        <span class="book-title">${escapeHtml(book.title || book.bookId)}</span>
        <span class="book-meta">${escapeHtml(book.author || "Unknown author")} · ${read}/${total} · ${book.annotationCount || 0} notes</span>
        <span class="progress"><span style="width: ${pct}%"></span></span>
      </button>`;
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
  let html = escapeHtml(state.chunk.text);
  const notes = state.annotations.filter((item) => item.chunkId === state.chunkId);
  const sharedIds = sharedNoteIdSet(notes);
  const seenQuotes = new Set();
  const rootNotes = notes
    .filter((item) => !item.parentId && item.quote)
    .sort((a, b) => Number(sharedIds.has(b.id)) - Number(sharedIds.has(a.id)));
  for (const note of rootNotes) {
    const normalizedQuote = normalizeForOverlap(note.quote);
    if (seenQuotes.has(normalizedQuote)) continue;
    seenQuotes.add(normalizedQuote);
    const quote = escapeHtml(note.quote);
    if (quote && html.includes(quote)) {
      const shared = sharedIds.has(note.id);
      const bookmark = shared ? `<span class="shared-bookmark" title="这里有两个人的折痕。">此处有回声</span>` : "";
      html = html.replace(
        quote,
        `<mark class="${note.id === state.activeAnnotationId ? "active" : ""} ${shared ? "shared" : ""}" data-note-id="${escapeHtml(note.id)}" title="${escapeHtml(note.note)}">${quote}</mark>${bookmark}${
          note.id === state.activeAnnotationId ? renderInlineNote(note, notes) : ""
        }`,
      );
    }
  }
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
      const replies = notes.filter((item) => item.parentId === note.id);
      const expanded = note.id === state.activeAnnotationId;
      const isShared = sharedNoteIdSet(notes).has(note.id);
      return `<article class="note-card ${(note.status || "") === "open" ? "open" : ""} ${expanded ? "active" : ""}" data-note-id="${escapeHtml(note.id)}" tabindex="0">
        ${isShared ? `<p class="shared-line">这里有两个人的折痕。</p>` : ""}
        <p class="note-quote">${escapeHtml(note.quote)}</p>
        <p class="note-body">${formatNote(note.note)}</p>
        <div class="note-meta">${escapeHtml(formatIdentity(note.author))} · ${escapeHtml(note.kind || "note")} · ${escapeHtml(note.status || "published")}${replies.length ? ` · ${replies.length} replies` : ""}</div>
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
  const quote = selection?.toString().trim() || "";
  state.selectedQuote = quote;
  $("note-selection").disabled = !quote || !state.bookId || !state.chunkId;
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
  renderBooks();
  renderChunks();
  renderAnnotations();
  scrollToPanel(".chapters");
}

async function selectChunk(chunkId) {
  state.chunkId = chunkId;
  state.activeAnnotationId = null;
  state.chunk = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
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
  scrollToPanel(".reader");
}

function openNoteForm(quote) {
  state.quote = quote.trim();
  if (!state.bookId || !state.chunkId || !state.quote) return;
  $("quote-preview").textContent = state.quote;
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

async function refreshCurrent() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    await loadBooks();
    if (state.bookId) {
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
  await api("/api/annotations", {
    method: "POST",
    body: {
      bookId: state.bookId,
      chunkId: state.chunkId,
      quote: state.quote,
      note: $("note").value.trim(),
      kind: "note",
    },
  });
  $("note-form").hidden = true;
  window.getSelection()?.removeAllRanges();
  updateSelectionAction();
  await refreshCurrent();
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

$("margins").addEventListener("submit", async (event) => {
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
  state.activeAnnotationId = savedNoteId;
  await refreshCurrent();
  if (savedNoteId) activateAnnotation(savedNoteId);
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
  await refreshCurrent();
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
  await refreshCurrent();
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

$("refresh").addEventListener("click", () => refreshCurrent().catch(showError));

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
  const toast = $("toast");
  toast.textContent = msg;
  toast.hidden = false;
  toast.onclick = () => { toast.hidden = true; };
}

loadBooks().catch(showError);
setInterval(() => {
  if (document.hidden) return;
  refreshCurrent().catch(showError);
}, 5000);
