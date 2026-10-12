// Redline — background service worker.
// Owns the screenshots and session history (IndexedDB), tab capture, the export
// to disk + Claude-ready text, the toolbar badge and every entry point (icon,
// shortcut, context menu).

// The active session lives in chrome.storage so every tab stays in sync. Copied
// (or set-aside) sessions move to the `sessions` store: that's History.
const SESSION_KEY = 'session';
const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// IndexedDB. Images live here, not in chrome.storage, so a capture in one tab
// doesn't broadcast megabytes of base64 to every other tab's content script.
//   images   item id → PNG data URL
//   thumbs   item id → small JPEG data URL (History rows)
//   sessions session id → archived session

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('redline', 2);
    req.onupgradeneeded = () => {
      for (const name of ['images', 'thumbs', 'sessions']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      req.result.onclose = () => (dbPromise = null);
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function run(name, mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(name, mode);
    const out = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function keyValueStore(name) {
  return {
    put: (id, value) => run(name, 'readwrite', (s) => s.put(value, id)),
    get: (id) => run(name, 'readonly', (s) => s.get(id)),
    all: () => run(name, 'readonly', (s) => s.getAll()),
    keys: () => run(name, 'readonly', (s) => s.getAllKeys()),
    remove: (ids) => run(name, 'readwrite', (s) => ids.forEach((id) => s.delete(id))),
    getMany: (ids) =>
      run(name, 'readonly', (s) => {
        const found = {};
        for (const id of ids) {
          const req = s.get(id);
          req.onsuccess = () => req.result && (found[id] = req.result);
        }
        return () => found;
      }),
  };
}

const images = keyValueStore('images');
const thumbs = keyValueStore('thumbs');
const sessions = keyValueStore('sessions');

async function getSession() {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] ?? null;
}

// Drop screenshots that belong to neither the active session nor History
// (after an undo window has passed, or History was trimmed).
async function collectGarbage() {
  const live = [await getSession(), ...(await sessions.all())];
  const keep = new Set(live.flatMap((s) => s?.items?.map((item) => item.id) ?? []));
  const staleImages = (await images.keys()).filter((id) => !keep.has(id));
  const staleThumbs = (await thumbs.keys()).filter((id) => !keep.has(id));
  if (staleImages.length) await images.remove(staleImages);
  if (staleThumbs.length) await thumbs.remove(staleThumbs);
  return { removed: staleImages.length };
}

// ---------------------------------------------------------------------------
// History

// Moves the active session into History and leaves a fresh one behind.
async function archive({ copied }) {
  const session = await getSession();
  await chrome.storage.local.remove(SESSION_KEY);
  if (!session?.items?.length) return { id: null };
  const now = Date.now();
  await sessions.put(session.id, { ...session, archivedAt: now, copiedAt: copied ? now : (session.copiedAt ?? null) });
  await trimHistory();
  return { id: session.id, count: session.items.length };
}

// Makes a History session active again. Whatever was in progress is set aside
// into History first, so nothing is lost.
async function reopen(id) {
  const entry = await sessions.get(id);
  if (!entry) throw new Error('That session is no longer in History');
  const active = await getSession();
  if (active?.id !== id) await archive({ copied: false });
  await sessions.remove([id]);
  const { archivedAt, ...session } = entry;
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return { ok: true, count: session.items.length };
}

async function trimHistory() {
  const all = (await sessions.all()).sort((a, b) => b.archivedAt - a.archivedAt);
  const extra = all.slice(HISTORY_LIMIT).map((s) => s.id);
  if (!extra.length) return;
  await sessions.remove(extra);
  await collectGarbage();
}

async function listHistory() {
  const all = (await sessions.all()).sort((a, b) => b.archivedAt - a.archivedAt);
  return { sessions: all.map(summarize) };
}

function summarize(s) {
  const hosts = [...new Set(s.items.map((item) => hostOf(item.url)))];
  return {
    id: s.id,
    archivedAt: s.archivedAt,
    copiedAt: s.copiedAt ?? null,
    count: s.items.length,
    pages: new Set(s.items.map((item) => item.url)).size,
    title: s.items[0]?.title || hosts[0] || 'Session',
    host: hosts[0] ?? '',
    preview: s.items[0]?.note ?? '',
    thumbId: s.items[0]?.id ?? null,
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// Small JPEGs for History rows, made once from the full screenshot.
async function getThumbs(ids) {
  const found = await thumbs.getMany(ids);
  const missing = ids.filter((id) => !found[id]);
  if (missing.length) {
    const full = await images.getMany(missing);
    for (const id of missing) {
      if (!full[id]) continue;
      try {
        found[id] = await makeThumb(full[id]);
        await thumbs.put(id, found[id]);
      } catch {}
    }
  }
  return found;
}

async function makeThumb(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 }));
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Capture

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureVisible(windowId) {
  // Chrome allows ~2 captures per second; "save & next" can hit that.
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      if (attempt > 4 || !/MAX_CAPTURE|quota/i.test(String(err?.message))) throw err;
      await sleep(300);
    }
  }
}

