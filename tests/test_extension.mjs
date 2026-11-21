#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PALETTE = [
  [220, 60, 60],
  [60, 180, 90],
  [60, 120, 230],
  [235, 175, 45],
  [170, 75, 220],
  [40, 195, 205]
];

function parseColor(str) {
  if (!str || str === "transparent") return [0, 0, 0, 0];
  if (str === "white" || str === "#ffffff" || str === "#fff") return [255, 255, 255, 255];
  if (str === "black" || str === "#000000" || str === "#000") return [0, 0, 0, 255];
  const m = /^#([0-9a-f]{6})$/i.exec(str);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  return [255, 255, 255, 255];
}

function closeColor(actual, expected, tol = 2) {
  return (
    Math.abs(actual[0] - expected[0]) <= tol &&
    Math.abs(actual[1] - expected[1]) <= tol &&
    Math.abs(actual[2] - expected[2]) <= tol
  );
}

class SoftwareCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.drawCalls = [];
  }

  getPixel(x, y) {
    const idx = (y * this.width + x) * 4;
    return [this.data[idx], this.data[idx + 1], this.data[idx + 2], this.data[idx + 3]];
  }

  getContext() {
    const self = this;
    return {
      fillStyle: "#ffffff",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      fillRect(x, y, w, h) {
        const [r, g, b, a] = parseColor(this.fillStyle);
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(self.width, Math.ceil(x + w));
        const y1 = Math.min(self.height, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const idx = (py * self.width + px) * 4;
            self.data[idx] = r;
            self.data[idx + 1] = g;
            self.data[idx + 2] = b;
            self.data[idx + 3] = a;
          }
        }
      },
      drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
        self.drawCalls.push({ sx, sy, sw, sh, dx, dy, dw, dh });
        if (!src.data) return;
        for (let py = 0; py < dh; py++) {
          const destY = dy + py;
          if (destY < 0 || destY >= self.height) continue;
          const srcY = Math.min(src.height - 1, Math.floor(sy + (py + 0.5) * (sh / dh)));
          for (let px = 0; px < dw; px++) {
            const destX = dx + px;
            if (destX < 0 || destX >= self.width) continue;
            const srcX = Math.min(src.width - 1, Math.floor(sx + (px + 0.5) * (sw / dw)));
            const sIdx = (srcY * src.width + srcX) * 4;
            const dIdx = (destY * self.width + destX) * 4;
            self.data[dIdx] = src.data[sIdx];
            self.data[dIdx + 1] = src.data[sIdx + 1];
            self.data[dIdx + 2] = src.data[sIdx + 2];
            self.data[dIdx + 3] = src.data[sIdx + 3];
          }
        }
      }
    };
  }

  async convertToBlob({ type }) {
    return new Blob([this.data], { type: type || "image/png" });
  }
}

function makeBitmap(width, height, fillRgb, paintFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  const fillRect = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const idx = (y * width + x) * 4;
        data[idx] = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
  };
  fillRect(0, 0, width, height, fillRgb);
  if (paintFn) paintFn(fillRect);
  return { width, height, data, closed: false, close() { this.closed = true; } };
}

function cropBitmap(src, x0, y0, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sIdx = ((y0 + y) * src.width + (x0 + x)) * 4;
      const dIdx = (y * w + x) * 4;
      data[dIdx] = src.data[sIdx];
      data[dIdx + 1] = src.data[sIdx + 1];
      data[dIdx + 2] = src.data[sIdx + 2];
      data[dIdx + 3] = src.data[sIdx + 3];
    }
  }
  return { width: w, height: h, data, closed: false, close() { this.closed = true; } };
}

