import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cardArtSvg } from "../public/card-art.js";
import { compactText } from "../public/card-logic.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(value = "") {
  return escapeXml(value).replace(/'/g, "&#39;");
}

function safeFilePart(value = "reading-card") {
  const text = String(value || "reading-card")
    .trim()
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "");
  return text || "reading-card";
}

function wrapText(text, maxChars, maxLines) {
  const chars = Array.from(compactText(text, maxChars * maxLines));
  const lines = [];
  let line = "";
  for (const char of chars) {
    line += char;
    const wide = /[\p{Script=Han}！？。，、；：“”‘’（）]/u.test(char);
    const length = Array.from(line).reduce((sum, item) => sum + (/[\p{Script=Han}]/u.test(item) ? 1 : 0.56), 0);
    if (wide && length >= maxChars) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function cardArtLabel(card = {}) {
  if ((card.scope || card.context?.scope) === "book" || card.art === "lastfold") return "LAST FOLD";
  if (card.art === "ripple") return "ECHO BOOKMARK";
  if (card.art === "stardust") return "DUST TRACE";
  return "FOLDED MARGIN";
}

function cardArtClass(card = {}) {
  if (card.art === "lastfold" || (card.scope || card.context?.scope) === "book") return "lastfold";
  if (card.art === "ripple") return "ripple";
  if (card.art === "stardust") return "stardust";
  return "fold";
}

function cardDisplayTitle(card = {}) {
  const raw = String(card.title || card.bookTitle || "Reading Card").trim();
  return raw
    .replace(/[（(][^）)]*(套装|共\d+册|全集|全套)[^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim() || raw;
}

function cardDisplaySubtitle(card = {}) {
  const raw = String(card.subtitle || card.chunkTitle || "").trim();
  return raw
    .replace(cardDisplayTitle(card), "")
    .replace(String(card.bookTitle || ""), "")
    .replace(/[·|｜]/g, " ")
    .replace(/[（(][^）)]*(套装|共\d+册|全集|全套)[^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "共读书签";
}

function cardDisplayQuote(card = {}) {
  return compactText(card.quote || "A passage worth carrying forward.", (card.scope || card.context?.scope) === "book" ? 82 : 64);
}

function cardDisplayNote(card = {}) {
  return compactText(card.note || "A small card from the margin.", (card.scope || card.context?.scope) === "book" ? 210 : 175);
}

function cardPalette(card = {}) {
  if (card.art === "lastfold" || (card.scope || card.context?.scope) === "book") {
    return {
      frame: "#dedbd3",
      paper: "#faf7f0",
      paperMid: "#eeeae1",
      paperEnd: "#e7e8e0",
      shadow: "rgba(55,47,38,.13)",
    };
  }
  if (card.art === "ripple") {
    return {
      frame: "#e4ded5",
      paper: "#faf5ed",
      paperMid: "#eee9df",
      paperEnd: "#e6e5dc",
      shadow: "rgba(72,58,46,.13)",
    };
  }
  if (card.art === "stardust") {
    return {
      frame: "#e1ddd4",
      paper: "#f8f5ef",
      paperMid: "#eeeae2",
      paperEnd: "#e8e6df",
      shadow: "rgba(61,54,43,.12)",
    };
  }
  return {
    frame: "#e7e2da",
    paper: "#fbf6ee",
    paperMid: "#eeeae2",
    paperEnd: "#e2e4dc",
    shadow: "rgba(70,54,42,.13)",
  };
}

export function renderCardSvg(card = {}) {
  const quoteLength = String(card.quote || "").length;
  const noteLength = String(card.note || "").length;
  const totalLength = quoteLength + noteLength;
  const height = totalLength < 110 ? 680 : totalLength > 310 ? 980 : 820;
  const width = 720;
  const quoteLines = wrapText(card.quote || "A passage worth carrying forward.", 14, totalLength > 310 ? 7 : 5);
  const noteLines = wrapText(card.note || "A small card from the margin.", 28, totalLength > 310 ? 5 : 4);
  const titleLines = wrapText(card.title || card.bookTitle || "Reading Card", 11, 2);
  const subtitle = compactText(card.subtitle || [card.bookTitle, card.chunkTitle].filter(Boolean).join(" · "), 52);
  const quoteY = totalLength < 110 ? 348 : 406;
  const noteY = height - 190;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbf6ee"/>
      <stop offset="0.6" stop-color="#eeeae2"/>
      <stop offset="1" stop-color="#e5e4dc"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="28" stdDeviation="34" flood-color="#46362a" flood-opacity="0.14"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="transparent"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="48" fill="url(#paper)" filter="url(#shadow)"/>
  <rect x="24.5" y="24.5" width="${width - 49}" height="${height - 49}" rx="47.5" fill="none" stroke="#ffffff" stroke-opacity="0.8"/>
  <g color="#584e40">${cardArtSvg(card, width, height)}</g>
  <g font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif" fill="#28241f">
    <text x="76" y="92" font-size="20" font-weight="800" letter-spacing="2" fill="#9d968d">${escapeXml(compactText(card.sourceLabel || cardArtLabel(card), 26).toUpperCase())}</text>
    <text x="76" y="146" font-size="22" font-weight="800" fill="#777168">${escapeXml(card.kicker || "收获了一枚回声书签")}</text>
    ${titleLines.map((line, index) => `<text x="76" y="${212 + index * 58}" font-size="50" font-weight="800">${escapeXml(line)}</text>`).join("")}
    <text x="76" y="${titleLines.length > 1 ? 334 : 282}" font-size="22" fill="#868078">${escapeXml(subtitle)}</text>
  </g>
  <g font-family="Georgia, 'Times New Roman', 'Songti SC', serif" fill="#34302b">
    ${quoteLines.map((line, index) => `<text x="76" y="${quoteY + index * 54}" font-size="38">${escapeXml(line)}</text>`).join("")}
  </g>
  <line x1="76" x2="644" y1="${noteY - 38}" y2="${noteY - 38}" stroke="#28241f" stroke-opacity="0.12"/>
  <g font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif" fill="#4b463f">
    <text x="76" y="${noteY}" font-size="18" font-weight="800" fill="#817b72">MARGIN</text>
    ${noteLines.map((line, index) => `<text x="76" y="${noteY + 42 + index * 30}" font-size="22">${escapeXml(line)}</text>`).join("")}
    <text x="76" y="${height - 74}" font-size="20" fill="#817b72">${escapeXml(card.footer || "A small card from the margin.")}</text>
  </g>
</svg>`;
}

export function renderCardHtml(card = {}) {
  const cardWidth = 360;
  const frameWidth = 396;
  const artHeight = 760;
  const art = cardArtSvg(card, cardWidth, artHeight);
  const kind = cardArtClass(card);
  const palette = cardPalette(card);
  const totalLength = [card.quote, card.note].filter(Boolean).join("").length;
  const sizeClass = totalLength < 120 ? "compact" : totalLength > 360 ? "tall" : "standard";

  return `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${frameWidth}px; background: ${palette.frame}; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif;
    color: #25221f;
    padding: 18px;
  }
  .card {
    position: relative;
    width: ${cardWidth}px;
    overflow: hidden;
    border-radius: 34px;
    padding: 34px 32px 32px;
    background: linear-gradient(145deg, ${palette.paper}, ${palette.paperMid} 58%, ${palette.paperEnd});
    border: 1px solid rgba(255,255,255,.86);
    box-shadow: 0 18px 54px ${palette.shadow}, inset 0 0 0 1px rgba(255,255,255,.42);
  }
  .card.compact { min-height: 560px; }
  .card.standard { min-height: 660px; }
  .card.tall { min-height: 760px; }
  .card.lastfold { background: linear-gradient(145deg, #faf7f0, #eeeae1 60%, #e7e8e0); }
  .art { position: absolute; inset: 0; pointer-events: none; opacity: .68; }
  .fold .art { color: rgba(76,69,61,.42); }
  .ripple .art { color: rgba(102,86,72,.50); }
  .stardust .art { color: rgba(88,78,64,.66); }
  .lastfold .art { opacity: .78; }
  .art svg { width: 100%; height: 100%; display: block; }
  .content { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 18px; }
  .compact .content { min-height: 490px; }
  .standard .content { min-height: 590px; }
  .tall .content { min-height: 690px; }
  .name {
    margin: 0;
    color: #a7a097;
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .kicker { margin: 0; color: #777168; font-size: 15px; font-weight: 800; }
  .title { margin: 0; font-size: 34px; line-height: 1.06; letter-spacing: 0; }
  .sub { margin: -8px 0 0; color: #868078; font-size: 14px; }
  .book-meta {
    margin: -8px 0 0;
    color: #8f877c;
    font-size: 12px;
    line-height: 1.35;
  }
  .quote {
    margin: 86px 0 0;
    padding: 0;
    color: #34302b;
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-size: 27px;
    line-height: 1.48;
  }
  .note {
    margin-top: auto;
    border-top: 1px solid rgba(40,36,31,.13);
    padding-top: 12px;
    color: #4b463f;
    font-size: 14px;
    line-height: 1.55;
  }
  .lastfold .quote { margin-top: 72px; }
  .lastfold .note { border-top-color: rgba(40,36,31,.16); }
  .lastfold .name { letter-spacing: .12em; }
  .note b {
    display: block;
    margin-bottom: 6px;
    color: #817b72;
    font-size: 12px;
    text-transform: uppercase;
  }
  .foot { margin: 0; color: #817b72; font-size: 13px; }
</style>
<article class="card ${escapeHtml(kind)} ${escapeHtml(sizeClass)}">
  <div class="art"><svg viewBox="0 0 ${cardWidth} ${artHeight}" preserveAspectRatio="none" color="#584e40">${art}</svg></div>
  <div class="content">
    <p class="name">${escapeHtml(cardArtLabel(card))}</p>
    <p class="kicker">${escapeHtml(card.kicker || "收获了一枚回声书签")}</p>
    <h1 class="title">${escapeHtml(cardDisplayTitle(card))}</h1>
    <p class="sub">${escapeHtml(cardDisplaySubtitle(card))}</p>
    ${(card.scope || card.context?.scope) === "book" && card.stats ? `<p class="book-meta">${escapeHtml(card.stats)}</p>` : ""}
    <blockquote class="quote">${escapeHtml(cardDisplayQuote(card))}</blockquote>
    <div class="note"><b>margin</b>${escapeHtml(cardDisplayNote(card))}</div>
    <p class="foot">${escapeHtml(card.footer || "a quiet mark left on the page")}</p>
  </div>
</article>`;
}

// Cache the CLI lookup: probing runs `playwright --version`, which is slow. A miss is
// re-checked after a few minutes so installing Playwright doesn't need a restart.
const PLAYWRIGHT_MISS_TTL_MS = 5 * 60 * 1000;
let playwrightLookup = null;

async function findPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CLI,
    path.join(ROOT, "node_modules", ".bin", "playwright"),
    "playwright",
    // Apps like Claude Desktop start MCP servers with a minimal PATH; try Homebrew's prefixes too.
    "/opt/homebrew/bin/playwright",
    "/usr/local/bin/playwright",
  ].filter(Boolean);
  for (const command of candidates) {
    try {
      await execFileAsync(command, ["--version"], { timeout: 15_000 });
      return command;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function playwrightCommand() {
  if (!playwrightLookup || (playwrightLookup.command === null && Date.now() - playwrightLookup.at > PLAYWRIGHT_MISS_TTL_MS)) {
    const at = Date.now();
    playwrightLookup = { at, command: undefined, promise: findPlaywright() };
    playwrightLookup.promise.then((command) => {
      if (playwrightLookup?.at === at) playwrightLookup.command = command;
    });
  }
  return playwrightLookup.promise;
}

/** Render a card to PNG with the Playwright CLI without blocking the server's event loop. */
export async function renderCardPng(card = {}) {
  const bin = await playwrightCommand();
  if (!bin) throw new Error("Playwright CLI not found; install it to enable PNG card rendering.");
  const token = randomBytes(8).toString("hex");
  const htmlPath = path.join(tmpdir(), `co-reading-card-${token}.html`);
  const pngPath = path.join(tmpdir(), `co-reading-card-${token}.png`);
  try {
    await writeFile(htmlPath, renderCardHtml(card));
    try {
      await execFileAsync(
        bin,
        ["screenshot", "--browser", "chromium", "--full-page", "--viewport-size", "396,1", `file://${htmlPath}`, pngPath],
        { timeout: 60_000 },
      );
    } catch (error) {
      throw new Error(error.stderr || error.stdout || error.message);
    }
    return await readFile(pngPath);
  } finally {
    await rm(htmlPath, { force: true });
    await rm(pngPath, { force: true });
  }
}

export async function renderCardImageContent(card) {
  try {
    return {
      type: "image",
      mimeType: "image/png",
      data: (await renderCardPng(card)).toString("base64"),
    };
  } catch {
    // Keep the zero-dependency server usable even when PNG rendering is not installed.
  }
  return {
    type: "image",
    mimeType: "image/svg+xml",
    data: Buffer.from(renderCardSvg(card), "utf8").toString("base64"),
  };
}

export async function saveCardImage(card = {}, outputDir) {
  if (!outputDir) throw new Error("outputDir is required");
  await mkdir(outputDir, { recursive: true });
  const title = safeFilePart(card.title || card.bookTitle || card.id || "reading-card");
  const id = safeFilePart(card.id || randomBytes(4).toString("hex"));
  const basePath = path.join(outputDir, `${title}-${id}`);
  try {
    const pngPath = `${basePath}.png`;
    await writeFile(pngPath, await renderCardPng(card));
    return { path: pngPath, mimeType: "image/png" };
  } catch {
    const svgPath = `${basePath}.svg`;
    await writeFile(svgPath, renderCardSvg(card));
    return { path: svgPath, mimeType: "image/svg+xml" };
  }
}
