// Redline — the in-page UI: element/area picker, note composer, dock and
// review sheet. Plain DOM in a shadow root; idle cost on a page is one storage
// read and a pointer listener.
(() => {
  'use strict';

  // A fresh copy (re-injected after an extension reload) replaces any orphan.
  document.dispatchEvent(new CustomEvent('redline:takeover'));
  const life = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: life.signal });
  on(document, 'redline:takeover', () => teardown(), { once: true });

  const KEY = 'session';
  const MAX_EDGE = 2000; // px; longer screenshots are scaled down (Claude downsizes beyond this anyway)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const IS_EXTENSION_PAGE = location.protocol === 'chrome-extension:';
  // Redline runs in every frame. The top frame owns the composer, dock, sheet
  // and the screenshot; child frames (e.g. a Shopify app inside the admin) only
  // pick and hand what they picked up.
  const IS_TOP = window === window.top;

  let session = null; // { id, folder, createdAt, items: [...] }
  let mode = 'idle'; // idle | picking | capturing | composing
  let sheetOpen = false;
  let sheetView = 'current'; // current | history | entry
  let history = null; // History summaries, newest first (loaded when the sheet opens)
  let entry = null; // the archived session open in the sheet
  let uiHidden = false; // Esc tucked the dock away (all tabs) until the next capture
  let lastCopy = null; // { id, hash, at }: the last text Redline copied (see onPaste)
  let plainNext = 0; // ⇧⌘V was pressed: leave the next paste alone until this time
  let shortcutLabel = isMac ? '⌘⇧S' : 'Ctrl+Shift+S';
  let myTabId = null;
  const pointer = { x: -1, y: -1 };
  const imageCache = new Map(); // item id → data URL

  // -------------------------------------------------------------------------
  // Plumbing

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) return teardown(), reject(new Error('Redline was reloaded; refresh the page'));
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  const pageKey = () => location.origin + location.pathname + location.search;
  // Frames are keyed without the query: embedded apps get fresh tokens on every load.
  const frameKey = () => location.origin + location.pathname;
  const uid = () => crypto.randomUUID();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const frames = (n = 2) => new Promise((r) => (function tick(i) { i ? requestAnimationFrame(() => tick(i - 1)) : r(); })(n));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  async function readSession() {
    return (await chrome.storage.local.get(KEY))[KEY] ?? null;
  }

  // Read-modify-write against storage (another tab may have changed it).
  async function mutate(fn) {
    const next = (await readSession()) ?? { id: uid(), folder: stamp(), createdAt: Date.now(), items: [] };
    fn(next);
    session = next;
    render();
    await chrome.storage.local.set({ [KEY]: next });
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    if ('lastCopy' in changes) lastCopy = changes.lastCopy.newValue ?? null;
    if ('panel' in changes) syncPanel(changes.panel.newValue);
    if (!(KEY in changes || 'uiHidden' in changes)) return;
    if (KEY in changes) session = changes[KEY].newValue ?? null;
    if ('uiHidden' in changes) uiHidden = !!changes.uiHidden.newValue;
    render();
  }

  function setUiHidden(hidden) {
    if (uiHidden === hidden) return;
    uiHidden = hidden;
    render();
    chrome.storage.local.set({ uiHidden: hidden }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Describing what was picked (goes into the prompt for Claude)

  const UTILITY = /^(-?(m|p)[xytrbl]?-|flex|grid|block|inline|hidden|contents|items-|justify-|content-|self-|place-|gap-|space-|w-|h-|min-|max-|size-|text-|font-|leading-|tracking-|bg-|from-|to-|via-|border|rounded|shadow|ring|outline|opacity-|absolute|relative|fixed|sticky|static|inset|top-|left-|right-|bottom-|z-|overflow|object-|aspect-|order-|col-|row-|basis-|grow|shrink|transition|duration-|ease-|delay-|animate-|cursor-|select-|pointer-|uppercase|lowercase|capitalize|italic|underline|truncate|whitespace-|break-|container|sr-only|visible|invisible|transform|translate-|scale-|rotate-|fill-|stroke-)/;

  function classesOf(el) {
    const ok = [...el.classList].filter((c) => c.length <= 40 && !/[:[\]/()!@]/.test(c) && !/\d{5,}/.test(c));
    const semantic = ok.filter((c) => !UTILITY.test(c.replace(/^tw-/, '')));
    return (semantic.length ? semantic : ok).slice(0, 2);
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id && el.id.length <= 60 && !/\s/.test(el.id)) return `${s}#${el.id}`;
    const cls = classesOf(el);
    return cls.length ? `${s}.${cls.join('.')}` : s;
  }

  // Readable path for humans and Claude: up to 4 levels, stopping at an id.
  // When no ancestor in the path has an id, the nearest one above is added as
  // context (on Shopify that's the section, e.g. #shopify-section-…__hero).
  function readablePath(el) {
    const parts = [];
    let n = el;
    for (; n?.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      parts.unshift(describe(n));
      if ((n !== el && n.id) || parts.length === 4) break;
    }
    const anchored = parts.length > 1 && parts[0].includes('#');
    const above = !anchored && n?.parentElement?.closest('[id]');
    if (above && above !== document.body && above !== document.documentElement) parts.unshift(`#${above.id} …`);
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // Exact path, used only to find the element again (Show on page, and to
  // tell the picker what's already noted).
  function exactPath(el) {
    const parts = [];
    for (let n = el; n?.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const parent = n.parentElement;
      const tag = n.tagName.toLowerCase();
      if (!parent) break;
      const same = [...parent.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    return parts.join(' > ');
  }

  function textOf(el) {
    if (el === document.body || el === document.documentElement) return '';
    const raw =
      el.getAttribute?.('aria-label') ||
      (el.tagName === 'IMG' && (el.alt || el.src.split('/').pop().split('?')[0])) ||
      ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el.value || el.placeholder)) ||
      el.innerText ||
      '';
    const text = raw.replace(/\s+/g, ' ').trim();
    return text.length > 90 ? `${text.slice(0, 88)}…` : text;
  }

  function isFixed(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  function elementAt(x, y) {
    let el = document.elementsFromPoint(x, y).find((n) => n !== host);
    // Look inside open shadow roots (web components).
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el ?? null;
  }

  // -------------------------------------------------------------------------
  // UI shell. The host is a manual popover so it renders in the top layer, above
  // the page's own modals and popovers.

  let host = null;
  let root = null;
  const $ = {};

  const HOST_STYLE =
    'all:initial!important;position:fixed!important;inset:0!important;width:auto!important;height:auto!important;' +
    'max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;' +
    'background:transparent!important;overflow:visible!important;display:block!important;pointer-events:none!important;' +
    'z-index:2147483647!important;color-scheme:light dark!important;';

  function ensureUI() {
    if (host) {
      if (!host.isConnected) raise();
      return;
    }
    host = document.createElement('redline-ui');
    host.setAttribute('popover', 'manual');
    host.style.cssText = HOST_STYLE;
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLES}</style>${TEMPLATE}`;
    for (const el of root.querySelectorAll('[data-ref]')) $[el.dataset.ref] = el;
    raise();
    wireUI();
    if (IS_TOP) {
      send({ type: 'shortcut' })
        .then(({ shortcut }) => setShortcut(shortcut))
        .catch(() => {});
    }
  }

  // An open modal <dialog> makes everything outside it inert, our top-layer
  // popover included. Living inside the dialog keeps the composer typeable.
  function topModal() {
    const open = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal'));
    return open.at(-1) ?? null;
  }

  function raise() {
    if (!host) return;
    const modal = topModal();
    const parent = modal ?? document.documentElement;
    if (host.parentNode !== parent) {
      parent.append(host);
      modal?.addEventListener('close', () => host?.parentNode === modal && raise(), { once: true });
    }
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // No popover support or detached; z-index still applies.
    }
  }

  function setShortcut(label) {
    shortcutLabel = label || '';
    for (const el of root.querySelectorAll('[data-shortcut]')) {
      el.textContent = shortcutLabel || 'no shortcut';
    }
    $.dockCapture.title = shortcutLabel ? `Capture (${shortcutLabel})` : 'Capture';
  }

  function setHidden(hidden) {
    host?.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
  }

  // A clicked button keeps focus even after its panel hides, and keys on it
  // never reach the page (see isolate), so a later Esc went nowhere until you
  // clicked the page. Mouse clicks give focus straight back; keyboard
  // activation (detail 0) keeps it.
  function dropButtonFocus(e, scope) {
    if (!e.detail) return;
    queueMicrotask(() => {
      const active = scope.activeElement;
      if (active?.tagName === 'BUTTON') active.blur();
    });
  }

  // Keep keystrokes typed into Redline away from the page's own shortcuts.
  function isolate(rootNode) {
    const events = ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut', 'focusin', 'focusout', 'wheel'];
    const presses = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'];
    for (const type of [...events, ...presses]) {
      rootNode.addEventListener(type, (e) => e.stopPropagation(), { passive: type === 'wheel' });
    }
  }

  function wireUI() {
    isolate(root);
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) actions[act]?.(e);
      dropButtonFocus(e, root);
    });

    // Composer (Enter/Esc are handled by the key router, see onKeyDown)
    $.input.addEventListener('input', () => {
      composer && (composer.armed = false);
      $.cmp.classList.remove('armed');
      placeComposer();
    });

    // Sheet: notes save as you type
    $.list.addEventListener('input', (e) => {
      const ta = e.target.closest('.card-note');
      if (!ta) return;
      const id = ta.closest('.card').dataset.id;
      clearTimeout(ta._save);
      ta._save = setTimeout(() => saveNote(id, ta.value), 250);
    });
    $.list.addEventListener('focusout', (e) => {
      const ta = e.target.closest?.('.card-note');
      if (ta?._save) clearTimeout(ta._save), saveNote(ta.closest('.card').dataset.id, ta.value);
    });
  }

  const actions = {
    capture: () => startPicking(),
    stop: () => stopPicking(),
    save: () => commit({ next: false }),
    next: () => commit({ next: true }),
    discard: () => closeComposer(),
    veil: () => dismissComposer(), // clicking the dimmed page counts as cancel
    delete: () => {
      if (!composer || composer.isNew) return;
      const id = composer.item.id;
      closeComposer();
      removeItem(id);
    },
    review: () => openSheet(),
    close: () => closeSheet(),
    copy: (e) => copyAll(e.target.closest('button')),
    copyEntry: (e) => copyAll(e.target.closest('button'), entry?.id),
    copyImage: (e) => copyImage(e.target.closest('.card')),
    clear: () => clearSession(),
    view: (e) => setSheetView(e.target.closest('[data-view]').dataset.view),
    back: () => setSheetView('history'),
    openEntry: (e) => openEntry(e.target.closest('[data-id]').dataset.id),
    reopen: (e) => reopenSession(e.target.closest('[data-id]')?.dataset.id ?? entry?.id),
    deleteEntry: () => deleteEntry(),
    shortcuts: () => send({ type: 'openShortcuts' }).catch(() => {}),
    zoom: (e) => openLightbox(e.target.closest('.card').dataset.id),
    unzoom: () => closeLightbox(),
    remove: (e) => removeItem(e.target.closest('.card').dataset.id),
    goto: (e) => {
      e.preventDefault();
      const id = e.target.closest('.card').dataset.id;
      const item = session?.items.find((i) => i.id === id);
      if (!item) return;
      if (item.url !== pageKey()) return window.open(item.url, '_blank');
      closeSheet();
      if (item.frameUrl) toFrames({ type: 'frame:show', id });
      else showItem(item);
    },
    toast: (e) => toastActions[Number(e.target.closest('[data-i]')?.dataset.i ?? 0)]?.(),
  };

  // -------------------------------------------------------------------------
  // Picking: hover highlights an element, click captures it, drag captures an
  // area, Space captures the whole screen. Page hover states stay live, so open
  // menus and tooltips can be captured too.

  let pickAbort = null;
  const pick = { base: null, el: null, trail: [], drag: null, raf: 0, notedFor: null, noted: [] };

  function startPicking() {
    if (mode === 'composing') return focusComposer();
    if (mode !== 'idle') return;
    closeSheet();
    closeLightbox();
    mode = 'picking';
    if (IS_TOP) setUiHidden(false);
    if (IS_TOP && !document.hasFocus()) window.focus();
    ensureUI();
    raise();
    if (IS_TOP) {
      send({ type: 'ping' }).catch(() => {}); // wake the worker so the capture is instant
      toFrames({ type: 'frame:start' });
    }

    Object.assign(pick, { base: null, el: null, trail: [], drag: null, notedFor: null });
    pickAbort = new AbortController();
    const opts = { capture: true, passive: false, signal: pickAbort.signal };
    addEventListener('pointermove', onPickMove, opts);
    addEventListener('pointerdown', onPickDown, opts);
    addEventListener('pointerup', onPickUp, opts);
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart', 'selectstart', 'touchstart']) {
      addEventListener(type, swallow, opts);
    }
    addEventListener('pointerout', (e) => !e.relatedTarget && clearHover(), opts); // left this frame
    addEventListener('scroll', () => pick.el && !pick.drag && drawHighlight(pick.el), { capture: true, passive: true, signal: pickAbort.signal });

    setCursor(true);
    if (IS_TOP) {
      $.hud.classList.add('on');
      $.hud.classList.toggle('top', pointer.y > innerHeight - 110);
    }
    render();
    if (pointer.x >= 0) hoverAt(pointer.x, pointer.y);
  }

  function stopPicking() {
    if (mode !== 'picking') return;
    mode = 'idle';
    cleanupPicking();
    if (IS_TOP) toFrames({ type: 'frame:stop' });
    render();
  }

  function cleanupPicking() {
    pickAbort?.abort();
    pickAbort = null;
    cancelAnimationFrame(pick.raf);
    setCursor(false);
    $.hud?.classList.remove('on', 'dragging');
    $.hl?.classList.remove('on');
    $.tag?.classList.remove('on');
    $.rg?.classList.remove('on');
  }

  function setCursor(onOff) {
    let style = document.getElementById('redline-cursor');
    if (!onOff) return style?.remove();
    if (style) return;
    style = document.createElement('style');
    style.id = 'redline-cursor';
    style.textContent = 'html,html *{cursor:crosshair!important;user-select:none!important;-webkit-user-select:none!important}';
    (document.head ?? document.documentElement).append(style);
  }

  const ours = (e) => e.target === host;

  function swallow(e) {
    if (ours(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // The click that follows a capturing pointerup must not reach the page (it
  // would follow the link you just pointed at).
  function swallowNextClick() {
    const kill = (e) => !ours(e) && (e.preventDefault(), e.stopImmediatePropagation());
    addEventListener('click', kill, { capture: true, signal: life.signal });
    setTimeout(() => removeEventListener('click', kill, { capture: true }), 500);
  }

  function onPickMove(e) {
    if (ours(e)) {
      $.hl.classList.remove('on');
      $.tag.classList.remove('on');
      return;
    }
    const { clientX: x, clientY: y } = e;
    if (pick.drag) {
      const d = pick.drag;
      if (!d.active && Math.hypot(x - d.x, y - d.y) > 5) {
        d.active = true;
        $.hl.classList.remove('on');
        $.tag.classList.remove('on');
        $.rg.classList.add('on');
        $.hud.classList.add('dragging');
      }
      if (d.active) drawRegion(d.x, d.y, x, y);
      return;
    }
    cancelAnimationFrame(pick.raf);
    pick.raf = requestAnimationFrame(() => hoverAt(x, y));
    $.hud.classList.toggle('top', y > innerHeight - 110 && Math.abs(x - innerWidth / 2) < 320);
  }

  function hoverAt(x, y) {
    const el = elementAt(x, y);
    if (!el) return;
    if (el === pick.base) return !pick.el || $.hl.classList.contains('on') || drawHighlight(pick.el);
    pick.base = el;
    pick.trail = [];
    if (childAgents.has(el)) {
      // An iframe running Redline highlights its own content.
      pick.el = null;
      $.hl.classList.remove('on');
      $.tag.classList.remove('on');
      return;
    }
    pick.el = el;
    drawHighlight(el);
    if (!IS_TOP) toParent({ type: 'enter' }); // so the parent knows where the pointer is
  }

  function clearHover() {
    pick.base = null;
    $.hl?.classList.remove('on');
    $.tag?.classList.remove('on');
  }

  function onPickDown(e) {
    if (ours(e)) return;
    swallow(e);
    if (e.button !== 0) return;
    pick.drag = { x: e.clientX, y: e.clientY, active: false };
  }

  function onPickUp(e) {
    if (ours(e)) return;
    swallow(e);
    const d = pick.drag;
    pick.drag = null;
    if (!d || e.button !== 0) return;
    swallowNextClick();
    hoverAt(e.clientX, e.clientY); // a fast click can land before the hover frame
    if (d.active) {
      $.rg.classList.remove('on');
      $.hud.classList.remove('dragging');
      const r = rectFromPoints(d.x, d.y, e.clientX, e.clientY);
      if (r.w >= 8 && r.h >= 8) return submit(areaPayload(r));
      return;
    }
    if (pick.el) submit(elementPayload(pick.el));
  }

  const NAV_KEYS = ['Enter', 'ArrowUp', 'ArrowDown'];

  // Keys land in whichever frame has focus, which may not be the one under the
  // pointer. Esc/Space are the top frame's; Enter/↑/↓ travel to the frame that
  // is actually hovering something. `from` is the frame element a key came up
  // from, so it's never bounced straight back.
  function pickKey(k, { fromAbove = false, from = null } = {}) {
    if (k === 'Escape') IS_TOP ? stopPicking() : toParent({ type: 'key', key: 'Escape' });
    else if (k === ' ') IS_TOP ? captureScreen() : toParent({ type: 'key', key: ' ' });
    else if (!NAV_KEYS.includes(k)) return false;
    else if (pick.el) navKey(k);
    else if (childAgents.has(pick.base) && pick.base !== from) forwardTo(pick.base, { type: 'key', key: k });
    else if (!IS_TOP && !fromAbove) toParent({ type: 'key', key: k });
    return true;
  }

  function navKey(k) {
    if (k === 'Enter') return submit(elementPayload(pick.el));
    if (k === 'ArrowUp' && pick.el.parentElement && pick.el.parentElement !== document.documentElement) {
      pick.trail.push(pick.el);
      pick.el = pick.el.parentElement;
    } else if (k === 'ArrowDown' && pick.trail.length) {
      pick.el = pick.trail.pop();
    }
    drawHighlight(pick.el);
  }

  function drawHighlight(el) {
    const r = el.getBoundingClientRect();
    Object.assign($.hl.style, {
      transform: `translate(${r.left}px, ${r.top}px)`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      borderRadius: radiiOf(el, r.width, r.height).map((v) => `${v}px`).join(' '),
    });
    $.hl.classList.add('on');

    if (pick.notedFor !== el) (pick.notedFor = el), (pick.noted = notesOn(el));
    const noted = pick.noted;
    $.hl.classList.toggle('noted', noted.length > 0);
    $.tag.classList.toggle('noted', noted.length > 0);
    $.tagNums.replaceChildren(...noted.map(({ n }) => Object.assign(document.createElement('span'), { textContent: n })));
    $.tagNote.textContent = noted.map((x) => x.note).filter(Boolean).join(' · ');
    $.tagName.textContent = describe(el);
    $.tagSize.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    $.tag.classList.add('on');
    const tw = $.tag.offsetWidth;
    const th = $.tag.offsetHeight;
    const tx = clamp(r.left, 6, innerWidth - tw - 6);
    let ty = r.top - th - 6;
    if (ty < 6) ty = r.bottom + th + 12 < innerHeight ? r.bottom + 6 : clamp(r.top, 0, innerHeight) + 6;
    $.tag.style.transform = `translate(${tx}px, ${ty}px)`;
  }

  // Notes already taken on this element, numbered as in the panel and the
  // prompt. Matched by the element itself (exact path, tag, classes and text),
  // never by a saved position, so it can't point at the wrong thing.
  function notesOn(el) {
    const out = [];
    session?.items.forEach((item, i) => {
      if (item.kind !== 'element' || !(IS_TOP ? !item.frameUrl && item.url === pageKey() : item.frameUrl === frameKey())) return;
      if (findLive(item) !== el || describe(el) !== item.target?.label || textOf(el) !== (item.target?.text ?? '')) return;
      out.push({ n: i + 1, note: item.note });
    });
    return out;
  }

  // Corner radii [top-left, top-right, bottom-right, bottom-left] in px. Corners
  // differ more often than you'd think (Shopify admin's title bar rounds only
  // its top-right one).
  function radiiOf(el, w, h) {
    const cs = getComputedStyle(el);
    return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => {
      const first = v.split(' ')[0]; // elliptical corners: the horizontal radius
      const px = first.endsWith('%') ? (parseFloat(first) / 100) * w : parseFloat(first);
      return Math.min(px || 0, w / 2, h / 2);
    });
  }

  function rectFromPoints(x0, y0, x1, y1) {
    const x = clamp(Math.min(x0, x1), 0, innerWidth);
    const y = clamp(Math.min(y0, y1), 0, innerHeight);
    return { x, y, w: clamp(Math.max(x0, x1), 0, innerWidth) - x, h: clamp(Math.max(y0, y1), 0, innerHeight) - y };
  }

  function drawRegion(x0, y0, x1, y1) {
    const r = rectFromPoints(x0, y0, x1, y1);
    Object.assign($.rg.style, { transform: `translate(${r.x}px, ${r.y}px)`, width: `${r.w}px`, height: `${r.h}px` });
    $.rgSize.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    $.rg.classList.toggle('inside', r.y + r.h + 34 > innerHeight);
  }

  // -------------------------------------------------------------------------
  // Capture

  const viewportRect = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });

  function intersect(r) {
    const x = clamp(r.x, 0, innerWidth);
    const y = clamp(r.y, 0, innerHeight);
    return { x, y, w: clamp(r.x + r.w, 0, innerWidth) - x, h: clamp(r.y + r.h, 0, innerHeight) - y };
  }

  // Element shots get breathing room so Claude sees where the element sits.
  function contextCrop(r) {
    const vw = innerWidth;
    const vh = innerHeight;
    let x0 = r.x - 24;
    let y0 = r.y - 24;
    let x1 = r.x + r.w + 24;
    let y1 = r.y + r.h + 24;
    const grow = (a, b, min) => {
      if (b - a >= min) return [a, b];
      const c = (a + b) / 2;
      return [c - min / 2, c + min / 2];
    };
    [x0, x1] = grow(x0, x1, Math.min(420, vw));
    [y0, y1] = grow(y0, y1, Math.min(260, vh));
    const shift = (a, b, max) => (a < 0 ? [0, Math.min(max, b - a)] : b > max ? [Math.max(0, a - (b - max)), max] : [a, b]);
    [x0, x1] = shift(x0, x1, vw);
    [y0, y1] = shift(y0, y1, vh);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // What was picked, in this frame's viewport coordinates. `doc` is the same in
  // this frame's document coordinates (Show on page falls back to it).
  function elementPayload(el) {
    const rect = viewportRect(el.getBoundingClientRect());
    const fixed = isFixed(el);
    return {
      kind: 'element',
      rect,
      radius: radiiOf(el, rect.w, rect.h),
      fixed,
      doc: fixed ? rect : { ...rect, x: rect.x + scrollX, y: rect.y + scrollY },
      css: exactPath(el),
      target: { label: describe(el), path: readablePath(el), text: textOf(el) },
    };
  }

  function areaPayload(r) {
    const center = elementAt(r.x + r.w / 2, r.y + r.h / 2);
    return {
      kind: 'area',
      rect: r,
      doc: { ...r, x: r.x + scrollX, y: r.y + scrollY },
      target: center ? { label: describe(center), path: readablePath(center) } : null,
    };
  }

  // Child frames hand the pick to the top frame, which takes the screenshot.
  function submit(p) {
    if (IS_TOP) return captureFrom(p);
    mode = 'idle';
    cleanupPicking();
    releaseFocus();
    toParent({ type: 'capture', ...p, frameUrl: frameKey(), bounds: viewportBounds() });
  }

  // Let the top frame's composer have the keyboard (blurs e.g. the app's input).
  function releaseFocus() {
    const active = document.activeElement;
    if (active && active !== document.body) active.blur?.();
  }

  // Top frame: `rect` and `bounds` (the visible part of the frame chain) are in
  // top-viewport coordinates by now.
  function captureFrom(p) {
    if (mode !== 'picking') return;
    const visible = intersect(p.bounds ? overlap(p.rect, p.bounds) : p.rect);
    if (visible.w < 2 || visible.h < 2) return;
    const element = p.kind === 'element';
    capture({
      kind: p.kind,
      spot: visible,
      crop: element ? contextCrop(visible) : visible,
      ring: element ? { ...p.rect, radius: p.radius } : null,
      fixed: !!p.fixed,
      rect: p.doc,
      css: p.css ?? null,
      target: p.target ?? null,
      frameUrl: p.frameUrl ?? null,
    });
  }

  function captureScreen() {
    const r = viewportBounds();
    capture({ kind: 'screen', spot: r, crop: r, rect: { ...r, x: scrollX, y: scrollY } });
  }

  async function capture(c) {
    cleanupPicking();
    mode = 'capturing';
    setHidden(true);
    let shot;
    try {
      await toFrames({ type: 'frame:snap', hidden: true }); // child frames stop picking, hide their highlight
      await frames(2); // let the hidden UI paint out
      shot = await send({ type: 'capture' });
    } catch (err) {
      mode = 'idle';
      render();
      return toast(`Couldn’t capture: ${err.message}`, { error: true });
    } finally {
      setHidden(false);
      toFrames({ type: 'frame:snap', hidden: false });
    }

    let image;
    try {
      image = await cropShot(shot.dataUrl, c.crop, c.ring);
    } catch (err) {
      mode = 'idle';
      render();
      return toast(`Couldn’t capture: ${err.message}`, { error: true });
    }
    flash(c.spot);
    const item = {
      id: uid(),
      kind: c.kind,
      note: '',
      url: pageKey(),
      title: document.title.trim(),
      vw: innerWidth,
      vh: innerHeight,
      rect: c.rect,
      fixed: !!c.fixed,
      css: c.css ?? null,
      target: c.target ?? null,
      frameUrl: c.frameUrl ?? null,
      createdAt: Date.now(),
    };
    openComposer({ item, isNew: true, image, spot: c.spot });
  }

  async function cropShot(dataUrl, crop, ring) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const s = img.naturalWidth / innerWidth; // device pixels per CSS pixel
    const sw = Math.max(1, Math.round(crop.w * s));
    const sh = Math.max(1, Math.round(crop.h * s));
    const k = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * k);
    canvas.height = Math.round(sh * k);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, Math.round(crop.x * s), Math.round(crop.y * s), sw, sh, 0, 0, canvas.width, canvas.height);

    // Outline the picked element in red unless it already fills the frame.
    if (ring && ring.w * ring.h < crop.w * crop.h * 0.8) {
      const f = s * k;
      const lw = Math.max(2, 2.5 * f);
      const gap = 3;
      const x = clamp((ring.x - crop.x - gap) * f, lw / 2, canvas.width - lw / 2);
      const y = clamp((ring.y - crop.y - gap) * f, lw / 2, canvas.height - lw / 2);
      const x2 = clamp((ring.x + ring.w - crop.x + gap) * f, lw / 2, canvas.width - lw / 2);
      const y2 = clamp((ring.y + ring.h - crop.y + gap) * f, lw / 2, canvas.height - lw / 2);
      ctx.save();
      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth = lw;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 3 * f;
      ctx.beginPath();
      const max = Math.min((x2 - x) / 2, (y2 - y) / 2);
      ctx.roundRect(x, y, x2 - x, y2 - y, [].concat(ring.radius).map((v) => Math.min((v + gap) * f, max)));
      ctx.stroke();
      ctx.restore();
    }

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const url = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
    return url;
  }

  function flash(r) {
    const el = document.createElement('div');
    el.className = 'flash';
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    $.r.append(el);
    setTimeout(() => el.remove(), 600);
  }

  // -------------------------------------------------------------------------
  // Composer: the note field that appears next to what you captured.

  let composer = null; // { item, isNew, image, spot, armed, scroll }
  let composerAbort = null;

  function openComposer({ item, isNew, image, spot }) {
    mode = 'composing';
    ensureUI();
    raise();
    composer = { item, isNew, image, spot, armed: false, scroll: { x: scrollX, y: scrollY } };

    const index = isNew ? (session?.items.length ?? 0) : session.items.findIndex((i) => i.id === item.id);
    $.cmpNum.textContent = index + 1;
    $.cmpWhat.textContent =
      item.kind === 'screen' ? 'Whole screen' : item.kind === 'area' ? `Area · ${Math.round(spot.w)} × ${Math.round(spot.h)}` : item.target?.label ?? 'Element';
    $.cmpThumb.hidden = isNew;
    if (!isNew) $.cmpThumb.src = image ?? '';
    $.input.value = item.note ?? '';
    $.cmpDelete.hidden = isNew;
    $.cmpSave.lastChild.textContent = isNew ? 'Save' : 'Done';
    $.cmpNext.hidden = !isNew;
    $.cmp.classList.remove('armed', 'shake');
    $.cmp.classList.toggle('edit', !isNew);

    $.spot.classList.toggle('screen', item.kind === 'screen');
    Object.assign($.spot.style, { left: `${spot.x}px`, top: `${spot.y}px`, width: `${spot.w}px`, height: `${spot.h}px`, transform: '' });
    $.spot.classList.add('on');
    $.veil.classList.add('on');
    $.cmp.classList.add('on');
    placeComposer(true);
    focusComposer();
    $.input.setSelectionRange($.input.value.length, $.input.value.length);
    toFrames({ type: 'frame:composing', on: true });
    render();

    // Follow the page if it scrolls underneath (fixed elements stay put).
    composerAbort = new AbortController();
    addEventListener(
      'scroll',
      () => {
        if (!composer || (item.fixed && !item.frameUrl)) return;
        const dx = composer.scroll.x - scrollX;
        const dy = composer.scroll.y - scrollY;
        $.spot.style.transform = `translate(${dx}px, ${dy}px)`;
        $.cmp.style.translate = `${dx}px ${dy}px`;
      },
      { passive: true, signal: composerAbort.signal },
    );
    addEventListener('resize', () => placeComposer(), { signal: composerAbort.signal });
  }

  function placeComposer(initial = false) {
    if (!composer) return;
    const { spot, item } = composer;
    const W = $.cmp.offsetWidth;
    const H = $.cmp.offsetHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    const gap = 14;
    const m = 12;
    let x;
    let y;
    let origin;
    if (item.kind === 'screen') {
      x = (vw - W) / 2;
      y = vh - H - 40;
      origin = 'bottom center';
    } else if (spot.x + spot.w + gap + W + m <= vw) {
      x = spot.x + spot.w + gap;
      y = spot.y;
      origin = 'left top';
    } else if (spot.x - gap - W - m >= 0) {
      x = spot.x - gap - W;
      y = spot.y;
      origin = 'right top';
    } else if (spot.y + spot.h + gap + H + m <= vh) {
      x = spot.x;
      y = spot.y + spot.h + gap;
      origin = 'left top';
    } else if (spot.y - gap - H - m >= 0) {
      x = spot.x;
      y = spot.y - gap - H;
      origin = 'left bottom';
    } else {
      x = vw - W - 24;
      y = vh - H - 24;
      origin = 'right bottom';
    }
    if (initial) $.cmp.style.transformOrigin = origin;
    $.cmp.style.left = `${clamp(x, m, vw - W - m)}px`;
    $.cmp.style.top = `${clamp(y, m, vh - H - m)}px`;
  }

  function dismissComposer() {
    if (!composer) return;
    const changed = $.input.value.trim() !== (composer.item.note ?? '').trim();
    if (changed && $.input.value.trim() && !composer.armed) {
      composer.armed = true;
      $.cmp.classList.add('armed');
      shake();
      return;
    }
    closeComposer();
  }

  // Focus may still sit in an iframe (the app you were clicking around in), and
  // Chrome doesn't always hand it over on the first ask. Ask until it sticks.
  function focusComposer(tries = 5) {
    if (!composer) return;
    if (!document.hasFocus()) window.focus();
    $.input.focus({ preventScroll: true });
    if (tries && (!document.hasFocus() || root.activeElement !== $.input)) {
      setTimeout(() => focusComposer(tries - 1), 60);
    }
  }

  function closeComposer() {
    if (composer) toFrames({ type: 'frame:composing', on: false });
    composerAbort?.abort();
    $.spot.classList.remove('on');
    $.veil.classList.remove('on');
    $.cmp.classList.remove('on', 'armed');
    $.cmp.style.translate = '';
    composer = null;
    mode = 'idle';
    $.input.blur();
    render();
  }

  function shake() {
    $.cmp.classList.remove('shake');
    void $.cmp.offsetWidth;
    $.cmp.classList.add('shake');
  }

  async function commit({ next }) {
    if (!composer) return;
    const note = $.input.value.trim();
    if (!note) return shake(), $.input.focus();
    const { item, isNew, image } = composer;
    closeComposer();
    if (next) startPicking();

    try {
      if (isNew) {
        imageCache.set(item.id, image);
        await send({ type: 'putImage', id: item.id, dataUrl: image });
        await mutate((s) => s.items.push({ ...item, note }));
        bumpDock();
      } else {
        await mutate((s) => {
          const it = s.items.find((i) => i.id === item.id);
          if (it) it.note = note;
        });
      }
    } catch (err) {
      toast(`Couldn’t save: ${err.message}`, { error: true });
    }
  }

  async function saveNote(id, value) {
    const it = session?.items.find((i) => i.id === id);
    if (!it || it.note === value) return;
    await mutate((s) => {
      const target = s.items.find((i) => i.id === id);
      if (target) target.note = value;
    });
  }

  async function removeItem(id) {
    const index = session?.items.findIndex((i) => i.id === id) ?? -1;
    if (index < 0) return;
    const item = session.items[index];
    await mutate((s) => (s.items = s.items.filter((i) => i.id !== id)));
    toast('Note deleted', {
      action: 'Undo',
      onAction: () => mutate((s) => s.items.splice(Math.min(index, s.items.length), 0, item)),
    });
  }

  async function getImage(id) {
    if (!imageCache.has(id)) {
      const found = await send({ type: 'getImages', ids: [id] }).catch(() => ({}));
      if (found[id]) imageCache.set(id, found[id]);
    }
    return imageCache.get(id) ?? null;
  }

  // Scroll a note's element into view and open it for editing.
  async function showItem(item) {
    const live = liveRect(item);
    let r = live && !live.hidden ? live : item.rect;
    if (!item.fixed) {
      const top = r.y - scrollY;
      if (top < 0 || top + Math.min(r.h, innerHeight / 2) > innerHeight) {
        scrollTo({ top: Math.max(0, r.y - innerHeight / 3), behavior: 'instant' });
        await frames(1);
      }
      r = { ...r, x: r.x - scrollX, y: r.y - scrollY };
    }
    if (!IS_TOP) return toParent({ type: 'edit', id: item.id, rect: intersectOrSelf(r), bounds: viewportBounds() });
    openComposer({ item, isNew: false, image: await getImage(item.id), spot: intersectOrSelf(r) });
  }

  function intersectOrSelf(r) {
    const i = intersect(r);
    return i.w > 1 && i.h > 1 ? i : r;
  }

  // -------------------------------------------------------------------------
  // Copy notes

  // A copy closes the session: it moves to History and the next note starts a
  // fresh one. `historyId` re-copies a session from History instead.
  async function copyAll(button, historyId = null) {
    const count = historyId ? (entry?.items.length ?? 0) : (session?.items.length ?? 0);
    if (!count) return toast('Nothing to copy yet');
    button?.classList.add('busy');
    try {
      const { text } = await send({ type: 'export', id: historyId });
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        await send({ type: 'copyText', text });
      }
      for (const b of root.querySelectorAll('[data-act="copy"], [data-act="copyEntry"]')) {
        b.classList.add('done');
        setTimeout(() => b.classList.remove('done'), 1600);
      }
      closeSheet(); // copied: get out of the way, as the dock does
      const showFiles = (id) => ({ label: 'Show files', run: () => revealFiles(id) });
      if (historyId) {
        if (entry?.id === historyId) entry.copiedAt = entry.archivedAt = Date.now();
        toast(`Copied ${plural(count, 'note')}`, { ok: true, actions: [showFiles(historyId)] });
      } else {
        const { id } = await send({ type: 'archive', copied: true });
        await syncSession();
        toast(`Copied ${plural(count, 'note')}`, {
          ok: true,
          actions: [showFiles(id), { label: 'Keep adding', run: () => reopenSession(id, { quiet: true }) }],
        });
      }
      refreshHistory();
    } catch (err) {
      toast(`Couldn’t copy: ${err.message}`, { error: true });
    } finally {
      button?.classList.remove('busy');
    }
  }

  // Opens the session's folder in Finder, for dragging the screenshots into a
  // desktop app.
  function revealFiles(id) {
    send({ type: 'revealFiles', id }).catch((err) => toast(`Couldn’t show the files: ${err.message}`, { error: true }));
  }

  // One screenshot (numbered) onto the clipboard, for pasting a single image.
  async function copyImage(card) {
    const n = Number(card.querySelector('.num').textContent);
    try {
      const { dataUrl } = await send({ type: 'numberedImage', itemId: card.dataset.id, n });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(dataUrl) })]);
      toast(`Copied screenshot ${n}`, { ok: true });
    } catch (err) {
      toast(`Couldn’t copy the screenshot: ${err.message}`, { error: true });
    }
  }

  // -------------------------------------------------------------------------
  // Paste anywhere. Copy puts text with file paths on the clipboard, which
  // coding agents (Claude Code, Codex) read as is. Pasting that same text into a
  // message box on a web page (a claude.ai project chat, ChatGPT, Codex on the
  // web…) brings the screenshots along: Redline swaps the paste for the
  // numbered images plus the notes worded for attachments. Paste and Match
  // Style (⌥⇧⌘V) pastes just the text; so does a page that takes no images.

  function onPaste(e) {
    if (!e.isTrusted || !lastCopy || Date.now() - lastCopy.at > 12 * 3600e3 || ours(e)) return;
    if (Date.now() < plainNext) return void (plainNext = 0);
    const field = e.composedPath()[0];
    if (!(field?.tagName === 'TEXTAREA' || field?.isContentEditable)) return; // single-line inputs keep plain text
    const text = e.clipboardData?.getData('text/plain');
    if (!text || textHash(text) !== lastCopy.hash) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pasteInto(field, lastCopy.id, text);
  }

  async function pasteInto(field, id, plainText) {
    let bundle;
    try {
      bundle = await send({ type: 'pasteBundle', id });
    } catch (err) {
      insertText(field, plainText);
      return toast(`Pasted the text only: ${err.message}`, { error: true });
    }
    const files = bundle.files.map((f) => new File([dataUrlToBlob(f.dataUrl)], f.name, { type: 'image/png' }));
    field.focus();
    // Chat apps take pasted images; the ones that don't usually have an upload input.
    const taken = !field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer(files), bubbles: true, cancelable: true, composed: true }),
    );
    const attached = taken || attachViaInput(field, files);
    insertText(field, attached ? bundle.text : plainText);
    if (attached) toast(`Attached ${plural(files.length, 'screenshot')} with your notes`, { ok: true });
    else toast('This page doesn’t take images, so only the text was pasted', { actions: [{ label: 'Show files', run: () => revealFiles(id) }] });
  }

  function transfer(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  // The message box's own upload input: within its form, or a few levels up.
  function attachViaInput(field, files) {
    let input = field.closest('form')?.querySelector('input[type="file"]') ?? null;
    for (let n = field.parentElement, i = 0; !input && n && i < 6; n = n.parentElement, i++) {
      input = n.querySelector('input[type="file"]');
    }
    if (!input) return false;
    input.files = transfer(input.multiple ? files : files.slice(0, 1)).files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function insertText(field, text) {
    field.focus();
    if (document.execCommand('insertText', false, text)) return;
    if (field.tagName === 'TEXTAREA') {
      const { selectionStart: a, selectionEnd: b, value } = field;
      field.value = value.slice(0, a) + text + value.slice(b);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function dataUrlToBlob(dataUrl) {
    const [head, body] = dataUrl.split(',');
    const bytes = atob(body);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    return new Blob([buf], { type: head.match(/data:([^;]+)/)?.[1] ?? 'image/png' });
  }

  // Same on both sides (background.js has a copy): identifies Redline's text on
  // the clipboard whatever the line endings.
  function textHash(text) {
    const s = text.replace(/\r\n?/g, '\n').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${s.length}:${(h >>> 0).toString(36)}`;
  }

  // Sets the current notes aside (into History) without copying them.
  async function clearSession() {
    if (!session?.items?.length) return;
    try {
      const { id } = await send({ type: 'archive', copied: false });
      await syncSession();
      toast('Moved to History', { action: 'Undo', onAction: () => reopenSession(id, { quiet: true }) });
      refreshHistory();
    } catch (err) {
      toast(`Couldn’t start a new session: ${err.message}`, { error: true });
    }
  }

  // Makes a History session the active one again; new notes join it.
  async function reopenSession(id, { quiet = false } = {}) {
    if (!id) return;
    try {
      const { count } = await send({ type: 'reopen', id });
      await syncSession();
      if (sheetOpen) setSheetView('current');
      refreshHistory();
      if (!quiet) toast(`Continuing a session of ${plural(count, 'note')}. New notes join it.`, { ok: true });
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // The worker changed the active session; don't wait for the storage event.
  async function syncSession() {
    session = await readSession();
    render();
  }

  async function refreshHistory() {
    if (!IS_TOP) return;
    try {
      history = (await send({ type: 'history' })).sessions;
    } catch {
      history = [];
    }
    if (sheetOpen) renderSheet();
  }

  async function openEntry(id) {
    const { session: s } = await send({ type: 'historyGet', id }).catch(() => ({}));
    if (!s) return refreshHistory();
    entry = s;
    setSheetView('entry');
  }

  async function deleteEntry() {
    const s = entry;
    if (!s) return;
    await send({ type: 'historyDelete', id: s.id }).catch(() => {});
    setSheetView('history');
    await refreshHistory();
    toast('Session deleted', {
      action: 'Undo',
      onAction: async () => {
        await send({ type: 'historyRestore', session: s });
        refreshHistory();
      },
      onExpire: () => send({ type: 'gc' }).catch(() => {}),
    });
  }

  // -------------------------------------------------------------------------
  // Review sheet

  // The panel is open or closed in every tab at once: it follows you to the
  // next tab, and closing it anywhere closes it everywhere. `sync: false` is
  // for changes that came from another tab.
  function openSheet(view = 'current', { sync = true } = {}) {
    if (mode === 'picking') stopPicking();
    if (mode !== 'idle') return;
    sheetOpen = true;
    sheetView = view;
    setUiHidden(false);
    ensureUI();
    raise();
    render();
    refreshHistory();
    if (sync) {
      requestAnimationFrame(() => $.sheet.classList.add('on'));
      setPanel({ open: true, view });
    } else {
      // Followed you here from another tab: already in place, no slide-in.
      $.sheet.style.transition = 'none';
      $.sheet.classList.add('on');
      void $.sheet.offsetWidth;
      $.sheet.style.transition = '';
    }
  }

  function setPanel(panel) {
    if (IS_TOP) chrome.storage.local.set({ panel }).catch(() => {});
  }

  // Background tabs skip opening (no need to build it in thirty tabs); they
  // pick the state up when you switch to them. Closing is applied everywhere.
  function syncPanel(panel) {
    if (!IS_TOP) return;
    if (!panel?.open) return closeSheet({ sync: false });
    if (document.visibilityState === 'hidden') return;
    if (!sheetOpen) openSheet(panel.view ?? 'current', { sync: false });
    else if (panel.view && panel.view !== sheetView && sheetView !== 'entry') setSheetView(panel.view, { sync: false });
  }

  // -------------------------------------------------------------------------
  // Keys. This script runs at document_start, so these capture listeners are
  // registered before any of the page's own: sites (and other extensions) that
  // grab Esc can't starve Redline of it. If something registered even earlier
  // swallows the keydown, the keyup is handled instead.

  let escDown = false; // saw this Esc's keydown
  let escIdle = false; // …and it's waiting for the bubble-phase idle handler

  function onKeyDown(e) {
    if (e.key === 'Escape') escDown = true;
    // ⌥⇧⌘V (Paste and Match Style) or Ctrl+Shift+V: paste plain text, no screenshots.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyV') plainNext = Date.now() + 1500;
    routeKey(e, false);
  }

  function onKeyUp(e) {
    if (e.key !== 'Escape') return;
    const missed = !escDown;
    const idle = escIdle;
    escDown = escIdle = false;
    if (missed) routeKey(e, true);
    else if (idle) idleEscape(e); // the page stopped it before our bubble listener
  }

  function claim(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function routeKey(e, late) {
    if (e.isComposing) return;
    if (mode === 'picking') {
      // From inside Redline (a focused button) only Esc counts; Enter still clicks it.
      const key = e.key === 'Escape' ? 'Escape' : late || ours(e) ? null : e.key;
      if (key && pickKey(key)) claim(e);
      return;
    }
    if (ours(e)) return ownKey(e, late);
    if (e.key !== 'Escape') return;
    if (IS_TOP && (lightboxOpen || sheetOpen || mode === 'composing')) return claim(e), escape();
    if (!IS_TOP && topComposing) return claim(e), toParent({ type: 'esc' }); // composer open up top
    if (late) idleEscape(e);
    else escIdle = !pageOverlayOpen(); // decided now: by keyup the page's dialog is gone
  }

  // The page has its own dialog/popover/modal open, so this Esc is for it.
  function pageOverlayOpen() {
    return !!document.querySelector('dialog[open], [aria-modal="true"], :popover-open:not(redline-ui)');
  }

  // Keys typed into Redline (composer, note fields, buttons) never reach
  // the page; their default action (typing, button activation) still happens.
  function ownKey(e, late) {
    if (!late) e.stopImmediatePropagation();
    const target = e.composedPath()[0];
    if (!late && target === $.input && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return commit({ next: e.metaKey || e.ctrlKey });
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (target === $.input) dismissComposer();
    else if (IS_TOP) escape();
    else toParent({ type: 'esc' });
  }

  // Esc with nothing of Redline's open: tucks the session away. Runs after the
  // page's own handlers (bubble phase), and not while typing in a field.
  function idleEscape(e) {
    if (e.key !== 'Escape') return;
    const wanted = e.type === 'keyup' ? true : !pageOverlayOpen();
    escIdle = false;
    if (!wanted || e.repeat || e.isComposing || mode !== 'idle') return;
    const t = e.composedPath()[0];
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName)) return;
    if (IS_TOP) escape();
    else toParent({ type: 'esc' });
  }

  function escape() {
    if (lightboxOpen) closeLightbox();
    else if (sheetOpen && sheetView === 'entry') setSheetView('history');
    else if (sheetOpen) closeSheet();
    else if (mode === 'composing') dismissComposer();
    else if (mode === 'picking') stopPicking();
    else if (mode === 'idle' && session?.items?.length && !uiHidden) hideSession();
  }

  async function hideSession() {
    setUiHidden(true);
    const { hidHint } = await chrome.storage.local.get('hidHint');
    if (hidHint) return;
    chrome.storage.local.set({ hidHint: true });
    toast('Notes hidden. They come back on your next capture.', { action: 'Show', onAction: () => setUiHidden(false) });
  }

  function closeSheet({ sync = true } = {}) {
    if (!sheetOpen) return;
    sheetOpen = false;
    $.sheet.classList.remove('on');
    root.activeElement?.blur();
    render();
    if (sync) setPanel({ open: false });
  }

  function setSheetView(view, { sync = true } = {}) {
    const back = sheetView === 'entry' && view === 'history';
    const forward = view === 'entry';
    sheetView = view;
    if (sync && view !== 'entry') setPanel({ open: true, view }); // a History detail stays in this tab
    if (view !== 'entry') {
      entry = null;
      $.entryList.dataset.id = '';
    }
    renderSheet();
    const pane = $[`pane_${view}`];
    pane.classList.remove('push', 'pop', 'fade');
    void pane.offsetWidth;
    pane.classList.add(forward ? 'push' : back ? 'pop' : 'fade');
    pane.scrollTop = 0;
  }

  function renderSheet() {
    const view = sheetView;
    const items = session?.items ?? [];
    for (const v of ['current', 'history', 'entry']) $[`pane_${v}`].hidden = v !== view;
    for (const b of $.seg.querySelectorAll('[data-view]')) {
      b.classList.toggle('on', b.dataset.view === view);
      b.setAttribute('aria-selected', b.dataset.view === view);
    }
    $.seg.hidden = view === 'entry';
    $.back.hidden = view !== 'entry';
    $.entryDelete.hidden = view !== 'entry';
    $.footCurrent.hidden = view !== 'current' || !items.length;
    $.footEntry.hidden = view !== 'entry';
    $.bottom.hidden = $.footCurrent.hidden && $.footEntry.hidden;
    if (view === 'current') renderCurrent(items);
    else if (view === 'history') renderHistory();
    else renderEntry();
  }

  function renderCurrent(items) {
    const pages = new Set(items.map((i) => i.url)).size;
    $.sheetTitle.textContent = 'Notes';
    $.sheetSub.textContent = items.length
      ? `${plural(items.length, 'note')}${pages > 1 ? ` across ${pages} pages` : ''}`
      : 'Nothing captured yet';
    $.empty.hidden = items.length > 0;
    $.list.hidden = !items.length;

    // Empty: offer to pick up the most recent session.
    const last = !items.length && history?.[0];
    $.last.hidden = !last;
    if (last) {
      $.lastBtn.dataset.id = last.id;
      $.lastTitle.textContent = last.title;
      $.lastMeta.textContent = `${last.copiedAt ? 'Copied' : 'Set aside'} ${ago(last.archivedAt)} · ${plural(last.count, 'note')}`;
    }

    const cards = new Map([...$.list.children].map((c) => [c.dataset.id, c]));
    items.forEach((item, i) => {
      let card = cards.get(item.id);
      cards.delete(item.id);
      if (!card) card = makeCard(item);
      card.querySelector('.num').textContent = i + 1;
      const ta = card.querySelector('.card-note');
      if (root.activeElement !== ta && ta.value !== item.note) ta.value = item.note;
      setSrc(card.querySelector('img'), imageCache.get(item.id));
      if ($.list.children[i] !== card) $.list.insertBefore(card, $.list.children[i] ?? null);
    });
    for (const card of cards.values()) card.remove();
    loadImages(items.map((i) => i.id));
  }

  function renderHistory() {
    const rows = history ?? [];
    $.sheetTitle.textContent = 'History';
    $.sheetSub.textContent = history ? (rows.length ? plural(rows.length, 'session') : 'Nothing here yet') : '';
    $.historyEmpty.hidden = !history || rows.length > 0;

    const groups = [];
    for (const row of rows) {
      const label = dayLabel(row.archivedAt);
      if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
      groups.at(-1).rows.push(row);
    }
    $.historyList.replaceChildren(
      ...groups.map((g) => {
        const section = document.createElement('section');
        section.className = 'grp';
        section.innerHTML = `<h3></h3><div class="grp-list"></div>`;
        section.firstChild.textContent = g.label;
        section.lastChild.append(...g.rows.map(makeRow));
        return section;
      }),
    );
    loadRowThumbs(rows.map((r) => r.thumbId));
  }

  function makeRow(r) {
    const row = document.createElement('button');
    row.className = 'row';
    row.dataset.act = 'openEntry';
    row.dataset.id = r.id;
    row.innerHTML = `
      <span class="row-main"><span class="row-title"></span><span class="row-meta"></span><span class="row-prev"></span></span>
      <img class="row-thumb" alt="">
      <span class="row-chev">${ICON.chevronRight}</span>`;
    row.querySelector('.row-title').textContent = r.title;
    row.querySelector('.row-meta').textContent = [
      clock(r.archivedAt),
      plural(r.count, 'note'),
      r.pages > 1 ? `${r.pages} pages` : r.host,
      r.copiedAt ? '' : 'Not copied',
    ]
      .filter(Boolean)
      .join(' · ');
    row.querySelector('.row-prev').textContent = r.preview;
    setSrc(row.querySelector('img'), thumbCache.get(r.thumbId));
    return row;
  }

  function renderEntry() {
    const s = entry;
    if (!s) return;
    $.sheetTitle.textContent = s.items[0]?.title || 'Session';
    $.sheetSub.textContent = `${plural(s.items.length, 'note')} · ${s.copiedAt ? 'copied' : 'set aside'} ${ago(s.archivedAt)}`;
    if ($.entryList.dataset.id !== s.id) {
      $.entryList.dataset.id = s.id;
      $.entryList.replaceChildren(
        ...s.items.map((item, i) => {
          const card = document.createElement('article');
          card.className = 'card ro';
          card.dataset.id = item.id;
          card.innerHTML = `
            <div class="card-shot" data-act="zoom"><img alt=""><span class="num"></span>
              <span class="card-acts"><button class="card-act" data-act="copyImage" title="Copy this screenshot">${ICON.copy}</button></span>
            </div>
            <p class="card-text"></p>
            <div class="card-meta"><span class="mono"></span><span class="where"></span></div>`;
          card.querySelector('.num').textContent = i + 1;
          card.querySelector('.card-text').textContent = item.note;
          card.querySelector('.mono').textContent = itemLabel(item);
          card.querySelector('.where').textContent = shortUrl(item.url);
          return card;
        }),
      );
    }
    for (const card of $.entryList.children) setSrc(card.querySelector('img'), imageCache.get(card.dataset.id));
    loadImages(s.items.map((i) => i.id));
  }

  function setSrc(img, src) {
    if (src && img.getAttribute('src') !== src) img.src = src;
  }

  const requested = new Set(); // ask the worker once per screenshot
  function loadImages(ids) {
    const want = ids.filter((id) => !imageCache.has(id) && !requested.has(id));
    if (!want.length) return;
    want.forEach((id) => requested.add(id));
    send({ type: 'getImages', ids: want })
      .then((found) => {
        for (const [id, url] of Object.entries(found)) imageCache.set(id, url);
        if (sheetOpen) renderSheet();
      })
      .catch(() => {});
  }

  const thumbCache = new Map();
  const thumbRequested = new Set();
  function loadRowThumbs(ids) {
    const want = ids.filter((id) => id && !thumbCache.has(id) && !thumbRequested.has(id));
    if (!want.length) return;
    want.forEach((id) => thumbRequested.add(id));
    send({ type: 'thumbs', ids: want })
      .then((found) => {
        for (const [id, url] of Object.entries(found)) thumbCache.set(id, url);
        if (sheetOpen && sheetView === 'history') renderSheet();
      })
      .catch(() => {});
  }

  function dayLabel(ts) {
    const day = new Date(ts).setHours(0, 0, 0, 0);
    const diff = Math.round((new Date().setHours(0, 0, 0, 0) - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // "today", "yesterday", "on Mon, Oct 6"
  function relDay(ts) {
    const d = dayLabel(ts);
    return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : `on ${d}`;
  }

  function ago(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return `${relDay(ts)} at ${clock(ts)}`;
  }

  const itemLabel = (item) =>
    item.kind === 'screen' ? 'Whole screen' : item.kind === 'area' ? 'Area' : item.target?.label ?? 'Element';

  function makeCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = item.id;
    const where = item.url === pageKey() ? 'This page' : shortUrl(item.url);
    const what = itemLabel(item);
    card.innerHTML = `
      <div class="card-shot" data-act="zoom">
        <img alt="">
        <span class="num"></span>
        <span class="card-acts">
          <button class="card-act" data-act="copyImage" title="Copy this screenshot">${ICON.copy}</button>
          <button class="card-act del" data-act="remove" title="Delete note">${ICON.trash}</button>
        </span>
      </div>
      <textarea class="card-note" rows="1" spellcheck="true" placeholder="What should change?"></textarea>
      <div class="card-meta">
        <span class="mono"></span>
        <a href="#" data-act="goto"></a>
      </div>`;
    card.querySelector('.mono').textContent = what;
    const link = card.querySelector('a');
    link.textContent = where;
    link.title = item.url === pageKey() ? 'Show on page' : item.url;
    return card;
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return (u.pathname + u.search).replace(/^\/$/, u.host) || u.host;
    } catch {
      return url;
    }
  }

  let lightboxOpen = false;
  function openLightbox(id) {
    const src = imageCache.get(id);
    if (!src) return;
    lightboxOpen = true;
    $.lbImg.src = src;
    $.lb.hidden = false;
    requestAnimationFrame(() => $.lb.classList.add('on'));
  }

  function closeLightbox() {
    if (!lightboxOpen) return;
    lightboxOpen = false;
    $.lb.classList.remove('on');
    setTimeout(() => !lightboxOpen && ($.lb.hidden = true), 200);
  }

  // -------------------------------------------------------------------------
  // Toasts

  let toastTimer = 0;
  let toastActions = [];
  let toastExpire = null;

  // `actions: [{ label, run }]`; `action` + `onAction` is the one-button form.
  function toast(text, { action, onAction, actions = action ? [{ label: action, run: onAction }] : [], onExpire, ok, error } = {}) {
    ensureUI();
    clearTimeout(toastTimer);
    toastExpire?.();
    $.toastText.textContent = text;
    $.toastIcon.innerHTML = ok ? ICON.check : error ? ICON.warn : '';
    $.toastIcon.hidden = !(ok || error);
    $.toast.classList.toggle('error', !!error);
    $.toastActs.replaceChildren(
      ...actions.map(({ label }, i) => {
        const b = document.createElement('button');
        b.textContent = label;
        Object.assign(b.dataset, { act: 'toast', i });
        return b;
      }),
    );
    toastExpire = onExpire ?? null;
    toastActions = actions.map(({ run }) => () => {
      toastExpire = null;
      hideToast();
      run();
    });
    $.toast.classList.add('on');
    toastTimer = setTimeout(hideToast, actions.length ? 6000 : 3200);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $.toast.classList.remove('on');
    const expire = toastExpire;
    toastExpire = null;
    expire?.();
  }

  // -------------------------------------------------------------------------
  // Render: dock + sheet from the current session.

  function render() {
    const items = session?.items ?? [];
    if (IS_TOP && (host || items.length || mode !== 'idle' || sheetOpen)) {
      ensureUI();
      const showDock = items.length > 0 && mode === 'idle' && !sheetOpen && !uiHidden;
      $.dock.classList.toggle('on', showDock);
      $.dockCount.textContent = items.length;
      $.dockLabel.textContent = items.length === 1 ? 'note' : 'notes';
      if (sheetOpen) renderSheet();
    }
    // The session changed under the picker (e.g. ⌘↵ saves while the next pick starts).
    if (mode === 'picking' && pick.el && $.hl?.classList.contains('on')) (pick.notedFor = null), drawHighlight(pick.el);
  }

  function bumpDock() {
    if (!$.dockCount) return;
    $.dockCount.classList.remove('bump');
    void $.dockCount.offsetWidth;
    $.dockCount.classList.add('bump');
  }

  function findLive(item) {
    if (!item.css) return null;
    try {
      return document.querySelector(item.css);
    } catch {
      return null;
    }
  }

  // Current rect of a note's element (document coords, or viewport if fixed).
  function liveRect(item) {
    const el = findLive(item);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) return { hidden: true };
    return item.fixed ? viewportRect(b) : { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height };
  }

  // -------------------------------------------------------------------------
  // Frames. Child frames pick on their own and post the result to their parent,
  // which translates it by the <iframe>'s offset and passes it on, hop by hop,
  // until it reaches the top frame. Commands go back down through the worker.

  const childAgents = new Set(); // <iframe>s whose document runs Redline
  let topComposing = false; // child frames: the top frame's composer is open


  const viewportBounds = () => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });
  const shift = (r, o) => r && { ...r, x: r.x + o.x, y: r.y + o.y };

  function overlap(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
  }

  function toParent(msg) {
    try {
      parent.postMessage({ redline: msg }, '*');
    } catch {}
  }

  function toFrames(msg) {
    if (!IS_TOP || (!childAgents.size && !document.querySelector('iframe, frame'))) return Promise.resolve();
    return send({ type: 'frames', payload: msg }).catch(() => {});
  }

  function pingChildren() {
    for (const f of document.querySelectorAll('iframe, frame')) {
      try {
        f.contentWindow?.postMessage({ redline: { type: 'ping' } }, '*');
      } catch {}
    }
  }

  function frameFor(win) {
    const search = (scope) => {
      for (const f of scope.querySelectorAll('iframe, frame')) if (f.contentWindow === win) return f;
      for (const el of scope.querySelectorAll('*')) {
        const hit = el.shadowRoot && search(el.shadowRoot);
        if (hit) return hit;
      }
      return null;
    };
    return search(document);
  }

  // The <iframe>'s content box in this frame's viewport.
  function frameBox(f) {
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    return {
      x: r.left + f.clientLeft + pl,
      y: r.top + f.clientTop + pt,
      w: f.clientWidth - pl - (parseFloat(cs.paddingRight) || 0),
      h: f.clientHeight - pt - (parseFloat(cs.paddingBottom) || 0),
    };
  }

  function forwardTo(frame, msg) {
    try {
      frame.contentWindow.postMessage({ redline: msg }, '*');
    } catch {}
  }

  function onFrameMessage(e) {
    const m = e.data?.redline;
    if (!m || typeof m !== 'object' || !e.source || e.source === window) return;
    if (!IS_TOP && e.source === parent) return fromParent(m);
    const frame = frameFor(e.source);
    if (!frame) return;
    if (m.type === 'hello') return void childAgents.add(frame);
    if (m.type === 'enter') {
      if (mode !== 'picking') return;
      childAgents.add(frame);
      if (pick.base !== frame) Object.assign(pick, { base: frame, el: null, trail: [] });
      $.hl?.classList.remove('on');
      $.tag?.classList.remove('on');
      if (!IS_TOP) toParent({ type: 'enter' });
      return;
    }
    if (m.type === 'key' && mode === 'picking' && (IS_TOP || (NAV_KEYS.includes(m.key) && pick.el))) {
      return void pickKey(m.key, { from: frame });
    }
    const box = frameBox(frame);
    const up = { ...m, rect: shift(m.rect, box), bounds: m.bounds && overlap(shift(m.bounds, box), box) };
    if (IS_TOP) fromChild(up);
    else toParent(up);
  }

  function fromParent(m) {
    if (m.type === 'ping') toParent({ type: 'hello' });
    else if (m.type === 'key' && mode === 'picking') pickKey(m.key, { fromAbove: true });
  }

  function fromChild(m) {
    if (m.type === 'esc') escape();
    else if (m.type === 'capture') captureFrom(m);
    else if (m.type === 'edit' && mode === 'idle') editFromFrame(m);
  }

  async function editFromFrame(m) {
    const item = session?.items.find((i) => i.id === m.id);
    if (!item) return;
    closeSheet();
    openComposer({ item, isNew: false, image: await getImage(item.id), spot: intersectOrSelf(overlap(m.rect, m.bounds)) });
  }

  function onFrameCommand(msg) {
    switch (msg.type) {
      case 'frame:start':
        return startPicking();
      case 'frame:stop':
        return stopPicking();
      case 'frame:snap':
        if (msg.hidden) stopPicking();
        return setHidden(msg.hidden);
      case 'frame:composing':
        topComposing = !!msg.on;
        if (topComposing) releaseFocus();
        return;
      case 'frame:show': {
        const item = session?.items.find((i) => i.id === msg.id);
        if (item?.frameUrl === frameKey()) showItem(item);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.target !== 'page') return false;
    if (IS_EXTENSION_PAGE && msg.tabId != null && myTabId != null && msg.tabId !== myTabId) return false;
    if (msg.type?.startsWith('frame:')) {
      if (IS_TOP) return false;
      onFrameCommand(msg);
      sendResponse({ ok: true });
      return false;
    }
    switch (msg.type) {
      case 'toggle':
        if (mode === 'picking') stopPicking();
        else startPicking();
        break;
      case 'review':
        openSheet();
        break;
      case 'history':
        openSheet('history');
        break;
      case 'copy':
        copyAll();
        break;
      case 'clear':
        clearSession();
        break;
      default:
        return false;
    }
    sendResponse({ ok: true });
    return false;
  }

  function teardown() {
    life.abort();
    pickAbort?.abort();
    composerAbort?.abort();
    setCursor(false);
    host?.remove();
    clearInterval(watch);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {}
  }

  on(window, 'keydown', onKeyDown, { capture: true });
  on(window, 'keyup', onKeyUp, { capture: true });
  on(window, 'paste', onPaste, { capture: true });
  on(window, 'keydown', idleEscape);
  on(window, 'pointermove', (e) => ((pointer.x = e.clientX), (pointer.y = e.clientY)), { passive: true, capture: true });
  on(window, 'pointerout', (e) => !e.relatedTarget && (pointer.x = pointer.y = -1), { passive: true, capture: true });
  on(window, 'message', onFrameMessage);
  on(document, 'visibilitychange', () => {
    if (IS_TOP && document.visibilityState === 'visible') {
      chrome.storage.local.get('panel').then(({ panel }) => syncPanel(panel)).catch(() => {});
    }
  });
  if (!IS_TOP) toParent({ type: 'hello' });

  // SPA navigation: a composer opened on the old page shouldn't linger.
  const here = IS_TOP ? pageKey : frameKey;
  let lastUrl = here();
  const watch = setInterval(() => {
    if (!chrome.runtime?.id) return teardown();
    if (here() === lastUrl) return;
    lastUrl = here();
    if (mode === 'composing') closeComposer();
  }, 1200);

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  chrome.tabs?.getCurrent?.((tab) => (myTabId = tab?.id ?? null));
  // Injected at document_start for the key listeners; the first render waits
  // for the page's DOM so nothing is added before the page builds its own.
  const domReady = new Promise((resolve) =>
    document.readyState === 'loading' ? on(document, 'DOMContentLoaded', resolve, { once: true }) : resolve(),
  );
  chrome.storage.local.get('lastCopy').then((stored) => (lastCopy = stored.lastCopy ?? null));
  Promise.all([chrome.storage.local.get([KEY, 'uiHidden', 'panel']), domReady]).then(([stored]) => {
    session = stored[KEY] ?? null;
    uiHidden = !!stored.uiHidden;
    pingChildren();
    render();
    if (stored.panel?.open) syncPanel(stored.panel); // the panel follows you to new pages too
  });

  // Exposed for pages that host Redline directly (the welcome page).
  window.__redline = { start: () => startPicking(), review: () => openSheet() };

  // -------------------------------------------------------------------------
  // Markup + styles

  const ICON = {
    capture:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.2V5.5A2.5 2.5 0 0 1 5.5 3h1.7M12.8 3h1.7A2.5 2.5 0 0 1 17 5.5v1.7M17 12.8v1.7a2.5 2.5 0 0 1-2.5 2.5h-1.7M7.2 17H5.5A2.5 2.5 0 0 1 3 14.5v-1.7"/><path d="M10 7v6M7 10h6"/></svg>',
    close:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
    trash:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13M8 5.5V4.2c0-.66.54-1.2 1.2-1.2h1.6c.66 0 1.2.54 1.2 1.2v1.3M5.2 5.5l.75 9.6A2 2 0 0 0 7.94 17h4.12a2 2 0 0 0 2-1.85l.74-9.65"/></svg>',
    copy:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2.4"/><path d="M13 7V5.4A2.4 2.4 0 0 0 10.6 3H5.4A2.4 2.4 0 0 0 3 5.4v5.2A2.4 2.4 0 0 0 5.4 13H7"/></svg>',
    check:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>',
    open:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 4.5H6A2.5 2.5 0 0 0 3.5 7v7A2.5 2.5 0 0 0 6 16.5h7a2.5 2.5 0 0 0 2.5-2.5v-2.5"/><path d="M11 3.5h5.5V9M16.5 3.5L9 11"/></svg>',
    chevronLeft:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>',
    chevronRight:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l5 5-5 5"/></svg>',
    history:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.8v2.6h2.6"/><path d="M10 6.8V10l2.3 1.6"/></svg>',
    warn:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="7.2"/><path d="M10 6.4v4.3M10 13.4v.1"/></svg>',
  };

  const SPINNER = '<span class="spin"></span>';

  const TEMPLATE = `
  <div class="r" data-ref="r">
    <div class="hl" data-ref="hl"></div>
    <div class="tag" data-ref="tag"><div class="tag-row"><span class="tag-nums" data-ref="tagNums"></span><span data-ref="tagName"></span><span class="d" data-ref="tagSize"></span></div><div class="tag-note" data-ref="tagNote"></div></div>
    <div class="rg" data-ref="rg"><span class="rg-size" data-ref="rgSize"></span></div>
    <div class="spot" data-ref="spot"></div>
    <div class="veil" data-ref="veil" data-act="veil"></div>

    <div class="hud glass" data-ref="hud">
      <span class="i"><kbd>Click</kbd> element</span>
      <span class="i"><kbd>Drag</kbd> area</span>
      <span class="i opt"><kbd>Space</kbd> screen</span>
      <span class="i opt"><kbd>↑</kbd><kbd>↓</kbd> parent / child</span>
      <button class="x" data-act="stop" title="Cancel (esc)">${ICON.close}</button>
    </div>

    <div class="cmp glass" data-ref="cmp" role="dialog" aria-label="Note">
      <div class="cmp-head">
        <span class="num" data-ref="cmpNum">1</span>
        <span class="cmp-what" data-ref="cmpWhat"></span>
      </div>
      <img class="cmp-thumb" data-ref="cmpThumb" alt="" hidden>
      <textarea data-ref="input" rows="1" spellcheck="true" placeholder="What should change?"></textarea>
      <div class="cmp-foot">
        <span class="cmp-hint"><span class="calm">esc to cancel</span><span class="warn">esc again to discard</span></span>
        <button class="btn danger" data-act="delete" data-ref="cmpDelete" hidden>Delete</button>
        <button class="btn ghost" data-act="next" data-ref="cmpNext" title="Save and capture the next one"><span>Next</span><kbd>${isMac ? '⌘' : 'Ctrl'}↵</kbd></button>
        <button class="btn primary" data-act="save" data-ref="cmpSave"><kbd>↵</kbd><span>Save</span></button>
      </div>
    </div>

    <div class="dock glass" data-ref="dock">
      <button class="dock-notes" data-act="review" title="Review notes">
        <span class="num" data-ref="dockCount">0</span><span data-ref="dockLabel">notes</span>
      </button>
      <button class="icon-btn" data-act="capture" data-ref="dockCapture" title="Capture">${ICON.capture}</button>
      <button class="btn primary pill" data-act="copy" title="Copy the notes. Paste into Claude Code or Codex as is; in a web chat the screenshots come along">
        <span class="ic">${ICON.copy}</span><span class="ic ok">${ICON.check}</span>${SPINNER}<span class="lbl">Copy notes</span>
      </button>
    </div>

    <aside class="sheet glass" data-ref="sheet" aria-label="Redline notes">
      <header class="sh-head">
        <div class="seg" data-ref="seg" role="tablist">
          <button data-act="view" data-view="current" role="tab">Current</button>
          <button data-act="view" data-view="history" role="tab">History</button>
        </div>
        <button class="back" data-act="back" data-ref="back" hidden>${ICON.chevronLeft}<span>History</span></button>
        <span class="sp"></span>
        <button class="icon-btn" data-act="deleteEntry" data-ref="entryDelete" title="Delete this session" hidden>${ICON.trash}</button>
        <button class="icon-btn" data-act="capture" title="Capture">${ICON.capture}</button>
        <button class="icon-btn" data-act="close" title="Close (esc)">${ICON.close}</button>
      </header>
      <div class="sh-titles"><h2 data-ref="sheetTitle">Notes</h2><p data-ref="sheetSub"></p></div>

      <div class="pane" data-ref="pane_current">
        <div class="sh-list" data-ref="list"></div>
        <div class="sh-empty" data-ref="empty" hidden>
          <div class="empty-ic">${ICON.capture}</div>
          <p>Press <kbd data-shortcut></kbd> on any page,<br>click what needs work, and say what should change.</p>
          <button class="link" data-act="shortcuts">Change shortcut</button>
        </div>
        <div class="last" data-ref="last" hidden>
          <div class="last-h">Last session</div>
          <div class="last-row">
            <div class="last-text"><div class="row-title" data-ref="lastTitle"></div><div class="row-meta" data-ref="lastMeta"></div></div>
            <button class="btn ghost" data-act="reopen" data-ref="lastBtn" title="Make it the current session and add more notes">Continue</button>
          </div>
        </div>
      </div>

      <div class="pane scroll" data-ref="pane_history" hidden>
        <div data-ref="historyList"></div>
        <div class="sh-empty" data-ref="historyEmpty" hidden>
          <div class="empty-ic">${ICON.history}</div>
          <p>Every time you copy, the session lands here<br>and the next note starts a fresh one.</p>
        </div>
      </div>

      <div class="pane scroll" data-ref="pane_entry" hidden>
        <div class="sh-cards" data-ref="entryList"></div>
      </div>

      <div class="sh-bottom" data-ref="bottom">
      <footer class="sh-foot" data-ref="footCurrent">
        <button class="btn ghost" data-act="clear" title="Move these notes to History and start fresh">New session</button>
        <button class="btn primary" data-act="copy">
          <span class="ic">${ICON.copy}</span><span class="ic ok">${ICON.check}</span>${SPINNER}<span class="lbl">Copy notes</span>
        </button>
      </footer>
      <footer class="sh-foot" data-ref="footEntry" hidden>
        <button class="btn ghost" data-act="reopen" title="Make it the current session and add more notes">Continue</button>
        <button class="btn primary" data-act="copyEntry">
          <span class="ic">${ICON.copy}</span><span class="ic ok">${ICON.check}</span>${SPINNER}<span class="lbl">Copy notes</span>
        </button>
      </footer>
      <p class="sh-note" data-ref="shNote">Paste into Claude Code or Codex as is. In a web chat, ${isMac ? '⌘V' : 'Ctrl+V'} attaches the screenshots too.</p>
      </div>
    </aside>

    <div class="lb" data-ref="lb" data-act="unzoom" hidden><img data-ref="lbImg" alt=""></div>

    <div class="toast glass" data-ref="toast" role="status">
      <span class="t-ic" data-ref="toastIcon" hidden></span>
      <span data-ref="toastText"></span>
      <span class="t-acts" data-ref="toastActs"></span>
    </div>
  </div>`;

  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif';
  const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

  const STYLES = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button:disabled { opacity: .4; pointer-events: none; }
  button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  svg { width: 16px; height: 16px; display: block; flex: none; }

  .r {
    --blue: #007aff; --red: #ff3b30; --green: #28cd41;
    --text: rgba(0,0,0,.86); --text2: rgba(60,60,67,.64); --text3: rgba(60,60,67,.34);
    --glass: rgba(246,246,248,.74); --solid: rgba(252,252,253,.92); --card: rgba(255,255,255,.9); --seg-on: #fff;
    --line: rgba(0,0,0,.09); --fill: rgba(118,118,128,.12); --fill2: rgba(118,118,128,.2);
    --shadow: 0 0 0 .5px rgba(0,0,0,.14), 0 1px 2px rgba(0,0,0,.06), 0 12px 40px -8px rgba(0,0,0,.24);
    --ease: cubic-bezier(.32,.72,0,1);
    --spring: cubic-bezier(.34,1.4,.64,1);
    position: fixed; inset: 0; pointer-events: none;
    font: 13px/1.38 ${FONT}; color: var(--text);
    -webkit-font-smoothing: antialiased; letter-spacing: -.004em;
  }
  @media (prefers-color-scheme: dark) {
    .r {
      --blue: #0a84ff; --red: #ff453a; --green: #32d74b;
      --text: rgba(255,255,255,.92); --text2: rgba(235,235,245,.62); --text3: rgba(235,235,245,.32);
      --glass: rgba(40,40,44,.8); --solid: rgba(38,38,42,.94); --card: rgba(255,255,255,.06); --seg-on: #636366;
      --line: rgba(255,255,255,.1); --fill: rgba(118,118,128,.24); --fill2: rgba(118,118,128,.36);
      --shadow: 0 0 0 .5px rgba(255,255,255,.14), 0 0 0 1px rgba(0,0,0,.45), 0 16px 48px -8px rgba(0,0,0,.65);
    }
  }
  .glass { background: var(--glass); -webkit-backdrop-filter: blur(28px) saturate(1.8); backdrop-filter: blur(28px) saturate(1.8); box-shadow: var(--shadow); }

  kbd {
    display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px;
    border-radius: 5px; background: var(--fill); color: var(--text); box-shadow: inset 0 -.5px 0 var(--line);
    font: 500 11px/1 ${FONT}; letter-spacing: 0;
  }
  .num {
    flex: none; display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
    background: var(--red); color: #fff; font: 600 11.5px/1 ${FONT}; font-variant-numeric: tabular-nums; letter-spacing: 0;
  }
  .mono { font-family: ${MONO}; font-size: 11.5px; }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px;
    font-size: 12.5px; font-weight: 500; white-space: nowrap; transition: transform .15s var(--ease), background-color .15s, filter .15s;
  }
  .btn:active { transform: scale(.96); }
  .btn.primary { background: var(--blue); color: #fff; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.primary kbd { background: rgba(255,255,255,.2); color: #fff; box-shadow: none; min-width: 0; height: 17px; padding: 0 4px; font-size: 11px; }
  .btn.ghost { background: var(--fill); }
  .btn.ghost:hover { background: var(--fill2); }
  .btn.ghost kbd { background: transparent; box-shadow: none; color: var(--text2); min-width: 0; height: 17px; padding: 0; }
  .btn.danger { color: var(--red); margin-right: auto; padding: 0 6px; }
  .btn.danger:hover { background: color-mix(in srgb, var(--red) 12%, transparent); }
  .btn .ic.ok, .btn .spin { display: none; }
  .btn.busy .spin { display: block; }
  .btn.busy .ic { display: none; }
  .btn.done .ic { display: none; }
  .btn.done .ic.ok { display: block; }
  .btn.done { background: var(--green); }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .icon-btn { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: var(--text2); transition: background-color .15s, color .15s; }
  .icon-btn:hover { background: var(--fill); color: var(--text); }
  .icon-btn svg { width: 18px; height: 18px; }
  .link { color: var(--blue); font-size: 12.5px; }
  .link:hover { text-decoration: underline; }

  /* Picker */
  .hl {
    position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;
    background: color-mix(in srgb, var(--blue) 9%, transparent); box-shadow: 0 0 0 1.5px var(--blue);
    transition: transform .09s var(--ease), width .09s var(--ease), height .09s var(--ease), border-radius .09s, opacity .12s;
    will-change: transform, width, height;
  }
  .hl.noted { background: color-mix(in srgb, var(--red) 9%, transparent); box-shadow: 0 0 0 1.5px var(--red); }
  .hl.on, .tag.on, .rg.on { opacity: 1; }
  .tag {
    position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0; padding: 0 8px; border-radius: 6px;
    background: rgba(28,28,30,.92); color: #fff; font: 500 11px/1 ${MONO}; white-space: nowrap;
    box-shadow: 0 2px 10px rgba(0,0,0,.18); transition: opacity .12s;
  }
  .tag-row { display: flex; align-items: center; gap: 7px; height: 22px; }
  .tag .d { color: rgba(255,255,255,.5); }
  /* Already noted: its number(s) and the note, so nothing gets captured twice */
  .tag.noted { padding: 3px 8px 8px; }
  .tag-nums { display: inline-flex; gap: 3px; }
  .tag-nums span {
    display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
    background: var(--red); font: 600 10.5px/1 ${FONT}; font-variant-numeric: tabular-nums;
  }
  .tag-note { max-width: 300px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; font: 400 12px/1.3 ${FONT}; color: rgba(255,255,255,.88); }
  .tag-nums:empty, .tag-note:empty { display: none; }
  .rg {
    position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;
    background: color-mix(in srgb, var(--blue) 6%, transparent);
    box-shadow: 0 0 0 1.5px var(--blue), 0 0 0 100vmax rgba(0,0,0,.24);
  }
  .rg-size {
    position: absolute; right: 0; top: calc(100% + 6px); height: 22px; padding: 0 8px; border-radius: 6px; display: flex; align-items: center;
    background: rgba(28,28,30,.92); color: #fff; font: 500 11px/1 ${MONO}; white-space: nowrap;
  }
  .rg.inside .rg-size { top: auto; bottom: 6px; right: 6px; }
  .flash { position: fixed; pointer-events: none; background: #fff; border-radius: 4px; animation: flash .5s var(--ease) forwards; }
  @keyframes flash { from { opacity: .9; } to { opacity: 0; } }

  .hud {
    position: fixed; left: 50%; bottom: 24px; display: flex; align-items: center; gap: 16px; height: 44px; padding: 0 6px 0 18px;
    border-radius: 22px; color: var(--text2); font-size: 12.5px; white-space: nowrap; pointer-events: none;
    opacity: 0; transform: translate(-50%, 14px) scale(.97); transition: opacity .2s, transform .4s var(--ease);
  }
  .hud.on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
  .hud.top { bottom: auto; top: 24px; }
  .hud.on.dragging { opacity: 0; pointer-events: none; }
  .hud .i { display: flex; align-items: center; gap: 6px; }
  .hud .i kbd + kbd { margin-left: -3px; }
  .hud .x { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: var(--text2); margin-left: -4px; }
  .hud .x:hover { background: var(--fill); color: var(--text); }
  @media (max-width: 640px) { .hud .opt { display: none; } }

  /* Composer */
  .spot {
    position: fixed; pointer-events: none; opacity: 0; border-radius: 6px;
    box-shadow: 0 0 0 2px var(--blue), 0 0 0 100vmax rgba(0,0,0,.32); transition: opacity .25s var(--ease);
  }
  .spot.screen { box-shadow: inset 0 0 0 3px var(--blue); border-radius: 0; }
  .spot.on { opacity: 1; }
  .veil { position: fixed; inset: 0; pointer-events: none; }
  .veil.on { pointer-events: auto; }
  .cmp {
    position: fixed; left: 0; top: 0; width: 336px; max-width: calc(100vw - 24px); border-radius: 14px; overflow: hidden;
    display: flex; flex-direction: column; background: var(--solid);
    pointer-events: none; opacity: 0; transform: scale(.94); transition: opacity .16s, transform .32s var(--spring);
  }
  .cmp.on { opacity: 1; transform: none; pointer-events: auto; }
  .cmp-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 0; min-width: 0; }
  .cmp-what { font: 500 11.5px/1.2 ${MONO}; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .cmp-thumb { display: block; margin: 10px 14px 0; width: calc(100% - 28px); max-height: 150px; object-fit: contain; border-radius: 8px; background: var(--fill); }
  .cmp textarea {
    display: block; width: 100%; min-height: 54px; max-height: 260px; field-sizing: content; resize: none; border: 0; outline: 0;
    background: transparent; color: var(--text); caret-color: var(--blue); padding: 8px 14px 12px;
    font: 400 15px/1.42 ${FONT}; letter-spacing: -.01em;
  }
  .cmp textarea::placeholder { color: var(--text3); }
  .cmp-foot { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 14px; border-top: .5px solid var(--line); }
  .cmp-hint { margin-right: auto; font-size: 11.5px; color: var(--text3); white-space: nowrap; }
  .cmp-hint .warn { display: none; color: var(--red); }
  .cmp.edit:not(.armed) .cmp-hint { display: none; }
  .cmp.edit.armed .btn.danger { display: none; }
  .cmp.armed .cmp-hint .calm { display: none; }
  .cmp.armed .cmp-hint .warn { display: inline; }
  .cmp .btn.danger + .btn, .cmp .btn.danger ~ .btn { margin-left: 0; }
  .cmp.shake { animation: shake .42s; }
  @keyframes shake { 15%, 85% { translate: -2px 0; } 30%, 70% { translate: 4px 0; } 45% { translate: -5px 0; } 60% { translate: 5px 0; } }

  /* Dock */
  .dock {
    position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 2px; height: 44px; padding: 6px; border-radius: 22px;
    pointer-events: none; opacity: 0; transform: translateY(14px) scale(.96); transition: opacity .2s, transform .45s var(--ease);
  }
  .dock.on { opacity: 1; transform: none; pointer-events: auto; }
  .dock-notes { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 6px; border-radius: 16px; font-weight: 500; transition: background-color .15s; }
  .dock-notes:hover { background: var(--fill); }
  .btn.pill { height: 32px; border-radius: 16px; padding: 0 14px 0 11px; margin-left: 2px; font-size: 13px; }
  .bump { animation: bump .5s var(--spring); }
  @keyframes bump { 35% { transform: scale(1.3); } }

  /* Sheet */
  .sheet {
    position: fixed; top: 12px; right: 12px; bottom: 12px; width: 384px; max-width: calc(100vw - 24px); border-radius: 18px;
    display: flex; flex-direction: column; overflow: hidden; background: var(--solid);
    pointer-events: none; transform: translateX(calc(100% + 32px)); transition: transform .5s var(--ease);
  }
  .sheet.on { transform: none; pointer-events: auto; }
  .sh-head { display: flex; align-items: center; gap: 2px; min-height: 32px; padding: 14px 12px 0 16px; }
  .sh-head .sp { flex: 1; }
  .seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--fill); }
  .seg button { height: 26px; padding: 0 14px; border-radius: 7px; font-size: 12.5px; font-weight: 500; color: var(--text2); transition: background-color .2s, color .2s, box-shadow .2s; }
  .seg button.on { background: var(--seg-on); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 0 0 .5px rgba(0,0,0,.04); }
  .back { display: inline-flex; align-items: center; gap: 1px; height: 32px; padding: 0 8px 0 0; margin-left: -6px; border-radius: 8px; color: var(--blue); font-size: 14px; font-weight: 500; }
  .back svg { width: 20px; height: 20px; }
  .back:hover span { text-decoration: underline; }
  .sh-titles { padding: 10px 20px 10px; min-width: 0; }
  .sh-titles h2 { font-size: 19px; font-weight: 700; letter-spacing: -.024em; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sh-titles p { font-size: 12px; color: var(--text2); margin-top: 1px; }
  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane.scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 2px 12px 14px; }
  .pane.push { animation: push .4s var(--ease) both; }
  .pane.pop { animation: pop .4s var(--ease) both; }
  .pane.fade { animation: fadein .22s ease both; }
  @keyframes push { from { opacity: 0; transform: translateX(32px); } }
  @keyframes pop { from { opacity: 0; transform: translateX(-32px); } }
  @keyframes fadein { from { opacity: 0; } }
  .sh-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 4px 12px 14px; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; }
  .sh-cards { display: flex; flex-direction: column; gap: 10px; }
  .card { border-radius: 14px; padding: 8px; background: var(--card); box-shadow: 0 0 0 .5px var(--line), 0 1px 2px rgba(0,0,0,.04); animation: rise .35s var(--ease) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  .card-shot { position: relative; border-radius: 9px; overflow: hidden; background: var(--fill); cursor: zoom-in; min-height: 60px; }
  .card-shot img { display: block; width: 100%; max-height: 210px; object-fit: contain; }
  .card-shot img:not([src]) { visibility: hidden; height: 120px; }
  .card-shot .num { position: absolute; left: 8px; top: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .card-acts { position: absolute; right: 6px; top: 6px; display: flex; gap: 6px; opacity: 0; transition: opacity .15s; }
  .card:hover .card-acts, .card-acts:focus-within { opacity: 1; }
  .card-act {
    width: 28px; height: 28px; border-radius: 14px; display: grid; place-items: center;
    color: #fff; background: rgba(0,0,0,.5); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); transition: background-color .15s;
  }
  .card-act:hover { background: rgba(0,0,0,.7); }
  .card-act.del:hover { background: var(--red); }
  .card-note {
    display: block; width: 100%; min-height: 30px; max-height: 240px; field-sizing: content; resize: none; border: 0; outline: 0;
    background: transparent; color: var(--text); caret-color: var(--blue); padding: 9px 6px 4px; border-radius: 6px;
    font: 400 14px/1.42 ${FONT}; letter-spacing: -.008em;
  }
  .card-note::placeholder { color: var(--text3); }
  .card-meta { display: flex; align-items: center; gap: 8px; padding: 2px 6px 3px; color: var(--text2); font-size: 11.5px; min-width: 0; }
  .card-meta .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
  .card-meta a { flex: none; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text2); text-decoration: none; }
  .card-meta a:hover { color: var(--blue); }
  .card-meta .where { flex: none; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card.ro { animation: none; }
  .card-text { padding: 9px 6px 4px; font: 400 14px/1.42 ${FONT}; letter-spacing: -.008em; white-space: pre-wrap; overflow-wrap: anywhere; }

  /* History */
  .grp + .grp { margin-top: 18px; }
  .grp h3 { padding: 0 6px 6px; font-size: 12px; font-weight: 600; color: var(--text2); }
  .grp-list { border-radius: 12px; overflow: hidden; background: var(--card); box-shadow: 0 0 0 .5px var(--line); }
  .row {
    position: relative; display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 10px 10px 14px; text-align: left;
    transition: background-color .15s;
  }
  .row:hover { background: var(--fill); }
  .row + .row::before { content: ''; position: absolute; left: 14px; right: 0; top: 0; border-top: .5px solid var(--line); }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .row-title { font-size: 13.5px; font-weight: 600; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-meta { font-size: 11.5px; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-prev { font-size: 12.5px; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .row-thumb { flex: none; width: 54px; height: 54px; border-radius: 8px; object-fit: cover; object-position: top center; background: var(--fill); box-shadow: 0 0 0 .5px var(--line); }
  .row-thumb:not([src]) { visibility: hidden; }
  .row-chev { flex: none; color: var(--text3); margin-left: -4px; }
  .row-chev svg { width: 14px; height: 14px; }
  .last { margin: 0 12px 12px; padding: 12px 12px 12px 14px; border-radius: 12px; background: var(--card); box-shadow: 0 0 0 .5px var(--line); }
  .last-h { font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--text3); margin-bottom: 4px; }
  .last-row { display: flex; align-items: center; gap: 12px; }
  .last-text { flex: 1; min-width: 0; }
  .sh-empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 14px; padding: 32px; text-align: center; color: var(--text2); line-height: 1.5; }
  .empty-ic { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--fill); color: var(--text2); }
  .empty-ic svg { width: 26px; height: 26px; }
  .sh-bottom { border-top: .5px solid var(--line); }
  .sh-foot { display: flex; gap: 8px; padding: 10px 12px 6px; }
  .sh-foot .btn { height: 38px; border-radius: 11px; font-size: 13.5px; padding: 0 14px; }
  .sh-foot .primary { flex: 1; }
  .sh-note { padding: 2px 12px 12px; text-align: center; font-size: 11px; color: var(--text3); }

  .lb {
    position: fixed; inset: 0; display: grid; place-items: center; padding: 4vh 4vw; background: rgba(0,0,0,.55);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); cursor: zoom-out; pointer-events: auto; opacity: 0; transition: opacity .2s;
  }
  .lb.on { opacity: 1; }
  .lb img { max-width: 100%; max-height: 92vh; border-radius: 10px; box-shadow: 0 24px 80px rgba(0,0,0,.5); transform: scale(.97); transition: transform .3s var(--ease); }
  .lb.on img { transform: none; }

  /* Toast */
  .toast {
    position: fixed; left: 50%; bottom: 24px; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 18px; border-radius: 22px;
    font-weight: 500; white-space: nowrap; max-width: calc(100vw - 24px);
    pointer-events: none; opacity: 0; transform: translate(-50%, 16px) scale(.97); transition: opacity .2s, transform .45s var(--ease);
  }
  .toast.on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
  .toast:has(.t-acts button) { padding-right: 6px; }
  .t-acts { display: flex; gap: 2px; }
  .t-ic { color: var(--green); margin-left: -4px; }
  .t-ic svg { width: 18px; height: 18px; }
  .toast.error .t-ic { color: var(--red); }
  .toast button { height: 32px; padding: 0 12px; border-radius: 16px; color: var(--blue); font-weight: 600; transition: background-color .15s; }
  .toast button:hover { background: var(--fill); }

  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; } }
  `;
})();
