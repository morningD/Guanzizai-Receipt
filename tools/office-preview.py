"""Bounded plain-text excerpts for Office XML and OFD materials."""
from pathlib import Path
import re
import sys
from xml.etree import ElementTree
from zipfile import ZipFile

LIMIT = 18_000
FORMATS = {
    ".docx": r"word/document\.xml",
    ".xlsx": r"xl/(sharedStrings|worksheets/sheet[0-9]+)\.xml",
    ".pptx": r"ppt/slides/slide[0-9]+\.xml",
    ".ofd": r"(?:[^/]+/)*Pages/[^/]+/Content\.xml",
}


def excerpt(file):
    pattern = FORMATS[file.suffix.lower()]
    parts = []
    remaining = LIMIT
    size_budget = 2 * 1024 * 1024
    with ZipFile(file) as archive:
        for member in archive.infolist():
            if not re.fullmatch(pattern, member.filename) or member.file_size > size_budget:
                continue
            size_budget -= member.file_size
            root = ElementTree.fromstring(archive.read(member))
            for node in root.iter():
                tag = node.tag.rsplit("}", 1)[-1]
                text = (node.text or "").strip()
                if tag not in {"t", "TextCode"} or not text:
                    continue
                parts.append(text[:remaining])
                remaining -= len(parts[-1]) + 1
                if remaining <= 0:
                    return "\n".join(parts)
    return "\n".join(parts)


if __name__ == "__main__":
    print(excerpt(Path(sys.argv[1])))
