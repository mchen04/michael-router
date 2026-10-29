import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { routeModel } from '../../src/routing.js';

const PUBLIC = new URL('../../public/', import.meta.url);
const publicFiles = readdirSync(PUBLIC, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name));
const pages = publicFiles.filter((file) => file.endsWith('.html'))
  .map((file) => ({ file, html: readFileSync(file, 'utf8') }));
const decode = (value) => value.replace(/&(lt|gt|amp|quot|apos|#39|#x27);/g, (_, entity) =>
  ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'", '#x27': "'" })[entity]);
const text = (value) => decode(value.replace(/<[^>]+>/g, '')).trim();
const snippets = (html) => [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)].map((match) => text(match[1]));
const modelsIn = (code) => [...code.matchAll(/["']?model["']?\s*[:=]\s*["']([^"']+)["']/g)].map((match) => match[1]);

function assertLocalReference(reference, file) {
  const origin = 'https://public.test';
  const base = new URL(path.relative(new URL('.', PUBLIC).pathname, file), `${origin}/`);
  const url = new URL(decode(reference), base);
  assert.equal(url.origin, origin, `${file}: external resource ${reference}`);
  let target = new URL(`.${url.pathname}`, PUBLIC);
  assert.ok(existsSync(target), `${file}: missing file ${reference}`);
  if (statSync(target).isDirectory()) target = new URL('index.html', target.href.endsWith('/') ? target : `${target.href}/`);
  assert.ok(statSync(target).isFile(), `${file}: missing file ${reference}`);
  if (url.hash) {
    const targetHtml = readFileSync(target, 'utf8');
    assert.ok(targetHtml.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${file}: missing anchor ${reference}`);
  }
}

test('public pages use local assets, valid links, and no inline script or style', () => {
  assert.ok(pages.some(({ file }) => file.endsWith('/index.html')));
  for (const expected of ['docs/api.html', 'docs/providers.html']) assert.ok(pages.some(({ file }) => file.endsWith(expected)), expected);
  for (const { file, html } of pages) {
    assert.doesNotMatch(html, /<style[\s>]/i, file);
    for (const [tag] of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
      for (const [, name] of tag.matchAll(/\s([a-z][a-z0-9-]*)\s*=/gi)) {
        assert.ok(name.toLowerCase() !== 'style' && !/^on/i.test(name), `${file}: ${name}`);
      }
    }
    for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(attrs, /\ssrc=["'][^"']+["']/, file);
      assert.equal(body.trim(), '', file);
    }
    for (const [tag, name, reference] of [...html.matchAll(/(<[^>]+?\s)(src|href)=["']([^"']+)["']/g)].map((match) => [match[1], match[2], match[3]])) {
      if (name === 'href' && /^<a\s/i.test(tag) && /^https:\/\//i.test(reference)) {
        assert.ok(reference.startsWith('https://openrouter.ai/models?max_price=0'), `${file}: unexpected external navigation`);
      } else assertLocalReference(reference, file);
    }
    const favicon = html.match(/<link\b[^>]*rel=["']icon["'][^>]*href=["']([^"']+)["']/i);
    assert.ok(favicon, `${file}: favicon link`);
    assertLocalReference(favicon[1], file);
    assert.match(html, /<html lang="en">/, file);
    assert.match(html, /<meta name="robots" content="noindex">/, file);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, file);
    assert.match(html, /<title>[^<]+<\/title>/, file);
    assert.match(html, /<meta name="description" content="[^"]+">/, file);
  }
  const home = pages.find(({ file }) => file.endsWith('/index.html')).html;
  for (const reference of ['/docs/api.html', '/docs/providers.html', '/AGENTS.md', '/llms.txt']) assert.ok(home.includes(`href="${reference}"`), reference);
  assert.ok(publicFiles.reduce((bytes, file) => bytes + statSync(file).size, 0) <= 150 * 1024);
});

test('public routing examples and model catalogs match all four providers', () => {
  for (const { file, html } of pages) {
    for (const code of snippets(html)) for (const model of modelsIn(code)) assert.doesNotThrow(() => routeModel(model), `${file}: executable example ${model}`);
    for (const match of html.matchAll(/<code>([a-z][a-z0-9._-]*\/[a-z0-9._:/@+-]+)<\/code>/gi)) {
      const model = match[1];
      if (model === 'text/event-stream' || model === 'application/json') continue;
      if (model === 'openrouter/free' || model.endsWith(':free')) continue;
      assert.throws(() => routeModel(model), { code: 'model_not_allowed' });
      const context = html.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120);
      assert.match(text(context), /refus|not allowed|reject/i, `${file}: paid model must be labeled refused`);
    }
    const sections = [...html.matchAll(/<section\b[^>]*class="[^"]*\bprovider\b[^"]*"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
    if (!file.endsWith('/index.html') && !file.endsWith('/providers.html')) continue;
    assert.deepEqual(sections.map((match) => match[1]).sort(), ['claude', 'gemini', 'openai', 'openrouter'], file);
    for (const [, provider, section] of sections) {
      const examples = snippets(section);
      assert.equal(examples.length, 3, `${file}: ${provider} needs curl, Python, and JavaScript`);
      for (const code of examples) {
        const models = modelsIn(code);
        assert.equal(models.length, 1, `${file}: ${provider} example needs a model`);
        assert.equal(routeModel(models[0]).provider, provider, `${file}: ${models[0]}`);
      }
      for (const [, item] of section.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
        const candidate = text(item.match(/<code>([^<]+)<\/code>/)?.[1] ?? '');
        if (!candidate) continue;
        if (candidate.includes('/') && candidate !== 'openrouter/free' && !candidate.endsWith(':free')) {
          assert.throws(() => routeModel(candidate), { code: 'model_not_allowed' });
          assert.match(text(item), /refus|not allowed|reject/i, `${file}: paid model must be labeled refused`);
        } else assert.equal(routeModel(candidate).provider, provider, `${file}: catalog ${candidate}`);
      }
    }
    if (file.endsWith('/providers.html')) {
      assert.ok([...html.matchAll(/<li><code>/g)].length >= 38, 'full model catalog');
      assert.match(html, /https:\/\/openrouter.ai\/models\?max_price=0/);
    }
  }
  assert.throws(() => routeModel('vendor/paid-model'), { code: 'model_not_allowed' });
});

test('public site contains no owner CLI, control routes, or literal passwords', () => {
  for (const file of publicFiles) {
    const source = decode(readFileSync(file, 'utf8'));
    assert.doesNotMatch(source, /\bmrouter\b|\/control\b|mrouter\.tgz/i, file);
    for (const [, value] of source.matchAll(/\b(?:OPENAI_API_KEY|MROUTER_PASSWORD|ROUTER_PASSWORD)\s*=\s*["']?([^\s"'\n;]+)/g)) {
      assert.ok(value === '<password>' || value.startsWith('$'), `${file}: literal password assignment`);
    }
    for (const [, value] of source.matchAll(/\b(?:api_key|apiKey|password)["']?\s*[:=]\s*["']([^"']+)["']/g)) {
      assert.equal(value, '<password>', `${file}: literal SDK password`);
    }
    for (const [, value] of source.matchAll(/Authorization:\s*Bearer\s+([^\s"'<>]+)/gi)) {
      assert.ok(value.startsWith('$') || value.startsWith('%s'), `${file}: literal bearer password`);
    }
  }
  assert.ok(!publicFiles.some((file) => /\/docs\/cli(?:\.html|\/)/i.test(file)));
  const home = text(pages.find(({ file }) => file.endsWith('/index.html')).html);
  assert.match(home, /OPENAI_BASE_URL=https:\/\/michael-router\.vercel\.app\/v1/);
  assert.match(home, /OPENAI_API_KEY=['"]<password>['"]/);
});

test('curl examples keep passwords out of process arguments', () => {
  const sources = pages.map(({ file, html }) => [file, snippets(html).join('\n')]);
  const root = new URL('../../', import.meta.url);
  for (const file of ['README.md', ...readdirSync(new URL('docs/', root)).filter((file) => file.endsWith('.md')).map((file) => `docs/${file}`)]) {
    sources.push([file, readFileSync(new URL(file, root), 'utf8')]);
  }
  for (const [file, source] of sources) {
    const curls = source.replace(/\\\n/g, ' ').replace(/\|[ \t]*\n/g, '| ').split('\n')
      .flatMap((line) => line.split(/&&|\|\||[|;]/)).map((command) => command.trim()).filter((command) => /^curl\s/.test(command));
    for (const command of curls) assert.doesNotMatch(command, /\$\{?(?:\w*PASSWORD|OPENAI_API_KEY)\b/i, file);
    if (file.endsWith('.html')) {
      assert.ok(curls.length, `${file}: curl example`);
      for (const command of curls) assert.match(command, /\s-H @-\s/, `${file}: header must come from stdin`);
    }
  }
});
