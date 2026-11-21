#!/usr/bin/env python3
"""Download and stitch an X (Twitter) image carousel into a single image.

Examples:
    python stitch_x_carousel.py <post-url>
    python stitch_x_carousel.py <post-url> -o panorama.jpg
    python stitch_x_carousel.py <post-url> --cols 6 -o grid.png
    python stitch_x_carousel.py <post-url> --max-width 8192
"""

from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageColor

USER_AGENT = "x-carousel-stitcher/1.0"
STATUS_ID_RE = re.compile(r"(?:status(?:es)?/|^\s*)(\d{10,25})(?:\b|[/?#]|$)")
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
JPEG_MAX_DIM = 65500
WEBP_MAX_DIM = 16383


def extract_tweet_id(url_or_id: str) -> str:
    """Extract numeric tweet/status ID from an X/Twitter URL or bare ID."""
    match = STATUS_ID_RE.search(url_or_id.strip())
    if not match:
        raise ValueError(f"Could not extract a status ID from: {url_or_id!r}")
    return match.group(1)


def sanitize_filename_part(value: str) -> str:
    """Sanitize untrusted API text for safe single-segment filenames."""
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(value or "x")).strip("._")
    return cleaned or "x"


def ensure_orig_url(url: str) -> str:
    """Ensure pbs.twimg.com media URLs request original full-resolution quality."""
    parsed = urllib.parse.urlsplit(url)
    if "pbs.twimg.com" not in parsed.netloc:
        return url
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    query["name"] = ["orig"]
    new_query = urllib.parse.urlencode(query, doseq=True)
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, new_query, parsed.fragment)
    )


def fetch_json(url: str, timeout: float = 20.0) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_carousel_metadata(tweet_id: str) -> tuple[str, list[str]]:
    """Fetch author handle and ordered full-res photo URLs via FxTwitter (with VxTwitter fallback)."""
    errors: list[str] = []

    try:
        data = fetch_json(f"https://api.fxtwitter.com/status/{tweet_id}")
        tweet = data.get("tweet") or {}
        author = (tweet.get("author") or {}).get("screen_name") or "x"
        photos = (tweet.get("media") or {}).get("photos") or []
        urls = [ensure_orig_url(p["url"]) for p in photos if p.get("url")]
        if urls:
            return author, urls
        errors.append("fxtwitter returned 0 photos")
    except Exception as exc:
        errors.append(f"fxtwitter failed: {exc}")

    try:
        data = fetch_json(f"https://api.vxtwitter.com/Twitter/status/{tweet_id}")
        author = data.get("user_screen_name") or "x"
        media = data.get("media_extended") or []
        urls = [
            ensure_orig_url(m["url"])
            for m in media
            if m.get("type") == "image" and m.get("url")
        ]
        if urls:
            return author, urls
        errors.append("vxtwitter returned 0 images")
    except Exception as exc:
        errors.append(f"vxtwitter failed: {exc}")

    raise RuntimeError(
        f"Failed to fetch carousel images for status {tweet_id} ({'; '.join(errors)})"
    )


def download_image(url: str, timeout: float = 30.0) -> tuple[bytes, Image.Image]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    img = Image.open(io.BytesIO(raw))
    img.load()
    return raw, img


def download_all(
    urls: list[str], keep_frames_dir: Path | None = None, workers: int = 8
) -> list[Image.Image]:
    if keep_frames_dir is not None:
        keep_frames_dir.mkdir(parents=True, exist_ok=True)

    results: list[tuple[bytes, Image.Image] | None] = [None] * len(urls)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers, len(urls))) as pool:
        future_to_idx = {pool.submit(download_image, url): idx for idx, url in enumerate(urls)}
        for future in concurrent.futures.as_completed(future_to_idx):
            idx = future_to_idx[future]
            results[idx] = future.result()

    images: list[Image.Image] = []
    for idx, item in enumerate(results, start=1):
        assert item is not None
        raw, img = item
        if keep_frames_dir is not None:
            ext = (img.format or "jpg").lower()
            if ext == "jpeg":
                ext = "jpg"
            (keep_frames_dir / f"{idx:02d}.{ext}").write_bytes(raw)
        images.append(img)
    return images


def flatten_to_rgb(im: Image.Image, bg: str) -> Image.Image:
    """Composite images with alpha onto `bg` before converting to RGB."""
    if im.mode in {"RGBA", "LA"} or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        rgb_bg = ImageColor.getrgb(bg)
        base = Image.new("RGBA", rgba.size, (*rgb_bg[:3], 255))
        return Image.alpha_composite(base, rgba).convert("RGB")
    return im.convert("RGB")