// ---------------------------------------------------------------------------
// Export: write every screenshot to ~/Downloads/Redline/<session>/NN.png and
// return a prompt that pairs each absolute path with its note.

// `id` exports a History session instead of the active one.
async function exportSession(id = null) {
  const session = await sessionById(id);
  if (!session?.items?.length) throw new Error('No notes to copy yet');

  const { paths } = await saveSessionFiles(session);
  if (id && (await sessions.get(id))) {
    const now = Date.now();
    await sessions.put(id, { ...session, copiedAt: now, archivedAt: now }); // back to the top of History
  }
  const text = buildPrompt(session, paths);
  // Pasting this exact text into a web chat brings the screenshots along (see
  // the content script's paste handler); remember which copy it was.
  await chrome.storage.local.set({ lastCopy: { id: session.id, hash: textHash(text), at: Date.now() } });
  pasteBundle(session.id).catch(() => {}); // warm it up so the paste is instant
  return { text, count: session.items.length };
}

// Active session, or one from History.
async function sessionById(id) {
  const active = await getSession();
  if (!id || active?.id === id) return active;
  return (await sessions.get(id)) ?? null;
}

// Writes ~/Downloads/Redline/<session>/NN.png. `keepFirst` leaves the first
// file's downloads row in place so it can be revealed in Finder.
async function saveSessionFiles(session, { keepFirst = false } = {}) {
  const stored = await images.getMany(session.items.map((item) => item.id));
  const folder = `Redline/${session.folder}`;
  await setDownloadUi(false);
  try {
    const saved = await Promise.all(
      session.items.map((item, i) =>
        stored[item.id] ? saveFile(stored[item.id], `${folder}/${pad(i + 1)}.png`, keepFirst && i === 0) : null,
      ),
    );
    return { paths: saved.map((f) => f?.path ?? null), firstId: saved[0]?.downloadId ?? null };
  } finally {
    await setDownloadUi(true);
  }
}

// "Show files": open the session's folder in Finder with screenshot 1 selected,
// for dragging the images into desktop apps.
async function revealFiles(id) {
  const session = await sessionById(id);
  if (!session?.items?.length) throw new Error('No screenshots to show');
  const { firstId } = await saveSessionFiles(session, { keepFirst: true });
  if (firstId == null) throw new Error('No screenshots to show');
  chrome.downloads.show(firstId);
  setTimeout(() => chrome.downloads.erase({ id: firstId }).catch(() => {}), 3000);
  return { ok: true };
}

// Same on both sides (content.js has a copy): identifies Redline's text on the
// clipboard whatever the line endings.
function textHash(text) {
  const s = text.replace(/\r\n?/g, '\n').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

// What a web-chat paste attaches: every screenshot numbered in its corner, and
// the prompt worded for attachments instead of file paths.
let bundleCache = null;
async function pasteBundle(id) {
  const session = await sessionById(id);
  if (!session?.items?.length) throw new Error('Those notes are no longer in Redline');
  const key = [session.id, ...session.items.map((item) => `${item.id}:${item.note}`)].join('|');
  if (bundleCache?.key !== key) {
    const value = (async () => {
      const stored = await images.getMany(session.items.map((item) => item.id));
      const files = await Promise.all(
        session.items.map(async (item, i) =>
          stored[item.id] ? { name: `redline-${pad(i + 1)}.png`, dataUrl: await numberImage(stored[item.id], i + 1) } : null,
        ),
      );
      return { files: files.filter(Boolean), text: buildPrompt(session, null) };
    })();
    bundleCache = { key, value };
    value.catch(() => bundleCache?.value === value && (bundleCache = null));
  }
  return bundleCache.value;
}

async function numberedImage(itemId, n) {
  const { [itemId]: dataUrl } = await images.getMany([itemId]);
  if (!dataUrl) throw new Error('That screenshot is missing');
  return { dataUrl: await numberImage(dataUrl, n) };
}

async function setDownloadUi(enabled) {
  try {
    await chrome.downloads.setUiOptions({ enabled });
  } catch {
    // Older Chrome: the download bubble just shows briefly.
  }
}

async function saveFile(url, filename, keepRow = false) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  const item = await downloadFinished(id);
  if (!keepRow) chrome.downloads.erase({ id }).catch(() => {}); // keep the file, drop the history row
  return { path: item.filename, downloadId: id };
}

