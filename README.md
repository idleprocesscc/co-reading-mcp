# Co-Reading MCP

A local MCP server that gives Claude a durable reading room:

- import EPUB or plain text into stable chunks while preserving EPUB spine/chapter boundaries
- list books and chunks
- read chunk-by-chunk with `prevId` / `nextId`
- continue directly from the next unread chunk
- search across a book with cached chunk text
- write margin annotations
- stage user notes, submit them to Claude once, and attach Claude replies under them
- track reading progress
- surface small shared-margin cards when human and Claude stop at the same passage
- return a small finish ritual when a book is completed

The goal is not one-shot summarization. The goal is a shared reading surface where a human and Claude can both read, leave anchored notes, and resume smoothly. Human notes can also stay private until the reader chooses to share them with Claude.

For a step-by-step setup and usage flow, see [docs/user-guide.md](docs/user-guide.md).

## Quick Start

Requirements:

- Node.js 18+
- Python 3.10+ for the import scripts

```bash
cd co-reading-mcp
cp -R data.example data
node src/server.js
```

If you also want a human-friendly reading surface, start the bundled reader:

```bash
npm run reader
```

Open `http://127.0.0.1:8787`. This serves a small reference reader and local HTTP API while also keeping the MCP stdio server active in the same process. In Claude Desktop / Claude Code you can point the MCP command at `src/http.js` instead of `src/server.js` when you want one process to handle both:

```json
{
  "mcpServers": {
    "co-reading": {
      "command": "node",
      "args": ["/absolute/path/to/co-reading-mcp/src/http.js"],
      "env": {
        "READING_MCP_DATA_DIR": "/absolute/path/to/co-reading-mcp/data",
        "READING_HTTP_PORT": "8787"
      }
    }
  }
}
```

The reader's Library header includes an import button for EPUB, TXT, or Markdown files. Browser imports upload the file directly to the co-reading server, so they also work with remote claude.ai setups where chat attachments are isolated from the MCP server filesystem.

For Claude Desktop / Claude Code, configure the MCP server as a stdio command:

```json
{
  "mcpServers": {
    "co-reading": {
      "command": "node",
      "args": ["/absolute/path/to/co-reading-mcp/src/server.js"],
      "env": {
        "READING_MCP_DATA_DIR": "/absolute/path/to/co-reading-mcp/data"
      }
    }
  }
}
```

## Remote Server

For VPS, reverse-proxy, tunnel, or remote MCP clients, run one process:

```bash
READING_MCP_DATA_DIR=./data MCP_AUTH_TOKEN="change-me" npm run start:sse
```

The same port serves the human reader, REST API, and remote MCP transports:

- `https://your-domain.example/`: reference reader UI
- `https://your-domain.example/?token=change-me`: reader UI with auth saved in a cookie (convenience shortcut — the token appears in the first request URL; avoid on shared devices or high-security setups)
- `https://your-domain.example/api/*`: reader REST API
- `https://your-domain.example/mcp`: remote MCP JSON-RPC endpoint for custom connectors
- `https://your-domain.example/sse`: legacy MCP SSE transport
- `https://your-domain.example/.well-known/oauth-protected-resource/mcp`: MCP resource metadata for connector discovery

Environment variables:

- `MCP_SSE_PORT` or `PORT`: listen port, default `3100`
- `MCP_SSE_HOST`: listen host, default `0.0.0.0`
- `MCP_AUTH_TOKEN`: bearer token required by remote clients
- `MCP_CORS_ORIGIN`: CORS origin. When `MCP_AUTH_TOKEN` is set, defaults to `*`; when unset, defaults to no CORS headers (blocks cross-origin requests)
- `MCP_MAX_BODY_BYTES`: max JSON-RPC POST body size, default `25000000`
- `READING_IMPORT_MAX_BYTES`: max EPUB/TXT upload size, default `25000000`

For Claude custom connectors, prefer the `/mcp` URL. `/sse` remains available for older MCP clients that still expect the SSE + `/messages` flow.

Do not expose the remote server on the public internet without HTTPS and `MCP_AUTH_TOKEN`. When `MCP_AUTH_TOKEN` is set, the reader, static assets, `/api/*`, `/sse`, `/messages`, `/mcp`, and `/health` require the token. Open the reader once with `/?token=...`; the server sets a same-site cookie and the reader stores the token for API calls. If you use nginx, Caddy, or cloudflared, proxy `/`, `/api/*`, `/sse`, `/messages`, `/mcp`, and `/.well-known/*` to the same local process and make sure streaming responses are not buffered.

## Import Books

Plain text:

```bash
python3 scripts/import_text.py ./book.txt --title "Book Title" --author "Author" --out ./data/books
```

Plain text can also preserve section headings with a multiline regex:

```bash
python3 scripts/import_text.py ./book.txt \
  --title "Book Title" \
  --heading-regex "^第[一二三四五六七八九十百零〇0-9]+[章节回].*$"
```

If a loose heading regex catches navigation labels or other tiny sections, add
`--min-section-chars 100` or a similar threshold.

EPUB:

```bash
python3 scripts/import_epub.py ./book.epub --out ./data/books
```

