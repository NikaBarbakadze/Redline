// Renders the Chrome Web Store images into store/: 1280×800 screenshots of the
// real extension on the test pages, and the 440×280 promo tile. Run from the
// repo root after `npm install` in tests/: node tools/store-shots.mjs
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { serve, launch, toggle, pick, note, ui } from '../tests/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store');
fs.mkdirSync(OUT, { recursive: true });

// The store wants exact sizes and no alpha: shoot at 2×, scale down to JPEG.
async function save(page, name, size = [1280, 800]) {
  const raw = path.join(OUT, `.${name}.png`);
  await page.screenshot({ path: raw });
  execFileSync('sips', ['-z', String(size[1]), String(size[0]), '-s', 'format', 'jpeg', '-s', 'formatOptions', '92', raw, '--out', path.join(OUT, `${name}.jpg`)], { stdio: 'ignore' });
  fs.rmSync(raw);
}

const tell = (sw, page, type) =>
  sw.evaluate(
    async ([url, type]) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      await chrome.tabs.sendMessage(tab.id, { type, target: 'page' }, { frameId: 0 });
    },
    [page.url(), type],
  );

const servers = [await serve(4818), await serve(4819)];
const { context, sw, page, downloads } = await launch({ width: 1280, height: 800 });
try {
  await page.goto('http://localhost:4818/');
  await page.waitForTimeout(800);

  // 1. Hover highlights like DevTools.
  await toggle(sw, page);
  const card = await page.locator('.product-card').nth(1).boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 4 });
  await page.waitForTimeout(400);
  await save(page, '1-pick');

  // 2. The note opens beside what you picked.
  await pick(page, page.locator('#cta'));
  await page.keyboard.type('Make this the brand green and say "Claim my free box".');
  await page.waitForTimeout(300);
  await save(page, '2-note');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // A few more notes for the panel.
  await note(sw, page, page.locator('.hero__title'), 'Headline is too long on mobile. Keep it on two lines at 390px.');
  await note(sw, page, page.locator('.product-card').first(), 'Cards need the price in bold and a "Most popular" badge on this one.');
  await note(sw, page, page.locator('header'), 'Header should stay transparent over the hero, solid after scrolling.');

  // 3. Every note with its screenshot, ready to copy.
  await tell(sw, page, 'review');
  await page.waitForTimeout(900);
  await save(page, '3-notes');

  // 5. What gets pasted (rendered after the iframe shot, from this copy).
  await ui(page, '.sheet [data-act=copy]').click();
  await page.waitForTimeout(1500);
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 4. Inside iframes: an app embedded in an admin.
  await page.goto('http://localhost:4818/admin');
  await page.waitForTimeout(1200);
  await page.evaluate(() => (document.querySelector('.topbar').innerHTML = '<b>Store admin</b>'));
  const app = page.frames().find((f) => f.url().includes('127.0.0.1:4819'));
  await toggle(sw, page);
  await pick(page, app.locator('#create-quiz'), { offset: 12 });
  await page.keyboard.type('Make "Create quiz" the primary button and move it next to the title.');
  await page.waitForTimeout(300);
  await save(page, '4-iframe');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // As it reads on a real machine and site, not the test rig's.
  const shown = prompt
    .split(downloads).join('~/Downloads')
    .split('http://localhost:4818').join('https://cozycrafts.example')
    .split(' — Test Store').join('')
    .split('#shopify-section-template--1234__hero').join('#hero')
    .split('\n').slice(0, 34).join('\n');
  await page.setContent(`<!doctype html><html><body style="margin:0;height:800px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;display:flex;flex-direction:column;align-items:center">
    <div style="margin:34px 0 18px;font-size:26px;font-weight:600;color:#1d1d1f;letter-spacing:-.01em">One paste: every note, its screenshot and where it lives</div>
    <div style="width:1080px;flex:1;margin-bottom:34px;border-radius:14px;background:#1c1c1e;box-shadow:0 20px 50px rgba(0,0,0,.18);overflow:hidden;display:flex;flex-direction:column">
      <div style="height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#2c2c2e"><i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i></div>
      <pre style="margin:0;padding:18px 22px;font:13px/1.55 ui-monospace,'SF Mono',Menlo,monospace;color:#e5e5ea;white-space:pre-wrap;overflow:hidden">${esc(shown)}</pre>
    </div></body></html>`);
  await page.waitForTimeout(300);
  await save(page, '5-prompt');

  // Promo tile, from welcome-style markup with the real icon.
  const icon = fs.readFileSync(path.join(ROOT, 'icons/128.png')).toString('base64');
  const tile = await context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.setContent(`<!doctype html><html><body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:22px;padding:0 36px;box-sizing:border-box;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif;color:#1d1d1f">
    <img src="data:image/png;base64,${icon}" width="96" height="96" style="flex:none">
    <div><div style="font-size:38px;font-weight:700;letter-spacing:-.02em">Redline</div>
    <div style="margin-top:8px;font-size:17px;line-height:1.35;color:#515154">Point at anything.<br>Say what should change.<br>Paste it into your coding agent.</div></div>
  </body></html>`);
  await tile.waitForTimeout(200);
  await save(tile, 'promo-440x280', [440, 280]);
} finally {
  await context.close();
  servers.forEach((s) => s.close());
}
console.log(fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')).join('\n'));