function downloadFinished(id) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return finish(reject, new Error('Download disappeared'));
      if (item.state === 'complete') finish(resolve, item);
      else if (item.state === 'interrupted') finish(reject, new Error(`Saving a screenshot failed (${item.error})`));
    };
    const onChanged = (delta) => delta.id === id && delta.state && check();
    const finish = (settle, value) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      settle(value);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    check();
  });
}

const pad = (n) => String(n).padStart(2, '0');

// `paths` are the saved PNGs for Claude Code; null means the screenshots are
// attached to a claude.ai chat instead, in order, each numbered in its corner.
function buildPrompt(session, paths) {
  const items = session.items;
  const count = items.length;
  const same = (key) => new Set(items.map(key)).size === 1;
  const onePage = same((item) => item.url);
  const oneViewport = same(viewport);
  const attached = !paths;

  const out = [
    `# UI changes (${count} ${count === 1 ? 'note' : 'notes'})`,
    '',
    attached
      ? `I took these while reviewing the page in the browser. Each note has a screenshot attached, in the same order and marked with the note's number in its top-left corner. In element screenshots the target is outlined in red.`
      : `I took these while reviewing the page in the browser. Each note pairs a screenshot with the change I want. The screenshots are local PNG files; open each one before making its change. In element screenshots the target is outlined in red.`,
    '',
  ];
  if (onePage) out.push(`Page: ${page(items[0])}`);
  if (oneViewport) out.push(`Viewport: ${viewport(items[0])}`);

  items.forEach((item, i) => {
    out.push('', `## ${i + 1}`);
    if (!onePage) out.push(`Page: ${page(item)}`);
    if (item.frameUrl) out.push(`Inside iframe: ${item.frameUrl}`);
    if (!oneViewport) out.push(`Viewport: ${viewport(item)}`);
    out.push(attached ? `Screenshot: attached image ${i + 1}` : `Screenshot: ${paths[i] ?? '(missing; the screenshot could not be saved)'}`);
    const target = describeTarget(item);
    if (target) out.push(target);
    out.push(`Change: ${item.note.trim().replace(/\n/g, '\n  ') || '(no note; see screenshot)'}`);
  });

  return out.join('\n') + '\n';
}

function page(item) {
  return item.title ? `${item.title} (${item.url})` : item.url;
}

function viewport(item) {
  return `${item.vw}×${item.vh}`;
}

function describeTarget(item) {
  const t = item.target;
  if (item.kind === 'screen') return 'Area: the whole visible screen';
  if (item.kind === 'area') return t?.path ? `Area: a dragged region centered on \`${t.path}\`` : 'Area: a dragged region';
  if (!t?.path) return null;
  return `Element: \`${t.path}\`${t.text ? ` "${t.text}"` : ''}`;
}

// ---------------------------------------------------------------------------
// The note's number in the screenshot's corner, so each image maps to its note
// even if the chat reorders attachments.
async function numberImage(dataUrl, n) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const r = Math.round(Math.max(14, Math.min(34, Math.min(bitmap.width, bitmap.height) * 0.05)));
  const c = Math.round(r * 1.6);
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = r * 0.4;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(c, c, r + Math.max(2, r * 0.14), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#FF3B30';
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 ${Math.round(r * 1.15)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), c, c + r * 0.05);
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

// ---------------------------------------------------------------------------
// Clipboard fallback for when the page can't write it (unfocused, permission
// policy) and for the toolbar context menu. Runs in an offscreen document.

async function copyText(text) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy the exported notes to the clipboard',
    });
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
  if (!res?.ok) throw new Error('Clipboard write failed');
}

// ---------------------------------------------------------------------------
// Talking to tabs

