#!/usr/bin/env python3
"""Import an EPUB into the Co-Reading MCP chunk format.

This is deliberately dependency-light. It reads the EPUB zip, extracts XHTML/HTML
documents in spine order when possible, falls back to all HTML files otherwise,
strips tags, and writes chunks while preserving spine item boundaries.

--keep-images (optional; without it the output is unchanged):
  * every <img> in a spine document is copied to <book>/assets/ (file name
    sanitized) and replaced in the text by a [[img:assets/<file>]] token. An
    image that is the only content of its block (display equation, figure)
    ends up as its own paragraph; an inline image stays inside its sentence.
  * <sup>/<sub> become Unicode super/subscripts when every character has one
    (t², x₀), otherwise ^x / _x (multi-char: ^(..) / _(..)).
  * sections, section titles, chunk boundaries and chunk ids are decided on
    the text-only version, so they match an import without --keep-images.
    Images from fragments the text-only import drops (cover pages, image-only
    title cards) are folded into the next section after its first paragraph.
"""

from __future__ import annotations

import argparse
import html
import posixpath
import re
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from urllib.parse import unquote

from import_text import IMG_TOKEN_RE, slugify, write_book_sections


CONTAINER = "META-INF/container.xml"

_SUP_MAP = dict(zip(
    "0123456789+-−=()（）niabcdefghjklmoprstuvwxyzABDEGHIJKLMNOPRTUVW",
    "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾⁽⁾ⁿⁱᵃᵇᶜᵈᵉᶠᵍʰʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ",
))
_SUB_MAP = dict(zip(
    "0123456789+-−=()（）aehijklmnoprstuvxβγρφχ",
    "₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ",
))
_SUPSUB_RE = re.compile(r"<(sup|sub)\b[^>]*>(.*?)</\1\s*>", re.DOTALL | re.IGNORECASE)
_IMG_RE = re.compile(r"<img\b[^>]*?>", re.IGNORECASE | re.DOTALL)
_SRC_RE = re.compile(r"""\bsrc\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)


def supsub_text(kind: str, inner: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", "", inner)).strip()
    if not text:
        return ""
    table = _SUP_MAP if kind == "sup" else _SUB_MAP
    if all(ch in table for ch in text):
        return "".join(table[ch] for ch in text)
    mark = "^" if kind == "sup" else "_"
    return f"{mark}{text}" if len(text) == 1 else f"{mark}({text})"


def sanitize_asset_name(name: str) -> str:
    stem, ext = posixpath.splitext(posixpath.basename(name))
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "img"
    ext = re.sub(r"[^A-Za-z0-9.]+", "", ext).lower()
    return stem + ext


class ImageCollector:
    """Rewrites <img>/<sup>/<sub> in XHTML and remembers which images to copy."""

    def __init__(self, zf: zipfile.ZipFile):
        self.zf = zf
        self.names = set(zf.namelist())
        self.by_zip_path: dict[str, str] = {}
        self.taken: set[str] = set()
        self.missing: list[str] = []
        self.data: dict[str, bytes] = {}

    def asset_for(self, doc_path: str, src: str) -> str | None:
        src = unquote((src or "").split("#", 1)[0].split("?", 1)[0]).strip()
        if not src or src.startswith(("data:", "http:", "https:")):
            return None
        doc_dir = posixpath.dirname(doc_path.replace("\\", "/"))
        zip_path = posixpath.normpath(posixpath.join(doc_dir, src)).lstrip("/")
        if zip_path not in self.names:
            matches = sorted(n for n in self.names if posixpath.basename(n) == posixpath.basename(src))
            if not matches:
                self.missing.append(src)
                return None
            zip_path = matches[0]
        if zip_path in self.by_zip_path:
            return self.by_zip_path[zip_path]
        name = sanitize_asset_name(zip_path)
        stem, ext = posixpath.splitext(name)
        counter = 1
        while name in self.taken:
            counter += 1
            name = f"{stem}-{counter}{ext}"
        self.taken.add(name)
        self.by_zip_path[zip_path] = name
        return name

    def rewrite(self, doc_path: str, raw: str) -> str:
        raw = _SUPSUB_RE.sub(
            lambda m: html.escape(supsub_text(m.group(1).lower(), m.group(2)), quote=False),
            raw,
        )

        def img_sub(match: re.Match[str]) -> str:
            src = _SRC_RE.search(match.group(0))
            name = self.asset_for(doc_path, src.group(2) if src else "")
            return f"[[img:assets/{name}]]" if name else ""

        return _IMG_RE.sub(img_sub, raw)

    def load(self) -> None:
        """Read the referenced image bytes while the EPUB is still open."""
        self.data = {name: self.zf.read(zip_path) for zip_path, name in self.by_zip_path.items()}

    def write_assets(self, assets_dir: Path) -> int:
        if assets_dir.exists():
            shutil.rmtree(assets_dir)
        if not self.data:
            return 0
        assets_dir.mkdir(parents=True, exist_ok=True)
        for name, data in self.data.items():
            (assets_dir / name).write_bytes(data)
        return len(self.data)


def insert_after_first_paragraph(text: str, extra: list[str]) -> str:
    parts = re.split(r"\n\s*\n", text, maxsplit=1)
    block = "\n\n".join(extra)
    return f"{parts[0]}\n\n{block}\n\n{parts[1]}" if len(parts) == 2 else f"{parts[0]}\n\n{block}"


def ns_name(name: str) -> str:
    return name.split("}", 1)[-1]


def strip_tags(raw: str) -> str:
    raw = re.sub(r"(?is)<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"\s+", " ", raw)
    return raw.strip()


def title_from_html(raw: str) -> str | None:
    for match in re.finditer(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", raw):
        title = strip_tags(match.group(1))
        if title:
            return title
    title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
    if title_match:
        title = strip_tags(title_match.group(1))
        if title:
            return title
    return None


def text_from_html(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(p|div|section|article|h[1-6]|li|tr)>", "\n\n", raw)
    raw = re.sub(r"(?is)<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
    raw = re.sub(r"\n\s*\n\s*\n+", "\n\n", raw)
    return raw.strip()


def sections_from_html_headings(raw: str) -> list[dict[str, str]]:
    matches = list(re.finditer(r"(?is)<h[1-3][^>]*>.*?</h[1-3]>", raw))
    if len(matches) < 2:
        return []

    sections = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        title = strip_tags(match.group(0)) or f"Section {index + 1}"
        text = text_from_html(raw[start:end])
        if text:
            sections.append({"title": title, "text": text})
    return sections


def heading_fragments(raw: str) -> tuple[str, list[str]]:
    """Text before the first h1-h3 heading, then the text of every heading section."""
    matches = list(re.finditer(r"(?is)<h[1-3][^>]*>.*?</h[1-3]>", raw))
    if not matches:
        return text_from_html(raw), []
    bounds = [match.start() for match in matches] + [len(raw)]
    return text_from_html(raw[: bounds[0]]), [
        text_from_html(raw[bounds[index] : bounds[index + 1]]) for index in range(len(matches))
    ]


def should_split_html_by_headings(raw: str, text: str, ordered_count: int) -> bool:
    sections = sections_from_html_headings(raw)
    return len(sections) >= 2 and (ordered_count == 1 or len(text) > 12000)


def clean_metadata_title(value: str | None, fallback: str) -> str:
    title = (value or "").strip()
    if not title or title.lower() in {"unknown", "untitled", "administrator"} or len(title) <= 1:
        return fallback
    return title


def clean_metadata_author(value: str | None, title: str) -> str | None:
    author = (value or "").strip()
    if not author or author.lower() in {"unknown", "administrator"} or author == title:
        return None
    return author


def find_opf_path(zf: zipfile.ZipFile) -> str | None:
    try:
        root = ET.fromstring(zf.read(CONTAINER))
    except Exception:
        return None

    for element in root.iter():
        if ns_name(element.tag) == "rootfile":
            full_path = element.attrib.get("full-path")
            if full_path:
                return full_path
    return None


def parse_opf(
    zf: zipfile.ZipFile, opf_path: str
) -> tuple[str | None, str | None, list[str], dict[str, str]]:
    root = ET.fromstring(zf.read(opf_path))
    opf_dir = str(Path(opf_path).parent)
    if opf_dir == ".":
        opf_dir = ""

    title = None
    author = None
    manifest: dict[str, str] = {}
    spine_ids: list[str] = []
    toc_path = None

    for element in root.iter():
        local = ns_name(element.tag)
        if local == "title" and element.text and title is None:
            title = element.text.strip()
        elif local == "creator" and element.text and author is None:
            author = element.text.strip()
        elif local == "item":
            item_id = element.attrib.get("id")
            href = element.attrib.get("href")
            media_type = element.attrib.get("media-type", "")
            properties = element.attrib.get("properties", "")
            if item_id and href and ("html" in media_type or href.lower().endswith((".html", ".xhtml", ".htm"))):
                manifest[item_id] = str(Path(opf_dir) / href) if opf_dir else href
            if href and ("nav" in properties.split() or media_type == "application/x-dtbncx+xml"):
                toc_path = str(Path(opf_dir) / href) if opf_dir else href
        elif local == "itemref":
            ref = element.attrib.get("idref")
            if ref:
                spine_ids.append(ref)

    ordered = [manifest[item_id] for item_id in spine_ids if item_id in manifest]
    toc_titles = parse_toc_titles(zf, toc_path, opf_dir) if toc_path else {}
    return title, author, ordered, toc_titles


def parse_toc_titles(zf: zipfile.ZipFile, toc_path: str, opf_dir: str) -> dict[str, str]:
    try:
        raw = zf.read(toc_path)
    except KeyError:
        return {}

    titles: dict[str, str] = {}
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return titles

    def normalize_href(href: str) -> str:
        href = href.split("#", 1)[0]
        if not href:
            return href
        return str(Path(opf_dir) / href) if opf_dir and not href.startswith(opf_dir) else href

    parent_map = {child: parent for parent in root.iter() for child in parent}
    for element in root.iter():
        if ns_name(element.tag) == "content":
            src = element.attrib.get("src", "")
            parent = parent_map.get(element)
            parent_text = "".join(parent.itertext()).strip() if parent is not None else None
            # NCX puts text in a nearby navLabel; ElementTree has no parent links,
            # so NCX titles are handled in the navPoint loop below.
            if src and parent_text:
                titles[normalize_href(src)] = parent_text

    for nav_point in root.iter():
        if ns_name(nav_point.tag) != "navPoint":
            continue
        label = None
        src = None
        for child in nav_point.iter():
            local = ns_name(child.tag)
            if local == "text" and child.text and label is None:
                label = child.text.strip()
            elif local == "content" and src is None:
                src = child.attrib.get("src")
        if label and src:
            titles[normalize_href(src)] = label

    for anchor in root.iter():
        if ns_name(anchor.tag) != "a":
            continue
        href = anchor.attrib.get("href")
        text = "".join(anchor.itertext()).strip()
        if href and text:
            titles[normalize_href(href)] = text

    return titles


def html_files(zf: zipfile.ZipFile) -> list[str]:
    return sorted(
        name
        for name in zf.namelist()
        if name.lower().endswith((".html", ".xhtml", ".htm")) and not name.endswith("/")
    )


def read_epub(
    path: Path, keep_images: bool = False
) -> tuple[str | None, str | None, list[dict[str, str]], ImageCollector | None]:
    with zipfile.ZipFile(path) as zf:
        opf_path = find_opf_path(zf)
        title = None
        author = None
        ordered: list[str] = []
        toc_titles: dict[str, str] = {}
        if opf_path:
            try:
                title, author, ordered, toc_titles = parse_opf(zf, opf_path)
            except Exception:
                ordered = []
        if not ordered:
            ordered = html_files(zf)

        images = ImageCollector(zf) if keep_images else None
        carried: list[str] = []
        sections = []

        def keep(section: dict[str, str], rich: str | None) -> None:
            if images is not None:
                rich = rich or section["text"]
                if carried:
                    rich = insert_after_first_paragraph(rich, carried)
                    carried.clear()
                section["richText"] = rich
            sections.append(section)

        def drop(rich: str | None) -> None:
            # Text-only import skips this fragment; keep its images for the next section.
            if images is not None and rich:
                carried.extend(IMG_TOKEN_RE.findall(rich))

        for index, name in enumerate(ordered):
            try:
                raw = zf.read(name).decode("utf-8")
            except UnicodeDecodeError:
                raw = zf.read(name).decode("utf-8", errors="ignore")
            except KeyError:
                continue
            rich_raw = images.rewrite(name, raw) if images is not None else None
            text = text_from_html(raw)
            if should_split_html_by_headings(raw, text, len(ordered)):
                matches = list(re.finditer(r"(?is)<h[1-3][^>]*>.*?</h[1-3]>", raw))
                rich_lead, rich_parts = heading_fragments(rich_raw) if rich_raw is not None else (None, [])
                if len(rich_parts) != len(matches):
                    rich_lead, rich_parts = None, [None] * len(matches)
                drop(rich_lead)
                kept = 0
                for match_index, match in enumerate(matches):
                    end = matches[match_index + 1].start() if match_index + 1 < len(matches) else len(raw)
                    section_text = text_from_html(raw[match.start() : end])
                    if not section_text:
                        drop(rich_parts[match_index])
                        continue
                    kept += 1
                    keep(
                        {
                            "title": strip_tags(match.group(0)) or f"Section {match_index + 1}",
                            "text": section_text,
                            "sourcePath": f"{name}#heading-{kept}",
                        },
                        rich_parts[match_index],
                    )
                continue
            rich_text = text_from_html(rich_raw) if rich_raw is not None else None
            if text:
                section_title = toc_titles.get(name) or title_from_html(raw) or f"Section {index + 1}"
                keep({"title": section_title, "text": text, "sourcePath": name}, rich_text)
            else:
                drop(rich_text)

        if carried and sections:
            sections[-1]["richText"] = "\n\n".join([sections[-1]["richText"], *carried])

        if images is not None:
            images.load()

    return title, author, sections, images


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--title")
    parser.add_argument("--author")
    parser.add_argument("--book-id")
    parser.add_argument("--out", type=Path, default=Path("data/books"))
    parser.add_argument("--max-chars", type=int, default=6000)
    parser.add_argument(
        "--keep-images",
        action="store_true",
        help="Copy images to <book>/assets/ and leave [[img:assets/<file>]] tokens in the text.",
    )
    args = parser.parse_args()

    title, author, sections, images = read_epub(args.input, keep_images=args.keep_images)
    final_title = args.title or clean_metadata_title(title, args.input.stem)
    final_author = args.author or clean_metadata_author(author, final_title)
    if not final_author and args.title and title and title != final_title:
        maybe_author = clean_metadata_title(title, "")
        if maybe_author and maybe_author != final_title:
            final_author = maybe_author
    book_id = args.book_id or slugify(final_title)

    if not sections:
        print("No readable text found in EPUB", file=sys.stderr)
        raise SystemExit(1)

    book_dir = write_book_sections(
        sections,
        final_title,
        final_author,
        args.out,
        book_id,
        args.max_chars,
        {"type": "epub", "fileName": args.input.name},
    )
    if images is not None:
        count = images.write_assets(book_dir / "assets")
        print(f"Images: {count} copied to assets/", file=sys.stderr)
        if images.missing:
            print(
                f"warning: {len(images.missing)} image refs not found in EPUB: {images.missing[:5]}",
                file=sys.stderr,
            )
    print(book_dir)


if __name__ == "__main__":
    main()
