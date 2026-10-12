// Redline — background service worker.
// Owns the screenshots (IndexedDB), tab capture, the export to disk + Claude-ready
// text, the toolbar badge and every entry point (icon, shortcut, context menu).

const SESSION_KEY = 'session';

// ---------------------------------------------------------------------------
// Screenshot store. Images live here, not in chrome.storage, so a capture in one
// tab doesn't broadcast megabytes of base64 to every other tab's content script.

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('redline', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images');
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

async function store(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('images', mode);
    const out = fn(tx.objectStore('images'));
    tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const images = {
  put: (id, dataUrl) => store('readwrite', (s) => s.put(dataUrl, id)),
  keys: () => store('readonly', (s) => s.getAllKeys()),
  remove: (ids) => store('readwrite', (s) => ids.forEach((id) => s.delete(id))),
  getMany: (ids) =>
    store('readonly', (s) => {
      const found = {};
      for (const id of ids) {
        const req = s.get(id);
        req.onsuccess = () => req.result && (found[id] = req.result);
      }
      return () => found;
    }),
};

async function getSession() {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] ?? null;
}

// Drop screenshots that no longer belong to the session (after a clear, or a
// delete whose undo window has passed).
async function collectGarbage() {
  const session = await getSession();
  const keep = new Set(session?.items?.map((item) => item.id));
  const stale = (await images.keys()).filter((id) => !keep.has(id));
  if (stale.length) await images.remove(stale);
  return { removed: stale.length };
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

async function exportSession() {
  const session = await getSession();
  if (!session?.items?.length) throw new Error('No notes to copy yet');

  const stored = await images.getMany(session.items.map((item) => item.id));
  const folder = `Redline/${session.folder}`;

  await setDownloadUi(false);
  try {
    const paths = await Promise.all(
      session.items.map((item, i) =>
        stored[item.id] ? saveFile(stored[item.id], `${folder}/${pad(i + 1)}.png`) : null,
      ),
    );
    return { text: buildPrompt(session, paths), count: session.items.length };
  } finally {
    await setDownloadUi(true);
  }
}

async function setDownloadUi(enabled) {
  try {
    await chrome.downloads.setUiOptions({ enabled });
  } catch {
    // Older Chrome: the download bubble just shows briefly.
  }
}

async function saveFile(url, filename) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  const item = await downloadFinished(id);
  chrome.downloads.erase({ id }).catch(() => {}); // keep the file, drop the history row
  return item.filename;
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

function buildPrompt(session, paths) {
  const items = session.items;
  const count = items.length;
  const same = (key) => new Set(items.map(key)).size === 1;
  const onePage = same((item) => item.url);
  const oneViewport = same(viewport);

  const out = [
    `# UI changes (${count} ${count === 1 ? 'note' : 'notes'})`,
    '',
    `I took these while reviewing the page in the browser. Each note pairs a screenshot with the change I want. The screenshots are local PNG files; open each one before making its change. In element screenshots the target is outlined in red.`,
    '',
  ];
  if (onePage) out.push(`Page: ${page(items[0])}`);
  if (oneViewport) out.push(`Viewport: ${viewport(items[0])}`);

  items.forEach((item, i) => {
    out.push('', `## ${i + 1}`);
    if (!onePage) out.push(`Page: ${page(item)}`);
    if (!oneViewport) out.push(`Viewport: ${viewport(item)}`);
    out.push(`Screenshot: ${paths[i] ?? '(missing; the screenshot could not be saved)'}`);
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
  const attempts = [
    () => chrome.tabs.sendMessage(tab.id, msg),
    async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
      return chrome.tabs.sendMessage(tab.id, msg);
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
  gc: () => collectGarbage(),
  export: () => exportSession(),
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
    case 'copy':
      if (await tellTab(tab, { type: 'copy' })) return;
      // No page UI available: copy straight from here.
      try {
        await copyText((await exportSession()).text);
      } catch {}
      return;
    case 'clear':
      if (await tellTab(tab, { type: 'clear' })) return;
      await chrome.storage.local.remove(SESSION_KEY);
      return collectGarbage();
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
      ['copy', 'Copy notes for Claude'],
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
