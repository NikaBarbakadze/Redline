// Renders the toolbar/store icons (16, 32, 48, 128) into ../icons.
// Run from tests/ (which has playwright-core): npm run icons
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', 'tests', 'package.json'));
const { chromium } = require('playwright-core');
const out = path.join(HERE, '..', 'icons');

// size-aware: small sizes get heavier strokes so the mark survives
function svg(size) {
  const sw = size <= 16 ? 13 : size <= 32 ? 11 : 9;   // corner stroke (in 128 units)
  const red = size <= 16 ? 15 : size <= 32 ? 13 : 11;  // red bar thickness
  const inset = size <= 32 ? 26 : 30;
  const len = size <= 32 ? 22 : 20;
  const a = inset, b = 128 - inset, r = 9;
  const corner = (x, y, dx, dy) =>
    `M${x} ${y + dy * len} V${y + dy * r} Q${x} ${y} ${x + dx * r} ${y} H${x + dx * len}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a3e"/><stop offset="1" stop-color="#1c1c1f"/></linearGradient>
    <linearGradient id="rr" gradientUnits="userSpaceOnUse" x1="44" y1="0" x2="84" y2="0"><stop offset="0" stop-color="#ff5a4f"/><stop offset="1" stop-color="#ff2d55"/></linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
  <rect x="4.5" y="4.5" width="119" height="119" rx="27.5" fill="none" stroke="rgba(255,255,255,.14)"/>
  <g fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${corner(a, a, 1, 1)}"/>
    <path d="${corner(b, a, -1, 1)}"/>
    <path d="${corner(a, b, 1, -1)}"/>
    <path d="${corner(b, b, -1, -1)}"/>
  </g>
  <line x1="${size <= 32 ? 44 : 46}" y1="64" x2="${size <= 32 ? 84 : 82}" y2="64" stroke="url(#rr)" stroke-width="${red}" stroke-linecap="round"/>
</svg>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size)}`);
  await page.locator('svg').screenshot({ path: `${out}/${size}.png`, omitBackground: true });
}
await browser.close();
