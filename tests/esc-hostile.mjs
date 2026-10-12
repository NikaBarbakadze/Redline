// Pages (and other extensions) that swallow Esc. Redline's key listener is
// registered at document_start, and falls back to keyup if something earlier
// still eats the keydown. Usage: node esc-hostile.mjs page|early|bubble
import { run, check, toggle, pick, ui, hasClass } from './harness.mjs';

const variant = process.argv[2] ?? 'page';
const SWALLOW = {
  page: () => addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), e.stopImmediatePropagation()), true),
  early: () => addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), e.stopImmediatePropagation()), true),
  bubble: () => document.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()),
};

await run(`Esc on a page that swallows it (${variant})`, async ({ context, sw, page }) => {
  if (variant === 'early') await context.addInitScript(SWALLOW.early); // before Redline, like another extension
  await page.goto('http://localhost:4818/');
  if (variant !== 'early') await page.evaluate(SWALLOW[variant]);
  const on = (sel) => hasClass(ui(page, sel), 'on');
  const capture = async () => {
    await toggle(sw, page);
    await pick(page, page.locator('#cta'));
  };

  await toggle(sw, page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('cancels a capture', !(await on('.hud')));

  await capture();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('closes an empty composer', !(await on('.cmp')));

  await capture();
  await page.keyboard.type('Green');
  await ui(page, '[data-act=save]').click();
  await page.waitForTimeout(400);
  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('closes the panel', !(await on('.sheet')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('hides the dock', !(await on('.dock')));

  await capture();
  await page.keyboard.type('Typed text');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const armed = await on('.cmp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('with text: first Esc arms, second discards', armed && !(await on('.cmp')));
});
