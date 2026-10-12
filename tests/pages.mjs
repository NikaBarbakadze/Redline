// Dark mode, a native modal <dialog>, the picker flagging what's already
// noted, a session across two pages, delete with undo, and the offscreen
// clipboard fallback.
import { run, check, toggle, pick, note, ui, hasClass, badge, clip } from './harness.mjs';

await run('Pages, dialogs and noted elements', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/');
  await note(sw, page, page.locator('.hero__title'), 'Headline in caps.');

  await page.evaluate(() => (window.clicks = []));
  await page.locator('.product-card__title').first().click();
  check('the page stays clickable while the dock shows', (await page.evaluate(() => window.clicks)).includes('H3'));

  await page.click('#open-modal');
  await page.waitForTimeout(300);
  await toggle(sw, page);
  await pick(page, page.locator('#quiz-start'));
  await page.keyboard.type('Start button: rounder corners.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('notes can be typed over a modal dialog', (await badge(sw)) === '2');
  check('the page dialog stays open', await page.evaluate(() => document.getElementById('quiz').open));
  await page.keyboard.press('Escape'); // closes the page's dialog…
  await page.waitForTimeout(300);
  check('…without hiding Redline', await hasClass(ui(page, '.dock'), 'on'));
  check('nothing is drawn on the page itself', (await page.locator('redline-pins').count()) === 0);

  const hover = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
    await page.waitForTimeout(200);
    return [await ui(page, '[data-ref=tagNums]').textContent(), await ui(page, '[data-ref=tagNote]').textContent(), await hasClass(ui(page, '.hl'), 'noted')];
  };
  await toggle(sw, page);
  const noted = await hover('.hero__title');
  check('picking flags an element that already has a note', noted[0] === '1' && noted[1] === 'Headline in caps.' && noted[2], JSON.stringify(noted));
  const fresh = await hover('#cta');
  check('…and only that one', fresh[0] === '' && fresh[1] === '' && !fresh[2], JSON.stringify(fresh));
  await page.evaluate(() => {
    const bar = Object.assign(document.createElement('div'), { id: 'titlebar' }); // like Shopify admin's app title bar
    bar.style.cssText = 'position:fixed;left:700px;top:520px;width:300px;height:55px;z-index:9;background:#eee;border-radius:0 12px 0 0';
    document.body.append(bar);
  });
  await hover('#titlebar');
  const corners = await ui(page, '.hl').evaluate((h) => h.style.borderRadius);
  check('the highlight follows each corner on its own', corners === '0px 12px 0px 0px', corners);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(700);
  await ui(page, '.card >> nth=0 >> [data-act=goto]').click();
  await page.waitForTimeout(600);
  check('Show on page opens its note', await ui(page, '.cmp').evaluate((c) => c.classList.contains('on') && c.classList.contains('edit')));
  await page.keyboard.type(' Keep the serif.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.goto('http://localhost:4818/cart');
  await page.waitForTimeout(500);
  await note(sw, page, page.locator('.cart__checkout'), 'Checkout button should be full width on mobile.');
  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(700);
  check('the panel lists notes from both pages', (await ui(page, '[data-ref=sheetSub]').textContent()) === '3 notes across 2 pages');
  await ui(page, '.card >> nth=1').hover();
  await ui(page, '.card >> nth=1 >> [data-act=remove]').click();
  await page.waitForTimeout(300);
  check('delete removes the card', (await ui(page, '.card').count()) === 2);
  await ui(page, '.toast .t-acts button').click();
  await page.waitForTimeout(400);
  check('undo brings it back', (await ui(page, '.card').count()) === 3);

  await ui(page, '[data-ref=footCurrent] .btn.primary').click();
  await page.waitForTimeout(1500);
  const text = await clip(page);
  check('copying from the panel closes it', !(await ui(page, '.sheet').evaluate((el) => el.classList.contains('on'))));
  check('the edit made through Show on page was saved', text.includes('Headline in caps. Keep the serif.'));
  check('notes keep their pages', text.includes('Page: Cozy Crafts — Cart (http://localhost:4818/cart)'));

  await sw.evaluate(async () => {
    if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({ url: 'src/offscreen.html', reasons: ['CLIPBOARD'], justification: 'test' });
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text: 'offscreen-ok' });
  });
  check('offscreen clipboard fallback works', (await clip(page)) === 'offscreen-ok');
}, { dark: true });