function loadStitcher(fetchImpl) {
  const src = fs.readFileSync(
    path.join(ROOT, "firefox-extension", "lib", "stitcher.js"),
    "utf8"
  );
  const createdBitmaps = [];
  const sandbox = {
    URL,
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
    OffscreenCanvas: SoftwareCanvas,
    fetch: (...args) => fetchImpl(...args),
    createImageBitmap: async (blob) => {
      const bmp = {
        tag: await blob.text(),
        width: 100,
        height: 100,
        closed: false,
        close() { this.closed = true; }
      };
      createdBitmaps.push(bmp);
      return bmp;
    },
    console
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(src, sandbox, { filename: "lib/stitcher.js" });
  sandbox.XCarouselStitcher._createdBitmaps = createdBitmaps;
  return sandbox.XCarouselStitcher;
}

test("extractTweetId, ensureOrigUrl, and buildFilename handle valid and invalid inputs", () => {
  const S = loadStitcher(() => { throw new Error("no network"); });

  for (const [input, expected] of [
    ["https://x.com/testuser/status/1234567890123456789", "1234567890123456789"],
    ["https://twitter.com/i/status/1234567890123456789/photo/2?s=20", "1234567890123456789"],
    ["1234567890123456789", "1234567890123456789"]
  ]) {
    assert.equal(S.extractTweetId(input), expected);
  }
  assert.throws(() => S.extractTweetId("https://example.com/nope"));
  assert.throws(() => S.extractTweetId(""));

  assert.equal(
    S.ensureOrigUrl("https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium"),
    "https://pbs.twimg.com/media/A.jpg?format=jpg&name=orig"
  );
  assert.equal(S.ensureOrigUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");

  assert.equal(S.buildFilename("artist", "12345", "png"), "artist_12345.png");
  assert.equal(S.buildFilename("bad/name:here", "12345", "jpeg"), "bad_name_here_12345.jpg");
  assert.equal(S.buildFilename("artist", "12345", "webp"), "artist_12345.webp");
});

test("fetchCarouselMetadata falls back to VxTwitter, filters videos, and enforces name=orig", async () => {
  const S = loadStitcher(async (url) => {
    if (url.includes("api.fxtwitter.com")) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        user_screen_name: "fallback_user",
        media_extended: [
          { type: "image", url: "https://pbs.twimg.com/media/IMG1.jpg" },
          { type: "video", url: "https://video.twimg.com/v.mp4" },
          { type: "image", url: "https://pbs.twimg.com/media/IMG2.jpg?name=medium" }
        ]
      })
    };
  });

  const meta = await S.fetchCarouselMetadata("1234567890123456789");
  assert.equal(meta.author, "fallback_user");
  assert.deepEqual(Array.from(meta.urls), [
    "https://pbs.twimg.com/media/IMG1.jpg?name=orig",
    "https://pbs.twimg.com/media/IMG2.jpg?name=orig"
  ]);

  const SBroken = loadStitcher(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await assert.rejects(() => SBroken.fetchCarouselMetadata("1234567890123456789"));
});

test("downloadAllBitmaps preserves slide order when responses finish out of order", async () => {
  const delays = { u1: 40, u2: 5, u3: 25, u4: 10 };
  const S = loadStitcher(async (url) => {
    await new Promise((r) => setTimeout(r, delays[url] || 1));
    return { ok: true, status: 200, blob: async () => new Blob([url]) };
  });

  const progress = [];
  const bitmaps = await S.downloadAllBitmaps(
    ["u1", "u2", "u3", "u4"],
    (done, total) => progress.push([done, total]),
    4
  );

  assert.deepEqual(Array.from(bitmaps, (b) => b.tag), ["u1", "u2", "u3", "u4"]);
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
});

