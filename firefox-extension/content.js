(function () {
  "use strict";

  const BUTTON_CLASS = "xcs-stitch-btn";
  const WRAPPER_CLASS = "xcs-stitch-wrap";
  const DATE_ROW_CLASS = "xcs-date-row";
  const COMPACT_ROOT_CLASS = "xcs-compact";
  const STATUS_LINK_RE = /\/status\/(\d{10,25})(?:\/|$|\?)/;
  const PERMALINK_HREF_RE = /^(?:https?:\/\/(?:mobile\.)?(?:x|twitter)\.com)?\/[^/?#]+\/status\/(\d{10,25})(?:\/?(?:[?#].*)?)?$/i;
  const ANALYTICS_LINK_RE = /\/status\/(\d{10,25})\/analytics(?:\/|$|\?)/i;
  const PHOTO_LINK_RE = /\/status\/(\d{10,25})\/photo\/(\d+)/;
  const VIDEO_LINK_RE = /\/status\/\d+\/video\/\d+/;
  const AUTHOR_MARKER_SELECTOR = '[data-testid="User-Name"], [data-anchor-to-hovered-child]';
  const NON_DATE_ROW_SELECTOR =
    '[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="User-Name"], [data-anchor-to-hovered-child], [data-post-avatar="true"], a[href*="/photo/"], a[href*="/video/"], div[role="group"]';
  const BOOKMARK_SELECTOR =
    '[data-testid="bookmark"], [data-testid="removeBookmark"], [data-engagement-action="bookmark"]';
  const ACTION_BAR_CHILD_SELECTOR =
    '[data-testid="bookmark"], [data-testid="removeBookmark"], [data-engagement-action="bookmark"], [data-engagement-action="reply"], [data-engagement-action="like"]';
  const activeButtons = new Map();
  let buttonPosition = "bookmark";

  function injectStyles() {
    if (document.getElementById("xcs-styles")) return;
    const style = document.createElement("style");
    style.id = "xcs-styles";
    style.textContent = `
      .${DATE_ROW_CLASS}:has(> .${WRAPPER_CLASS}.xcs-in-date-row) {
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

  function findQuotedCardAncestor(marker, article, primaryAuthor) {
    let cur = marker.parentElement;
    let lastExclusive = null;
    while (cur && cur !== article) {
      if (primaryAuthor && cur.contains(primaryAuthor)) {
        break;
      }
      if (cur.matches('article, [data-href*="/status/"], div[role="link"], div[tabindex="0"]')) {
        return cur;
      }
      if (!cur.querySelector("[data-engagement-action]")) {
        lastExclusive = cur;
      }
      cur = cur.parentElement;
    }
    return lastExclusive;
  }

  function getQuotedContainers(article) {
    const containers = [];
    const addUnique = (card) => {
      if (card && article.contains(card) && card !== article && !containers.includes(card)) {
        containers.push(card);
      }
    };

    for (const nested of article.querySelectorAll("article")) {
      if (nested !== article) addUnique(nested);
    }

    let authorMarkers = Array.from(article.querySelectorAll('[data-testid="User-Name"]'));
    const primaryHeaderAuthor =
      authorMarkers[0] || article.querySelector("[data-anchor-to-hovered-child]");
    if (authorMarkers.length <= 1) {
      authorMarkers = Array.from(article.querySelectorAll("[data-anchor-to-hovered-child]"));
    }
    if (authorMarkers.length <= 1) {
      authorMarkers = Array.from(article.querySelectorAll('[data-post-avatar="true"]'));
    }

    if (authorMarkers.length > 1) {
      const primaryAuthor = primaryHeaderAuthor || authorMarkers[0];
      for (let i = 1; i < authorMarkers.length; i++) {
        addUnique(findQuotedCardAncestor(authorMarkers[i], article, primaryAuthor));
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
        'video, [data-testid="videoComponent"], [data-testid="videoPlayer"], [data-testid="playButton"], [data-icon="icon-player-play"], a[href*="/video/"]'
      )
    ) {
      return true;
    }
    return false;
  }

  function isInPostText(el) {
    return Boolean(el.closest('[data-testid="tweetText"], div[dir="auto"]'));
  }

  function isNonDateAnchorContext(el) {
    return Boolean(isInPostText(el) || el.closest('div[role="group"], [data-engagement-action]'));
  }

  function findMainTimeElement(article, quotedContainers) {
    for (const t of article.querySelectorAll("time")) {
      if (!isInsideAny(t, quotedContainers)) return t;
    }

    let fallback = null;
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (isInsideAny(a, quotedContainers) || isNonDateAnchorContext(a)) continue;
      const href = a.getAttribute("href") || "";
      if (!PERMALINK_HREF_RE.test(href)) continue;
      if (a.getAttribute("data-base-ui-tooltip-trigger") !== null) {
        return a;
      }
      if (!fallback) fallback = a;
    }
    return fallback;
  }

  function findTweetStatusId(article, quotedContainers) {
    for (const t of article.querySelectorAll("time")) {
      if (isInsideAny(t, quotedContainers)) continue;
      const timeLink = t.closest("a[href]");
      if (timeLink) {
        const m = (timeLink.getAttribute("href") || "").match(STATUS_LINK_RE);
        if (m) return m[1];
      }
      break;
    }

    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (isInsideAny(a, quotedContainers) || isNonDateAnchorContext(a)) continue;
      if (a.getAttribute("data-base-ui-tooltip-trigger") === null) continue;
      const m = (a.getAttribute("href") || "").match(PERMALINK_HREF_RE);
      if (m) return m[1];
    }

    for (const node of article.querySelectorAll('[data-href*="/status/"]')) {
      if (isInsideAny(node, quotedContainers)) continue;
      const m = (node.getAttribute("data-href") || "").match(STATUS_LINK_RE);
      if (m) return m[1];
    }

    for (const a of article.querySelectorAll('a[href*="/analytics"]')) {
      if (isInsideAny(a, quotedContainers) || isInPostText(a)) continue;
      const m = (a.getAttribute("href") || "").match(ANALYTICS_LINK_RE);
      if (m) return m[1];
    }

    for (const a of article.querySelectorAll('a[href*="/photo/"], a[href*="/video/"]')) {
      if (isInsideAny(a, quotedContainers) || isInPostText(a)) continue;
      const m = (a.getAttribute("href") || "").match(STATUS_LINK_RE);
      if (m) return m[1];
    }

    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (isInsideAny(a, quotedContainers) || isNonDateAnchorContext(a)) continue;
      const m = (a.getAttribute("href") || "").match(STATUS_LINK_RE);
      if (m) return m[1];
    }

    const pageMatch = location.pathname.match(STATUS_LINK_RE);
    return pageMatch ? pageMatch[1] : null;
  }

  function hasMultipleImages(article, quotedContainers, tweetId) {
    const photoNodes = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"]')).filter(
      (el) => !isInsideAny(el, quotedContainers) && !isVideoElementOrLink(el)
    );

    const photoIndices = new Set();
    const links = article.querySelectorAll('a[href*="/photo/"]');
    for (const a of links) {
      if (isInsideAny(a, quotedContainers) || isVideoElementOrLink(a)) continue;
      const href = a.getAttribute("href") || "";
      if (VIDEO_LINK_RE.test(href)) continue;
      const m = href.match(PHOTO_LINK_RE);
      if (m && (!tweetId || m[1] === tweetId)) photoIndices.add(m[2]);
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

  function isInAuthorHeader(timeEl, article) {
    if (timeEl.closest('[data-testid="User-Name"]')) {
      return true;
    }
    let cur = timeEl.parentElement;
    for (let depth = 0; depth < 3 && cur && cur !== article; depth++) {
      if (
        cur.querySelector(
          'div[role="group"], [data-testid="tweetPhoto"], a[href*="/photo/"], a[href*="/video/"]'
        )
      ) {
        break;
      }
      if (cur.querySelector(AUTHOR_MARKER_SELECTOR)) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function findDateRowAnchor(article, quotedContainers) {
    for (const t of article.querySelectorAll("time")) {
      if (!isInsideAny(t, quotedContainers) && !isInAuthorHeader(t, article)) {
        return t.closest("a[href]") || t;
      }
    }

    let fallback = null;
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (isInsideAny(a, quotedContainers) || isNonDateAnchorContext(a)) continue;
      const href = a.getAttribute("href") || "";
      if (!PERMALINK_HREF_RE.test(href)) continue;
      if (isInAuthorHeader(a, article)) continue;
      if (a.getAttribute("data-base-ui-tooltip-trigger") !== null) {
        return a;
      }
      if (!fallback) fallback = a;
    }
    if (fallback) return fallback;

    for (const a of article.querySelectorAll('a[href*="/analytics"]')) {
      if (isInsideAny(a, quotedContainers) || isNonDateAnchorContext(a)) continue;
      const href = a.getAttribute("href") || "";
      if (!ANALYTICS_LINK_RE.test(href)) continue;
      if (!isInAuthorHeader(a, article)) return a;
    }

    return null;
  }

  function findDateViewsRow(article, quotedContainers) {
    const timeLink = findDateRowAnchor(article, quotedContainers);
    if (!timeLink) return null;

    let bestRow = null;
    let cur = timeLink.parentElement;

    for (let depth = 0; depth < 6 && cur && cur !== article; depth++) {
      if (cur.querySelector(NON_DATE_ROW_SELECTOR)) {
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

  function clearDateRowClass(wrapper) {
    if (wrapper.classList.contains("xcs-in-date-row") && wrapper.parentElement) {
      wrapper.parentElement.classList.remove(DATE_ROW_CLASS);
    }
  }

  function placeInDateRow(dateRow, wrapper) {
    if (wrapper.parentElement !== dateRow) {
      clearDateRowClass(wrapper);
      dateRow.appendChild(wrapper);
    }
    wrapper.classList.remove("xcs-in-header", "xcs-in-action-bar");
    dateRow.classList.add(DATE_ROW_CLASS);
    wrapper.classList.add("xcs-in-date-row");
  }

  function findHeaderMenuButton(article, quotedContainers) {
    for (const c of article.querySelectorAll('[data-testid="caret"]')) {
      if (!isInsideAny(c, quotedContainers)) return c;
    }

    let fallback = null;
    for (const btn of article.querySelectorAll('button[data-slot="xds-menu-trigger"]')) {
      if (isInsideAny(btn, quotedContainers)) continue;
      if (btn.closest('div[role="group"]') || btn.closest("[data-engagement-action]")) continue;
      if (btn.getAttribute("aria-label") === "More") return btn;
      if (!fallback) fallback = btn;
    }
    return fallback;
  }

  function findHeaderRightTarget(article, quotedContainers) {
    const caret = findHeaderMenuButton(article, quotedContainers);
    if (!caret) return null;

    let target = caret.parentElement;
    let cur = caret.parentElement;
    for (let depth = 0; depth < 4 && cur && cur !== article; depth++) {
      if (cur.querySelector(AUTHOR_MARKER_SELECTOR)) {
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
      if (articleRect.width > 0 && wrapRect.right > articleRect.right + 4) {
        return true;
      }
    }

    const mainTime = findMainTimeElement(article, quotedContainers);
    if (mainTime && typeof mainTime.getBoundingClientRect === "function") {
      if (rectsOverlap(wrapRect, mainTime.getBoundingClientRect())) {
        return true;
      }
    }

    const userNames = article.querySelectorAll(AUTHOR_MARKER_SELECTOR);
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
        if (rectsOverlap(wrapRect, sib.getBoundingClientRect(), -4)) {
          return true;
        }
      }
    }

    return false;
  }

  function insertBeforeIfNeeded(parent, node, ref) {
    if (node.parentElement === parent) {
      const children = parent.children;
      if (ref) {
        const refIdx = Array.prototype.indexOf.call(children, ref);
        if (refIdx > 0 && children[refIdx - 1] === node) return;
      } else if (children[children.length - 1] === node) {
        return;
      }
    }
    if (ref) parent.insertBefore(node, ref);
    else parent.appendChild(node);
  }

  function placeInActionBar(article, wrapper, quotedContainers) {
    const groups = Array.from(article.querySelectorAll('div[role="group"]')).filter(
      (g) => !isInsideAny(g, quotedContainers)
    );
    const engagementGroups = groups.filter((g) => g.querySelector(ACTION_BAR_CHILD_SELECTOR));
    const actionBar =
      engagementGroups.length > 0
        ? engagementGroups[engagementGroups.length - 1]
        : groups.length > 0
          ? groups[groups.length - 1]
          : null;
    if (!actionBar) return false;

    clearDateRowClass(wrapper);
    wrapper.classList.remove("xcs-in-header", "xcs-in-date-row");
    wrapper.classList.add("xcs-in-action-bar");

    const bookmarkBtn = actionBar.querySelector(BOOKMARK_SELECTOR);
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
        insertBeforeIfNeeded(slot, wrapper, bmChild);
      } else {
        insertBeforeIfNeeded(actionBar, wrapper, slot);
      }
      return true;
    }

    insertBeforeIfNeeded(actionBar, wrapper, null);
    return true;
  }

  function placeInHeader(headerRight, wrapper) {
    clearDateRowClass(wrapper);
    wrapper.classList.remove("xcs-in-action-bar", "xcs-in-date-row");
    wrapper.classList.add("xcs-in-header");
    if (wrapper.parentElement !== headerRight) {
      headerRight.insertBefore(wrapper, headerRight.firstChild);
    }
  }

  function placeButton(article, wrapper, quotedContainers) {
    delete wrapper.dataset.headerFallback;

    if (buttonPosition === "header-auto") {
      const headerRight = findHeaderRightTarget(article, quotedContainers);
      if (headerRight) {
        placeInHeader(headerRight, wrapper);
        if (!headerButtonOverlaps(article, wrapper, headerRight, quotedContainers)) {
          return;
        }
        wrapper.dataset.headerFallback = "1";
      }
    }

    const dateRow = findDateViewsRow(article, quotedContainers);
    if (dateRow) {
      placeInDateRow(dateRow, wrapper);
      return;
    }

    if (placeInActionBar(article, wrapper, quotedContainers)) return;

    if (buttonPosition !== "header-auto") {
      const headerRight = findHeaderRightTarget(article, quotedContainers);
      if (headerRight) {
        placeInHeader(headerRight, wrapper);
      }
    }
  }

  function enhanceArticle(article, repositionExisting = false) {
    const quotedContainers = getQuotedContainers(article);
    const tweetId = findTweetStatusId(article, quotedContainers);

    const existingBtn = article.querySelector(`.${BUTTON_CLASS}`);
    if (existingBtn) {
      if (existingBtn.dataset.tweetId === tweetId) {
        const existingWrap = existingBtn.closest(`.${WRAPPER_CLASS}`);
        if (!existingWrap) return;

        if (repositionExisting) {
          placeButton(article, existingWrap, quotedContainers);
          return;
        }

        if (existingWrap.classList.contains("xcs-in-header")) {
          const shouldLeaveHeader =
            buttonPosition === "bookmark" ||
            headerButtonOverlaps(article, existingWrap, existingWrap.parentElement, quotedContainers);
          if (shouldLeaveHeader) {
            if (buttonPosition === "header-auto") {
              existingWrap.dataset.headerFallback = "1";
            } else {
              delete existingWrap.dataset.headerFallback;
            }
            const dateRow = findDateViewsRow(article, quotedContainers);
            if (dateRow) {
              placeInDateRow(dateRow, existingWrap);
            } else {
              placeInActionBar(article, existingWrap, quotedContainers);
            }
          }
        } else if (buttonPosition === "header-auto" && !existingWrap.dataset.headerFallback) {
          placeButton(article, existingWrap, quotedContainers);
        } else if (existingWrap.classList.contains("xcs-in-action-bar")) {
          const dateRow = findDateViewsRow(article, quotedContainers);
          if (dateRow) {
            placeInDateRow(dateRow, existingWrap);
          }
        }
        return;
      }
      // Article node was recycled by X for a different tweet; remove stale button
      const staleWrap = existingBtn.closest(`.${WRAPPER_CLASS}`);
      if (staleWrap) {
        clearDateRowClass(staleWrap);
        staleWrap.remove();
      } else {
        existingBtn.remove();
      }
    }

    if (!tweetId || !hasMultipleImages(article, quotedContainers, tweetId)) return;

    const wrapper = document.createElement("div");
    wrapper.className = WRAPPER_CLASS;
    wrapper.appendChild(createStitchButton(tweetId));

    placeButton(article, wrapper, quotedContainers);
  }

  function scanTweets(repositionExisting = false) {
    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      if (article.parentElement && article.parentElement.closest("article")) {
        continue;
      }
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
    attributeFilter: ["href", "data-href"]
  });

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", () => scheduleScan(true));
  }
})();
