(function (global) {
  "use strict";

  const STATUS_ID_RE = /(?:status(?:es)?\/|^\s*)(\d{10,25})(?:\b|[/?#]|$)/;
  // Firefox canvas max dimension is 32767px; stay safely below that ceiling.
  const MAX_CANVAS_DIM = 32000;
  const MAX_CANVAS_AREA = 120_000_000;
  const METADATA_TIMEOUT_MS = 15_000;
  const IMAGE_TIMEOUT_MS = 30_000;

  const DEFAULT_OPTIONS = {
    direction: "horizontal",
    cols: 6,
    format: "png",
    quality: 0.95,
    maxWidth: 0, // 0 = full original resolution
    gap: 0,
    overlap: 0,
    reverse: false,
    normalize: true,
    bg: "#ffffff",
    inlineAction: "viewer"
  };

  function extractTweetId(input) {
    if (!input || typeof input !== "string") {
      throw new Error("Please enter an X/Twitter post URL or status ID.");
    }
    const match = input.trim().match(STATUS_ID_RE);
    if (!match) {
      throw new Error("Could not find a valid X/Twitter status ID in that URL.");
    }
    return match[1];
  }

  function ensureOrigUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.hostname.includes("pbs.twimg.com")) {
        url.searchParams.set("name", "orig");
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  function sanitizeFilenamePart(str) {
    return (
      String(str || "x")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "x"
    );
  }

  function buildFilename(author, tweetId, format) {
    const ext = format === "jpeg" ? "jpg" : format === "webp" ? "webp" : "png";
    return `${sanitizeFilenamePart(author)}_${sanitizeFilenamePart(tweetId)}.${ext}`;
  }

  async function fetchBodyWithTimeout(url, options, timeoutMs, externalSignal, bodyType) {
    const controller = new AbortController();
    let timedOut = false;

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const resp = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      if (!resp.ok) {
        if (bodyType === "json") {
          throw new Error(`HTTP ${resp.status} from ${new URL(url).hostname}`);
        }
        throw new Error(`Image download failed (HTTP ${resp.status})`);
      }
      const abortError = () =>
        new Error(
          timedOut
            ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
            : "Download aborted"
        );
      if (controller.signal.aborted) {
        throw abortError();
      }
      const bodyPromise = bodyType === "json" ? resp.json() : resp.blob();
      const body = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        controller.signal.addEventListener("abort", onAbort, { once: true });
        bodyPromise.then(
          (val) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(val);
          },
          (err) => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(err);
          }
        );
      });
      return body;
    } catch (err) {
      if (timedOut) {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  function fetchJson(url, timeoutMs = METADATA_TIMEOUT_MS) {
    return fetchBodyWithTimeout(
      url,
      {
        method: "GET",
        credentials: "omit",
        cache: "no-store"
      },
      timeoutMs,
      null,
      "json"
    );
  }

  async function fetchCarouselMetadata(tweetId) {
    const errors = [];

    // Primary: FxTwitter API (natively returns all slides of >4-image X carousels)
    try {
      const data = await fetchJson(`https://api.fxtwitter.com/status/${tweetId}`);
      const tweet = data && data.tweet ? data.tweet : {};
      const author = (tweet.author && tweet.author.screen_name) || "x";
      const media = tweet.media || {};
      const photos = Array.isArray(media.photos) ? media.photos : [];
      const allMedia = Array.isArray(media.all) ? media.all : photos;
      const urls = photos
        .map((p) => p && p.url)
        .filter(Boolean)
        .map(ensureOrigUrl);
      const skippedMediaCount = Math.max(0, allMedia.length - urls.length);
      if (urls.length > 0) {
        return {
          tweetId,
          author,
          text: tweet.text || "",
          urls,
          skippedMediaCount
        };
      }
      errors.push("FxTwitter returned no photos");
    } catch (err) {
      errors.push(`FxTwitter: ${err.message}`);
    }

    try {
      const data = await fetchJson(`https://api.vxtwitter.com/Twitter/status/${tweetId}`);
      const author = data.user_screen_name || "x";
      const media = Array.isArray(data.media_extended) ? data.media_extended : [];
      const urls = media
        .filter((m) => m && m.type === "image" && m.url)
        .map((m) => ensureOrigUrl(m.url));
      const skippedMediaCount = Math.max(0, media.length - urls.length);
      if (urls.length > 0) {
        return {
          tweetId,
          author,
          text: data.text || "",
          urls,
          skippedMediaCount
        };
      }
      errors.push("VxTwitter returned no images");
    } catch (err) {
      errors.push(`VxTwitter: ${err.message}`);
    }

    throw new Error(`Could not fetch carousel images (${errors.join("; ")})`);
  }

  async function fetchImageBitmap(url, signal) {
    const blob = await fetchBodyWithTimeout(
      url,
      {
        method: "GET",
        credentials: "omit",
        cache: "force-cache"
      },
      IMAGE_TIMEOUT_MS,
      signal,
      "blob"
    );
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("Failed to decode image"));
      };
      img.src = objUrl;
    });
  }

  function closeBitmaps(bitmaps) {
    for (const bmp of bitmaps || []) {
      if (bmp && typeof bmp.close === "function") {
        try {
          bmp.close();
        } catch {}
      }
    }
  }

  async function downloadAllBitmaps(urls, onProgress, concurrency = 6) {
    const results = new Array(urls.length);
    const controller = new AbortController();
    let nextIndex = 0;
    let completed = 0;
    let firstError = null;

    async function worker() {
      while (!firstError && nextIndex < urls.length) {
        const idx = nextIndex++;
        try {
          const bmp = await fetchImageBitmap(urls[idx], controller.signal);
          if (firstError) {
            closeBitmaps([bmp]);
            return;
          }
          results[idx] = bmp;
          completed++;
          if (typeof onProgress === "function") {
            onProgress(completed, urls.length);
          }
        } catch (err) {
          if (!firstError) {
            firstError = err;
            controller.abort();
          }
          return;
        }
      }
    }

    const workers = [];
    const count = Math.min(concurrency, urls.length);
    for (let i = 0; i < count; i++) {
      workers.push(worker());
    }
    await Promise.allSettled(workers);

    if (firstError) {
      closeBitmaps(results);
      throw firstError;
    }
    return results;
  }

  function computeLayout(images, opts) {
    const direction = opts.direction || "horizontal";
    const gap = Math.max(0, Number(opts.gap) || 0);
    const overlap = Math.max(0, Number(opts.overlap) || 0);
    const normalize = opts.normalize !== false;

    const placements = [];
    let totalW = 0;
    let totalH = 0;

    if (direction === "grid") {
      const requestedCols = Number(opts.cols);
      const cols = Math.max(
        1,
        Math.min(
          images.length,
          requestedCols > 0 ? Math.floor(requestedCols) : Math.ceil(Math.sqrt(images.length))
        )
      );
      const rows = Math.ceil(images.length / cols);
      const cellW = Math.max(...images.map((im) => im.width));
      const cellH = Math.max(...images.map((im) => im.height));
      totalW = cols * cellW + gap * (cols - 1);
      totalH = rows * cellH + gap * (rows - 1);

      images.forEach((im, idx) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const fit = normalize ? Math.min(cellW / im.width, cellH / im.height) : 1;
        const dw = Math.max(1, Math.round(im.width * fit));
        const dh = Math.max(1, Math.round(im.height * fit));
        const dx = c * (cellW + gap) + Math.floor((cellW - dw) / 2);
        const dy = r * (cellH + gap) + Math.floor((cellH - dh) / 2);
        placements.push({
          image: im,
          sx: 0,
          sy: 0,
          sw: im.width,
          sh: im.height,
          dx,
          dy,
          dw,
          dh
        });
      });
    } else if (direction === "vertical") {
      const targetW = Math.max(...images.map((im) => im.width));
      let y = 0;
      images.forEach((im, idx) => {
        const cropTop = idx > 0 ? Math.min(overlap, im.height - 1) : 0;
        const sh = im.height - cropTop;
        const dw = normalize ? targetW : im.width;
        const scale = normalize ? targetW / im.width : 1;
        const dh = Math.max(1, Math.round(sh * scale));
        const dx = Math.floor((targetW - dw) / 2);
        placements.push({
          image: im,
          sx: 0,
          sy: cropTop,
          sw: im.width,
          sh,
          dx,
          dy: y,
          dw,
          dh
        });
        y += dh + (idx < images.length - 1 ? gap : 0);
      });
      totalW = targetW;
      totalH = y;
    } else {
      const targetH = Math.max(...images.map((im) => im.height));
      let x = 0;
      images.forEach((im, idx) => {
        const cropLeft = idx > 0 ? Math.min(overlap, im.width - 1) : 0;
        const sw = im.width - cropLeft;
        const dh = normalize ? targetH : im.height;
        const scale = normalize ? targetH / im.height : 1;
        const dw = Math.max(1, Math.round(sw * scale));
        const dy = Math.floor((targetH - dh) / 2);
        placements.push({
          image: im,
          sx: cropLeft,
          sy: 0,
          sw,
          sh: im.height,
          dx: x,
          dy,
          dw,
          dh
        });
        x += dw + (idx < images.length - 1 ? gap : 0);
      });
      totalW = x;
      totalH = targetH;
    }

    let scale = 1;
    let clampedReason = null;

    const userMaxWidth = Number(opts.maxWidth) || 0;
    if (userMaxWidth > 0 && totalW > userMaxWidth) {
      scale = Math.min(scale, userMaxWidth / totalW);
    }

    const format = opts.format || "png";
    const formatMaxDim = format === "webp" ? 16383 : MAX_CANVAS_DIM;
    if (totalW * scale > formatMaxDim) {
      scale = Math.min(scale, formatMaxDim / totalW);
      clampedReason = `Scaled to fit ${format.toUpperCase()} / browser max width (${formatMaxDim}px).`;
    }
    if (totalH * scale > formatMaxDim) {
      scale = Math.min(scale, formatMaxDim / totalH);
      clampedReason = `Scaled to fit ${format.toUpperCase()} / browser max height (${formatMaxDim}px).`;
    }
    if (totalW * scale * totalH * scale > MAX_CANVAS_AREA) {
      scale = Math.min(scale, Math.sqrt(MAX_CANVAS_AREA / (totalW * totalH)));
      clampedReason = "Scaled to fit browser canvas memory limit.";
    }

    const outW = Math.max(1, Math.round(totalW * scale));
    const outH = Math.max(1, Math.round(totalH * scale));
    return { placements, outW, outH, scale, clampedReason };
  }

  function createCanvas(width, height) {
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(width, height);
    }
    throw new Error("Canvas API is not available in this context.");
  }

  async function canvasToBlob(canvas, format, quality) {
    const mime =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
          ? "image/webp"
          : "image/png";
    const q = typeof quality === "number" ? Math.max(0.01, Math.min(1, quality)) : 0.95;

    if (typeof canvas.convertToBlob === "function") {
      return canvas.convertToBlob({ type: mime, quality: q });
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas failed to encode image blob (image may exceed browser limits)."));
        },
        mime,
        q
      );
    });
  }

  async function stitchBitmapsToCanvas(bitmaps, rawOptions) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, rawOptions || {});
    const ordered = opts.reverse ? [...bitmaps].reverse() : bitmaps;
    const { placements, outW, outH, scale, clampedReason } = computeLayout(ordered, opts);

    // JPEG has no alpha channel; force an opaque fill instead of encoding transparency as black
    const effectiveBg =
      opts.format === "jpeg" && (!opts.bg || opts.bg === "transparent")
        ? "#ffffff"
        : opts.bg;
    const useAlpha = effectiveBg === "transparent";

    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext("2d", { alpha: useAlpha });
    if (!ctx) {
      throw new Error("Could not acquire 2D canvas context.");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (!useAlpha && effectiveBg) {
      ctx.fillStyle = effectiveBg;
      ctx.fillRect(0, 0, outW, outH);
    }

    for (const p of placements) {
      const x0 = Math.round(p.dx * scale);
      const y0 = Math.round(p.dy * scale);
      const x1 = Math.round((p.dx + p.dw) * scale);
      const y1 = Math.round((p.dy + p.dh) * scale);
      ctx.drawImage(
        p.image,
        p.sx,
        p.sy,
        p.sw,
        p.sh,
        x0,
        y0,
        Math.max(1, x1 - x0),
        Math.max(1, y1 - y0)
      );
    }

    return { canvas, width: outW, height: outH, clampedReason };
  }

  async function stitchBitmapsToBlob(bitmaps, rawOptions) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, rawOptions || {});
    const { canvas, width, height, clampedReason } = await stitchBitmapsToCanvas(bitmaps, opts);
    try {
      const blob = await canvasToBlob(canvas, opts.format, opts.quality);
      return { blob, width, height, clampedReason, format: opts.format };
    } finally {
      // Release large RGBA backing store immediately instead of waiting for GC
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  async function loadOptions() {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
      const saved = await browser.storage.local.get("options");
      return Object.assign({}, DEFAULT_OPTIONS, (saved && saved.options) || {});
    }
    return Object.assign({}, DEFAULT_OPTIONS);
  }

  async function saveOptions(partial) {
    const current = await loadOptions();
    const merged = Object.assign({}, current, partial || {});
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
      await browser.storage.local.set({ options: merged });
    }
    return merged;
  }

  global.XCarouselStitcher = {
    DEFAULT_OPTIONS,
    MAX_CANVAS_DIM,
    extractTweetId,
    ensureOrigUrl,
    buildFilename,
    fetchCarouselMetadata,
    downloadAllBitmaps,
    closeBitmaps,
    stitchBitmapsToCanvas,
    stitchBitmapsToBlob,
    loadOptions,
    saveOptions
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
