# Co-Reading MCP

A local MCP server that gives Claude a durable reading room:

- import EPUB or plain text into stable chunks while preserving EPUB spine/chapter boundaries
- list books and chunks
- read chunk-by-chunk with `prevId` / `nextId`
- search across a book
- write margin annotations
- stage user notes, submit them to Claude once, and attach Claude replies under them
- track reading progress

The goal is not one-shot summarization. The goal is a shared reading surface where a human and Claude can both read, leave anchored notes, and resume smoothly.

## Quick Start

Requirements:

- Node.js 18+
- Python 3.10+ for the import scripts

```bash
cd reading-mcp
cp -R data.example data
node src/server.js
```

For Claude Desktop / Claude Code, configure the MCP server as a stdio command:

```json
{
  "mcpServers": {
    "co-reading": {
      "command": "node",
      "args": ["/absolute/path/to/reading-mcp/src/server.js"],
      "env": {
        "READING_MCP_DATA_DIR": "/absolute/path/to/reading-mcp/data"
      }
    }
  }
}
```

## Import Books

Plain text:

```bash
python3 scripts/import_text.py ./book.txt --title "Book Title" --author "Author" --out ./data/books
```

EPUB:

```bash
python3 scripts/import_epub.py ./book.epub --out ./data/books
```

Both importers create:

```text
data/books/<book-id>/
  manifest.json
  chunks/
    ch00.txt
    ch01.txt
```

EPUB imports keep each spine item as a section boundary. If a chapter is longer than `--max-chars`, only that chapter is split into `Chapter Title Part 1/N`, `Part 2/N`, and so on.

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
- `reading_search_chunks`
- `reading_annotate_passage`
- `reading_list_annotations`
- `reading_submit_user_notes`
- `reading_reply_to_annotation`
- `reading_mark_read`
- `reading_get_progress`

See [docs/mcp-tools.md](docs/mcp-tools.md) and [docs/data-format.md](docs/data-format.md).
For the intended Claude workflow, see [docs/claude-workflow.md](docs/claude-workflow.md).

## Privacy

This repo is designed so private content stays in `data/`, which is ignored by git. `data.example/` contains only toy text.

## Contributors

Created by Koshi with Claude and GPT.
