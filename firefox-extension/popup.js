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
    directions: document.querySelectorAll('[name="direction"]'),
    sourceHint: document.getElementById("source-hint"),
    format: document.getElementById("format-select"),
    cols: document.getElementById("cols-input"),
    maxWidth: document.getElementById("max-width-select"),
    gap: document.getElementById("gap-input"),
    overlap: document.getElementById("overlap-input"),
    reverse: document.getElementById("reverse-check"),
    compactButton: document.getElementById("compact-btn-check"),
    inlineAction: document.getElementById("inline-action-select"),
    buttonPosition: document.getElementById("button-position-select"),
    downloadBtn: document.getElementById("download-btn"),
    viewerBtn: document.getElementById("viewer-btn"),
    status: document.getElementById("status"),
    statusText: document.getElementById("status-text"),
    progressTrack: document.getElementById("progress-track"),
    progressBar: document.getElementById("progress-bar")
  };

  function updateFieldVisibility() {
    const direction = document.querySelector('[name="direction"]:checked').value;
    globalThis.updateStitchLayoutFields(direction);
  }

  function readFormOptions() {
    return {
      direction: document.querySelector('[name="direction"]:checked').value,
      format: els.format.value,
      cols: Math.max(1, Number(els.cols.value) || 6),
      maxWidth: Math.max(0, Number(els.maxWidth.value) || 0),
      gap: Math.max(0, Number(els.gap.value) || 0),
      overlap: Math.max(0, Number(els.overlap.value) || 0),
      reverse: Boolean(els.reverse.checked),
      compactButton: Boolean(els.compactButton.checked),
      inlineAction: els.inlineAction.value,
      buttonPosition: els.buttonPosition.value
    };
  }

  function applyOptionsToForm(opts) {
    const selected = Array.from(els.directions).find(el => el.value === opts.direction);
    (selected || els.directions[0]).checked = true;
    els.format.value = opts.format || "png";
    els.cols.value = String(opts.cols || 6);
    els.maxWidth.value = String(opts.maxWidth || 0);
    els.gap.value = String(opts.gap || 0);
    els.overlap.value = String(opts.overlap || 0);
    els.reverse.checked = Boolean(opts.reverse);
    els.compactButton.checked = Boolean(opts.compactButton);
    els.inlineAction.value = opts.inlineAction || "viewer";
    els.buttonPosition.value = opts.buttonPosition || "bookmark";
    updateFieldVisibility();
  }

  function setStatus(text, kind = "", progressPct = null) {
    els.status.classList.remove("hidden", "error", "success");
    if (kind) els.status.classList.add(kind);
    els.statusText.textContent = text;
    if (typeof progressPct === "number") {
      els.progressTrack.classList.remove("hidden");
      els.progressBar.style.width = `${Math.max(0, Math.min(100, progressPct))}%`;
    } else {
      els.progressTrack.classList.add("hidden");
    }
  }

  function setBusy(busy) {
    els.downloadBtn.disabled = busy;
    els.viewerBtn.disabled = busy;
  }

  async function checkPermissions() {
    if (!browser.permissions || !browser.permissions.contains) return true;
    const ok = await browser.permissions.contains({ origins: REQUIRED_ORIGINS });
    els.permBanner.classList.toggle("hidden", ok);
    return ok;
  }

  els.grantPermBtn.addEventListener("click", async () => {
    try {
      const granted = await browser.permissions.request({ origins: REQUIRED_ORIGINS });
      els.permBanner.classList.toggle("hidden", granted);
    } catch (err) {
      setStatus(`Permission request failed: ${err.message}`, "error");
    }
  });

  async function persistFormOptions() {
    updateFieldVisibility();
    await Stitcher.saveOptions(readFormOptions());
  }

  for (const el of [
    ...els.directions,
    els.format,
    els.cols,
    els.maxWidth,
    els.gap,
    els.overlap,
    els.reverse,
    els.compactButton,
    els.inlineAction,
    els.buttonPosition
  ]) {
    el.addEventListener("change", persistFormOptions);
  }

  // Delegate stitch & download to background via Port so work finishes even if popup closes
  els.downloadBtn.addEventListener("click", async () => {
    const input = els.urlInput.value.trim();
    let tweetId;
    try {
      tweetId = Stitcher.extractTweetId(input);
    } catch (err) {
      setStatus(err.message, "error");
      return;
    }

    const hasPerms = await checkPermissions();
    if (!hasPerms) {
      setStatus('Please click "Grant Access" above first.', "error");
      return;
    }

    const opts = readFormOptions();
    await Stitcher.saveOptions(opts);

    if (!browser.downloads || !browser.downloads.download) {
      const viewerUrl = new URL(browser.runtime.getURL("viewer.html"));
      viewerUrl.searchParams.set("id", tweetId);
      await browser.tabs.create({ url: viewerUrl.toString() });
      window.close();
      return;
    }

    setBusy(true);
    setStatus("Fetching carousel metadata...", "", 5);

    const port = browser.runtime.connect({ name: "xcs-stitch-download" });
    let finished = false;

    port.onMessage.addListener((msg) => {
      if (!msg || finished) return;
      if (msg.type === "progress" && msg.progress) {
        setStatus(msg.progress.text || "Working...", "", msg.progress.pct ?? 50);
      } else if (msg.type === "done" && msg.result) {
        finished = true;
        const r = msg.result;
        const mb = (r.sizeBytes / (1024 * 1024)).toFixed(2);
        const notes = [];
        if (r.skippedMediaCount > 0) {
          notes.push(`${r.skippedMediaCount} video${r.skippedMediaCount === 1 ? "" : "s"} skipped`);
        }
        if (r.clampedReason) notes.push(r.clampedReason);
        const extra = notes.length ? ` (${notes.join("; ")})` : "";
        setStatus(
          `Saved ${r.filename} (${r.width}x${r.height}, ${mb} MB)${extra}`,
          "success",
          100
        );
        setBusy(false);
        port.disconnect();
      } else if (msg.type === "error") {
        finished = true;
        setStatus(msg.error || "Stitching failed", "error");
        setBusy(false);
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (!finished) {
        setBusy(false);
      }
    });

    port.postMessage({ type: "START", urlOrId: tweetId, options: opts });
  });

  els.viewerBtn.addEventListener("click", async () => {
    const input = els.urlInput.value.trim();
    const opts = readFormOptions();
    await Stitcher.saveOptions(opts);

    let tweetId = "";
    if (input) {
      try {
        tweetId = Stitcher.extractTweetId(input);
      } catch (err) {
        setStatus(err.message, "error");
        return;
      }
    }

    const viewerUrl = new URL(browser.runtime.getURL("viewer.html"));
    if (tweetId) viewerUrl.searchParams.set("id", tweetId);
    await browser.tabs.create({ url: viewerUrl.toString() });
    window.close();
  });

  els.urlInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !els.downloadBtn.disabled) {
      els.downloadBtn.click();
    }
  });

  els.urlInput.addEventListener("input", () => {
    document.getElementById("viewer-label").textContent = els.urlInput.value.trim() ? "Preview stitch" : "Open viewer";
    els.sourceHint.textContent = "";
    if (els.status.classList.contains("error")) els.status.classList.add("hidden");
  });

  async function init() {
    try {
      applyOptionsToForm(await Stitcher.loadOptions());
    } catch {
      applyOptionsToForm(Stitcher.DEFAULT_OPTIONS);
      setStatus("Couldn't read saved settings. Using defaults.", "error");
    } finally {
      document.querySelector("main").inert = false;
      document.querySelector(".preferences").inert = false;
    }
    await checkPermissions();

    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeUrl = tabs && tabs[0] && tabs[0].url;
      if (activeUrl) {
        try {
          const id = Stitcher.extractTweetId(activeUrl);
          if (!els.urlInput.value) {
            els.urlInput.value = id;
            document.getElementById("viewer-label").textContent = "Preview stitch";
            const author = new URL(activeUrl).pathname.match(/^\/(\w{1,15})\/status(?:es)?\//i)?.[1];
            els.sourceHint.textContent = author && author !== "i" ? `Current tab · @${author}` : "Current tab";
          }
        } catch {}
      }
    } catch {}
  }

  init();
})();