test("downloadAllBitmaps aborts stalled bodies and siblings, closes decoded bitmaps, and stops progress on error", async () => {
  let abortedCount = 0;
  let progressAfterReject = 0;
  let rejected = false;

  const S = loadStitcher((url, opts) => new Promise((resolve, reject) => {
    if (url === "ok1") {
      setTimeout(() => resolve({ ok: true, status: 200, blob: async () => new Blob(["ok1"]) }), 5);
      return;
    }
    if (url === "fail2") {
      setTimeout(() => resolve({ ok: false, status: 404, blob: async () => new Blob([]) }), 15);
      return;
    }
    if (url === "stalledBody") {
      // Resolves headers immediately, then stalls on body stream
      resolve({ ok: true, status: 200, blob: () => new Promise(() => {}) });
      return;
    }
    if (url === "abortedBeforeBody") {
      setTimeout(() => resolve({
        ok: true,
        status: 200,
        blob: () => Promise.reject(new Error("should not start reading body after abort"))
      }), 20);
      return;
    }
    const timer = setTimeout(
      () => resolve({ ok: true, status: 200, blob: async () => new Blob([url]) }),
      200
    );
    if (opts && opts.signal) {
      opts.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        abortedCount++;
        reject(new Error("aborted"));
      }, { once: true });
    }
  }));

  await assert.rejects(
    () => S.downloadAllBitmaps(["ok1", "fail2", "slow3", "stalledBody", "abortedBeforeBody"], () => {
      if (rejected) progressAfterReject++;
    }, 5),
    /HTTP 404/
  );
  rejected = true;
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(abortedCount, 1, "In-flight sibling fetch should be aborted");
  assert.equal(progressAfterReject, 0, "onProgress must not fire after failure");
  assert(S._createdBitmaps.length >= 1 && S._createdBitmaps.every((b) => b.closed), "Decoded bitmaps must be closed");
});

test("stitchBitmapsToCanvas stitches horizontal, reverse, overlap, vertical, grid, and mixed panels accurately", async () => {
  const S = loadStitcher(() => { throw new Error("no network"); });

  const horiz = [0, 1, 2, 3].map((i) => makeBitmap(200, 300, PALETTE[i]));
  const hRes = await S.stitchBitmapsToCanvas(horiz, { direction: "horizontal" });
  assert.equal(hRes.width, 800);
  assert.equal(hRes.height, 300);
  for (let i = 0; i < 4; i++) {
    assert(closeColor(hRes.canvas.getPixel(i * 200 + 20, 150), PALETTE[i]));
  }

  const revRes = await S.stitchBitmapsToCanvas(horiz, { direction: "horizontal", reverse: true });
  assert(closeColor(revRes.canvas.getPixel(20, 150), PALETTE[3]));
  assert(closeColor(revRes.canvas.getPixel(620, 150), PALETTE[0]));

  const masterOv = makeBitmap(620, 300, PALETTE[0], (fill) => {
    fill(200, 0, 420, 300, PALETTE[1]);
    fill(400, 0, 620, 300, PALETTE[2]);
    fill(205, 0, 215, 300, [255, 255, 0]);
    fill(405, 0, 415, 300, [255, 255, 0]);
  });
  const ovPanels = [0, 1, 2].map((i) => cropBitmap(masterOv, i * 200, 0, 220, 300));
  const ovRes = await S.stitchBitmapsToCanvas(ovPanels, { direction: "horizontal", overlap: 20 });
  assert.equal(ovRes.width, 620);
  assert(closeColor(ovRes.canvas.getPixel(190, 50), PALETTE[0]));
  assert(closeColor(ovRes.canvas.getPixel(210, 50), [255, 255, 0]));
  assert(closeColor(ovRes.canvas.getPixel(230, 50), PALETTE[1]));

  const vert = [0, 1, 2].map((i) => makeBitmap(300, 180, PALETTE[i + 2]));
  const vRes = await S.stitchBitmapsToCanvas(vert, { direction: "vertical" });
  assert.equal(vRes.width, 300);
  assert.equal(vRes.height, 540);
  for (let i = 0; i < 3; i++) {
    assert(closeColor(vRes.canvas.getPixel(150, i * 180 + 20), PALETTE[i + 2]));
  }

  const grid = PALETTE.map((rgb) => makeBitmap(160, 160, rgb));
  const gRes = await S.stitchBitmapsToCanvas(grid, {
    direction: "grid",
    cols: 3,
    gap: 10,
    bg: "#000000"
  });
  assert.equal(gRes.width, 500);
  assert.equal(gRes.height, 330);
  assert(closeColor(gRes.canvas.getPixel(165, 80), [0, 0, 0]));
  assert(closeColor(gRes.canvas.getPixel(10, 10), PALETTE[0]));
  assert(closeColor(gRes.canvas.getPixel(350, 180), PALETTE[5]));

  const mixedGrid = await S.stitchBitmapsToCanvas(
    [makeBitmap(100, 200, PALETTE[0]), makeBitmap(200, 100, PALETTE[1])],
    { direction: "grid", cols: 2, bg: "#000000", normalize: true }
  );
  assert.equal(mixedGrid.width, 400);
  assert.equal(mixedGrid.height, 200);
  assert(closeColor(mixedGrid.canvas.getPixel(10, 100), [0, 0, 0]));
  assert(closeColor(mixedGrid.canvas.getPixel(100, 100), PALETTE[0]));
  assert(closeColor(mixedGrid.canvas.getPixel(300, 10), [0, 0, 0]));
  assert(closeColor(mixedGrid.canvas.getPixel(300, 100), PALETTE[1]));

  const mixed = [
    makeBitmap(200, 300, PALETTE[0], (f) => f(50, 75, 150, 225, [255, 255, 255])),
    makeBitmap(100, 150, PALETTE[1]),
    makeBitmap(400, 600, PALETTE[2])
  ];
  const mNorm = await S.stitchBitmapsToCanvas(mixed, { direction: "horizontal", normalize: true });
  assert.equal(mNorm.width, 1200);
  assert.equal(mNorm.height, 600);

  const mRaw = await S.stitchBitmapsToCanvas(mixed, {
    direction: "horizontal",
    normalize: false,
    bg: "#000000"
  });
  assert.equal(mRaw.width, 700);
  assert.equal(mRaw.height, 600);
  assert(closeColor(mRaw.canvas.getPixel(50, 10), [0, 0, 0]));
  assert(closeColor(mRaw.canvas.getPixel(75, 300), [255, 255, 255]));
});