def stitch_images(
    images: list[Image.Image],
    *,
    direction: str = "horizontal",
    cols: int | None = None,
    gap: int = 0,
    overlap: int = 0,
    normalize: bool = True,
    bg: str = "white",
) -> Image.Image:
    if not images:
        raise ValueError("No images to stitch.")
    if gap < 0:
        raise ValueError("Gap must be >= 0.")
    if overlap < 0:
        raise ValueError("Overlap must be >= 0.")

    use_alpha = bg.lower() == "transparent"
    mode = "RGBA" if use_alpha else "RGB"
    bg_color: Any = (0, 0, 0, 0) if use_alpha else bg
    converted = [im.convert("RGBA") if use_alpha else flatten_to_rgb(im, bg) for im in images]

    if cols is not None or direction == "grid":
        if cols is not None and cols <= 0:
            raise ValueError("Grid --cols must be >= 1.")
        num_cols = min(len(converted), cols if cols is not None else math.ceil(math.sqrt(len(converted))))
        num_rows = math.ceil(len(converted) / num_cols)
        cell_w = max(im.width for im in converted)
        cell_h = max(im.height for im in converted)
        total_w = num_cols * cell_w + gap * (num_cols - 1)
        total_h = num_rows * cell_h + gap * (num_rows - 1)
        canvas = Image.new(mode, (total_w, total_h), bg_color)
        for idx, im in enumerate(converted):
            r, c = divmod(idx, num_cols)
            if normalize and im.size != (cell_w, cell_h):
                fit = min(cell_w / im.width, cell_h / im.height)
                im = im.resize(
                    (max(1, round(im.width * fit)), max(1, round(im.height * fit))),
                    Image.Resampling.LANCZOS,
                )
            x = c * (cell_w + gap) + (cell_w - im.width) // 2
            y = r * (cell_h + gap) + (cell_h - im.height) // 2
            canvas.paste(im, (x, y))
        return canvas

    if direction == "horizontal":
        target_h = max(im.height for im in converted)
        prepared: list[Image.Image] = []
        for idx, im in enumerate(converted):
            # Trim overlap in source pixels before normalizing resize (matches extension behavior)
            if overlap > 0 and idx > 0:
                crop_x = min(overlap, im.width - 1)
                im = im.crop((crop_x, 0, im.width, im.height))
            if normalize and im.height != target_h:
                new_w = max(1, round(im.width * (target_h / im.height)))
                im = im.resize((new_w, target_h), Image.Resampling.LANCZOS)
            prepared.append(im)

        total_w = sum(im.width for im in prepared) + gap * (len(prepared) - 1)
        canvas = Image.new(mode, (total_w, target_h), bg_color)
        x = 0
        for im in prepared:
            y = (target_h - im.height) // 2
            canvas.paste(im, (x, y))
            x += im.width + gap
        return canvas

    if direction == "vertical":
        target_w = max(im.width for im in converted)
        prepared = []
        for idx, im in enumerate(converted):
            if overlap > 0 and idx > 0:
                crop_y = min(overlap, im.height - 1)
                im = im.crop((0, crop_y, im.width, im.height))
            if normalize and im.width != target_w:
                new_h = max(1, round(im.height * (target_w / im.width)))
                im = im.resize((target_w, new_h), Image.Resampling.LANCZOS)
            prepared.append(im)

        total_h = sum(im.height for im in prepared) + gap * (len(prepared) - 1)
        canvas = Image.new(mode, (target_w, total_h), bg_color)
        y = 0
        for im in prepared:
            x = (target_w - im.width) // 2
            canvas.paste(im, (x, y))
            y += im.height + gap
        return canvas

    raise ValueError(f"Unsupported direction: {direction!r}")


def maybe_resize(
    img: Image.Image,
    *,
    scale: float | None = None,
    max_width: int | None = None,
    max_height: int | None = None,
) -> Image.Image:
    if scale is not None and (not math.isfinite(scale) or scale <= 0):
        raise ValueError("--scale must be a finite number > 0.")
    if max_width is not None and max_width <= 0:
        raise ValueError("--max-width must be > 0.")
    if max_height is not None and max_height <= 0:
        raise ValueError("--max-height must be > 0.")

    factor = scale if scale is not None else 1.0
    if max_width is not None and img.width * factor > max_width:
        factor = min(factor, max_width / img.width)
    if max_height is not None and img.height * factor > max_height:
        factor = min(factor, max_height / img.height)
    if factor >= 1.0 - 1e-9:
        return img
    new_size = (max(1, round(img.width * factor)), max(1, round(img.height * factor)))
    return img.resize(new_size, Image.Resampling.LANCZOS)


