// Runs every suite, one fresh browser each. `npm test` (after `npm install`).
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  ['capture.mjs'],
  ['pages.mjs'],
  ['iframes.mjs'],
  ['drag-frames.mjs'],
  ['history.mjs'],
  ['panel-sync.mjs'],
  ['paste-anywhere.mjs'],
  ['esc-hide.mjs'],
  ['esc-after-buttons.mjs'],
  ['iframe-focus.mjs'],
  ['esc-hostile.mjs', 'page'],
  ['esc-hostile.mjs', 'early'],
  ['esc-hostile.mjs', 'bubble'],
];

let failed = 0;
for (const args of suites) {
  const r = spawnSync(process.execPath, args, { cwd: HERE, encoding: 'utf8' });
  process.stdout.write(r.stdout);
  if (r.status !== 0) {
    failed++;
    if (r.stderr) process.stdout.write(r.stderr);
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exitCode = failed ? 1 : 0;
