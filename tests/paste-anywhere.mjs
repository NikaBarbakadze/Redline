// Copy notes → paste into web chats: screenshots come along when the page takes
// images (via paste or its upload input); plain boxes, Paste and Match Style
// and unrelated clipboard text get plain text. Plus Show files and the
// per-screenshot copy button.
import { run, check, note, ui, hasClass, clip } from './harness.mjs';

await run('Paste anywhere', async ({ sw, page }) => {
  await page.goto('http://localhost:4818/');
  await note(sw, page, page.locator('#cta'), 'Make the CTA green.');
  await note(sw, page, page.locator('.hero__title'), 'Headline in caps.');
  check('the button says Copy notes', (await ui(page, '.dock .btn.primary .lbl').textContent()) === 'Copy notes');
  await ui(page, '.dock .btn.primary').click();
  await page.waitForTimeout(1500);
  const copied = await clip(page);
  check('the clipboard has the file-path prompt', /\/downloads\/Redline\/.+\/01\.png/i.test(copied));
  check('the toast offers Show files and Keep adding', (await ui(page, '.toast .t-acts button').allTextContents()).join('|') === 'Show files|Keep adding');
  await ui(page, '.toast .t-acts button >> nth=0').click();
  await page.waitForTimeout(800);
  check('Show files works', !(await hasClass(ui(page, '.toast'), 'error')));

  const pasteInto = async (url, sel, keys = ['Meta+V']) => {
    await page.goto(`http://localhost:4818/${url}`);
    await page.waitForTimeout(500);
    await page.click(sel);
    for (const k of keys) await page.keyboard.press(k);
    await page.waitForTimeout(1800);
    return page.evaluate((s) => ({ files: window.received ?? [], text: document.querySelector(s).value ?? document.querySelector(s).innerText }), sel);
  };

  let got = await pasteInto('chat-pm', '[contenteditable]');
  check('a chat that takes pasted images gets both screenshots', got.files.join(',') === 'redline-01.png,redline-02.png', got.files.join(','));
  check('…and notes worded for attachments', got.text.includes('attached image 2') && !/downloads\/Redline/i.test(got.text));

  // Headless has no Paste and Match Style command: send its keydown, then paste.
  got = await pasteInto('chat-pm', '[contenteditable]', ['Meta+Alt+Shift+V', 'Meta+V']);
  check('Paste and Match Style pastes just the text', got.files.length === 0 && /downloads\/Redline/i.test(got.text));

  got = await pasteInto('chat-input', '#msg');
  check('a chat with only an upload input gets the screenshots through it', got.files.length === 2 && got.text.includes('attached image 1'));

  got = await pasteInto('plain', '#msg');
  check('a plain text box gets the original text', got.text.trim() === copied.trim());

  await page.evaluate(() => navigator.clipboard.writeText('hello world'));
  got = await pasteInto('chat-pm', '[contenteditable]');
  check('other clipboard text is left alone', got.files.length === 0 && got.text.trim() === 'hello world');

  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4818/*' });
    await chrome.tabs.sendMessage(tab.id, { type: 'history', target: 'page' }, { frameId: 0 });
  });
  await page.waitForTimeout(700);
  await ui(page, '.row').first().click();
  await page.waitForTimeout(700);
  await ui(page, '[data-ref=entryList] .card >> nth=0').hover();
  await ui(page, '[data-ref=entryList] .card >> nth=0 >> [data-act=copyImage]').click();
  await page.waitForTimeout(800);
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
  check('a single screenshot can be copied as an image', types.includes('image/png'));
});
