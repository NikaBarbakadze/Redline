// Clipboard writer for the service worker, which has no DOM of its own.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'copy') return false;
  const buffer = document.getElementById('buffer');
  buffer.value = msg.text;
  buffer.select();
  sendResponse({ ok: document.execCommand('copy') });
  return false;
});
