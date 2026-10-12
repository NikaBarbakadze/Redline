// Capturing inside an iframe while typing in one of the app's fields: the
// composer takes the keyboard, and Esc cancels it even if focus is forced back.
import { run, check, toggle, pick, ui, hasClass } from './harness.mjs';

await run('Composer focus after an iframe capture', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/admin');
  await page.waitForTimeout(1200);
  const app = page.frames().find((f) => f.url().includes('127.0.0.1:4819'));
  await app.evaluate(() => {
    const input = Object.assign(document.createElement('input'), { id: 'quiz-name' });
    document.querySelector('.app-header').prepend(input);
    window.appEsc = 0;
    addEventListener('keydown', (e) => e.key === 'Escape' && window.appEsc++);
  });
  const field = await app.locator('#quiz-name').boundingBox();
  await page.mouse.click(field.x + 12 + 10, field.y + 12 + 8);
  await page.keyboard.type('Yarn');
  const composerOpen = () => hasClass(ui(page, '.cmp'), 'on');
  const capture = async () => {
    await toggle(sw, page);
    await pick(page, app.locator('#create-quiz'), { offset: 12 });
  };

  await capture();
  await page.keyboard.type('Bigger button');
  check('typing goes into the composer, not the app', (await ui(page, 'textarea[data-ref=input]').inputValue()) === 'Bigger button' && (await app.locator('#quiz-name').inputValue()) === 'Yarn');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc twice discards it; the app never sees Esc', !(await composerOpen()) && (await app.evaluate(() => window.appEsc)) === 0);

  await capture();
  await app.locator('#quiz-name').focus(); // focus stuck in the app
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc from the app field still cancels the composer', !(await composerOpen()) && (await app.evaluate(() => window.appEsc)) === 0);

  await app.locator('#quiz-name').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('with the composer closed, Esc is the app’s again', (await app.evaluate(() => window.appEsc)) === 1);
}, { width: 1440, height: 900 });
