// Shows the capture shortcut as it's actually bound (it can be unset if another
// extension already claimed it).
const keys = document.getElementById('keys');
const label = document.getElementById('shortcut-label');
const inline = document.getElementById('inline-keys');

function split(shortcut) {
  return shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
}

async function showShortcut() {
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'capture');
  const shortcut = cmd?.shortcut ?? '';
  keys.replaceChildren(
    ...split(shortcut).map((k) => Object.assign(document.createElement('kbd'), { textContent: k })),
  );
  label.textContent = shortcut ? 'Capture anywhere with' : 'No shortcut set yet.';
  label.classList.toggle('missing', !shortcut);
  inline.textContent = shortcut || 'the toolbar icon';
}

document.getElementById('change').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
addEventListener('focus', showShortcut);
showShortcut();