test("downscaling keeps seams gap-free and clamps oversized strips for PNG and WebP", async () => {
  const S = loadStitcher(() => { throw new Error("no network"); });

  for (const [count, w, h, maxWidth] of [
    [4, 200, 300, 533],
    [18, 848, 1424, 8192]
  ]) {
    const panels = Array.from({ length: count }, () => ({ width: w, height: h }));
    const res = await S.stitchBitmapsToCanvas(panels, { direction: "horizontal", maxWidth });
    assert.equal(res.width, maxWidth);
    const dc = res.canvas.drawCalls;
    for (let i = 1; i < dc.length; i++) {
      assert.equal(dc[i].dx, dc[i - 1].dx + dc[i - 1].dw, `Gap at seam ${i}`);
    }
    assert.equal(dc[dc.length - 1].dx + dc[dc.length - 1].dw, maxWidth);
  }

  const huge = Array.from({ length: 40 }, () => ({ width: 848, height: 1424 }));
  const clampedPng = await S.stitchBitmapsToCanvas(huge, { direction: "horizontal", format: "png" });
  assert(clampedPng.width <= 32000 && clampedPng.clampedReason);

  const clampedWebp = await S.stitchBitmapsToCanvas(huge, { direction: "horizontal", format: "webp" });
  assert(clampedWebp.width <= 16383 && clampedWebp.clampedReason);
});

