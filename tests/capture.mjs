// Element, area and whole-screen capture; copy writes the PNGs and a prompt.
import fs from 'fs';
import { run, check, toggle, pick, ui, badge, clip } from './harness.mjs';

await run('Capture and copy', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/');
  await page.evaluate(() => (window.clicks = []));

  await toggle(sw, page);
  await pick(page, page.locator('#cta'));
  check('clicking to capture does not click the page', page.url() === 'http://localhost:4818/' && (await page.evaluate(() => window.clicks.length)) === 0);
  await page.keyboard.type('Make the button bigger and use our brand green (#2f9e44).');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  await toggle(sw, page);
  const card = await page.locator('.product-card').nth(1).boundingBox();
  await page.mouse.move(card.x - 10, card.y - 10);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width + 10, card.y + card.height + 10, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.keyboard.type('Cards feel cramped. Add more padding and');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('show a "Most popular" badge on Winter.');
  await page.keyboard.press('Meta+Enter'); // save & capture the next one
  await page.waitForTimeout(500);
  await page.keyboard.press(' '); // whole screen
  await page.waitForTimeout(800);
  await page.keyboard.type('Too much empty space under the hero.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check('badge counts the notes', (await badge(sw)) === '3');

  await ui(page, '.dock .btn.primary').click();
  await page.waitForTimeout(1500);
  const text = await clip(page);
  const paths = [...text.matchAll(/Screenshot: (.+\.png)/g)].map((m) => m[1]);
  check('prompt has three numbered notes', /## 1[\s\S]*## 2[\s\S]*## 3/.test(text));
  check('element note names the element and its section', text.includes('Element: `section#shopify-section-template--1234__hero > div.hero__content > a#cta` "Get my free box"'));
  check('area and screen notes are labelled', text.includes('Area: a dragged region centered on') && text.includes('Area: the whole visible screen'));
  check('multi-line notes stay together', text.includes('Add more padding and\n  show a "Most popular" badge'));
  check('every screenshot is on disk', paths.length === 3 && paths.every((p) => fs.existsSync(p) && fs.statSync(p).size > 1000), paths.join(', '));
  check('downloads list is left clean', (await sw.evaluate(() => chrome.downloads.search({}))).length === 0);
  check('copying starts a fresh session', (await badge(sw)) === '');
});
