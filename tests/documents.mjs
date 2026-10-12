// Pages that aren't HTML (an SVG or XML file in a tab or an iframe) can't host
// Redline's UI. It stays out of them quietly instead of throwing.
import { run, check, toggle, note, scriptErrors } from './harness.mjs';

await run('Non-HTML documents', async ({ context, sw, page }) => {
  const errors = await scriptErrors(context, page);
  await page.goto('http://localhost:4818/');
  await page.waitForTimeout(600);
  await note(sw, page, page.locator('h1').first(), 'A note, so every page shows the dock.');

  for (const file of ['pic.svg', 'feed.xml']) {
    await page.goto(`http://localhost:4818/${file}`);
    await page.waitForTimeout(800);
    check(`opening ${file} with notes in the session throws nothing`, !errors.length, errors.join(' | '));
    errors.length = 0;
  }

  await page.goto('http://localhost:4818/svg-frame.html');
  await page.waitForTimeout(800);
  await toggle(sw, page); // tells every frame, the SVG one included, to start picking
  await page.mouse.move(200, 60, { steps: 3 });
  await page.waitForTimeout(300);
  check('picking starts on a page with an SVG iframe without errors', !errors.length, errors.join(' | '));
  check('…and still picks the page around it', await page.locator('redline-ui').evaluate((h) => h.shadowRoot.querySelector('.hl').classList.contains('on')));
  await page.keyboard.press('Escape');
});