class MockElement {
  constructor(tag, attrs = {}, styles = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this._rect = null;
    this._computedStyle = { display: "flex", flexDirection: "column", ...styles };
    this._classes = new Set((attrs.class || "").split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...cls) => cls.forEach((c) => this._classes.add(c)),
      remove: (...cls) => cls.forEach((c) => this._classes.delete(c)),
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        const enable = force === undefined ? !this._classes.has(c) : Boolean(force);
        if (enable) this._classes.add(c);
        else this._classes.delete(c);
        return enable;
      }
    };
    this.textContent = "";
    this.listeners = {};
  }
  get className() { return Array.from(this._classes).join(" "); }
  set className(val) { this._classes = new Set(String(val).split(/\s+/).filter(Boolean)); }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = v; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { return Boolean(this.parentElement); }
  getBoundingClientRect() {
    if (typeof this._rect === "function") return this._rect();
    return this._rect || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (MockElement._onMutation) MockElement._onMutation({ type: "attributes", attributeName: k, target: this });
  }
  _detachFromParent(child) {
    if (!child.parentElement) return;
    const prev = child.parentElement;
    const idx = prev.children.indexOf(child);
    if (idx !== -1) prev.children.splice(idx, 1);
  }
  appendChild(child) {
    this._detachFromParent(child);
    child.parentElement = this;
    this.children.push(child);
    if (MockElement._onMutation) MockElement._onMutation({ type: "childList", target: this });
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const idx = parent.children.indexOf(this);
    if (idx !== -1) parent.children.splice(idx, 1);
    this.parentElement = null;
    if (MockElement._onMutation) MockElement._onMutation({ type: "childList", target: parent });
  }
  insertBefore(child, ref) {
    this._detachFromParent(child);
    child.parentElement = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) this.children.push(child);
    else this.children.splice(idx, 0, child);
    return child;
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  async trigger(ev, eventObj = {}) {
    const evt = { preventDefault() {}, stopPropagation() {}, ...eventObj };
    for (const fn of this.listeners[ev] || []) {
      await fn(evt);
    }
  }
  contains(node) { return node === this || this.children.some((c) => c.contains(node)); }
  matches(selectorList) { return selectorList.split(",").some((s) => this._matchesSingle(s.trim())); }
  _matchesSingle(sel) {
    if (!sel) return false;
    let rem = sel;
    const tagMatch = rem.match(/^([a-zA-Z0-9-]+)/);
    if (tagMatch) {
      if (this.tagName !== tagMatch[1].toUpperCase()) return false;
      rem = rem.slice(tagMatch[1].length);
    }
    for (const m of rem.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
      if (!this._classes.has(m[1])) return false;
    }
    rem = rem.replace(/\.[a-zA-Z0-9_-]+/g, "");
    for (const [, name, op, val] of rem.matchAll(/\[([a-zA-Z0-9_-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual === null) return false;
      if (op === "=" && actual !== val) return false;
      if (op === "*=" && !actual.includes(val)) return false;
    }
    return true;
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function el(tag, attrs = {}, styles = {}, children = []) {
  const node = new MockElement(tag, attrs, styles);
  for (const ch of children) node.appendChild(ch);
  return node;
}

function buildPostDetailArticle({
  id = "1234567890123456789",
  photoCount = 0,
  hasVideo = false,
  videoWrapsTweetPhoto = false,
  hasCarouselArrows = false,
  quotedPhotos = 0
}) {
  const mediaChildren = [];
  for (let i = 1; i <= photoCount; i++) {
    mediaChildren.push(
      el("a", { href: `/testuser/status/${id}/photo/${i}` }, {}, [
        el("div", { "data-testid": "tweetPhoto" })
      ])
    );
  }
  if (hasVideo) {
    const videoInner = [el("video"), el("div", { "data-testid": "videoPlayer" })];
    if (videoWrapsTweetPhoto) videoInner.push(el("div", { "data-testid": "tweetPhoto" }));
    mediaChildren.push(
      el("a", { href: `/testuser/status/${id}/video/1` }, {}, [
        el("div", { "data-testid": "videoComponent" }, {}, videoInner)
      ])
    );
  }
  if (hasCarouselArrows) {
    mediaChildren.push(el("button", { "aria-label": "Next slide" }));
  }

  const children = [
    el("div", { "data-testid": "User-Name" }),
    el("div", { "data-testid": "tweetText" }),
    el("div", { class: "media-wrap" }, {}, mediaChildren)
  ];

  if (quotedPhotos > 0) {
    const qMedia = Array.from({ length: quotedPhotos }, (_, i) =>
      el("a", { href: `/other/status/999999999999/photo/${i + 1}` }, {}, [
        el("div", { "data-testid": "tweetPhoto" })
      ])
    );
    children.push(
      el("div", { role: "link", tabindex: "0" }, {}, [
        el("div", { "data-testid": "User-Name" }),
        ...qMedia
      ])
    );
  }

  const dateRow = el("div", { class: "date-views-row" }, { display: "flex", flexDirection: "row" }, [
    el("a", { href: `/testuser/status/${id}` }, { display: "inline" }, [el("time")]),
    el("span", {}, { display: "inline" })
  ]);
  children.push(el("div", { class: "date-section" }, { display: "flex", flexDirection: "column" }, [dateRow]));
  children.push(el("div", { role: "group" }, { display: "flex", flexDirection: "row" }));

  return { article: el("article", { "data-testid": "tweet" }, {}, children), dateRow };
}

function buildTimelineArticle({ id = "1234567890123456789", photoCount = 4 }) {
  const headerRight = el("div", { class: "header-right" }, { display: "flex", flexDirection: "row" }, [
    el("button", { "data-testid": "caret" })
  ]);
  const headerRow = el("div", { class: "header-row" }, { display: "flex", flexDirection: "row" }, [
    el("div", { "data-testid": "User-Name" }, {}, [
      el("a", { href: `/testuser/status/${id}` }, {}, [el("time")])
    ]),
    headerRight
  ]);
  const media = Array.from({ length: photoCount }, (_, i) =>
    el("a", { href: `/testuser/status/${id}/photo/${i + 1}` }, {}, [
      el("div", { "data-testid": "tweetPhoto" })
    ])
  );
  const bookmarkCluster = el("div", { class: "bm-share" }, { display: "flex", flexDirection: "row" }, [
    el("div", {}, {}, [el("button", { "data-testid": "bookmark" })]),
    el("div", {}, {}, [el("button", { "aria-label": "Share post" })])
  ]);
  const actionBar = el("div", { role: "group" }, { display: "flex", flexDirection: "row" }, [
    bookmarkCluster
  ]);
  return {
    article: el("article", { "data-testid": "tweet" }, {}, [
      headerRow,
      el("div", { class: "media-wrap" }, {}, media),
      actionBar
    ]),
    headerRight,
    bookmarkCluster
  };
}

test("content.js injects Stitch only on multi-image posts, in date/views row or timeline header, and sends click messages", async () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, "firefox-extension", "content.js"), "utf8");
  const head = el("head");
  const body = el("body");

  const cases = {
    postMulti: buildPostDetailArticle({ id: "1000000000001", photoCount: 4 }),
    postCarouselNarrow: buildPostDetailArticle({ id: "1000000000002", photoCount: 1, hasCarouselArrows: true }),
    postSinglePhoto: buildPostDetailArticle({ id: "1000000000003", photoCount: 1 }),
    postVideoOnly: buildPostDetailArticle({ id: "1000000000004", photoCount: 0, hasVideo: true, videoWrapsTweetPhoto: true }),
    postOnePhotoOneVideo: buildPostDetailArticle({ id: "1000000000005", photoCount: 1, hasVideo: true }),
    postSingleQuotingFour: buildPostDetailArticle({ id: "1000000000006", photoCount: 1, quotedPhotos: 4 }),
    postVideoWithArrows: buildPostDetailArticle({ id: "1000000000007", photoCount: 0, hasVideo: true, videoWrapsTweetPhoto: true, hasCarouselArrows: true }),
    timelineFourPhotos: buildTimelineArticle({ id: "1000000000008", photoCount: 4 }),
    timelineOnePhoto: buildTimelineArticle({ id: "1000000000009", photoCount: 1 })
  };

  for (const c of Object.values(cases)) body.appendChild(c.article);

  let observerCallback = null;
  let observerConfig = null;
  let observerTarget = null;
  let storageChangeListener = null;
  const sentMessages = [];

  MockElement._onMutation = (record) => {
    if (!observerCallback || !observerConfig || !observerTarget) return;
    if (!observerTarget.contains(record.target)) return;
    if (record.type === "childList" && observerConfig.childList) {
      observerCallback([record]);
    } else if (
      record.type === "attributes" &&
      observerConfig.attributes &&
      (!observerConfig.attributeFilter || observerConfig.attributeFilter.includes(record.attributeName))
    ) {
      observerCallback([record]);
    }
  };

  const document = {
    head,
    body,
    documentElement: el("html", {}, {}, [head, body]),
    getElementById: (id) => head.children.find((c) => c.id === id) || null,
    createElement: (tag) => el(tag),
    createElementNS: (_ns, tag) => el(tag),
    querySelectorAll: (sel) => body.querySelectorAll(sel)
  };

  const sandbox = {
    document,
    location: { pathname: "/testuser/status/1000000000001" },
    getComputedStyle: (node) => node._computedStyle || { display: "block", flexDirection: "row" },
    MutationObserver: class {
      constructor(cb) { observerCallback = cb; }
      observe(target, config) { observerTarget = target; observerConfig = config; }
    },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 0,
    browser: {
      storage: {
        local: {
          get: async () => ({ options: { compactButton: false } })
        },
        onChanged: {
          addListener: (fn) => { storageChangeListener = fn; }
        }
      },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (msg) => {
          sentMessages.push(msg);
          return { ok: true, mode: msg.forceMode || "viewer", count: 4 };
        }
      }
    },
    console
  };
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(contentSrc, sandbox, { filename: "content.js" });

    const postBtn = cases.postMulti.dateRow.querySelector(".xcs-stitch-btn");
    assert(postBtn, "4-photo post must place Stitch button in date/views row");
    assert(cases.postCarouselNarrow.dateRow.querySelector(".xcs-stitch-btn"));
    assert(
      cases.timelineFourPhotos.bookmarkCluster.querySelector(".xcs-stitch-btn"),
      "Default timeline position must place Stitch button next to Bookmark"
    );

    for (const key of [
      "postSinglePhoto",
      "postVideoOnly",
      "postOnePhotoOneVideo",
      "postSingleQuotingFour",
      "postVideoWithArrows",
      "timelineOnePhoto"
    ]) {
      assert.equal(cases[key].article.querySelector(".xcs-stitch-btn"), null, `${key} must not show Stitch button`);
    }

    const mediaWrap = cases.postSinglePhoto.article.querySelector(".media-wrap");
    mediaWrap.appendChild(el("button", { "aria-label": "Next slide" }));
    assert(
      cases.postSinglePhoto.dateRow.querySelector(".xcs-stitch-btn"),
      "1-photo carousel must gain Stitch button when nav arrow arrives later"
    );

    // Switch timeline placement to header-auto and verify late caret + re-render restoration
    storageChangeListener({ options: { newValue: { compactButton: false, buttonPosition: "header-auto" } } }, "local");
    assert(cases.timelineFourPhotos.headerRight.querySelector(".xcs-stitch-btn"));

    const lateHeaderRight = el("div", { class: "header-right" }, { display: "flex", flexDirection: "row" });
    const lateTimeline = el("article", { "data-testid": "tweet" }, {}, [
      el("div", { class: "header-row" }, { display: "flex", flexDirection: "row" }, [
        el("div", { "data-testid": "User-Name" }, {}, [
          el("a", { href: "/testuser/status/1000000000010" }, {}, [el("time")])
        ]),
        lateHeaderRight
      ]),
      el("div", { class: "media-wrap" }, {}, Array.from({ length: 4 }, (_, i) =>
        el("a", { href: `/testuser/status/1000000000010/photo/${i + 1}` }, {}, [
          el("div", { "data-testid": "tweetPhoto" })
        ])
      )),
      el("div", { role: "link", tabindex: "0" }, {}, [
        el("div", { "data-testid": "User-Name" }),
        el("button", { "data-testid": "caret" })
      ])
    ]);
    body.appendChild(lateTimeline);
    assert.equal(lateTimeline.querySelector(".xcs-stitch-btn"), null);
    lateHeaderRight.appendChild(el("button", { "data-testid": "caret" }));
    assert(
      lateHeaderRight.querySelector(".xcs-stitch-btn"),
      "4-photo timeline tweet must gain Stitch button when main caret arrives later"
    );

    lateHeaderRight.querySelector(".xcs-stitch-wrap").remove();
    assert(
      lateHeaderRight.querySelector(".xcs-stitch-btn"),
      "Removed Stitch button must be restored after DOM re-render"
    );

    cases.postMulti.article.appendChild(el("span"));
    assert.equal(cases.postMulti.article.querySelectorAll(".xcs-stitch-btn").length, 1);

    const timeAnchor = cases.postMulti.dateRow.querySelector("a");
    timeAnchor.setAttribute("href", "/testuser/status/9999999999999");
    const refreshedBtn = cases.postMulti.dateRow.querySelector(".xcs-stitch-btn");
    assert.equal(refreshedBtn.dataset.tweetId, "9999999999999");
    assert.equal(cases.postMulti.article.querySelectorAll(".xcs-stitch-btn").length, 1);

    await refreshedBtn.trigger("click", { shiftKey: false });
    assert.equal(sentMessages[0].type, "INLINE_STITCH_CLICK");
    assert.equal(sentMessages[0].tweetId, "9999999999999");
    assert.equal(sentMessages[0].forceMode, undefined);

    delete refreshedBtn.dataset.state;
    await refreshedBtn.trigger("click", { shiftKey: true });
    assert.equal(sentMessages[1].forceMode, "download");

    assert.equal(document.documentElement.classList.contains("xcs-compact"), false);
    storageChangeListener({ options: { newValue: { compactButton: true, buttonPosition: "header-auto" } } }, "local");
    assert.equal(document.documentElement.classList.contains("xcs-compact"), true);
    storageChangeListener({ options: { newValue: { compactButton: false, buttonPosition: "header-auto" } } }, "local");
    assert.equal(document.documentElement.classList.contains("xcs-compact"), false);

    // When header overlaps timestamp/badge (e.g. long name or third-party badge), button moves next to Bookmark
    const crowdedBookmarkWrap = el("div", {}, {}, [el("button", { "data-testid": "bookmark" })]);
    const crowdedShareWrap = el("div", {}, {}, [el("button", { "aria-label": "Share post" })]);
    const crowdedRightCluster = el("div", { class: "bm-share" }, { display: "flex", flexDirection: "row" }, [
      crowdedBookmarkWrap,
      crowdedShareWrap
    ]);
    const crowdedActionBar = el("div", { role: "group" }, { display: "flex", flexDirection: "row" }, [
      crowdedRightCluster
    ]);
    const crowdedTime = el("time");
    let timeRight = 320;
    crowdedTime._rect = () => ({ left: 260, right: timeRight, top: 10, bottom: 26, width: timeRight - 260, height: 16 });
    const crowdedUserName = el("div", { "data-testid": "User-Name" }, {}, [
      el("a", { href: "/testuser/status/1000000000011" }, {}, [crowdedTime])
    ]);
    crowdedUserName._rect = () => ({ left: 60, right: timeRight, top: 10, bottom: 26, width: timeRight - 60, height: 16 });
    const crowdedHeaderRight = el("div", { class: "header-right" }, { display: "flex", flexDirection: "row" }, [
      el("button", { "data-testid": "caret" })
    ]);
    const origInsert = crowdedHeaderRight.insertBefore.bind(crowdedHeaderRight);
    crowdedHeaderRight.insertBefore = (child, ref) => {
      child._rect = () => ({ left: 420, right: 490, top: 6, bottom: 30, width: 70, height: 24 });
      return origInsert(child, ref);
    };
    const crowdedArticle = el("article", { "data-testid": "tweet" }, {}, [
      el("div", { class: "header-row" }, { display: "flex", flexDirection: "row" }, [
        crowdedUserName,
        crowdedHeaderRight
      ]),
      el("div", { class: "media-wrap" }, {}, Array.from({ length: 2 }, (_, i) =>
        el("a", { href: `/testuser/status/1000000000011/photo/${i + 1}` }, {}, [
          el("div", { "data-testid": "tweetPhoto" })
        ])
      )),
      crowdedActionBar
    ]);
    crowdedArticle._rect = () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400 });

    // Initially no overlap -> stays in headerRight
    body.appendChild(crowdedArticle);
    assert(crowdedHeaderRight.querySelector(".xcs-stitch-btn"), "Unobstructed button stays in header");

    // Third-party extension injects a badge pushing timestamp onto Stitch -> relocates next to Bookmark
    timeRight = 445;
    crowdedUserName.appendChild(el("span", { class: "third-party-badge" }));
    assert.equal(crowdedHeaderRight.querySelector(".xcs-stitch-btn"), null, "Overlapping button leaves header");
    assert(crowdedRightCluster.querySelector(".xcs-stitch-btn"), "Relocated button sits next to Bookmark/Share");
    assert.equal(crowdedRightCluster.children[0].querySelector(".xcs-stitch-btn") !== null, true);
  } finally {
    MockElement._onMutation = null;
  }
});
