// A Shopify-admin-like page with the app in a cross-origin iframe (bordered,
// padded, scrolling): picking, ↑ forwarded from the top frame, area drag, Esc,
// what's already noted flagged inside the iframe, and the iframe URL (without
// its tokens) in the prompt.
import { run, check, toggle, pick, ui, hasClass, clip } from './harness.mjs';

const OFF = 12; // the iframe's 8px border + 4px padding

await run('Cross-origin iframes', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/admin');
  await page.waitForTimeout(1200);
  const app = page.frames().find((f) => f.url().includes('127.0.0.1:4819'));
  await app.evaluate(() => {
    window.clicks = [];
    document.addEventListener('click', (e) => window.clicks.push(e.target.id || e.target.className));
  });

  await toggle(sw, page);
  const create = await app.locator('#create-quiz').boundingBox();
  await pick(page, app.locator('#create-quiz'), { offset: OFF });
  const spot = await ui(page, '.spot').evaluate((s) => [parseFloat(s.style.left), parseFloat(s.style.top)]);
  check('the composer spotlights the element inside the iframe', Math.abs(spot[0] - (create.x + OFF)) < 1 && Math.abs(spot[1] - (create.y + OFF)) < 1, spot.join(','));
  await page.keyboard.type('Make "Create quiz" the primary green button.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  await app.evaluate(() => document.getElementById('settings').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await toggle(sw, page);
  const save = await app.locator('#save-settings').boundingBox();
  await page.mouse.move(save.x + OFF + save.width / 2, save.y + OFF + save.height / 2, { steps: 4 });
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowUp'); // focus is in the top frame; the key goes to the iframe
  await page.waitForTimeout(150);
  check('↑ selects the parent inside the iframe', (await app.evaluate(() => document.querySelector('redline-ui').shadowRoot.querySelector('[data-ref=tagName]').textContent)) === 'section#settings');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.keyboard.type('Settings card needs a description line.');
  await page.keyboard.press('Meta+Enter'); // save & capture the next one
  await page.waitForTimeout(500);

  await app.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(200);
  const list = await app.locator('#quiz-list').boundingBox();
  await page.mouse.move(list.x + OFF + 10, list.y + OFF + 10);
  await page.mouse.down();
  await page.mouse.move(list.x + OFF + list.width - 10, list.y + OFF + list.height - 10, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.keyboard.type('Rows need more vertical padding.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  await toggle(sw, page);
  const again = await app.locator('#create-quiz').boundingBox();
  await page.mouse.move(again.x + OFF + again.width / 2, again.y + OFF + again.height / 2, { steps: 3 });
  await page.waitForTimeout(200);
  const flagged = await app.evaluate(() => {
    const r = document.querySelector('redline-ui').shadowRoot;
    return [r.querySelector('[data-ref=tagNums]').textContent, r.querySelector('[data-ref=tagNote]').textContent, r.querySelector('.hl').classList.contains('noted')];
  });
  check('picking inside the iframe flags what is already noted', flagged[0] === '1' && flagged[1].startsWith('Make "Create quiz"') && flagged[2], JSON.stringify(flagged));
  await app.locator('body').press('Escape');
  await page.waitForTimeout(300);
  check('Esc inside the iframe cancels capture', !(await hasClass(ui(page, '.hud'), 'on')));
  const clicks = await app.evaluate(() => window.clicks);
  check('the app never got a click', clicks.length === 0, JSON.stringify(clicks));

  await ui(page, '[data-act=copy] >> nth=0').click();
  await page.waitForTimeout(1500);
  const text = await clip(page);
  check('notes name the iframe without its tokens', (text.match(/Inside iframe: http:\/\/127\.0\.0\.1:4819\/app\n/g) ?? []).length === 3 && !text.includes('id_token'), text.split('\n').filter((l) => /^(## |Inside|Area|Element)/.test(l)).join(' | '));
  check('element paths are inside the app', text.includes('`header.app-header > button#create-quiz` "Create quiz"') && text.includes('`div.page > section#settings`'));
}, { width: 1440, height: 900 });
