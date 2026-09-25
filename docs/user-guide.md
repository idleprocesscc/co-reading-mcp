# Co-Reading User Guide

This guide is the shortest path from a fresh clone to human + Claude co-reading.

## What Runs Where

Co-Reading has three surfaces that share the same `data/` folder:

- Reader web app: humans open this in a browser to import books, read, highlight, and write notes.
- REST API: the reader web app uses this to save notes and upload EPUB/TXT files.
- MCP server: Claude uses this to read chunks, search, annotate, reply to notes, and mark progress.

For remote setups such as claude.ai, chat attachments are not automatically available on the MCP server filesystem. Import books from the reader web app unless you know your Claude client can pass file bytes to MCP tools.

## Local Setup

Requirements:

- Node.js 18+
- Python 3.10+

```bash
git clone https://github.com/idleprocesscc/co-reading-mcp.git
cd co-reading-mcp
cp -R data.example data
npm run reader
```

Open:

```text
http://127.0.0.1:8787/
```

This starts one process with:

- reader UI at `/`
- REST API at `/api/*`
- MCP stdio on the same process

## Import a Book From the Browser

1. Open the reader UI.
2. Click the `+` button in the Library header.
3. Choose one or more `.epub`, `.txt`, `.md`, or `.markdown` files.
4. Wait for the status line to say the import finished.
5. Select the book from the Library.

The browser uploads file bytes directly to the Co-Reading server with `POST /api/import`. No SSH or manual script run is needed.

## Connect Claude Desktop or Claude Code

Use `src/http.js` when you want the same process to serve both the reader and MCP:

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

Claude can then call:

- `reading_list_books`
- `reading_list_chunks`
- `reading_read_chunk`
- `reading_annotate_passage`
- `reading_reply_to_annotation`
- `reading_mark_read`

## Remote Setup for claude.ai

Run the remote server:

```bash
READING_MCP_DATA_DIR=./data MCP_AUTH_TOKEN="change-me" npm run start:sse
```

Expose that one process through HTTPS with a VPS reverse proxy or a tunnel.

URLs:

- `https://your-domain.example/?token=change-me` for the human reader
- `https://your-domain.example/sse` for MCP SSE
- `https://your-domain.example/mcp` for JSON-RPC over POST

When `MCP_AUTH_TOKEN` is set, the reader, static files, `/api/*`, `/sse`, `/messages`, `/mcp`, and `/health` require the token. Open the reader once with `?token=...`; the server sets a same-site cookie, and the reader stores the token in local storage before removing it from the address bar.

## Human Notes

In the reader:

1. Open a book and chapter.
2. Highlight text.
3. Write a note.
4. The note is saved locally as an open user note.
5. Click `Send to Claude` when you want Claude to receive the staged notes.

The server sends each note once and marks it submitted so the next send does not duplicate it.

Replies that you type under Claude's margin notes follow the same rule: they are saved as open user replies first, then included the next time you click `Send to Claude`. Every reply in a thread has its own small `Reply` link, so you can answer one particular message instead of only the thread's first note.

The address bar keeps the open book and chapter (`#/book/<bookId>/<chunkId>`), so reloading the page returns to the same place. `←` / `→` move to the previous or next chunk when you are not typing.

## Books With Images

Leave `Keep EPUB images on import` checked in the Library panel (or pass `--keep-images` to `scripts/import_epub.py`) to keep an EPUB's pictures and formula images. Figures and display formulas show on their own line; inline formulas sit inside the sentence at text height. Dark mode inverts them so black-on-white art stays readable.

Highlighting across an image works: the saved quote keeps the image placeholder, so the note anchors to the same spot and Claude sees where the formula was.

## Claude Notes and Replies

Claude should:

1. Use `reading_read_chunk` to read a chunk.
2. Use `reading_annotate_passage` to leave margin notes.
3. Use `reading_reply_to_annotation` to reply under a human note.
4. Use `reading_mark_read` when done with a chunk.

Claude replies are stored under the original note with `parentId`, so the reader can show a thread around the same passage.

Replies can nest more than one level deep. The reader renders the whole thread under the original highlighted passage, so a Claude reply under a human reply still appears in the margin instead of becoming a detached note.

## Context Policy

When the human clicks `Send to Claude`, `reading_submit_user_notes` uses `chunk-once-per-session` by default:

- first note from a chunk in a Claude session includes the full chunk text
- later notes from that same chunk in the same session send only note and quote anchors
- a new Claude session should use a new `sessionId`, which allows chunk text to be sent again

This keeps cross-session context safe while avoiding repeated full chapter text inside one conversation.

## Command-Line Import Still Exists

The browser import is the easiest path, but scripts are still useful for automation.

EPUB:

```bash
python3 scripts/import_epub.py ./book.epub --out ./data/books
# keep pictures and formula images:
python3 scripts/import_epub.py ./book.epub --out ./data/books --keep-images
```

TXT with chapter headings:

```bash
python3 scripts/import_text.py ./book.txt \
  --title "Book Title" \
  --heading-regex "^Chapter\\s+\\w+" \
  --out ./data/books
```
