#!/usr/bin/env python3
"""Package firefox-extension/ into a reproducible dist/x-carousel-stitcher.xpi."""

from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = ROOT / "firefox-extension"
OUT_XPI = ROOT / "dist" / "x-carousel-stitcher.xpi"
EXCLUDE_NAMES = {"README.md", "Thumbs.db"}
EXCLUDE_SUFFIXES = {".map", ".bak", ".swp", ".tmp"}
FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def should_include(path: Path) -> bool:
    rel = path.relative_to(EXT_DIR)
    if any(part.startswith(".") for part in rel.parts):
        return False
    if path.name in EXCLUDE_NAMES or path.suffix.lower() in EXCLUDE_SUFFIXES:
        return False
    return True


def build_xpi() -> Path:
    OUT_XPI.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT_XPI, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(EXT_DIR.rglob("*")):
            if path.is_file() and should_include(path):
                info = zipfile.ZipInfo(path.relative_to(EXT_DIR).as_posix(), date_time=FIXED_ZIP_TIME)
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, path.read_bytes())
    return OUT_XPI


if __name__ == "__main__":
    xpi = build_xpi()
    print(f"Built {xpi} ({xpi.stat().st_size:,} bytes)")
