#!/usr/bin/env python3
"""Import a plain text file into the Co-Reading MCP chunk format."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Image placeholder left in chunk text by `import_epub.py --keep-images`.
IMG_TOKEN_RE = re.compile(r"\[\[img:[^\]\n]+\]\]")


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


def split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def split_ranges(paragraphs: list[str], max_chars: int) -> list[tuple[int, int]]:
    """Pick chunk boundaries as [start, end) paragraph index ranges."""
    if sum(len(p) + 2 for p in paragraphs) <= max_chars:
        return [(0, len(paragraphs))]

    ranges: list[tuple[int, int]] = []
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
            ranges.append((start, len(paragraphs)))
            break

        search_start = max(start + 1, end - 5)
        search_end = min(len(paragraphs), end + 3)
        best_cut = end
        for index in range(search_end - 1, search_start - 1, -1):
            if is_semantic_break(paragraphs[index - 1], paragraphs[index]):
                best_cut = index
                break

        ranges.append((start, best_cut))
        start = best_cut

    return ranges


def split_text(text: str, max_chars: int) -> list[str]:
    paragraphs = split_paragraphs(text)
    if not paragraphs:
        return [text.strip()]
    chunks = ["\n\n".join(paragraphs[start:end]) for start, end in split_ranges(paragraphs, max_chars)]
    return chunks or [text.strip()]


def rich_units(rich_text: str) -> list[list[str]]:
    """Group rich paragraphs so each group lines up with one text-only paragraph.

    A paragraph that is nothing but image tokens has no text-only counterpart,
    so it rides along with the next paragraph (or the last one at the end).
    """
    units: list[list[str]] = []
    pending: list[str] = []
    for paragraph in split_paragraphs(rich_text):
        if IMG_TOKEN_RE.sub("", paragraph).strip():
            units.append(pending + [paragraph])
            pending = []
        else:
            pending.append(paragraph)
    if pending:
        if units:
            units[-1].extend(pending)
        else:
            units.append(pending)
    return units


def split_rich_text(text: str, rich_text: str, max_chars: int) -> list[str]:
    """Split image-bearing text at the same places split_text would split `text`.

    Chunk count, titles and ids then match a text-only import of the same book.
    """
    paragraphs = split_paragraphs(text)
    units = rich_units(rich_text)
    if paragraphs and len(units) == len(paragraphs):
        ranges = split_ranges(paragraphs, max_chars)
    else:
        # Paragraphs did not line up; measure image tokens as one character instead.
        print("warning: image text did not line up with plain text; chunking it separately", file=sys.stderr)
        ranges = split_ranges([IMG_TOKEN_RE.sub("#", "\n\n".join(unit)) for unit in units], max_chars)
    chunks = ["\n\n".join(p for unit in units[start:end] for p in unit) for start, end in ranges]
    return chunks or [rich_text.strip()]


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
        rich_text = section.get("richText")
        if rich_text is None:
            section_chunks = split_text(section_text, max_chars)
        else:
            section_chunks = split_rich_text(section_text, rich_text, max_chars)
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
                    "hasImages": rich_text is not None,
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
                "wordCount": count_words(IMG_TOKEN_RE.sub(" ", chunk) if planned["hasImages"] else chunk),
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


def sections_from_heading_regex(
    text: str,
    heading_regex: str,
    min_section_chars: int = 1,
) -> list[dict[str, Any]]:
    pattern = re.compile(heading_regex, re.MULTILINE)
    matches = list(pattern.finditer(text))
    if not matches:
        return []

    sections: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        section_text = text[start:end].strip()
        title = match.group(1).strip() if match.groups() else match.group(0).strip()
        if section_text and len(section_text) >= min_section_chars:
            sections.append({"title": title, "text": section_text, "sourcePath": None})
    return sections


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--title", required=True)
    parser.add_argument("--author")
    parser.add_argument("--book-id")
    parser.add_argument("--out", type=Path, default=Path("data/books"))
    parser.add_argument("--max-chars", type=int, default=6000)
    parser.add_argument(
        "--heading-regex",
        help=(
            "Optional multiline regex for TXT section headings. If the regex has a capture "
            "group, group 1 becomes the section title; otherwise the full match is used."
        ),
    )
    parser.add_argument(
        "--min-section-chars",
        type=int,
        default=1,
        help="When using --heading-regex, skip sections shorter than this many characters.",
    )
    args = parser.parse_args()

    text = args.input.read_text(encoding="utf-8")
    if args.heading_regex:
        sections = sections_from_heading_regex(text, args.heading_regex, args.min_section_chars)
        if sections:
            book_dir = write_book_sections(
                sections,
                args.title,
                args.author,
                args.out,
                args.book_id,
                args.max_chars,
                {
                    "type": "text",
                    "headingRegex": args.heading_regex,
                    "minSectionChars": args.min_section_chars,
                },
            )
        else:
            book_dir = write_book(text, args.title, args.author, args.out, args.book_id, args.max_chars)
    else:
        book_dir = write_book(text, args.title, args.author, args.out, args.book_id, args.max_chars)
    print(book_dir)


if __name__ == "__main__":
    main()
