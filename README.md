# X Carousel Stitcher

Stitches multi-image X carousels into one image, including the 4+ slide panoramas that X splits into separate cards. Comes as a Firefox extension and a standalone Python script.

Neither version needs an X account or API keys. Both pull full-resolution `?name=orig` slides from FxTwitter and fall back to VxTwitter if that fails.

## Firefox extension

Multi-image posts on X get a `Stitch` button. It ignores single photos, videos, GIFs, and quoted media so the button stays out of the way. By default it sits on the right side of the date and views row on post pages and next to the bookmark button in timelines, with popup options to place it in the top-right header (space permitting) or switch to a simplified icon-only button.

Clicking `Stitch` opens a viewer tab with all slides kept in memory. From there you can switch between horizontal, vertical, and grid layouts, flip the order, trim overlap, add a gap, change the output format between PNG, JPEG, and WebP, or cap the width without downloading the slides again. Drag to pan across wide strips, use the wheel to scroll horizontally, hold Ctrl while scrolling to zoom, then download the file or copy a PNG to the clipboard. Hold Shift while clicking `Stitch` to skip the viewer and download right away, or switch the default click behavior in the toolbar popup.

The toolbar popup auto-fills the active tab when you are on a post page. Right-clicking a post or post link adds stitch actions to the context menu.

### Installing

Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/x-carousel-stitcher/).

For local development or a temporary install, open `about:debugging#/runtime/this-firefox`, click Load Temporary Add-on, and pick `firefox-extension/manifest.json`.

To build a packaged `.xpi` for AMO self-signing or Developer Edition:

```powershell
python scripts/build_xpi.py
```

The archive lands at `dist/x-carousel-stitcher.xpi`.

## Python CLI

Needs Python 3.10+ and Pillow. Install Pillow with `pip install pillow`.

```powershell
# Horizontal strip, saved as <author>_<id>.png
python stitch_x_carousel.py <post-url>

# JPEG capped to 8192px wide
python stitch_x_carousel.py <post-url> -o panorama.jpg --max-width 8192

# Wrap into a 6-column grid
python stitch_x_carousel.py <post-url> --cols 6 -o grid.png
```

## Repo layout

- `firefox-extension/` holds the MV3 extension source.
- `scripts/build_xpi.py` packages the extension into `dist/x-carousel-stitcher.xpi`.
- `stitch_x_carousel.py` is the standalone CLI.
- `tests/` holds the Python and Node test suites.

## Tests

```powershell
python -m unittest tests/test_python_stitcher.py
node --test tests/test_extension.mjs
```