// Sends a message to Redline's UI in a tab, injecting it first when the tab was
// open before the extension was installed or reloaded. Returns false when the
// page can't host it (chrome://, the Web Store).
async function tellTab(tab, msg) {
  if (!tab?.id) return false;
  msg = { ...msg, target: 'page' };
  const top = { frameId: 0 }; // child frames take their cues from the top frame
  const attempts = [
    () => chrome.tabs.sendMessage(tab.id, msg, top),
    async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/content.js'] });
      return chrome.tabs.sendMessage(tab.id, msg, top);
    },
    // Extension pages (the welcome page) embed the UI directly.
    () => chrome.runtime.sendMessage({ ...msg, tabId: tab.id }),
  ];
  for (const attempt of attempts) {
    try {
      if ((await attempt())?.ok) return true;
    } catch {}
  }
  flashBadge();
  return false;
}

async function flashBadge() {
  await chrome.action.setBadgeText({ text: '×' });
  await sleep(1500);
  updateBadge(await getSession());
}

function updateBadge(session) {
  const count = session?.items?.length ?? 0;
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

async function shortcut() {
  const [cmd] = (await chrome.commands.getAll()).filter((c) => c.name === 'capture');
  return cmd?.shortcut ?? '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ---------------------------------------------------------------------------
// Messages from the page UI

const handlers = {
  ping: () => ({ ok: true }),
  capture: async (_, sender) => ({ dataUrl: await captureVisible(sender.tab.windowId) }),
  putImage: async ({ id, dataUrl }) => (await images.put(id, dataUrl), { ok: true }),
  getImages: ({ ids }) => images.getMany(ids),
  // Top frame → every frame in its tab (start/stop picking, hide for the shot).
  frames: async ({ payload }, sender) => {
    await chrome.tabs.sendMessage(sender.tab.id, { ...payload, target: 'page' }).catch(() => {});
    return { ok: true };
  },
  gc: () => collectGarbage(),
  export: ({ id }) => exportSession(id),
  pasteBundle: ({ id }) => pasteBundle(id),
  numberedImage: ({ itemId, n }) => numberedImage(itemId, n),
  revealFiles: ({ id }) => revealFiles(id),
  archive: ({ copied }) => archive({ copied: !!copied }),
  reopen: ({ id }) => reopen(id),
  history: () => listHistory(),
  historyGet: async ({ id }) => ({ session: (await sessions.get(id)) ?? null }),
  historyDelete: async ({ id }) => (await sessions.remove([id]), { ok: true }),
  historyRestore: async ({ session }) => (await sessions.put(session.id, session), { ok: true }),
  thumbs: ({ ids }) => getThumbs(ids),
  copyText: async ({ text }) => (await copyText(text), { ok: true }),
  shortcut: async () => ({ shortcut: await shortcut() }),
  openShortcuts: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target) return false; // addressed to a page or the offscreen document
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Entry points

chrome.action.onClicked.addListener((tab) => tellTab(tab, { type: 'toggle' }));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'capture') tellTab(tab ?? (await activeTab()), { type: 'toggle' });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  tab ??= await activeTab();
  switch (info.menuItemId) {
    case 'review':
      return tellTab(tab, { type: 'review' });
    case 'history':
      return tellTab(tab, { type: 'history' });
    case 'copy':
      if (await tellTab(tab, { type: 'copy' })) return;
      // No page UI available: do it from here.
      try {
        await copyText((await exportSession()).text);
        await archive({ copied: true });
      } catch {}
      return;
    case 'clear':
      if (await tellTab(tab, { type: 'clear' })) return;
      return archive({ copied: false });
    case 'shortcuts':
      return chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SESSION_KEY in changes) updateBadge(changes[SESSION_KEY].newValue);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    const menu = [
      ['review', 'Review notes'],
      ['history', 'History'],
      ['copy', 'Copy notes'],
      ['clear', 'Start a new session'],
      ['shortcuts', 'Change keyboard shortcut…'],
    ];
    for (const [id, title] of menu) chrome.contextMenus.create({ id, title, contexts: ['action'] });
  });
  if (reason === 'install') chrome.tabs.create({ url: 'welcome.html' });
});

chrome.runtime.onStartup.addListener(() => {
  setDownloadUi(true); // in case the worker died mid-export
  collectGarbage();
});

chrome.action.setBadgeBackgroundColor({ color: '#FF3B30' });
chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
getSession().then(updateBadge);
