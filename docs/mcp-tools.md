# MCP Tools

## `reading_list_books`

Returns all imported books with progress and annotation counts. Annotation counts are cached by `annotations.jsonl` file signature so repeated calls do not re-parse the JSONL file unless it changes.

## `reading_list_chunks`

Input:

```json
{ "bookId": "anthropic-guidelines" }
```

Returns chunks in reading order, including `prevId`, `nextId`, `read`, and `annotationCount`.

## `reading_read_chunk`

Input:

```json
{ "bookId": "anthropic-guidelines", "chunkId": "ch00" }
```

Returns the chunk text plus neighboring ids.

## `reading_continue`

Input:

```json
{ "bookId": "anthropic-guidelines" }
```

`bookId` is optional. When omitted, the server uses the most recently read book.

Returns the next unread chunk after `lastChunkId`. If `lastChunkId` is missing or stale, it falls back to the first unread chunk. If the book is already complete, it returns `completed: true` and a progress summary instead of chunk text.

## `reading_search_chunks`

Input:

```json
{ "bookId": "anthropic-guidelines", "query": "values", "limit": 10 }
```

Returns matching snippets.

Chunk text is cached by file signature after first read. Search is still a simple substring scan, but repeated searches avoid re-reading every chunk from disk.

## `reading_import_book`

Input:

```json
{
  "filename": "book.epub",
  "dataBase64": "...",
  "bookId": "optional-stable-id",
  "overwrite": false
}
```

Imports one EPUB or TXT/Markdown file from base64 content. Use this when the file fits inside one MCP request. `dataBase64` can be raw base64 or a `data:*;base64,...` URL.

For TXT/Markdown imports, optional fields mirror `scripts/import_text.py`:

```json
{
  "filename": "book.txt",
  "dataBase64": "...",
  "title": "Book Title",
  "author": "Author",
  "headingRegex": "^Chapter\\s+\\w+",
  "minSectionChars": 100,
  "maxChars": 6000
}
```

The server validates the file type, upload size, and `bookId`, writes the book into `data/books`, and returns the imported `bookId`, title, and chunk count.

## Chunked Import

Use chunked import when a file is too large for one JSON-RPC body.

1. Start:

```json
{
  "filename": "large.epub",
  "expectedBytes": 1234567,
  "bookId": "large-book"
}
```

Call `reading_import_begin` and keep the returned `uploadId`.

2. Append base64 parts:

```json
{
  "uploadId": "...",
  "index": 0,
  "dataBase64": "..."
}
```

Call `reading_import_part` once per binary part. Each part should be independently base64-encoded; do not split a single base64 string at arbitrary characters.

3. Finish:

```json
{ "uploadId": "..." }
```

Call `reading_import_finish` to run the importer. Use `reading_import_cancel` to discard an unfinished upload.

## `reading_annotate_passage`

Input:

```json
{
  "bookId": "anthropic-guidelines",
  "chunkId": "ch00",
  "quote": "this line matters",
  "note": "This is a resonance note.",
  "author": "claude",
  "kind": "resonance",
  "mood": "quiet",
  "tags": ["identity"],
  "status": "published",
  "parentId": null
}
```

Writes one JSONL annotation. If the quote is present in the chunk, the returned object includes a `quoteOffset`. Root annotations also return `annotationIndexInBook`, `annotationIndexInChunk`, and a short `message` such as “Saved annotation 12 in this book.”

For a user-facing reading app, create user notes with:

```json
{
  "bookId": "anthropic-guidelines",
  "chunkId": "ch00",
  "quote": "this line matters",
  "note": "I want Claude to comment on this.",
  "author": "user",
  "status": "open"
}
```

## `reading_list_annotations`

Input:

```json
{ "bookId": "anthropic-guidelines", "chunkId": "ch00", "kind": "resonance", "status": "published" }
```

All fields are optional except `bookId` in most practical use.

By default this tool hides human notes with `status: "open"`, `"private"`, or `"draft"` and hides replies under those private notes. This lets a reader save notes and leave without exposing them to Claude. A trusted local UI can pass `includePrivate: true`; Claude-facing MCP clients should not.

## `reading_submit_user_notes`

Input:

```json
{
  "bookId": "anthropic-guidelines",
  "sessionId": "claude-session-2026-05-22",
  "contextMode": "chunk-once-per-session"
}
```

Finds all user annotations with `status: "open"`, `"private"`, or `"draft"`, returns them as one batch for Claude, and rewrites them to `status: "submitted"` so the same notes are not sent again.

