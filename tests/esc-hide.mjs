// Esc with nothing open hides the dock (all tabs, survives reload)
// until the next capture; Esc in a field is left alone; Esc inside an iframe
// closes the panel (and the dock with it) and hides the session there too.
import { run, check, toggle, note, ui, hasClass } from './harness.mjs';

await run('Esc hides the session', async ({ sw, page }) => {
  const dock = () => hasClass(ui(page, '.dock'), 'on');
  await page.goto('http://localhost:4818/');
  await note(sw, page, page.locator('#cta'), 'Green CTA.');
  await note(sw, page, page.locator('.hero__title'), 'Caps.');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc hides the dock', !(await dock()));
  check('the first time, a hint explains how they come back', (await ui(page, '[data-ref=toastText]').textContent()).startsWith('Notes hidden'));
  await page.reload();
  await page.waitForTimeout(800);
  check('still hidden after a reload', (await ui(page, '.dock').count()) === 1 && !(await dock()));

  await toggle(sw, page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('a capture brings it back', await dock());

  await page.evaluate(() => document.body.prepend(Object.assign(document.createElement('input'), { id: 'q' })));
  await page.click('#q');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc in a text field is left alone', await dock());
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('the hint only shows once', !(await dock()) && !(await hasClass(ui(page, '.toast'), 'on')));

  await page.goto('http://localhost:4818/admin');
  await page.waitForTimeout(1200);
  const app = page.frames().find((f) => f.url().includes('127.0.0.1:4819'));
  await note(sw, page, app.locator('#create-quiz'), 'Primary button.', { offset: 12 });
  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(600);
  const row = await app.locator('.quiz-row__name').first().boundingBox();
  await page.mouse.click(row.x + 22, row.y + 17); // focus moves into the iframe
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check('Esc with focus in an iframe closes the panel', !(await hasClass(ui(page, '.sheet'), 'on')));
  check('…and the dock with it', !(await dock()));
  await toggle(sw, page);
  await page.keyboard.press('Escape'); // cancelled capture: the dock is back
  await page.waitForTimeout(400);
  await page.mouse.click(row.x + 22, row.y + 17);
  await page.waitForTimeout(200);
  const back = await dock();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check('with the dock back, Esc in the iframe hides the session', back && !(await dock()));
}, { width: 1440, height: 900 });
