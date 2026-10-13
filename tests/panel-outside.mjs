// Clicking anywhere outside the notes panel closes it, like Esc, and the click
// still reaches the page, iframes included. Clicks on Redline's own UI (the
// panel, its toasts, a zoomed screenshot) don't count, and neither do a right
// click or dragging the page's scrollbar.
import { run, check, note, icon, ui, hasClass } from './harness.mjs';

const OFF = 12; // the admin iframe's 8px border + 4px padding

await run('Clicking outside closes the panel', async ({ sw, page }) => {
  const open = () => hasClass(ui(page, '.sheet'), 'on');
  const show = async () => {
    if (await open()) return;
    await icon(sw, page);
    await page.waitForTimeout(500);
  };
  const clickAt = async (x, y, opts) => {
    await page.mouse.click(x, y, opts);
    await page.waitForTimeout(400);
  };
  const title = () => page.locator('.hero__title').boundingBox();

  await page.goto('http://localhost:4818/');
  await note(sw, page, page.locator('#cta'), 'Green CTA.');
  await note(sw, page, page.locator('.product-card__title').first(), 'Bigger title.');
  await show();

  await ui(page, '.seg [data-view=history]').click();
  await ui(page, '.seg [data-view=current]').click();
  await ui(page, '[data-ref=sheetTitle]').click();
  await page.waitForTimeout(300);
  check('clicks inside the panel keep it open', await open());

  await ui(page, '[data-ref=list] > .card .card-shot').first().click();
  await page.waitForTimeout(400);
  await clickAt(20, 20); // the zoomed screenshot's backdrop
  check('clicking a zoomed screenshot closes just the zoom', (await open()) && !(await hasClass(ui(page, '.lb'), 'on')));

  await ui(page, '[data-ref=list] > .card [data-act=remove]').first().click();
  await page.waitForTimeout(400);
  await ui(page, '.toast .t-acts button').click(); // Undo
  await page.waitForTimeout(400);
  check('the Undo toast is part of Redline', (await open()) && (await ui(page, '[data-ref=list] > .card').count()) === 2);

  const t = await title();
  await clickAt(t.x + 20, t.y + t.height / 2, { button: 'right' });
  check('a right click leaves it open', await open());

  await page.mouse.wheel(0, 100); // brings up the overlay scrollbar (macOS)
  await page.mouse.move(1277, 400, { steps: 3 });
  await page.waitForTimeout(300);
  await clickAt(1277, 400);
  check('clicking an overlay scrollbar leaves it open', await open());
  await page.evaluate(() => scrollTo(0, 0));

  // A styled scrollbar is a classic one everywhere, even with macOS overlay scrollbars.
  await page.addStyleTag({ content: '::-webkit-scrollbar { width: 14px } ::-webkit-scrollbar-thumb { background: #aaa }' });
  await page.waitForTimeout(200);
  const bar = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
  check('(the page has a classic scrollbar to test with)', bar > 0, `${bar}px`);
  await clickAt(1280 - bar / 2, 400);
  check('clicking the page scrollbar leaves it open', await open());
  check('…and the page scrolls', (await page.evaluate(() => scrollY)) > 0);
  await page.evaluate(() => scrollTo(0, 0));

  await ui(page, '[data-ref=list] > .card .card-note').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Darker on hover.');
  await page.evaluate(() => (window.clicks = []));
  await clickAt(t.x + 20, t.y + t.height / 2);
  check('a click on the page closes it', !(await open()));
  check('…and still reaches the page', (await page.evaluate(() => window.clicks)).includes('H1'));
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('session')).session.items[0].note);
  check('…and keeps an edit in progress', saved === 'Green CTA. Darker on hover.', saved);

  await page.goto('http://localhost:4818/admin');
  await page.waitForTimeout(1200);
  const app = page.frames().find((f) => f.url().includes('127.0.0.1:4819'));
  await app.evaluate(() => {
    window.clicks = [];
    document.addEventListener('click', (e) => window.clicks.push(e.target.id || e.target.className));
  });
  await show();
  const head = await app.locator('.app-header__title').boundingBox();
  await clickAt(head.x + OFF + 10, head.y + OFF + head.height / 2);
  check('a click inside an iframe closes it', !(await open()));
  check('…and still reaches the app', (await app.evaluate(() => window.clicks)).includes('app-header__title'));

  await show();
  await clickAt(100, 200); // the admin's own nav
  check('so does a click on the page around the iframe', !(await open()));
}, { scrollbars: true });
