#!/usr/bin/env python3
"""Contract tests for stitch_x_carousel.py using in-memory artificial images."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import stitch_x_carousel as stitcher  # noqa: E402

PALETTE = [
    (220, 60, 60),    # Red
    (60, 180, 90),    # Green
    (60, 120, 230),   # Blue
    (235, 175, 45),   # Gold
    (170, 75, 220),   # Purple
    (40, 195, 205),   # Cyan
]


def close_color(actual: tuple[int, ...], expected: tuple[int, int, int], tol: int = 3) -> bool:
    return all(abs(actual[c] - expected[c]) <= tol for c in range(3))


def make_horizontal_panels() -> list[Image.Image]:
    master = Image.new("RGB", (800, 300), (245, 245, 245))
    draw = ImageDraw.Draw(master)
    for i in range(4):
        x0 = i * 200
        draw.rectangle([x0, 0, x0 + 199, 299], fill=PALETTE[i])
        draw.rectangle([x0 + 70, 110, x0 + 130, 190], fill=(255, 255, 255))
    draw.rectangle([0, 230, 799, 250], fill=(255, 255, 255))
    draw.line([(0, 20), (799, 280)], fill=(15, 20, 25), width=8)
    return [master.crop((i * 200, 0, (i + 1) * 200, 300)) for i in range(4)]


def make_overlap_panels() -> list[Image.Image]:
    master = Image.new("RGB", (620, 300), (255, 255, 255))
    draw = ImageDraw.Draw(master)
    for i in range(3):
        x0 = i * 200
        draw.rectangle([x0, 0, min(619, x0 + 219), 299], fill=PALETTE[i])
    draw.rectangle([205, 0, 215, 299], fill=(255, 255, 0))
    draw.rectangle([405, 0, 415, 299], fill=(255, 255, 0))
    return [master.crop((i * 200, 0, i * 200 + 220, 300)) for i in range(3)]


def make_vertical_panels() -> list[Image.Image]:
    master = Image.new("RGB", (300, 540), (255, 255, 255))
    draw = ImageDraw.Draw(master)
    for i in range(3):
        y0 = i * 180
        draw.rectangle([0, y0, 299, y0 + 179], fill=PALETTE[i + 2])
    return [master.crop((0, i * 180, 300, (i + 1) * 180)) for i in range(3)]


def make_mixed_panels() -> list[Image.Image]:
    panels = []
    for i, (w, h) in enumerate([(200, 300), (100, 150), (400, 600)]):
        im = Image.new("RGB", (w, h), PALETTE[i])
        ImageDraw.Draw(im).rectangle([w // 4, h // 4, (3 * w) // 4, (3 * h) // 4], fill=(255, 255, 255))
        panels.append(im)
    return panels


def make_grid_panels() -> list[Image.Image]:
    return [Image.new("RGB", (160, 160), PALETTE[i]) for i in range(6)]


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None


class TestUrlAndMetadata(unittest.TestCase):
    def test_extract_tweet_id_accepts_urls_and_bare_ids(self) -> None:
        cases = [
            ("https://x.com/testuser/status/1234567890123456789", "1234567890123456789"),
            ("https://twitter.com/i/status/1234567890123456789/photo/3?s=20", "1234567890123456789"),
            ("1234567890123456789", "1234567890123456789"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(stitcher.extract_tweet_id(raw), expected)

    def test_extract_tweet_id_rejects_non_status_input(self) -> None:
        with self.assertRaises(ValueError):
            stitcher.extract_tweet_id("https://example.com/no-tweet-here")

    def test_ensure_orig_url_rewrites_twimg_only(self) -> None:
        self.assertEqual(
            stitcher.ensure_orig_url("https://pbs.twimg.com/media/ABC.jpg?format=jpg&name=small"),
            "https://pbs.twimg.com/media/ABC.jpg?format=jpg&name=orig",
        )
        self.assertEqual(
            stitcher.ensure_orig_url("https://example.com/a.jpg"),
            "https://example.com/a.jpg",
        )

    def test_fetch_carousel_metadata_falls_back_to_vxtwitter_and_filters_videos(self) -> None:
        def fake_fetch_json(url: str, timeout: float = 20.0) -> dict:
            if "api.fxtwitter.com" in url:
                raise OSError("upstream unavailable")
            return {
                "user_screen_name": "fallback_user",
                "media_extended": [
                    {"type": "image", "url": "https://pbs.twimg.com/media/A.jpg"},
                    {"type": "video", "url": "https://video.twimg.com/v.mp4"},
                    {"type": "image", "url": "https://pbs.twimg.com/media/B.jpg?name=medium"},
                ],
            }

        with mock.patch.object(stitcher, "fetch_json", side_effect=fake_fetch_json):
            author, urls = stitcher.fetch_carousel_metadata("1234567890123456789")

        self.assertEqual(author, "fallback_user")
        self.assertEqual(
            urls,
            [
                "https://pbs.twimg.com/media/A.jpg?name=orig",
                "https://pbs.twimg.com/media/B.jpg?name=orig",
            ],
        )

    def test_fetch_carousel_metadata_raises_when_all_providers_fail(self) -> None:
        with mock.patch.object(stitcher, "fetch_json", side_effect=OSError("network down")):
            with self.assertRaises(RuntimeError):
                stitcher.fetch_carousel_metadata("1234567890123456789")


class TestStitchingAndSaving(unittest.TestCase):
    def test_horizontal_and_reversed_stitching(self) -> None:
        panels = make_horizontal_panels()
        out = stitcher.stitch_images(panels, direction="horizontal")
        self.assertEqual(out.size, (800, 300))
        for i in range(4):
            self.assertTrue(close_color(out.getpixel((i * 200 + 20, 200)), PALETTE[i]))

        rev = stitcher.stitch_images(list(reversed(panels)), direction="horizontal")
        self.assertTrue(close_color(rev.getpixel((20, 200)), PALETTE[3]))
        self.assertTrue(close_color(rev.getpixel((620, 200)), PALETTE[0]))

    def test_overlap_trims_leading_edge_without_duplicating_seam(self) -> None:
        out = stitcher.stitch_images(make_overlap_panels(), direction="horizontal", overlap=20)
        self.assertEqual(out.size, (620, 300))
        self.assertTrue(close_color(out.getpixel((190, 50)), PALETTE[0]))
        self.assertTrue(close_color(out.getpixel((210, 50)), (255, 255, 0)))
        self.assertTrue(close_color(out.getpixel((230, 50)), PALETTE[1]))

    def test_vertical_stitching(self) -> None:
        out = stitcher.stitch_images(make_vertical_panels(), direction="vertical")
        self.assertEqual(out.size, (300, 540))
        for i in range(3):
            self.assertTrue(close_color(out.getpixel((250, i * 180 + 20)), PALETTE[i + 2]))

    def test_grid_layout_preserves_aspect_ratio_and_applies_gap(self) -> None:
        out = stitcher.stitch_images(make_grid_panels(), direction="grid", cols=3, gap=10, bg="black")
        self.assertEqual(out.size, (500, 330))
        self.assertTrue(close_color(out.getpixel((165, 80)), (0, 0, 0)))
        self.assertTrue(close_color(out.getpixel((10, 10)), PALETTE[0]))
        self.assertTrue(close_color(out.getpixel((350, 180)), PALETTE[5]))

        portrait = Image.new("RGB", (100, 200), PALETTE[0])
        landscape = Image.new("RGB", (200, 100), PALETTE[1])
        mixed_grid = stitcher.stitch_images([portrait, landscape], direction="grid", cols=2, bg="black")
        self.assertEqual(mixed_grid.size, (400, 200))
        self.assertTrue(close_color(mixed_grid.getpixel((10, 100)), (0, 0, 0)))
        self.assertTrue(close_color(mixed_grid.getpixel((100, 100)), PALETTE[0]))
        self.assertTrue(close_color(mixed_grid.getpixel((300, 10)), (0, 0, 0)))
        self.assertTrue(close_color(mixed_grid.getpixel((300, 100)), PALETTE[1]))

        with self.assertRaises(ValueError):
            stitcher.stitch_images(make_grid_panels(), direction="grid", cols=0)

    def test_mixed_dimension_normalization_and_unscaled_centering(self) -> None:
        panels = make_mixed_panels()
        norm = stitcher.stitch_images(panels, direction="horizontal", normalize=True)
        self.assertEqual(norm.size, (1200, 600))

        raw = stitcher.stitch_images(panels, direction="horizontal", normalize=False, bg="black")
        self.assertEqual(raw.size, (700, 600))
        self.assertTrue(close_color(raw.getpixel((50, 10)), (0, 0, 0)))
        self.assertTrue(close_color(raw.getpixel((50, 300)), (255, 255, 255)))

    def test_empty_or_invalid_direction_raises_value_error(self) -> None:
        with self.assertRaises(ValueError):
            stitcher.stitch_images([])
        with self.assertRaises(ValueError):
            stitcher.stitch_images(make_grid_panels()[:1], direction="diagonal")

    def test_resize_and_save_formats_and_dimension_guards(self) -> None:
        img = stitcher.stitch_images(make_horizontal_panels(), direction="horizontal")
        scaled = stitcher.maybe_resize(img, max_width=400)
        self.assertEqual(scaled.size, (400, 150))
        self.assertEqual(stitcher.maybe_resize(scaled, max_width=1000).size, (400, 150))
        self.assertEqual(stitcher.maybe_resize(scaled, scale=1.5).size, (400, 150))
        for bad_scale in (0, -0.5, float("inf"), float("nan")):
            with self.subTest(scale=bad_scale):
                with self.assertRaises(ValueError):
                    stitcher.maybe_resize(scaled, scale=bad_scale)

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            rgba_img = scaled.convert("RGBA")
            for ext in (".png", ".jpg", ".webp"):
                out_path = td_path / f"out{ext}"
                stitcher.save_image(rgba_img, out_path, quality=90)
                with Image.open(out_path) as reopened:
                    self.assertEqual(reopened.size, (400, 150))

            with self.assertRaisesRegex(ValueError, "Unsupported output extension"):
                stitcher.save_image(scaled, td_path / "out.gif")

            huge_webp = Image.new("RGB", (17000, 10), (255, 255, 255))
            with self.assertRaisesRegex(ValueError, "16383"):
                stitcher.save_image(huge_webp, td_path / "too_wide.webp")

            huge_jpg = Image.new("RGB", (65501, 1), (255, 255, 255))
            with self.assertRaisesRegex(ValueError, r"65500.*--max-width"):
                stitcher.save_image(huge_jpg, td_path / "too_wide.jpg")

            tall_jpg = Image.new("RGB", (1, 65501), (255, 255, 255))
            with self.assertRaisesRegex(ValueError, r"65500.*--max-height"):
                stitcher.save_image(tall_jpg, td_path / "too_tall.jpg")

    def test_sanitize_filename_part_blocks_path_traversal(self) -> None:
        self.assertEqual(stitcher.sanitize_filename_part("../../evil/user"), "evil_user")
        self.assertEqual(stitcher.sanitize_filename_part("..."), "x")


class TestCliEntryPoint(unittest.TestCase):
    def test_main_downloads_reverses_keeps_frames_and_writes_output(self) -> None:
        panels = make_horizontal_panels()[:2]
        encoded: dict[str, bytes] = {}
        for idx, im in enumerate(panels, start=1):
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            encoded[f"https://pbs.twimg.com/media/P{idx}.png?name=orig"] = buf.getvalue()

        meta_payload = json.dumps({
            "tweet": {
                "author": {"screen_name": "artist"},
                "media": {"photos": [{"url": u} for u in encoded]},
            }
        }).encode("utf-8")

        def fake_urlopen(req: object, timeout: float = 20.0) -> FakeResponse:
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if "api.fxtwitter.com" in url:
                return FakeResponse(meta_payload)
            return FakeResponse(encoded[url])

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_file = td_path / "stitched.png"
            frames_dir = td_path / "frames"

            with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
                rc = stitcher.main([
                    "https://x.com/artist/status/1234567890123456789",
                    "--reverse",
                    "--keep-frames",
                    str(frames_dir),
                    "-o",
                    str(out_file),
                ])

            self.assertEqual(rc, 0)
            self.assertTrue(out_file.exists())
            self.assertEqual(sorted(p.name for p in frames_dir.iterdir()), ["01.png", "02.png"])
            with Image.open(out_file) as stitched:
                self.assertEqual(stitched.size, (400, 300))
                self.assertTrue(close_color(stitched.getpixel((20, 200)), PALETTE[1]))
                self.assertTrue(close_color(stitched.getpixel((220, 200)), PALETTE[0]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
