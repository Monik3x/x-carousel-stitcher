(function () {
  "use strict";

  const Stitcher = globalThis.XCarouselStitcher;
  const MENU_OPEN_VIEWER = "xcs-open-viewer";
  const MENU_DOWNLOAD_DIRECT = "xcs-download-direct";
  const FETCH_ORIGINS = [
    "https://api.fxtwitter.com/*",
    "https://api.vxtwitter.com/*",
    "https://pbs.twimg.com/*"
  ];

  const pendingBlobUrls = new Map();
  let activeJobs = 0;
  let keepAliveTimer = null;

  // MV3 event pages idle-suspend after ~30s even while async work runs; ping a lightweight API while jobs or download blobs are live.
  function syncKeepAlive() {
    const needed = activeJobs > 0 || pendingBlobUrls.size > 0;
    if (needed && !keepAliveTimer) {
      keepAliveTimer = setInterval(() => {
        if (browser.runtime && browser.runtime.getPlatformInfo) {
          browser.runtime.getPlatformInfo().catch(() => {});
        }
      }, 20_000);
    } else if (!needed && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function revokeDownloadUrl(downloadId) {
    const entry = pendingBlobUrls.get(downloadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingBlobUrls.delete(downloadId);
    syncKeepAlive();
    try {
      URL.revokeObjectURL(entry.url);
    } catch {}
  }

  if (browser.downloads && browser.downloads.onChanged) {
    browser.downloads.onChanged.addListener((delta) => {
      if (
        delta.state &&
        (delta.state.current === "complete" || delta.state.current === "interrupted")
      ) {
        revokeDownloadUrl(delta.id);
      }
    });
  }

  async function hasFetchPermissions() {
    if (!browser.permissions || !browser.permissions.contains) return true;
    try {
      return await browser.permissions.contains({ origins: FETCH_ORIGINS });
    } catch {
      return true;
    }
  }

  async function downloadBlob(blob, filename, saveAs = false) {
    if (!browser.downloads || !browser.downloads.download) {
      throw new Error("Browser downloads API is unavailable on this platform.");
    }
    const url = URL.createObjectURL(blob);
    try {
      const downloadId = await browser.downloads.download({
        url,
        filename,
        saveAs,
        conflictAction: "uniquify"
      });
      const timer = setTimeout(() => revokeDownloadUrl(downloadId), 120_000);
      pendingBlobUrls.set(downloadId, { url, timer });
      syncKeepAlive();
      return downloadId;
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  let menuRegChain = Promise.resolve();
  function registerContextMenus() {
    if (!browser.contextMenus) return;
    menuRegChain = menuRegChain
      .then(async () => {
        await browser.contextMenus.removeAll();
        const patterns = [
          "https://x.com/*",
          "https://twitter.com/*",
          "https://mobile.x.com/*",
          "https://mobile.twitter.com/*"
        ];

        browser.contextMenus.create({
          id: MENU_OPEN_VIEWER,
          title: "Stitch X Carousel (Open Viewer)",
          contexts: ["page", "link", "image"],
          documentUrlPatterns: patterns
        });

        browser.contextMenus.create({
          id: MENU_DOWNLOAD_DIRECT,
          title: "Stitch X Carousel & Download",
          contexts: ["page", "link", "image"],
          documentUrlPatterns: patterns
        });
      })
      .catch(() => {});
  }

  if (browser.contextMenus) {
    browser.runtime.onInstalled.addListener(registerContextMenus);
    browser.runtime.onStartup.addListener(registerContextMenus);

    browser.contextMenus.onClicked.addListener(async (info, tab) => {
      const candidates = [info.linkUrl, info.pageUrl, tab && tab.url].filter(Boolean);
      let tweetId = null;
      for (const candidate of candidates) {
        try {
          tweetId = Stitcher.extractTweetId(candidate);
          break;
        } catch {}
      }
      if (!tweetId) {
        await browser.tabs.create({ url: browser.runtime.getURL("viewer.html") });
        return;
      }

      if (info.menuItemId === MENU_OPEN_VIEWER) {
        await openViewerTab(tweetId);
      } else if (info.menuItemId === MENU_DOWNLOAD_DIRECT) {
        if (!(await hasFetchPermissions())) {
          await openViewerTab(tweetId);
          return;
        }
        try {
          await stitchAndDownloadTweet(tweetId);
        } catch {
          await openViewerTab(tweetId);
        }
      }
    });
  }

  function openViewerTab(tweetId, extraParams = {}) {
    const url = new URL(browser.runtime.getURL("viewer.html"));
    url.searchParams.set("id", tweetId);
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
    return browser.tabs.create({ url: url.toString() });
  }

  async function stitchAndDownloadTweet(tweetId, overrideOptions, onProgress) {
    activeJobs++;
    syncKeepAlive();
    try {
      const saved = await Stitcher.loadOptions();
      const opts = Object.assign({}, saved, overrideOptions || {});

      if (onProgress) onProgress({ stage: "metadata", pct: 5, text: "Fetching carousel info..." });
      const meta = await Stitcher.fetchCarouselMetadata(tweetId);

      if (onProgress) {
        onProgress({
          stage: "downloading",
          completed: 0,
          total: meta.urls.length,
          pct: 10,
          text: `Found ${meta.urls.length} images by @${meta.author}. Downloading...`
        });
      }

      const bitmaps = await Stitcher.downloadAllBitmaps(meta.urls, (completed, total) => {
        if (onProgress) {
          onProgress({
            stage: "downloading",
            completed,
            total,
            pct: 10 + Math.round((completed / total) * 75),
            text: `Downloading ${completed}/${total} images...`
          });
        }
      });

      try {
        if (onProgress) onProgress({ stage: "stitching", pct: 90, text: "Stitching image..." });
        const { blob, width, height, clampedReason, format } = await Stitcher.stitchBitmapsToBlob(
          bitmaps,
          opts
        );
        const filename = Stitcher.buildFilename(meta.author, meta.tweetId, format);
        await downloadBlob(blob, filename, false);
        return {
          ok: true,
          filename,
          author: meta.author,
          tweetId: meta.tweetId,
          count: meta.urls.length,
          skippedMediaCount: meta.skippedMediaCount || 0,
          width,
          height,
          sizeBytes: blob.size,
          clampedReason
        };
      } finally {
        Stitcher.closeBitmaps(bitmaps);
      }
    } finally {
      activeJobs--;
      syncKeepAlive();
    }
  }

  // Long-lived Port channel so popup stitches survive popup dismissal
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "xcs-stitch-download") return;

    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
    });

    const safePost = (msg) => {
      if (disconnected) return;
      try {
        port.postMessage(msg);
      } catch {
        disconnected = true;
      }
    };

    port.onMessage.addListener(async (msg) => {
      if (!msg || msg.type !== "START") return;
      try {
        const tweetId = Stitcher.extractTweetId(msg.urlOrId || "");
        const result = await stitchAndDownloadTweet(tweetId, msg.options, (progress) => {
          safePost({ type: "progress", progress });
        });
        safePost({ type: "done", result });
      } catch (err) {
        safePost({ type: "error", error: err.message || String(err) });
      }
    });
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") return undefined;

    if (message.type === "OPEN_VIEWER") {
      try {
        const tweetId = Stitcher.extractTweetId(message.urlOrId || message.tweetId || "");
        return openViewerTab(tweetId, message.params || {}).then(() => ({ ok: true, tweetId }));
      } catch (err) {
        return Promise.resolve({ ok: false, error: err.message });
      }
    }

    if (message.type === "INLINE_STITCH_CLICK") {
      return (async () => {
        try {
          const tweetId = Stitcher.extractTweetId(message.tweetId || "");
          const opts = await Stitcher.loadOptions();
          const mode = message.forceMode || opts.inlineAction || "viewer";

          if (
            mode === "viewer" ||
            !(await hasFetchPermissions()) ||
            !browser.downloads ||
            !browser.downloads.download
          ) {
            await openViewerTab(tweetId);
            return { ok: true, mode: "viewer" };
          }

          const senderTabId = sender && sender.tab ? sender.tab.id : null;
          const requestId = message.requestId || null;
          const result = await stitchAndDownloadTweet(tweetId, opts, (progress) => {
            if (senderTabId !== null && requestId) {
              browser.tabs
                .sendMessage(senderTabId, {
                  type: "STITCH_PROGRESS",
                  requestId,
                  progress
                })
                .catch(() => {});
            }
          });
          return Object.assign({ mode: "download" }, result);
        } catch (err) {
          return { ok: false, error: err.message || String(err) };
        }
      })();
    }

    return undefined;
  });
})();
