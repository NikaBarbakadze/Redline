// Copy files the session into History; numbering restarts; re-copy, Continue,
// Keep adding, New session + undo, delete + undo, Esc navigation.
import { run, check, note, ui, badge, clip, hasClass } from './harness.mjs';

const folderOf = (t) => t.match(/Redline\/([^/]+)\//)?.[1];
const notes = (t) => (t.match(/^## \d+/gm) ?? []).length;

await run('History', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/');
  const num = () => ui(page, '[data-ref=cmpNum]').textContent();
  await note(sw, page, page.locator('#cta'), 'CTA should be green.');
  await note(sw, page, page.locator('.hero__title'), 'Headline in caps.');
  await ui(page, '.dock .btn.primary').click();
  await page.waitForTimeout(1500);
  const first = await clip(page);
  check('copy: two notes', notes(first) === 2);
  check('copy files the session away', (await badge(sw)) === '' && !(await hasClass(ui(page, '.dock'), 'on')));

  await note(sw, page, page.locator('.product-card__title'), 'Card titles feel heavy.');
  check('the next note starts a fresh session', (await badge(sw)) === '1');

  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(600);
  await ui(page, '.seg [data-view=history]').click();
  await page.waitForTimeout(700);
  check('History lists the copied session', (await ui(page, '.row').count()) === 1 && (await ui(page, '.row .row-meta').textContent()).includes('2 notes'));
  await ui(page, '.row').click();
  await page.waitForTimeout(700);
  check('a session opens with its notes', (await ui(page, '[data-ref=entryList] .card').count()) === 2);

  await ui(page, '[data-ref=footEntry] .btn.primary').click();
  await page.waitForTimeout(1500);
  const again = await clip(page);
  check('re-copy uses the same files', notes(again) === 2 && folderOf(again) === folderOf(first));
  check('re-copy leaves the current session alone', (await badge(sw)) === '1');
  check('copying closes the panel', !(await hasClass(ui(page, '.sheet'), 'on')));

  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(600);
  await ui(page, '.seg [data-view=history]').click();
  await page.waitForTimeout(600);
  await ui(page, '.row:has-text("2 notes")').click();
  await page.waitForTimeout(600);
  await ui(page, '[data-ref=footEntry] .btn.ghost').click(); // Continue
  await page.waitForTimeout(800);
  check('Continue makes it current', (await ui(page, '[data-ref=list] .card').count()) === 2 && (await badge(sw)) === '2');
  await ui(page, '.seg [data-view=history]').click();
  await page.waitForTimeout(600);
  check('…and sets the other session aside', (await ui(page, '.row .row-meta').textContent()).includes('Not copied'));
  await ui(page, '.sheet [data-act=close]').click();
  await page.waitForTimeout(300);

  await note(sw, page, page.locator('.product-card__title').nth(2), 'Spring card: add badge.');
  await ui(page, '.dock .btn.primary').click();
  await page.waitForTimeout(1500);
  const third = await clip(page);
  check('a continued session keeps numbering and files', notes(third) === 3 && folderOf(third) === folderOf(first));

  await ui(page, '.toast button:has-text("Keep adding")').click();
  await page.waitForTimeout(600);
  check('Keep adding reopens it', (await badge(sw)) === '3');

  await ui(page, '.dock-notes').click();
  await page.waitForTimeout(600);
  await ui(page, '[data-ref=footCurrent] .btn.ghost').click(); // New session
  await page.waitForTimeout(600);
  check('New session files it into History', (await badge(sw)) === '' && (await ui(page, '[data-ref=last]').isVisible()));
  await ui(page, '.toast .t-acts button').click(); // Undo
  await page.waitForTimeout(600);
  check('…with undo', (await badge(sw)) === '3');

  await ui(page, '.seg [data-view=history]').click();
  await page.waitForTimeout(600);
  await ui(page, '.row').first().click();
  await page.waitForTimeout(600);
  await ui(page, '[data-ref=entryDelete]').click();
  await page.waitForTimeout(600);
  const afterDelete = await ui(page, '.row').count();
  await ui(page, '.toast .t-acts button').click();
  await page.waitForTimeout(600);
  check('delete from History, with undo', afterDelete === 0 && (await ui(page, '.row').count()) === 1);

  await ui(page, '.row').first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc in a session goes back to the list', (await ui(page, '[data-ref=sheetTitle]').textContent()) === 'History');
});