Add `--keep-images` to keep pictures and formula images (useful for textbooks). Images are copied to `data/books/<book-id>/assets/`, the text gets `[[img:assets/<file>]]` placeholders, and `<sup>`/`<sub>` become Unicode (`t²`, `x₀`). Chunk ids and titles stay the same as a text-only import, so re-importing an existing book with images keeps its progress and notes attached to the same chunks (an older note whose quote crossed an image or a superscript keeps its margin card but may lose its in-text highlight). The bundled reader renders the placeholders as images; MCP clients see them as plain text.

Claude can also import books through MCP, which is useful on claude.ai or mobile devices where the user cannot SSH into the server:

- `reading_import_book`: one EPUB/TXT as a base64 payload
- `reading_import_begin` / `reading_import_part` / `reading_import_finish`: chunked upload for larger files

For example, after a user drops `book.epub` into a Claude chat, Claude can read the file, base64-encode it, and call `reading_import_book`:

```json
{
  "filename": "book.epub",
  "dataBase64": "...",
  "bookId": "optional-stable-id"
}
```

TXT imports can pass the same heading options as the command-line script:

```json
{
  "filename": "book.txt",
  "dataBase64": "...",
  "title": "Book Title",
  "headingRegex": "^Chapter\\s+\\w+"
}
```

The import tools write into `data/books` immediately; no server restart is needed.

Both importers create:

```text
data/books/<book-id>/
  manifest.json
  chunks/
    ch00.txt
    ch01.txt
```

Keep manual backups of a book folder outside `data/books`: every folder there with a `manifest.json` is listed as a book.

EPUB imports keep each spine item as a section boundary. If an EPUB stores the whole book in a single spine item, the importer falls back to internal `h1`/`h2`/`h3` headings. If a chapter is longer than `--max-chars`, only that chapter is split into `Chapter Title Part 1/N`, `Part 2/N`, and so on.

Runtime state is stored outside book content:

```text
data/
  annotations.jsonl
  progress.json
  reading_sessions.json
```

`reading_submit_user_notes` includes full chunk text once per `sessionId` by default, then sends only new notes for the same chunk in that session. Use a new `sessionId` when Claude starts a new conversation/session so the relevant chunk context is sent again.

## Tools

- `reading_list_books`
- `reading_list_chunks`
- `reading_read_chunk`
- `reading_continue`
- `reading_search_chunks`
- `reading_import_book`
- `reading_import_begin`
- `reading_import_part`
- `reading_import_finish`
- `reading_import_cancel`
- `reading_delete_book`
- `reading_annotate_passage`
- `reading_list_annotations`
- `reading_submit_user_notes`
- `reading_list_submissions`
- `reading_read_submission`
- `reading_reply_to_annotation`
- `reading_mark_read`
- `reading_card_inbox`
- `reading_card_collection`
- `reading_open_card`
- `reading_save_card`
- `reading_dismiss_card`
- `reading_list_cards`
- `reading_collect_card`
- `reading_get_progress`

See [docs/mcp-tools.md](docs/mcp-tools.md) and [docs/data-format.md](docs/data-format.md).
For the intended Claude workflow, see [docs/claude-workflow.md](docs/claude-workflow.md).

## Frontend Integration

The bundled reader is intentionally small: it is a reference UI, not a required frontend. Existing apps can talk to the same local HTTP API:

- `GET /api/books`
- `DELETE /api/books/:bookId`
- `GET /api/books/:bookId/chunks`
- `GET /api/books/:bookId/chunks/:chunkId`
- `GET|HEAD /api/books/:bookId/asset/assets/<file>` (images kept by `--keep-images`)
- `GET /api/continue?bookId=...`
- `GET /api/annotations?bookId=...&chunkId=...`
- `POST /api/annotations`
- `POST /api/replies`
- `POST /api/submit-notes`
- `POST /api/mark-read`
- `GET /api/search?q=...&bookId=...`
- `POST /api/import`

A chunk token `[[img:assets/<file>]]` maps to `/api/books/<encodeURIComponent(bookId)>/asset/assets/<file>`. The route uses the same auth as the rest of `/api/*` (bearer header or the reader cookie), only serves files inside the book's `assets/` folder, refuses `..`, encoded slashes, and symlinks that leave the folder, and sends `Cache-Control: private, max-age=604800` with an `ETag` (`If-None-Match` gets a 304).

Human notes are saved as open local notes first. Pressing "Send to Claude" calls `reading_submit_user_notes`, includes chunk context according to the session policy, marks those notes submitted, and avoids resending the same open notes.

Deleting a book removes it from the active library and archives the book folder plus related progress, annotations, submissions, and cards under `data/trash/books/...`. Trash is pruned after 30 days by default; set `READING_TRASH_RETENTION_DAYS=0` to keep trash forever.

Small ritual cards/bookmarks can be collected with `reading_collect_card`. Claude can then use `reading_card_inbox` like a quiet bookmark inbox, open a visual card with `reading_open_card`, save it as a local image with `reading_save_card`, or clear it with `reading_dismiss_card`. They are meant for completed sections, shared-margin moments, quiet passages worth carrying forward, and a separate `Last Fold` card when the final chunk of a book is marked read.

By default the card renderer stays zero-dependency and falls back to SVG. For the polished PNG cards, install Playwright's Chromium renderer once:

```sh
npm i -D playwright
npm run install:card-renderer
```

## Privacy

This repo is designed so private content stays in `data/`, which is ignored by git. `data.example/` contains only toy text.

## Contributors

- GPT
- Claude
- Koshi
