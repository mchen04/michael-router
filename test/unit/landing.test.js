// The landing page (DESIGN §11): it loads only its own files, nothing in it needs what the
// vercel.json CSP forbids, and the routing examples, the CLI list and the repository it shows
// match the code and package.json. No curl example, on the page or in the docs, puts the
// password in curl's arguments, where any local user can read it in the process list.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS } from '../../cli/lib/commands.js';
import { routeModel } from '../../src/routing.js';

const PUBLIC = new URL('../../public/', import.meta.url);
const html = readFileSync(new URL('index.html', PUBLIC), 'utf8');
/** @param {string} s */
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
/** @param {string} start @param {string} end */
const block = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('the page references only its own files and needs no inline script or style', () => {
  assert.doesNotMatch(html, /<style[\s>]/i);
  for (const [tag] of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    for (const [, name] of tag.matchAll(/\s([a-z][a-z0-9-]*)=/gi)) assert.ok(name !== 'style' && !/^on/i.test(name), `${name}= in ${tag}`);
  }
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(attrs, /\ssrc="[^"]+"/);
    assert.equal(body, '');
  }
  for (const [, ref] of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
    if (ref.startsWith('#')) {
      assert.ok(html.includes(`id="${ref.slice(1)}"`), `anchor ${ref}`);
      continue;
    }
    assert.match(ref, /^[a-z0-9][\w.-]*$/i, `${ref} is a file of this site`);
    assert.ok(statSync(new URL(ref, PUBLIC)).isFile(), ref);
  }
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
  const files = readdirSync(PUBLIC, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
  const bytes = files.reduce((n, f) => n + statSync(path.join(f.parentPath, f.name)).size, 0);
  assert.ok(bytes <= 150 * 1024, `public/ is ${bytes} bytes`);
});

test('routing examples go where the page says, and the CLI list is the mrouter command list', () => {
  const rows = block('<ol class="routes">', '</ol>')
    .split('data-provider="')
    .slice(1)
    .map((row) => ({ provider: row.slice(0, row.indexOf('"')), models: [...row.matchAll(/<code class="model">([^<]+)<\/code>/g)].map((m) => m[1]) }));
  assert.deepEqual(rows.map((r) => r.provider), ['openrouter', 'claude', 'gemini', 'openai', 'none']);
  for (const { provider, models } of rows) {
    assert.ok(models.length, provider);
    for (const model of models) {
      if (provider === 'none') assert.throws(() => routeModel(model), { code: 'model_not_routable' }, model);
      else assert.equal(routeModel(model).provider, provider, model);
    }
  }

  const listed = [...block('<dl class="commands">', '</dl>').matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [text(m[1]), text(m[2])]);
  const expected = Object.values(COMMANDS).flatMap((cmd) =>
    (cmd.subcommands ? Object.values(cmd.subcommands) : [cmd]).map((c) => [c.synopsis ?? c.usage.split(' [')[0], c.summary]),
  );
  assert.deepEqual(listed, expected);
});

test('the Install row and docs/CLI.md name the repository that package.json points to', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const repo = pkg.repository.url.replace(/^git\+https:\/\//, '').replace(/\.git$/, '');
  assert.equal(repo, 'github.com/mchen04/michael-router');
  assert.ok(block('<dt>Install</dt>', '</div>').includes(`<code>${repo}</code>`));
  assert.ok(readFileSync(new URL('../../docs/CLI.md', import.meta.url), 'utf8').includes(`https://${repo}.git`));
});

test('no curl example on the page or in the docs puts the expanded password in curl arguments', () => {
  const root = new URL('../../', import.meta.url);
  /** @type {Record<string, string>} */
  const sources = { 'public/index.html': [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => text(m[1])).join('\n') };
  for (const file of ['README.md', ...readdirSync(new URL('docs/', root)).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]) {
    sources[file] = readFileSync(new URL(file, root), 'utf8');
  }
  // One shell command per line once continuation lines are joined; each pipeline stage stands alone.
  const curls = Object.entries(sources).flatMap(([file, s]) =>
    s
      .replace(/\\\n/g, ' ')
      .replace(/\|[ \t]*\n/g, '| ')
      .split('\n')
      .flatMap((line) => line.split(/&&|\|\||[|;]/))
      .map((cmd) => cmd.trim())
      .filter((cmd) => /^curl\s/.test(cmd))
      .map((cmd) => ({ file, cmd })),
  );
  for (const { file, cmd } of curls) assert.doesNotMatch(cmd, /\$\{?\w*password/i, `${file}: ${cmd}`);
  for (const file of ['public/index.html', 'docs/API.md']) {
    assert.ok(curls.some((c) => c.file === file && /\s-H @-\s/.test(c.cmd)), `${file} has a curl example that reads the header from stdin`);
  }
});
