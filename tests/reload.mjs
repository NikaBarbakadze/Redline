// After Redline is reloaded or updated, the copy still running in an open tab
// is orphaned. Its 1.2 s liveness timer is all that used to notice, and Chrome
// throttles or freezes timers in background tabs, so an orphan could live on
// for hours. The first event it gets (switching back to the tab fires
// visibilitychange) must shut it down instead of calling the dead extension.
import { run, check, note, scriptErrors } from './harness.mjs';

await run('Orphaned after a reload', async ({ context, sw, page }) => {
  await page.goto('http://localhost:4818/');
  await page.waitForTimeout(600);
  await note(sw, page, page.locator('h1').first(), 'A note, so the dock is up.');
  const errors = await scriptErrors(context, page);
  const dock = () => page.locator('redline-ui').evaluateAll((hosts) => hosts.filter((h) => h.shadowRoot?.querySelector('.dock.on')).length);
  check('the dock is up before the reload', (await dock()) === 1);

  // Tab switches every 20 ms, so some land between the reload and the timer.
  await page.evaluate(() => {
    const t = setInterval(() => document.dispatchEvent(new Event('visibilitychange')), 20);
    setTimeout(() => clearInterval(t), 3000);
  });
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await page.waitForTimeout(3300);
  check('the orphan never calls into the dead extension', !errors.some((e) => /context invalidated/i.test(e)), errors.join(' | '));
  check('…and takes its dock down', (await dock()) === 0);
});
