// Launches Playwright's Chromium with Redline loaded, serves the mock pages in
// ./site, and collects pass/fail checks. Each test file is a standalone script.
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// REDLINE_EXT points the suites at another build, e.g. the unzipped store package.
export const EXT = process.env.REDLINE_EXT ? path.resolve(process.env.REDLINE_EXT) : path.resolve(HERE, '..');
export const SHOTS = path.join(HERE, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

const ROUTES = { '/': 'index.html', '/admin': 'admin.html', '/app': 'app.html', '/chat-pm': 'chat-pm.html', '/chat-input': 'chat-input.html', '/plain': 'plain.html' };

// The test store on 4818; the "app" iframe is loaded from 4819 (another site,
// so Chrome runs it out of process like a Shopify admin app).
export function serve(port = 4818) {
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const file = path.join(HERE, 'site', ROUTES[p] ?? (p.includes('.') ? p : 'other.html'));
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    const type = { '.svg': 'image/svg+xml', '.xml': 'application/xml' }[path.extname(file)] ?? 'text/html';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

export async function launch({ dark = false, width = 1280, height = 800, args = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-test-'));
  const downloads = path.join(tmp, 'downloads');
  fs.mkdirSync(path.join(tmp, 'profile', 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'profile', 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...args],
  });
  const close = context.close.bind(context);
  context.close = async () => {
    await close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  const page = context.pages()[0] ?? (await context.newPage());
  // Let Chrome save files where the profile says, not into Playwright's temp dir.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The welcome tab opens on install; get it out of the way.
  await page.waitForTimeout(500);
  for (const p of context.pages()) if (p !== page && p.url().includes('welcome.html')) await p.close();
  return { context, sw, page, downloads };
}

// What ⌘⇧S does. (No page.bringToFront(): in headless it breaks pointer
// routing into out-of-process iframes.)
export const toggle = (sw, page) => tell(sw, page, 'toggle');

// What the toolbar icon does: open or close the notes panel.
export const icon = (sw, page) => tell(sw, page, 'panel');

async function tell(sw, page, type) {
  await sw.evaluate(
    async ([url, type]) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      await chrome.tabs.sendMessage(tab.id, { type, target: 'page' }, { frameId: 0 });
    },
    [page.url(), type],
  );
  await page.waitForTimeout(150);
}

// Hover + click an element in the page (or an iframe; `offset` covers the
// iframe's border + padding, which Playwright's frame boxes leave out).
export async function pick(page, locator, { offset = 0 } = {}) {
  const b = await locator.first().boundingBox();
  const at = [b.x + offset + b.width / 2, b.y + offset + b.height / 2];
  await page.mouse.move(...at, { steps: 3 });
  await page.waitForTimeout(150);
  await page.mouse.click(...at);
  await page.waitForTimeout(800);
}

// Capture an element and save a note for it.
export async function note(sw, page, locator, text, opts) {
  await toggle(sw, page);
  await pick(page, locator, opts);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
}

export const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
export const ui = (page, sel) => page.locator(`redline-ui >> ${sel}`);
export const hasClass = (locator, cls) => locator.evaluate((el, c) => el.classList.contains(c), cls);
export const badge = (sw) => sw.evaluate(() => chrome.action.getBadgeText({}));
export const clip = (page) => page.evaluate(() => navigator.clipboard.readText());

// Exceptions from Redline's content scripts, which run in isolated worlds that
// Playwright's 'pageerror' doesn't see. Pass `frame` for an out-of-process iframe.
export async function scriptErrors(context, target) {
  const errors = [];
  const cdp = await context.newCDPSession(target);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => errors.push(d.exception?.description?.split('\n')[0] ?? d.text));
  await cdp.send('Runtime.enable');
  return errors;
}

const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
}

// Runs a test body against a fresh browser and reports. Exit code 1 on failure.
export async function run(title, body, opts = {}) {
  const servers = [await serve(4818), await serve(4819)];
  const env = await launch(opts);
  const errors = [];
  env.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await body(env);
  } catch (err) {
    check(`finished without throwing`, false, err.message.split('\n')[0]);
    await shot(env.page, `failed-${title.replace(/\W+/g, '-')}`).catch(() => {});
  } finally {
    await env.context.close();
    servers.forEach((s) => s.close());
  }
  if (errors.length) check('no page errors', false, errors[0]);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}