def save_image(img: Image.Image, output_path: Path, quality: int = 95, bg: str = "white") -> None:
    suffix = output_path.suffix.lower() or ".png"
    if suffix not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported output extension {suffix!r}. Use one of: .png, .jpg, .jpeg, .webp."
        )

    clamped_q = max(1, min(100, quality))
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if suffix in {".jpg", ".jpeg"}:
        if max(img.size) > JPEG_MAX_DIM:
            cap_flag = "--max-width" if img.width >= img.height else "--max-height"
            raise ValueError(
                f"JPEG max dimension is {JPEG_MAX_DIM}px, but stitched image is {img.width}x{img.height}. "
                f"Use .png or pass {cap_flag} {JPEG_MAX_DIM}."
            )
        rgb = flatten_to_rgb(img, "white" if bg.lower() == "transparent" else bg)
        rgb.save(output_path, format="JPEG", quality=clamped_q, optimize=True)
    elif suffix == ".webp":
        if max(img.size) > WEBP_MAX_DIM:
            cap_flag = "--max-width" if img.width >= img.height else "--max-height"
            raise ValueError(
                f"WebP max dimension is {WEBP_MAX_DIM}px, but stitched image is {img.width}x{img.height}. "
                f"Use .png/.jpg or pass {cap_flag} {WEBP_MAX_DIM}."
            )
        img.save(output_path, format="WEBP", quality=clamped_q, method=4)
    else:
        # Skip slow PNG optimize pass on very large images (>40 MP)
        optimize = (img.width * img.height) <= 40_000_000
        img.save(output_path, format="PNG", optimize=optimize)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download all images from an X/Twitter carousel and stitch them into one image."
    )
    parser.add_argument(
        "url",
        help="X/Twitter post URL (or numeric status ID)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output image path (.png, .jpg, .webp). Defaults to <author>_<id>.png",
    )
    parser.add_argument(
        "-d",
        "--direction",
        choices=["horizontal", "vertical", "grid"],
        default="horizontal",
        help="Stitching layout (default: horizontal)",
    )
    parser.add_argument(
        "--cols",
        type=int,
        default=None,
        help="Number of columns for grid mode (automatically enables grid layout)",
    )
    parser.add_argument(
        "--gap",
        type=int,
        default=0,
        help="Gap in pixels between panels (default: 0)",
    )
    parser.add_argument(
        "--overlap",
        type=int,
        default=0,
        help="Pixels to trim from the leading edge of each subsequent panel (default: 0)",
    )
    parser.add_argument(
        "--reverse",
        action="store_true",
        help="Reverse panel order (useful for right-to-left carousels)",
    )
    parser.add_argument(
        "--no-normalize",
        action="store_true",
        help="Do not resize mismatched panels to a shared height/width",
    )
    parser.add_argument(
        "--scale",
        type=float,
        default=None,
        help="Scale factor applied to the final stitched image (e.g. 0.5)",
    )
    parser.add_argument(
        "--max-width",
        type=int,
        default=None,
        help="Cap final image width while preserving aspect ratio",
    )
    parser.add_argument(
        "--max-height",
        type=int,
        default=None,
        help="Cap final image height while preserving aspect ratio",
    )
    parser.add_argument(
        "--bg",
        default="white",
        help="Background color for gaps/padding (e.g. white, black, #ffffff, transparent)",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=95,
        help="Quality for JPEG/WebP output, 1-100 (default: 95)",
    )
    parser.add_argument(
        "--keep-frames",
        type=Path,
        default=None,
        help="Optional directory to save individual original-resolution carousel images",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        tweet_id = extract_tweet_id(args.url)
        print(f"Fetching carousel metadata for status {tweet_id}...")
        author, urls = fetch_carousel_metadata(tweet_id)
        print(f"Found {len(urls)} images by @{author}. Downloading full resolution...")

        images = download_all(urls, keep_frames_dir=args.keep_frames)
        if args.reverse:
            images.reverse()

        stitched = stitch_images(
            images,
            direction=args.direction,
            cols=args.cols,
            gap=args.gap,
            overlap=args.overlap,
            normalize=not args.no_normalize,
            bg=args.bg,
        )
        stitched = maybe_resize(
            stitched,
            scale=args.scale,
            max_width=args.max_width,
            max_height=args.max_height,
        )

        safe_author = sanitize_filename_part(author)
        output_path = args.output or Path(f"{safe_author}_{tweet_id}.png")
        save_image(stitched, output_path, quality=args.quality, bg=args.bg)
        size_mb = output_path.stat().st_size / (1024 * 1024)
        print(f"Saved {output_path.resolve()} ({stitched.width}x{stitched.height}, {size_mb:.2f} MB)")
        return 0
    except (ValueError, RuntimeError, OSError, urllib.error.URLError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
