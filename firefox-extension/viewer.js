(function () {
  "use strict";

  const Stitcher = globalThis.XCarouselStitcher;
  const REQUIRED_ORIGINS = [
    "https://api.fxtwitter.com/*",
    "https://api.vxtwitter.com/*",
    "https://pbs.twimg.com/*"
  ];

  const els = {
    permBanner: document.getElementById("perm-banner"),
    grantPermBtn: document.getElementById("grant-perm-btn"),
    urlInput: document.getElementById("url-input"),
    sourceForm: document.getElementById("source-form"),
    loadBtn: document.getElementById("load-btn"),
    copyBtn: document.getElementById("copy-btn"),
    downloadBtn: document.getElementById("download-btn"),
    direction: document.getElementById("direction-select"),
    cols: document.getElementById("cols-input"),
    format: document.getElementById("format-select"),
    maxWidth: document.getElementById("max-width-select"),
    gap: document.getElementById("gap-input"),
    overlap: document.getElementById("overlap-input"),
    reverse: document.getElementById("reverse-check"),
    adjustmentsToggle: document.getElementById("adjustments-toggle"),
    adjustmentsPanel: document.getElementById("adjustments-panel"),
    fitHeightBtn: document.getElementById("fit-height-btn"),
    fitWidthBtn: document.getElementById("fit-width-btn"),
    zoomOutBtn: document.getElementById("zoom-out-btn"),
    zoomInBtn: document.getElementById("zoom-in-btn"),
    zoom100Btn: document.getElementById("zoom-100-btn"),
    zoomLabel: document.getElementById("zoom-label"),
    viewport: document.getElementById("viewport"),
    stage: document.getElementById("stage"),
    previewImg: document.getElementById("preview-img"),
    emptyState: document.getElementById("empty-state"),
    loadingState: document.getElementById("loading-state"),
    loadingText: document.getElementById("loading-text"),
    progressBar: document.getElementById("progress-bar"),
    errorState: document.getElementById("error-state"),
    errorText: document.getElementById("error-text"),
    metaInfo: document.getElementById("meta-info"),
    toast: document.getElementById("toast"),
    sourceLink: document.getElementById("source-link")
  };

  const state = {
    meta: null,
    bitmaps: [],
    currentBlob: null,
    currentBlobUrl: null,
    currentFormat: "png",
    currentWidth: 0,
    currentHeight: 0,
    zoomMode: "fit-height",
    zoom: 1,
    loadSeq: 0,
    renderSeq: 0
  };

  let toastTimer = null;
  let restitchTimer = null;
  function showToast(msg) {
    clearTimeout(toastTimer);
    els.toast.textContent = msg;
    toastTimer = setTimeout(() => {
      els.toast.textContent = "";
    }, 3000);
  }

  function showView(which) {
    document.body.dataset.view = which;
    const sourceSlot = document.getElementById(which === "empty" ? "empty-source" : "toolbar-source");
    if (els.sourceForm.parentElement !== sourceSlot) sourceSlot.append(els.sourceForm);
    els.emptyState.classList.toggle("hidden", which !== "empty");
    els.loadingState.classList.toggle("hidden", which !== "loading");
    els.errorState.classList.toggle("hidden", which !== "error");
    els.stage.classList.toggle("hidden", which !== "stage");
    els.viewport.classList.toggle("pannable", which === "stage");
  }

  function readOptions() {
    return {
      direction: els.direction.value,
      cols: Math.max(1, Number(els.cols.value) || 6),
      format: els.format.value,
      maxWidth: Math.max(0, Number(els.maxWidth.value) || 0),
      gap: Math.max(0, Number(els.gap.value) || 0),
      overlap: Math.max(0, Number(els.overlap.value) || 0),
      reverse: Boolean(els.reverse.checked)
    };
  }

  function applyOptions(opts) {
    els.direction.value = opts.direction || "horizontal";
    els.cols.value = String(opts.cols || 6);
    els.format.value = opts.format || "png";
    els.maxWidth.value = String(opts.maxWidth || 0);
    els.gap.value = String(opts.gap || 0);
    els.overlap.value = String(opts.overlap || 0);
    els.reverse.checked = Boolean(opts.reverse);
    globalThis.updateStitchLayoutFields(els.direction.value);
  }

  function setPreviewScale(zoom) {
    const clamped = Math.max(0.03, Math.min(4, zoom));
    state.zoom = clamped;
    els.previewImg.style.width = `${Math.max(1, Math.floor(state.currentWidth * clamped))}px`;
    els.previewImg.style.height = `${Math.max(1, Math.floor(state.currentHeight * clamped))}px`;
    els.zoomLabel.textContent = `${Math.round(clamped * 100)}%`;
  }

  function applyZoom() {
    if (!state.currentWidth || !state.currentHeight) return;
    els.fitWidthBtn.setAttribute("aria-pressed", state.zoomMode === "fit-width");
    els.fitHeightBtn.setAttribute("aria-pressed", state.zoomMode === "fit-height");
    els.zoom100Btn.setAttribute("aria-pressed", state.zoomMode === "manual" && state.zoom === 1);

    const pad = 48;
    const fullW = Math.max(100, els.viewport.offsetWidth - pad);
    const fullH = Math.max(100, els.viewport.offsetHeight - pad);

    if (state.zoomMode === "fit-height") {
      // Compute from scrollbar-free size first, then refit once if a horizontal scrollbar appears.
      setPreviewScale(Math.min(1, fullH / state.currentHeight));
      const innerH = Math.max(100, els.viewport.clientHeight - pad);
      if (innerH < fullH) {
        setPreviewScale(Math.min(1, innerH / state.currentHeight));
      }
      return;
    }

    if (state.zoomMode === "fit-width") {
      setPreviewScale(Math.min(1, fullW / state.currentWidth));
      const innerW = Math.max(100, els.viewport.clientWidth - pad);
      if (innerW < fullW) {
        setPreviewScale(Math.min(1, innerW / state.currentWidth));
      }
      return;
    }

    setPreviewScale(state.zoom);
  }

  function revokeCurrentBlob() {
    if (state.currentBlobUrl) {
      URL.revokeObjectURL(state.currentBlobUrl);
      state.currentBlobUrl = null;
    }
    state.currentBlob = null;
  }

  function clearLoadedState() {
    revokeCurrentBlob();
    Stitcher.closeBitmaps(state.bitmaps);
    state.bitmaps = [];
    state.meta = null;
    state.currentWidth = 0;
    state.currentHeight = 0;
    els.previewImg.removeAttribute("src");
    els.sourceLink.classList.add("hidden");
    els.copyBtn.disabled = true;
    els.downloadBtn.disabled = true;
  }

  async function renderStitched() {
    if (!state.bitmaps.length || !state.meta) return;
    const seq = ++state.renderSeq;
    const opts = readOptions();

    els.copyBtn.disabled = true;
    els.downloadBtn.disabled = true;
    els.metaInfo.textContent = "Stitching...";

    try {
      const result = await Stitcher.stitchBitmapsToBlob(state.bitmaps, opts);
      if (seq !== state.renderSeq) return;

      revokeCurrentBlob();
      state.currentBlob = result.blob;
      state.currentBlobUrl = URL.createObjectURL(result.blob);
      state.currentFormat = result.format || opts.format;
      state.currentWidth = result.width;
      state.currentHeight = result.height;

      els.previewImg.src = state.currentBlobUrl;
      showView("stage");

      if (state.zoomMode !== "manual" && state.zoomMode !== "fit-width") {
        state.zoomMode = "fit-height";
      }
      applyZoom();

      const mb = (result.blob.size / (1024 * 1024)).toFixed(2);
      const extras = [];
      if (state.meta.skippedMediaCount > 0) {
        extras.push(
          `${state.meta.skippedMediaCount} video${state.meta.skippedMediaCount === 1 ? "" : "s"} skipped`
        );
      }
      if (result.clampedReason) extras.push(result.clampedReason);
      const extraText = extras.length ? ` • ${extras.join(" • ")}` : "";

      els.metaInfo.textContent =
        `@${state.meta.author} • ${state.meta.urls.length} panels • ${result.width.toLocaleString()} × ${result.height.toLocaleString()} px • ${mb} MB (${state.currentFormat.toUpperCase()})${extraText}`;

      els.copyBtn.disabled = false;
      els.downloadBtn.disabled = false;
    } catch (err) {
      if (seq !== state.renderSeq) return;
      els.errorText.textContent = err.message || String(err);
      showView("error");
      els.metaInfo.textContent = "Stitch failed";
    }
  }

  async function checkPermissions() {
    if (!browser.permissions || !browser.permissions.contains) return true;
    const ok = await browser.permissions.contains({ origins: REQUIRED_ORIGINS });
    els.permBanner.classList.toggle("hidden", ok);
    return ok;
  }

  async function loadCarousel(input) {
    let tweetId;
    try {
      tweetId = Stitcher.extractTweetId(input);
    } catch (err) {
      els.urlInput.setCustomValidity(err.message);
      els.urlInput.reportValidity();
      return;
    }

    const seq = ++state.loadSeq;
    clearTimeout(restitchTimer);
    state.renderSeq++;
    clearLoadedState();
    els.loadBtn.disabled = true;
    let hasPerms;
    try {
      hasPerms = await checkPermissions();
    } catch {
      if (seq !== state.loadSeq) return;
      els.errorText.textContent = "Couldn't check site access. Try loading the post again.";
      showView("error");
      els.metaInfo.textContent = "Site access unavailable";
      els.loadBtn.disabled = !els.urlInput.value.trim();
      return;
    }
    if (seq !== state.loadSeq) return;
    if (!hasPerms) {
      els.errorText.textContent = "Select Grant access to load the photos.";
      els.metaInfo.textContent = "Waiting for access";
      els.loadBtn.disabled = !els.urlInput.value.trim();
      showView("error");
      return;
    }

    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set("id", tweetId);
    history.replaceState(null, "", nextUrl.toString());

    els.copyBtn.disabled = true;
    els.downloadBtn.disabled = true;
    showView("loading");
    els.loadingText.textContent = "Fetching carousel metadata...";
    els.progressBar.style.width = "8%";

    try {
      const meta = await Stitcher.fetchCarouselMetadata(tweetId);
      if (seq !== state.loadSeq) return;

      els.loadingText.textContent = `Downloading 0/${meta.urls.length} full-resolution panels...`;
      els.progressBar.style.width = "12%";

      const bitmaps = await Stitcher.downloadAllBitmaps(meta.urls, (done, total) => {
        if (seq !== state.loadSeq) return;
        const pct = 12 + Math.round((done / total) * 80);
        els.loadingText.textContent = `Downloading ${done}/${total} full-resolution panels...`;
        els.progressBar.style.width = `${pct}%`;
      });

      if (seq !== state.loadSeq) {
        Stitcher.closeBitmaps(bitmaps);
        return;
      }

      Stitcher.closeBitmaps(state.bitmaps);
      state.meta = meta;
      state.bitmaps = bitmaps;
      state.zoomMode = "fit-height";

      document.title = `@${meta.author} (${meta.urls.length} panels) — X Carousel Stitcher`;
      els.sourceLink.href = `https://x.com/${encodeURIComponent(meta.author)}/status/${encodeURIComponent(meta.tweetId)}`;
      els.sourceLink.classList.remove("hidden");

      els.loadingText.textContent = "Stitching image...";
      els.progressBar.style.width = "96%";
      await renderStitched();
    } catch (err) {
      if (seq !== state.loadSeq) return;
      clearLoadedState();
      els.errorText.textContent = err.message || String(err);
      showView("error");
      els.metaInfo.textContent = "Failed to load carousel";
    } finally {
      if (seq === state.loadSeq) {
        els.loadBtn.disabled = !els.urlInput.value.trim();
      }
    }
  }

  function triggerAnchorDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  els.grantPermBtn.addEventListener("click", async () => {
    try {
      const granted = await browser.permissions.request({ origins: REQUIRED_ORIGINS });
      els.permBanner.classList.toggle("hidden", granted);
      if (granted && els.urlInput.value.trim()) {
        loadCarousel(els.urlInput.value.trim());
      }
    } catch (err) {
      showToast(`Permission error: ${err.message}`);
    }
  });

  els.sourceForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!els.loadBtn.disabled) loadCarousel(els.urlInput.value.trim());
  });

  els.urlInput.addEventListener("input", () => {
    els.urlInput.setCustomValidity("");
    els.loadBtn.disabled = document.body.dataset.view === "loading" || !els.urlInput.value.trim();
  });

  function scheduleRestitch() {
    globalThis.updateStitchLayoutFields(els.direction.value);
    Stitcher.saveOptions(readOptions()).catch(() => {});
    if (!state.bitmaps.length) return;
    state.renderSeq++;
    els.copyBtn.disabled = true;
    els.downloadBtn.disabled = true;
    clearTimeout(restitchTimer);
    restitchTimer = setTimeout(() => {
      renderStitched();
    }, 120);
  }

  els.adjustmentsToggle.addEventListener("click", () => {
    const open = els.adjustmentsPanel.classList.toggle("hidden") === false;
    els.adjustmentsToggle.setAttribute("aria-expanded", String(open));
  });

  for (const el of [
    els.direction,
    els.cols,
    els.format,
    els.maxWidth,
    els.gap,
    els.overlap,
    els.reverse
  ]) {
    el.addEventListener("change", scheduleRestitch);
  }

  els.downloadBtn.addEventListener("click", async () => {
    if (!state.currentBlob || !state.meta) return;
    // Match filename to the format the blob was actually rendered in
    const filename = Stitcher.buildFilename(
      state.meta.author,
      state.meta.tweetId,
      state.currentFormat
    );

    if (!browser.downloads || !browser.downloads.download) {
      triggerAnchorDownload(state.currentBlob, filename);
      showToast(`Downloading ${filename}`);
      return;
    }

    const url = URL.createObjectURL(state.currentBlob);
    try {
      const dlId = await browser.downloads.download({
        url,
        filename,
        conflictAction: "uniquify"
      });
      if (browser.downloads.onChanged) {
        const cleanup = (delta) => {
          if (
            delta.id === dlId &&
            delta.state &&
            (delta.state.current === "complete" || delta.state.current === "interrupted")
          ) {
            URL.revokeObjectURL(url);
            browser.downloads.onChanged.removeListener(cleanup);
          }
        };
        browser.downloads.onChanged.addListener(cleanup);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast(`Downloading ${filename}`);
    } catch (err) {
      URL.revokeObjectURL(url);
      if (err && /cancel/i.test(err.message || "")) {
        showToast("Download canceled");
      } else {
        showToast(`Download failed: ${(err && err.message) || err}`);
      }
    }
  });

  els.copyBtn.addEventListener("click", async () => {
    if (!state.bitmaps.length) return;
    if (
      typeof ClipboardItem === "undefined" ||
      !navigator.clipboard ||
      !navigator.clipboard.write
    ) {
      showToast("Clipboard image copy is not supported in this Firefox version.");
      return;
    }
    try {
      // Pass a Promise to ClipboardItem so clipboard.write runs synchronously inside the click gesture
      const pngPromise =
        state.currentBlob && state.currentBlob.type === "image/png"
          ? Promise.resolve(state.currentBlob)
          : Stitcher.stitchBitmapsToBlob(
              state.bitmaps,
              Object.assign({}, readOptions(), { format: "png" })
            ).then((res) => res.blob);

      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngPromise })]);
      showToast("Copied PNG to clipboard!");
    } catch (err) {
      showToast(`Copy failed: ${err.message}`);
    }
  });

  els.fitHeightBtn.addEventListener("click", () => {
    state.zoomMode = "fit-height";
    applyZoom();
  });
  els.fitWidthBtn.addEventListener("click", () => {
    state.zoomMode = "fit-width";
    applyZoom();
  });
  els.zoom100Btn.addEventListener("click", () => {
    state.zoomMode = "manual";
    state.zoom = 1;
    applyZoom();
  });
  els.zoomInBtn.addEventListener("click", () => {
    state.zoomMode = "manual";
    state.zoom *= 1.25;
    applyZoom();
  });
  els.zoomOutBtn.addEventListener("click", () => {
    state.zoomMode = "manual";
    state.zoom /= 1.25;
    applyZoom();
  });

  new ResizeObserver(() => {
    if (state.zoomMode !== "manual") applyZoom();
  }).observe(els.viewport);

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  els.viewport.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || els.stage.classList.contains("hidden")) return;
    dragging = true;
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    startScrollLeft = els.viewport.scrollLeft;
    startScrollTop = els.viewport.scrollTop;
    els.viewport.classList.add("panning");
    ev.preventDefault();
  });

  window.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    els.viewport.scrollLeft = startScrollLeft - (ev.clientX - dragStartX);
    els.viewport.scrollTop = startScrollTop - (ev.clientY - dragStartY);
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    els.viewport.classList.remove("panning");
  });

  els.viewport.addEventListener(
    "wheel",
    (ev) => {
      if (els.stage.classList.contains("hidden")) return;
      if (ev.ctrlKey) {
        ev.preventDefault();
        state.zoomMode = "manual";
        state.zoom *= ev.deltaY < 0 ? 1.15 : 1 / 1.15;
        applyZoom();
      } else if (
        Math.abs(ev.deltaY) > Math.abs(ev.deltaX) &&
        els.viewport.scrollWidth > els.viewport.clientWidth &&
        els.viewport.scrollHeight <= els.viewport.clientHeight + 4
      ) {
        ev.preventDefault();
        els.viewport.scrollLeft += ev.deltaY;
      }
    },
    { passive: false }
  );

  window.addEventListener("beforeunload", () => {
    revokeCurrentBlob();
    Stitcher.closeBitmaps(state.bitmaps);
  });

  async function init() {
    const opts = await Stitcher.loadOptions();
    applyOptions(opts);
    await checkPermissions();

    const params = new URLSearchParams(location.search);
    const idParam = params.get("id") || params.get("url");
    if (idParam) {
      els.urlInput.value = /^\d+$/.test(idParam)
        ? `https://x.com/i/status/${idParam}`
        : idParam;
      loadCarousel(idParam);
    } else {
      showView("empty");
    }
  }

  init();
})();
