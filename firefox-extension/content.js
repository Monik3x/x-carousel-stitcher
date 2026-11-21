(function () {
  "use strict";

  const BUTTON_CLASS = "xcs-stitch-btn";
  const WRAPPER_CLASS = "xcs-stitch-wrap";
  const DATE_ROW_CLASS = "xcs-date-row";
  const COMPACT_ROOT_CLASS = "xcs-compact";
  const STATUS_LINK_RE = /\/status\/(\d{10,25})(?:\/|$|\?)/;
  const PHOTO_LINK_RE = /\/status\/\d+\/photo\/(\d+)/;
  const VIDEO_LINK_RE = /\/status\/\d+\/video\/\d+/;
  const activeButtons = new Map();
  let buttonPosition = "bookmark";

  function injectStyles() {
    if (document.getElementById("xcs-styles")) return;
    const style = document.createElement("style");
    style.id = "xcs-styles";
    style.textContent = `
      .${DATE_ROW_CLASS} {
        width: 100% !important;
        max-width: 100% !important;
        align-items: center !important;
      }
      .${WRAPPER_CLASS} {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }
      .${WRAPPER_CLASS}.xcs-in-date-row {
        margin-left: auto;
        padding-left: 12px;
      }
      .${WRAPPER_CLASS}.xcs-in-header {
        margin-right: 4px;
      }
      .${WRAPPER_CLASS}.xcs-in-action-bar {
        margin-right: 4px;
      }
      .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: transparent;
        border: 1px solid rgba(113, 118, 123, 0.35);
        border-radius: 9999px;
        padding: 3px 10px;
        color: rgb(113, 118, 123);
        font-family: "TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.2;
        cursor: pointer;
        transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
        user-select: none;
        white-space: nowrap;
      }
      .${WRAPPER_CLASS}.xcs-in-header .${BUTTON_CLASS} {
        font-size: 12px;
        padding: 2px 8px;
      }
      .${BUTTON_CLASS}:hover {
        color: rgb(29, 155, 240);
        border-color: rgba(29, 155, 240, 0.5);
        background-color: rgba(29, 155, 240, 0.12);
      }
      .${BUTTON_CLASS}[data-state="busy"] {
        color: rgb(29, 155, 240);
        border-color: rgba(29, 155, 240, 0.5);
        cursor: progress;
      }
      .${BUTTON_CLASS}[data-state="done"] {
        color: rgb(0, 186, 124);
        border-color: rgba(0, 186, 124, 0.5);
      }
      .${BUTTON_CLASS}[data-state="error"] {
        color: rgb(244, 33, 46);
        border-color: rgba(244, 33, 46, 0.5);
      }
      .${BUTTON_CLASS} svg {
        width: 15px;
        height: 15px;
        flex-shrink: 0;
        fill: currentColor;
      }
      .${COMPACT_ROOT_CLASS} .${WRAPPER_CLASS}.xcs-in-header,
      .${COMPACT_ROOT_CLASS} .${WRAPPER_CLASS}.xcs-in-action-bar {
        margin-right: 0;
      }
      .${COMPACT_ROOT_CLASS} .${BUTTON_CLASS},
      .${COMPACT_ROOT_CLASS} .${WRAPPER_CLASS}.xcs-in-header .${BUTTON_CLASS},
      .${COMPACT_ROOT_CLASS} .${WRAPPER_CLASS}.xcs-in-action-bar .${BUTTON_CLASS} {
        border: none;
        padding: 7px;
        min-width: 34px;
        min-height: 34px;
        justify-content: center;
      }
      .${COMPACT_ROOT_CLASS} .${BUTTON_CLASS} svg {
        width: 19px;
        height: 19px;
      }
      .${COMPACT_ROOT_CLASS} .${BUTTON_CLASS}:not([data-state]) span {
        display: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getQuotedContainers(article) {
    const userNames = article.querySelectorAll('[data-testid="User-Name"]');
    if (userNames.length <= 1) return [];

    const containers = [];
    for (let i = 1; i < userNames.length; i++) {
      const card =
        userNames[i].closest('div[role="link"]') ||
        userNames[i].closest('div[tabindex="0"]');
      if (card && article.contains(card) && card !== article) {
        containers.push(card);
      }
    }
    return containers;
  }

  function isInsideAny(el, containers) {
    for (const c of containers) {
      if (c.contains(el)) return true;
    }
    return false;
  }

  function isVideoElementOrLink(el) {
    if (!el) return false;
    if (
      el.closest(
        '[data-testid="videoComponent"], [data-testid="videoPlayer"], a[href*="/video/"]'
      )
    ) {
      return true;
    }
    if (
      el.querySelector &&
      el.querySelector(
        'video, [data-testid="videoComponent"], [data-testid="videoPlayer"], [data-testid="playButton"], a[href*="/video/"]'
      )
    ) {
      return true;
    }
    return false;
  }

  function findMainTimeElement(article, quotedContainers) {
    const times = article.querySelectorAll("time");
    for (const t of times) {
      if (!isInsideAny(t, quotedContainers)) return t;
    }
    return null;
  }

  function findTweetStatusId(article, quotedContainers) {
    const timeEl = findMainTimeElement(article, quotedContainers);
    if (timeEl) {
      const timeLink = timeEl.closest("a[href]");
      if (timeLink) {
        const m = (timeLink.getAttribute("href") || "").match(STATUS_LINK_RE);
        if (m) return m[1];
      }
    }

    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      if (isInsideAny(a, quotedContainers)) continue;
      const m = (a.getAttribute("href") || "").match(STATUS_LINK_RE);
      if (m) return m[1];
    }

    const pageMatch = location.pathname.match(STATUS_LINK_RE);
    return pageMatch ? pageMatch[1] : null;
  }

  function hasMultipleImages(article, quotedContainers) {
    const photoNodes = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"]')).filter(
      (el) => !isInsideAny(el, quotedContainers) && !isVideoElementOrLink(el)
    );

    const photoIndices = new Set();
    const links = article.querySelectorAll('a[href*="/photo/"]');
    for (const a of links) {
      if (isInsideAny(a, quotedContainers)) continue;
      const href = a.getAttribute("href") || "";
      if (VIDEO_LINK_RE.test(href)) continue;
      const m = href.match(PHOTO_LINK_RE);
      if (m) photoIndices.add(m[1]);
    }

    if (photoNodes.length >= 2 || photoIndices.size >= 2) {
      return true;
    }

    // Narrow viewports render 1 slide plus nav arrows; require a real photo so video carousels stay excluded.
    if (photoNodes.length >= 1 || photoIndices.size >= 1) {
      const navButtons = article.querySelectorAll(
        'button[aria-label*="Next slide"], button[aria-label*="Previous slide"]'
      );
      for (const btn of navButtons) {
        if (!isInsideAny(btn, quotedContainers) && !isVideoElementOrLink(btn)) {
          return true;
        }
      }
    }

    return false;
  }

  function createIconSvg() {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute(
      "d",
      "M3 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H3zm0 2h5v10H3V7zm7 0h4v10h-4V7zm6 0h5v10h-5V7z"
    );
    svg.appendChild(path);
    return svg;
  }

  function createStitchButton(tweetId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BUTTON_CLASS;
    btn.dataset.tweetId = tweetId;
    btn.setAttribute("aria-label", "Stitch carousel into one image");
    btn.title = "Stitch carousel into one image (Shift+Click to download directly)";

    const icon = createIconSvg();
    const label = document.createElement("span");
    label.textContent = "Stitch";
    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      if (btn.dataset.state === "busy") return;

      const requestId = `${tweetId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeButtons.set(requestId, { btn, label });
      btn.dataset.state = "busy";
      label.textContent = "...";

      try {
        const forceMode = ev.shiftKey ? "download" : undefined;
        const resp = await browser.runtime.sendMessage({
          type: "INLINE_STITCH_CLICK",
          tweetId,
          requestId,
          forceMode
        });

        if (resp && resp.ok) {
          btn.dataset.state = "done";
          label.textContent = resp.mode === "download" ? `Saved (${resp.count})` : "Opened";
        } else {
          btn.dataset.state = "error";
          label.textContent = "Failed";
          btn.title = (resp && resp.error) || "Stitching failed";
        }
      } catch (err) {
        btn.dataset.state = "error";
        label.textContent = "Error";
        btn.title = err.message || String(err);
      } finally {
        activeButtons.delete(requestId);
        setTimeout(() => {
          if (btn.isConnected) {
            delete btn.dataset.state;
            label.textContent = "Stitch";
            btn.title = "Stitch carousel into one image (Shift+Click to download directly)";
          }
        }, 3000);
      }
    });

    return btn;
  }

  function findDateViewsRow(article, quotedContainers) {
    const timeEl = findMainTimeElement(article, quotedContainers);
    if (!timeEl) return null;

    // On timeline tweets, <time> lives inside [data-testid="User-Name"]
    if (timeEl.closest('[data-testid="User-Name"]')) {
      return null;
    }

    const timeLink = timeEl.closest("a[href]") || timeEl;
    let bestRow = null;
    let cur = timeLink.parentElement;

    for (let depth = 0; depth < 6 && cur && cur !== article; depth++) {
      if (
        cur.querySelector(
          '[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="User-Name"], div[role="group"]'
        )
      ) {
        break;
      }

      const cs = getComputedStyle(cur);
      const isHorizontalFlex =
        cs.display.includes("flex") &&
        (cs.flexDirection === "row" || cs.flexDirection === "row-reverse");

      if (isHorizontalFlex) {
        bestRow = cur;
      }
      cur = cur.parentElement;
    }

    return bestRow || timeLink.parentElement;
  }

  function findHeaderRightTarget(article, quotedContainers) {
    const carets = article.querySelectorAll('[data-testid="caret"]');
    let caret = null;
    for (const c of carets) {
      if (!isInsideAny(c, quotedContainers)) {
        caret = c;
        break;
      }
    }
    if (!caret) return null;

    let target = caret.parentElement;
    let cur = caret.parentElement;
    for (let depth = 0; depth < 4 && cur && cur !== article; depth++) {
      if (cur.querySelector('[data-testid="User-Name"]')) {
        break;
      }
      const cs = getComputedStyle(cur);
      if (cs.display.includes("flex") && cs.flexDirection === "row") {
        target = cur;
      }
      cur = cur.parentElement;
    }
    return target;
  }

  function rectsOverlap(a, b, pad = 2) {
    if (!a || !b || a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
      return false;
    }
    return (
      a.left < b.right + pad &&
      a.right + pad > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top
    );
  }

  function headerButtonOverlaps(article, wrapper, headerRight, quotedContainers) {
    if (typeof wrapper.getBoundingClientRect !== "function") return false;
    const wrapRect = wrapper.getBoundingClientRect();
    if (!wrapRect || (wrapRect.width === 0 && wrapRect.height === 0)) return false;

    if (typeof article.getBoundingClientRect === "function") {
      const articleRect = article.getBoundingClientRect();
      if (articleRect.width > 0 && wrapRect.right > articleRect.right + 1) {
        return true;
      }
    }

    const mainTime = findMainTimeElement(article, quotedContainers);
    if (mainTime && typeof mainTime.getBoundingClientRect === "function") {
      if (rectsOverlap(wrapRect, mainTime.getBoundingClientRect())) {
        return true;
      }
    }

    const userNames = article.querySelectorAll('[data-testid="User-Name"]');
    for (const un of userNames) {
      if (isInsideAny(un, quotedContainers)) continue;
      if (typeof un.getBoundingClientRect === "function") {
        if (rectsOverlap(wrapRect, un.getBoundingClientRect())) {
          return true;
        }
      }
      break;
    }

    // Check siblings of headerRight (e.g. badges injected by third-party extensions) and siblings inside headerRight
    const headerRow = headerRight && headerRight.parentElement;
    if (headerRow) {
      for (const sib of headerRow.children) {
        if (sib === headerRight || typeof sib.getBoundingClientRect !== "function") continue;
        if (rectsOverlap(wrapRect, sib.getBoundingClientRect())) {
          return true;
        }
      }
    }
    if (headerRight) {
      for (const sib of headerRight.children) {
        if (sib === wrapper || typeof sib.getBoundingClientRect !== "function") continue;
        if (rectsOverlap(wrapRect, sib.getBoundingClientRect(), 0)) {
          return true;
        }
      }
    }

    return false;
  }

  function placeInActionBar(article, wrapper, quotedContainers) {
    const groups = Array.from(article.querySelectorAll('div[role="group"]')).filter(
      (g) => !isInsideAny(g, quotedContainers)
    );
    const actionBar = groups.length > 0 ? groups[groups.length - 1] : null;
    if (!actionBar) return false;

    wrapper.classList.remove("xcs-in-header", "xcs-in-date-row");
    wrapper.classList.add("xcs-in-action-bar");

    const bookmarkBtn = actionBar.querySelector(
      '[data-testid="bookmark"], [data-testid="removeBookmark"]'
    );
    if (bookmarkBtn) {
      let slot = bookmarkBtn;
      while (slot.parentElement && slot.parentElement !== actionBar) {
        slot = slot.parentElement;
      }
      const cs = getComputedStyle(slot);
      if (slot.children.length >= 2 && cs.display.includes("flex") && cs.flexDirection === "row") {
        let bmChild = bookmarkBtn;
        while (bmChild.parentElement && bmChild.parentElement !== slot) {
          bmChild = bmChild.parentElement;
        }
        slot.insertBefore(wrapper, bmChild);
      } else {
        actionBar.insertBefore(wrapper, slot);
      }
      return true;
    }

    actionBar.appendChild(wrapper);
    return true;
  }

  function placeTimelineButton(article, wrapper, quotedContainers) {
    if (buttonPosition === "header-auto") {
      const headerRight = findHeaderRightTarget(article, quotedContainers);
      if (headerRight) {
        wrapper.classList.remove("xcs-in-action-bar", "xcs-in-date-row");
        wrapper.classList.add("xcs-in-header");
        if (wrapper.parentElement !== headerRight) {
          headerRight.insertBefore(wrapper, headerRight.firstChild);
        }
        if (headerButtonOverlaps(article, wrapper, headerRight, quotedContainers)) {
          placeInActionBar(article, wrapper, quotedContainers);
        }
        return;
      }
    }

    if (placeInActionBar(article, wrapper, quotedContainers)) return;

    const headerRight = findHeaderRightTarget(article, quotedContainers);
    if (headerRight) {
      wrapper.classList.remove("xcs-in-action-bar", "xcs-in-date-row");
      wrapper.classList.add("xcs-in-header");
      headerRight.insertBefore(wrapper, headerRight.firstChild);
    }
  }

  function enhanceArticle(article, repositionExisting = false) {
    const quotedContainers = getQuotedContainers(article);
    const tweetId = findTweetStatusId(article, quotedContainers);

    const existingBtn = article.querySelector(`.${BUTTON_CLASS}`);
    if (existingBtn) {
      if (existingBtn.dataset.tweetId === tweetId) {
        const existingWrap = existingBtn.closest(`.${WRAPPER_CLASS}`);
        if (existingWrap && !existingWrap.classList.contains("xcs-in-date-row")) {
          if (buttonPosition === "bookmark" && existingWrap.classList.contains("xcs-in-header")) {
            placeInActionBar(article, existingWrap, quotedContainers);
          } else if (buttonPosition === "header-auto") {
            if (existingWrap.classList.contains("xcs-in-header")) {
              if (
                headerButtonOverlaps(article, existingWrap, existingWrap.parentElement, quotedContainers)
              ) {
                placeInActionBar(article, existingWrap, quotedContainers);
              }
            } else if (repositionExisting && existingWrap.classList.contains("xcs-in-action-bar")) {
              placeTimelineButton(article, existingWrap, quotedContainers);
            }
          }
        }
        return;
      }
      // Article node was recycled by X for a different tweet; remove stale button
      const staleWrap = existingBtn.closest(`.${WRAPPER_CLASS}`);
      if (staleWrap) staleWrap.remove();
      else existingBtn.remove();
    }

    if (!tweetId || !hasMultipleImages(article, quotedContainers)) return;

    const wrapper = document.createElement("div");
    wrapper.className = WRAPPER_CLASS;
    wrapper.appendChild(createStitchButton(tweetId));

    const dateRow = findDateViewsRow(article, quotedContainers);
    if (dateRow) {
      dateRow.classList.add(DATE_ROW_CLASS);
      wrapper.classList.add("xcs-in-date-row");
      dateRow.appendChild(wrapper);
      return;
    }

    placeTimelineButton(article, wrapper, quotedContainers);
  }

  function scanTweets(repositionExisting = false) {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      enhanceArticle(article, repositionExisting);
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "STITCH_PROGRESS" && message.requestId) {
      const entry = activeButtons.get(message.requestId);
      if (entry && message.progress) {
        if (message.progress.stage === "downloading" && message.progress.total) {
          entry.label.textContent = `${message.progress.completed}/${message.progress.total}`;
        } else if (message.progress.stage === "stitching") {
          entry.label.textContent = "Stitching...";
        }
      }
    }
  });

  function applyUiOptions(opts) {
    const root = document.documentElement;
    if (root && root.classList) {
      root.classList.toggle(COMPACT_ROOT_CLASS, Boolean(opts && opts.compactButton));
    }
    buttonPosition =
      opts && opts.buttonPosition === "header-auto" ? "header-auto" : "bookmark";
    scheduleScan(true);
  }

  let scheduled = false;
  let pendingReposition = false;
  function scheduleScan(repositionExisting = false) {
    if (repositionExisting === true) pendingReposition = true;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const reposition = pendingReposition;
      pendingReposition = false;
      try {
        scanTweets(reposition);
      } finally {
        scheduled = false;
      }
    });
  }

  if (browser.storage && browser.storage.local) {
    browser.storage.local
      .get("options")
      .then((saved) => applyUiOptions(saved && saved.options))
      .catch(() => {});

    if (browser.storage.onChanged) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.options && changes.options.newValue) {
          applyUiOptions(changes.options.newValue);
        }
      });
    }
  }

  injectStyles();
  scanTweets();

  const observer = new MutationObserver(scheduleScan);

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"]
  });

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", scheduleScan);
  }
})();
