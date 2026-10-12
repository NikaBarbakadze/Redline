// Area drags that cross an iframe edge, either way: the box follows the pointer
// over the whole tab (the top frame draws it), the iframe doesn't hover-highlight
// underneath it, and letting go anywhere captures the area.
import { run, check, toggle, ui } from './harness.mjs';

const appUI = (app, sel) => app.evaluate((s) => document.querySelector('redline-ui')?.shadowRoot.querySelector(s)?.className ?? '', sel);
const spotOf = (page) => ui(page, '.spot').evaluate((s) => ['left', 'top', 'width', 'height'].map((k) => Math.round(parseFloat(s.style[k]))));
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);

async function drag(page, from, to, mid) {
  await page.mouse.move(...from);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 12 });
  await page.waitForTimeout(150);
  await mid?.();
  await page.mouse.up();
  await page.waitForTimeout(900);
}

await run('Drags across iframe edges', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/admin');
  await page.waitForTimeout(1200);
  const app = page.frames().find((f) => f.url().includes('127.0.0.1:4819'));

  // Admin sidebar → into the app.
  await toggle(sw, page);
  await drag(page, [120, 150], [700, 500], async () => {
    check('outer → iframe: the box keeps following the pointer', (await ui(page, '[data-ref=rgSize]').textContent()) === '580 × 350', await ui(page, '[data-ref=rgSize]').textContent());
    check('outer → iframe: the iframe does not hover-highlight under the drag', !(await appUI(app, '.hl')).includes('on'), await appUI(app, '.hl'));
  });
  let spot = await spotOf(page);
  check('outer → iframe: letting go inside the iframe captures the area', near(spot, [120, 150, 580, 350]), spot.join(','));
  await page.keyboard.type('Outer to inner.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // Inside the app → up over the admin top bar.
  await toggle(sw, page);
  await drag(page, [900, 600], [150, 30], async () => {
    check('iframe → outer: the box is drawn over the whole tab', (await ui(page, '[data-ref=rgSize]').textContent()) === '750 × 570', await ui(page, '[data-ref=rgSize]').textContent());
    check('iframe → outer: the iframe draws no box of its own', !(await appUI(app, '.rg')).includes('on'), await appUI(app, '.rg'));
  });
  spot = await spotOf(page);
  check('iframe → outer: letting go outside the iframe captures the area', near(spot, [150, 30, 750, 570]), spot.join(','));
  await page.keyboard.type('Inner to outer.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // Out and back in again: still the iframe's own area, as before.
  await toggle(sw, page);
  await drag(page, [400, 300], [1000, 700]);
  spot = await spotOf(page);
  check('a drag inside the iframe still captures there', near(spot, [400, 300, 600, 400]), spot.join(','));
  await page.keyboard.type('Inside only.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // A tiny drag that crosses the edge and ends under 8px is no capture, and
  // leaves nothing behind.
  await toggle(sw, page);
  await drag(page, [258, 300], [266, 304]);
  check('a too-small cross-edge drag captures nothing', !(await ui(page, '.spot').evaluate((s) => s.classList.contains('on'))));
  await page.mouse.move(150, 300, { steps: 4 });
  await page.waitForTimeout(150);
  check('…and leaves no box behind', !(await ui(page, '.rg').evaluate((s) => s.classList.contains('on'))) && !(await appUI(app, '.rg')).includes('on'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await ui(page, '[data-act=copy] >> nth=0').click();
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  check('only the inside-only area is labelled as inside the iframe', (text.match(/Inside iframe:/g) ?? []).length === 1, text.split('\n').filter((l) => /^(## |Inside|Area)/.test(l)).join(' | '));
}, { width: 1440, height: 900 });
