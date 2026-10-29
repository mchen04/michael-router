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

const testedModels = {
  claude: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  openai: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'o3'],
  gemini: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  openrouter: ['openrouter/free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3.5-lightning:free', 'poolside/laguna-s-2.1:free', 'cohere/north-mini-code:free'],
};
const recommendedModels = { claude: 'claude-opus-5-5', openai: 'gpt-6.1-sol', gemini: 'gemini-3.5-flash-lite', openrouter: 'openrouter/free' };

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
    for (const code of snippets(html)) for (const model of modelsIn(code)) {
      const provider = routeModel(model).provider;
      assert.ok(testedModels[provider].includes(model), `${file}: untested example ${model}`);
    }
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
      const isLanding = file.endsWith('/index.html');
      assert.equal(examples.length, isLanding ? 1 : 0, `${file}: one request per provider only on the landing page`);
      assert.ok(section.includes(`Recommended default: <code>${recommendedModels[provider]}</code>`), `${provider}: recommended default`);
      for (const code of examples) {
        const models = modelsIn(code);
        assert.equal(models.length, 1, `${file}: ${provider} example needs a model`);
        assert.equal(routeModel(models[0]).provider, provider, `${file}: ${models[0]}`);
        assert.equal(models[0], recommendedModels[provider], `${file}: use the recommended default`);
      }
      if (!isLanding) {
        const listed = [...section.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((match) => match[1]);
        assert.deepEqual(listed, testedModels[provider], `${provider}: exact tested catalog`);
        for (const model of listed) assert.equal(routeModel(model).provider, provider, model);
      }
    }
    if (file.endsWith('/providers.html')) {
      assert.match(html, /Tested 2026-10-29/);
      assert.match(html, /https:\/\/openrouter.ai\/models\?max_price=0/);
    }
  }
  assert.throws(() => routeModel('vendor/paid-model'), { code: 'model_not_allowed' });
});

test('public site contains no owner CLI, control routes, or literal passwords', () => {
  for (const file of publicFiles) {
    const source = decode(readFileSync(file, 'utf8'));
    assert.doesNotMatch(source, /\bmrouter\b|\/control\b|mrouter\.tgz|\bdatabase\b/i, file);
    assert.doesNotMatch(source, /o4-mini|gemini-4-argon|gemini-3\.8-flash|gemini-3\.1-pro-preview|gemini-2\.5-pro|gemini-2\.5-flash|google\/gemma-|thinkingmachines\/inkling/i, file);
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
    if (file.endsWith('/index.html')) {
      assert.ok(curls.length, `${file}: curl example`);
      for (const command of curls) assert.match(command, /\s-H @-\s/, `${file}: header must come from stdin`);
    }
  }
});

test('public guides explain the medium effort default and how to change it', () => {
  for (const file of ['index.html', 'docs/providers.html', 'docs/api.html', 'AGENTS.md', 'llms.txt']) {
    const source = text(readFileSync(new URL(file, PUBLIC), 'utf8'));
    assert.match(source, /Effort defaults to medium/, file);
    assert.match(source, /"reasoning_effort": "low" \| "medium" \| "high"/, file);
    assert.match(source, /higher costs more/, file);
  }
  for (const file of ['AGENTS.md', 'llms.txt']) {
    const source = readFileSync(new URL(file, PUBLIC), 'utf8');
    for (const model of Object.values(recommendedModels)) assert.ok(source.includes(model), file);
  }
});
