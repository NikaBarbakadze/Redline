// The notes panel is one panel across tabs: it follows you to the next tab and
// closing it anywhere (Esc or ×) closes it everywhere. The toolbar icon opens
// and closes it.
import { run, check, note, toggle, icon, ui, hasClass } from './harness.mjs';

await run('Panel follows you across tabs', async ({ context, sw, page: a }) => {
  const open = (p) => hasClass(ui(p, '.sheet'), 'on');
  await a.goto('http://localhost:4818/');
  await note(sw, a, a.locator('#cta'), 'Green CTA.');
  await ui(a, '.dock-notes').click();
  await a.waitForTimeout(600);

  const b = await context.newPage();
  await b.goto('http://localhost:4818/cart');
  await b.bringToFront();
  await b.waitForTimeout(800);
  check('the open panel follows you to another tab', await open(b));

  await b.keyboard.press('Escape');
  await b.waitForTimeout(500);
  check('Esc there closes it…', !(await open(b)));
  check('…and in the first tab too', !(await open(a)));

  await ui(b, '.dock-notes').click();
  await b.waitForTimeout(600);
  await a.bringToFront();
  await a.waitForTimeout(800);
  check('opened in the second tab, it is open back in the first', await open(a));

  await ui(a, '.seg [data-view=history]').click();
  await a.waitForTimeout(500);
  await b.bringToFront();
  await b.waitForTimeout(800);
  check('the History tab carries over', (await ui(b, '[data-ref=sheetTitle]').textContent()) === 'History');

  await ui(b, '.sheet [data-act=close]').click();
  await b.waitForTimeout(500);
  await a.bringToFront();
  await a.waitForTimeout(600);
  check('closing with × closes it everywhere', !(await open(a)) && !(await open(b)));

  await a.reload();
  await a.waitForTimeout(800);
  check('a closed panel stays closed on new pages', !(await open(a).catch(() => false)));

  const picking = () => hasClass(ui(a, '.hud'), 'on');
  await icon(sw, a);
  await a.waitForTimeout(500);
  check('the toolbar icon opens the notes panel', await open(a));
  check('…on Current, with the note', (await ui(a, '[data-ref=sheetTitle]').textContent()) === 'Notes' && (await ui(a, '[data-ref=list] > .card').count()) === 1);
  check('…without starting a capture', !(await picking()));
  await icon(sw, a);
  await a.waitForTimeout(500);
  check('clicking it again closes the panel', !(await open(a)));

  await toggle(sw, a);
  await a.mouse.move(400, 300);
  await a.waitForTimeout(200);
  const wasPicking = await picking();
  await icon(sw, a);
  await a.waitForTimeout(500);
  check('mid-capture, the icon stops picking and opens the panel', wasPicking && !(await picking()) && (await open(a)));
});
