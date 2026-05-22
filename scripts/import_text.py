#!/usr/bin/env python3
"""Import a plain text file into the Co-Reading MCP chunk format."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^\w\u4e00-\u9fff]+", "-", value, flags=re.UNICODE)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "book"


def count_words(text: str) -> int:
    words = re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]", text)
    return len(words)


def is_semantic_break(prev: str, current: str) -> bool:
    break_markers = {"***", "---", "* * *", "◆", "■", "●", "○", "☆"}
    if prev.strip() in break_markers or current.strip() in break_markers:
        return True
    if len(prev.strip()) < 20 and prev.strip().isdigit():
        return True
    return prev.endswith(("。", "。\"", "。』", "。）", ".", ".\"", "?\"", "？\"", "！\""))


def split_text(text: str, max_chars: int) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return [text.strip()]
    if sum(len(p) + 2 for p in paragraphs) <= max_chars:
        return ["\n\n".join(paragraphs)]

    chunks: list[str] = []
    start = 0

    while start < len(paragraphs):
        current_len = 0
        end = start

        while end < len(paragraphs):
            paragraph_len = len(paragraphs[end]) + 2
            if current_len + paragraph_len > max_chars and end > start:
                break
            current_len += paragraph_len
            end += 1

        if end >= len(paragraphs):
            chunks.append("\n\n".join(paragraphs[start:]))
            break

        search_start = max(start + 1, end - 5)
        search_end = min(len(paragraphs), end + 3)
        best_cut = end
        for index in range(search_end - 1, search_start - 1, -1):
            if is_semantic_break(paragraphs[index - 1], paragraphs[index]):
                best_cut = index
                break

        chunks.append("\n\n".join(paragraphs[start:best_cut]))
        start = best_cut

    return chunks or [text.strip()]


def chunk_id(index: int) -> str:
    return f"ch{index:02d}"


def write_book_sections(
    sections: list[dict[str, Any]],
    title: str,
    author: str | None,
    out_dir: Path,
    book_id: str | None,
    max_chars: int,
    source: dict[str, Any] | None = None,
) -> Path:
    resolved_book_id = book_id or slugify(title)
    book_dir = out_dir / resolved_book_id
    chunks_dir = book_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    planned_chunks = []
    for section_index, section in enumerate(sections):
        section_title = section.get("title") or f"Section {section_index + 1}"
        section_text = section.get("text") or ""
        section_chunks = split_text(section_text, max_chars)
        for part_index, chunk in enumerate(section_chunks):
            part_count = len(section_chunks)
            display_title = section_title if part_count == 1 else f"{section_title} Part {part_index + 1}/{part_count}"
            planned_chunks.append(
                {
                    "text": chunk,
                    "title": display_title,
                    "sectionTitle": section_title,
                    "sectionIndex": section_index,
                    "sectionPart": part_index + 1,
                    "sectionPartCount": part_count,
                    "sourcePath": section.get("sourcePath"),
                }
            )

    manifest_chunks = []
    for index, planned in enumerate(planned_chunks):
        cid = chunk_id(index)
        path = chunks_dir / f"{cid}.txt"
        chunk = planned["text"]
        path.write_text(f"# {planned['title']}\n\n{chunk.strip()}\n", encoding="utf-8")
        manifest_chunks.append(
            {
                "id": cid,
                "title": planned["title"],
                "sectionTitle": planned["sectionTitle"],
                "sectionIndex": planned["sectionIndex"],
                "sectionPart": planned["sectionPart"],
                "sectionPartCount": planned["sectionPartCount"],
                "sourcePath": planned["sourcePath"],
                "order": index,
                "path": f"chunks/{cid}.txt",
                "charCount": len(chunk),
                "wordCount": count_words(chunk),
                "prevId": chunk_id(index - 1) if index > 0 else None,
                "nextId": chunk_id(index + 1) if index < len(planned_chunks) - 1 else None,
            }
        )

    manifest = {
        "bookId": resolved_book_id,
        "title": title,
        "author": author,
        "language": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": source or {"type": "text"},
        "chunks": manifest_chunks,
    }
    (book_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return book_dir


def write_book(
    text: str,
    title: str,
    author: str | None,
    out_dir: Path,
    book_id: str | None,
    max_chars: int,
) -> Path:
    return write_book_sections(
        [{"title": title, "text": text, "sourcePath": None}],
        title,
        author,
        out_dir,
        book_id,
        max_chars,
        {"type": "text"},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--title", required=True)
    parser.add_argument("--author")
    parser.add_argument("--book-id")
    parser.add_argument("--out", type=Path, default=Path("data/books"))
    parser.add_argument("--max-chars", type=int, default=6000)
    args = parser.parse_args()

    text = args.input.read_text(encoding="utf-8")
    book_dir = write_book(text, args.title, args.author, args.out, args.book_id, args.max_chars)
    print(book_dir)


if __name__ == "__main__":
    main()
