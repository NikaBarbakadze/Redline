// A clicked Redline button used to keep focus after its panel hid, so Esc died
// until you clicked the page.
import { run, check, toggle, pick, ui, hasClass } from './harness.mjs';

await run('Esc after clicking Redline buttons', async ({ sw, page }) => {
  const dock = () => hasClass(ui(page, '.dock'), 'on');
  const reveal = async () => {
    await toggle(sw, page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  };
  await page.goto('http://localhost:4818/');
  await toggle(sw, page);
  await pick(page, page.locator('#cta'));
  await page.keyboard.type('Green.');
  await ui(page, '[data-act=save]').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('after clicking Save', !(await dock()));

  await reveal();
  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(600);
  await ui(page, '.sheet [data-act=close]').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('after closing the panel with ×', !(await dock()));

  await reveal();
  await toggle(sw, page);
  await ui(page, '.hud .x').click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('after cancelling capture with the hint bar’s ×', !(await dock()));

  await reveal();
  await ui(page, '.dock [data-act=capture]').click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc cancels a capture started from the dock', !(await hasClass(ui(page, '.hud'), 'on')));
});
