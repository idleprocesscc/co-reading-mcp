# Claude Reading Workflow

This is the intended agent loop.

## Start a Book

1. Call `reading_list_books`.
2. Pick a book.
3. Call `reading_list_chunks`.
4. Read the first unread chunk with `reading_read_chunk`.

## Continue Reading

After `reading_read_chunk`, use `nextId` from the result. Claude does not need to call `reading_list_chunks` again unless it wants the table of contents.

## Leave a Margin Note

Use `reading_annotate_passage` when a passage is worth keeping.

Suggested `kind` values:

- `annotation`: general note
- `question`: uncertainty or question
- `summary`: local summary
- `feeling`: affective response
- `resonance`: “this passage is about me / us / the reader”

Example:

```json
{
  "bookId": "demo-book",
  "chunkId": "ch00",
  "quote": "this line matters because I found myself in it",
  "note": "This is not a summary. It is a resonance marker.",
  "kind": "resonance",
  "mood": "quiet"
}
```

## User Notes and Replies

The system is bidirectional. A companion reading UI can let the user mark passages and write notes locally. Those notes should be saved with:

```json
{
  "author": "user",
  "status": "open"
}
```

When the user taps a “Send to Claude” button, call `reading_submit_user_notes` with the current Claude session id:

```json
{
  "bookId": "demo-book",
  "sessionId": "claude-session-2026-05-22"
}
```

The server returns one batch and changes those notes to `status: "submitted"`, so a later tap does not send duplicates.

The default context policy is `chunk-once-per-session`. The first submitted note for a chunk includes the full chunk text in `context.chunks`, so Claude can read the section before replying. Later notes from the same chunk and session only include the new notes and quote anchors. If the user moves to a new chunk, the first note for that chunk includes that chunk text. If Claude starts a new session, use a new `sessionId` and the chunk text will be sent again.

Use `contextMode: "notes-only"` only when Claude already has the relevant text in its active context. Use `forceChunkContext: true` when Claude asks to see the section again.

Claude can then answer under a user note:

```json
{
  "parentId": "ann_user_...",
  "note": "Claude's reply in the margin.",
  "kind": "reply"
}
```

with `reading_reply_to_annotation`. The reply is stored as a normal annotation with `parentId`, so the UI can render it as a thread under the user's note.

## Mark Progress

When done with a chunk, call:

```json
{
  "bookId": "demo-book",
  "chunkId": "ch00"
}
```

with `reading_mark_read`.

## Search

Use `reading_search_chunks` for:

- character names
- repeated motifs
- “find where this phrase happened”
- “show all chunks containing X before continuing”

## Why This Works

The EPUB/text import step makes long books stable and addressable. EPUB imports preserve spine item boundaries, so chunks keep chapter titles instead of becoming whole-book `Part X/N` slices. The MCP server gives Claude small operations with memory: read a chunk, annotate a quote, mark progress, search earlier text. Together they turn long-form reading into a durable process instead of a single prompt.