This is the tool a companion app or Claude-facing integration should call when the user taps “Send notes to Claude”. In the built-in browser reader, this action publishes the private notes so Claude can retrieve them through MCP and returns the context package to the HTTP caller; it is not a push notification into claude.ai by itself.

By default, `contextMode` is `chunk-once-per-session`: the first submitted user note for a chunk includes that chunk's full text in `context.chunks`. Later notes for the same chunk and `sessionId` only send the new notes, with the repeated chunk listed in `context.omittedChunks`. A new `sessionId` starts fresh and includes the chunk again.

Supported context modes:

- `chunk-once-per-session`: default; send each chunk once per Claude session
- `chunk-always`: include full chunk text every time
- `notes-only`: send only the submitted notes and quote anchors

Set `forceChunkContext: true` to re-send chunk text inside the same session.

Each successful submit also writes a submission batch. Use `reading_list_submissions` to find recent shared batches and `reading_read_submission` to read one batch with notes and context.

## `reading_list_submissions`

Input:

```json
{ "bookId": "anthropic-guidelines", "limit": 10 }
```

Returns recent human note submission summaries. The summary includes `id`, `submittedAt`, note ids, chunk ids, and a compact context summary.

## `reading_read_submission`

Input:

```json
{ "submissionId": "sub_..." }
```

Returns one submitted batch with its notes and context package.

## `reading_reply_to_annotation`

Input:

```json
{
  "parentId": "ann_guidelines_user_001",
  "note": "Claude's reply under this user note.",
  "kind": "reply"
}
```

Creates a Claude annotation with `parentId` pointing to the original note. If `bookId`, `chunkId`, or `quote` are omitted, they are inherited from the parent annotation.

## `reading_mark_read`

Input:

```json
{ "bookId": "anthropic-guidelines", "chunkId": "ch00" }
```

Marks a chunk as read and updates `lastChunkId`. The response includes `chunksRead`, `chunkCount`, `complete`, and a human-readable `message`.

When the marked chunk completes the book, the response also includes:

```json
{
  "finish": {
    "annotationCount": 32,
    "moodCounts": { "quiet": 4 },
    "kindCounts": { "resonance": 12, "feeling": 5 },
    "celebration": {
      "title": "Book finished, margins preserved.",
      "line": "The reading is done; the conversation can keep unfolding from any note.",
      "prompt": "Write a short closing note that feels like placing a bookmark after the final page."
    },
    "message": "Congratulations, Book Title is complete: 43/43 chunks, 32 annotations."
  }
}
```

`finish.celebration` is intentionally small and variable. Claude can use it as a closing ritual, or a frontend can ignore it and keep only the stable counts.

## `reading_collect_card`

Input:

```json
{
  "bookId": "anthropic-guidelines",
  "chunkId": "ch00",
  "kicker": "收获了一枚回声书签",
  "title": "Book Title",
  "quote": "a sentence worth carrying forward",
  "note": "Why this passage became a card.",
  "art": "fold"
}
```

Collects a small ritual reading card/bookmark for later. `art` can be `fold`, `ripple`, or `stardust`. Use this for completed sections, shared-margin moments, or quiet passages worth carrying forward.

## `reading_card_inbox`

Input:

```json
{ "bookId": "anthropic-guidelines", "limit": 10 }
```

Returns only unread card prompts, such as “收获了一枚回声书签”, with the `cardId` needed to open or dismiss them. This is the reader-facing flow Claude should use instead of reading raw card data.

## `reading_open_card`

Input:

```json
{ "cardId": "card_..." }
```

Returns the selected card as image content so Claude can view it directly. If Playwright Chromium is installed, the card is rendered as a polished PNG from the same HTML/CSS card template used by the reader; otherwise the server falls back to an SVG image. The text part is only a short caption.

## `reading_save_card`

Input:

```json
{ "cardId": "card_..." }
```

Renders the selected card to a local image file and returns its absolute path plus `mimeType`. Use this when the host client can send local files after MCP returns a path.

## `reading_dismiss_card`

Input:

```json
{ "cardId": "card_..." }
```

Marks a card as dismissed so it no longer appears in `reading_card_inbox`. The card remains in `cards.jsonl` and can still be found with `reading_list_cards`.

## `reading_list_cards`

Input:

```json
{ "bookId": "anthropic-guidelines", "limit": 10 }
```

Lists collected cards, newest first. Cards are stored separately from annotations in `cards.jsonl`, so they can act like lightweight bookmarks instead of new margin notes.

## `reading_get_progress`

Input:

```json
{ "bookId": "anthropic-guidelines" }
```
