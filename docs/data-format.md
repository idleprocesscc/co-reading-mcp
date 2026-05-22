# Data Format

## Book Manifest

Each imported book lives under `data/books/<book-id>/manifest.json`.

```json
{
  "bookId": "demo-book",
  "title": "Demo Book",
  "author": "Example Author",
  "chunks": [
    {
      "id": "ch00",
      "title": "A Small Lamp Part 1/2",
      "sectionTitle": "A Small Lamp",
      "sectionIndex": 0,
      "sectionPart": 1,
      "sectionPartCount": 2,
      "sourcePath": "OPS/chapter01.xhtml",
      "order": 0,
      "path": "chunks/ch00.txt",
      "charCount": 331,
      "wordCount": 62,
      "prevId": null,
      "nextId": "ch01"
    }
  ]
}
```

`path` is relative to the book directory.

## Annotations

Annotations are stored as JSONL in `data/annotations.jsonl`.

```json
{
  "id": "ann_...",
  "bookId": "demo-book",
  "chunkId": "ch00",
  "quote": "selected passage",
  "note": "margin note",
  "author": "claude",
  "kind": "resonance",
  "mood": "quiet",
  "tags": ["optional"],
  "status": "published",
  "parentId": null,
  "createdAt": "2026-05-22T00:00:00.000Z"
}
```

`kind` is intentionally flexible. Suggested values are `annotation`, `question`, `summary`, `feeling`, and `resonance`.

`status` supports the bidirectional co-reading flow:

- `open`: a local user note waiting to be submitted
- `submitted`: a user note that has already been sent to Claude
- `published`: Claude notes, Claude replies, or already-public notes

`parentId` creates threads. A Claude reply under a user note stores the user's annotation id as `parentId`.

## Progress

Progress is stored in `data/progress.json`.

```json
{
  "demo-book": {
    "lastChunkId": "ch00",
    "lastReadAt": "2026-05-22T00:00:00.000Z",
    "readChunkIds": ["ch00"]
  }
}
```

## Session Context Ledger

Submitted user notes use `data/reading_sessions.json` to avoid sending the same chunk text repeatedly inside one Claude session.

```json
{
  "sessions": {
    "claude-session-2026-05-22": {
      "chunks": {
        "demo-book/ch00": {
          "bookId": "demo-book",
          "chunkId": "ch00",
          "sentAt": "2026-05-22T00:00:00.000Z",
          "contextMode": "chunk-once-per-session"
        }
      },
      "annotations": {
        "ann_...": {
          "bookId": "demo-book",
          "chunkId": "ch00",
          "submittedAt": "2026-05-22T00:00:00.000Z"
        }
      }
    }
  }
}
```

Changing `sessionId` intentionally resets chunk context dedupe, so cross-session handoffs include the relevant chunk text again.
