// `npm run check`: syntax-check every .js/.mjs file with `node --check` and parse the JSON configs.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skip = new Set(['node_modules', 'evidence', 'coverage', 'out', 'tmp']);
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.m?js$/.test(e.name)) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files.sort()) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
for (const name of ['package.json', 'vercel.json', 'src/pricing.json']) {
  try {
    JSON.parse(readFileSync(path.join(root, name), 'utf8'));
  } catch (err) {
    console.error(`${name}: ${err.message}`);
    failed++;
  }
}
console.log(`check: ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
