#!/usr/bin/env node
// Render the landing page (public/) with headless Chromium and record layout checks.
//   PLAYWRIGHT_CORE_PATH=<dir containing node_modules/playwright-core> node tools/render-landing.mjs --out DIR
// Serves public/ through dev/server.js (the same static headers as vercel.json) on 127.0.0.1 and
// launches its own headless Chromium, which it closes at the end; it never attaches to a running
// browser. Per viewport and colour scheme it writes a full-page PNG and a first-viewport PNG, and
// summary.json records horizontal overflow (documentElement.scrollWidth > innerWidth), transferred
// bytes, console errors, failed requests, requests to other origins (blocked), tap targets whose
// hit area is under 44 px, the smallest prose text size, whether the first routing rule fits in
// the first viewport, the offset between the section links' baseline and the title's when they
// share a line, the gaps between the section links when they sit on one line, plus the base URL
// text with and without JavaScript.
// Exits 1 when overflow, a tap target under 44 px, a console error, a failed request or an
// external request is found.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { startDevServer } from '../dev/server.js';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  { name: 'narrow', width: 360, height: 780, deviceScaleFactor: 2, mobile: true },
  { name: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
];
const SCHEMES = /** @type {const} */ (['light', 'dark']);

/** @param {string[]} argv */
function parseArgs(argv) {
  let out;
  for (let i = 0; i < argv.length; i++) {
    const m = /^--out(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument: ${argv[i]}`);
    out = m[1] ?? argv[++i];
  }
  if (!out) throw new Error('usage: node tools/render-landing.mjs --out DIR');
  return { out: path.resolve(out) };
}

function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_CORE_PATH;
  if (!dir) throw new Error('set PLAYWRIGHT_CORE_PATH to a directory containing node_modules/playwright-core');
  return createRequire(path.join(path.resolve(dir), 'index.js'))('playwright-core');
}

/** Runs in the page: overflow, tap targets and text sizes. */
function measure() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  /** @param {Element} el */
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
  /** @param {Element} el */
  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const overflowing = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 0.5 && !insideScroller(el)) overflowing.push(`${describe(el)} right=${Math.round(r.right)}`);
  }
  // A tap target's size is its hit area, found by hit-testing outwards from its centre in 1 px
  // steps, so a ::before that widens a short link counts and an overlapping neighbour does not.
  /** @param {Element} el @param {number} x @param {number} y */
  const hits = (el, x, y) => {
    const t = document.elementFromPoint(x, y);
    return t !== null && el.contains(t);
  };
  const scrollY = window.scrollY;
  const smallTargets = [];
  let smallestTarget = null;
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary')) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
    /** @param {number} dx @param {number} dy */
    const reach = (dx, dy) => {
      let n = 0;
      while (n < 100 && hits(el, cx + dx * (n + 1), cy + dy * (n + 1))) n++;
      return n;
    };
    const [w, h] = [reach(-1, 0) + reach(1, 0) + 1, reach(0, -1) + reach(0, 1) + 1];
    const target = `${describe(el)} "${el.textContent?.trim()}" ${w}x${h}`;
    if (w < 44 || h < 44) smallTargets.push(target);
    if (!smallestTarget || w * h < smallestTarget.area) smallestTarget = { area: w * h, target };
  }
  window.scrollTo(0, scrollY);
  /** @type {Record<string, number>} */
  const sizes = {};
  let minProse = Infinity;
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('.vh')) continue;
    const own = [...el.childNodes].map((n) => (n.nodeType === Node.TEXT_NODE ? (n.textContent ?? '') : '')).join('').trim();
    if (!own) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    const key = `${describe(el)} ${px}px`;
    sizes[key] = (sizes[key] ?? 0) + 1;
    // Prose: running text, not a legend, code or the CLI listing.
    if (own.length >= 30 && !el.closest('code, pre, figcaption, .commands')) minProse = Math.min(minProse, px);
  }
  /** @param {Element} el the y of el's text baseline, from a zero-size inline-block probe */
  const baseline = (el) => {
    const probe = document.createElement('span');
    probe.style.display = 'inline-block';
    el.append(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return y;
  };
  const h1 = document.querySelector('h1');
  const toc = document.querySelector('.toc');
  const tocNo = document.querySelector('.toc li:last-child .toc-no');
  const besideTitle = h1 && toc && tocNo && toc.getBoundingClientRect().top < h1.getBoundingClientRect().bottom;
  const rule = document.querySelector('.route')?.getBoundingClientRect();
  const links = [...document.querySelectorAll('.toc a')].map((a) => a.getBoundingClientRect());
  const oneLine = links.length > 1 && links.every((r) => Math.abs(r.top - links[0].top) < 1);
  const smallest = Object.entries(sizes)
    .map(([k, n]) => ({ element: k.slice(0, k.lastIndexOf(' ')), px: parseFloat(k.slice(k.lastIndexOf(' ') + 1)), count: n }))
    .sort((a, b) => a.px - b.px)
    .slice(0, 6);
  return {
    scrollWidth: doc.scrollWidth,
    innerWidth: window.innerWidth,
    horizontalOverflow: doc.scrollWidth > window.innerWidth,
    overflowingElements: overflowing.slice(0, 20),
    pageHeight: doc.scrollHeight,
    smallTapTargets: smallTargets,
    smallestTapTarget: smallestTarget?.target ?? null,
    minProseTextPx: minProse,
    smallestText: smallest,
    firstRule: rule ? { top: Math.round(rule.top), bottom: Math.round(rule.bottom), inFirstViewport: rule.bottom <= window.innerHeight } : null,
    titleNavBaselineDelta: besideTitle ? Math.round((baseline(tocNo) - baseline(h1)) * 10) / 10 : null,
    navLinkGaps: oneLine ? links.slice(1).map((r, i) => Math.round((r.left - links[i].right) * 10) / 10) : null,
    baseUrl: document.querySelector('.facts .url')?.textContent ?? null,
  };
}

/**
 * @param {any} browser @param {string} origin @param {string} outDir
 * @param {typeof VIEWPORTS[number]} vp @param {'light' | 'dark'} scheme @param {{javaScript?: boolean, suffix?: string, fullPage?: boolean}} [opts]
 */
async function render(browser, origin, outDir, vp, scheme, { javaScript = true, suffix = '', fullPage = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    colorScheme: scheme,
    javaScriptEnabled: javaScript,
    serviceWorkers: 'block',
  });
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const failedRequests = [];
  /** @type {string[]} */
  const externalRequests = [];
  /** @type {{path: string, type: string, status: number | null, bytes: number}[]} */
  const resources = [];
  /** @type {Promise<void>[]} */
  const pending = [];
  await context.route((/** @type {URL} */ url) => url.origin !== origin && url.protocol !== 'data:', (/** @type {any} */ route) => {
    externalRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  try {
    const page = await context.newPage();
    page.on('console', (/** @type {any} */ msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (/** @type {Error} */ err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (/** @type {any} */ req) => {
      if (!externalRequests.includes(req.url())) failedRequests.push(`${req.url()} ${req.failure()?.errorText ?? ''}`.trim());
    });
    page.on('requestfinished', (/** @type {any} */ req) => {
      pending.push(
        Promise.all([req.sizes(), req.response()]).then(([s, res]) => {
          resources.push({ path: new URL(req.url()).pathname, type: req.resourceType(), status: res?.status() ?? null, bytes: s.responseHeadersSize + s.responseBodySize });
        }),
      );
    });
    const response = await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await page.locator('body').evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
    await Promise.all(pending);
    const name = `${vp.name}-${scheme}${suffix}`;
    const shots = { firstViewport: `${name}-viewport.png`, full: fullPage ? `${name}-full.png` : null };
    await page.screenshot({ path: path.join(outDir, shots.firstViewport) });
    if (shots.full) await page.screenshot({ path: path.join(outDir, shots.full), fullPage: true });
    const metrics = javaScript ? await page.evaluate(measure) : { baseUrl: await page.locator('.facts .url').textContent() };
    return {
      viewport: vp.name,
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      scheme,
      javaScript,
      status: response?.status() ?? null,
      png: shots,
      ...metrics,
      transferredBytes: resources.reduce((n, r) => n + r.bytes, 0),
      resources: resources.sort((a, b) => a.path.localeCompare(b.path)),
      consoleErrors,
      failedRequests,
      externalRequests,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywright();
  await mkdir(out, { recursive: true });
  const dev = await startDevServer({ port: 0, handler: async () => new Response('Not found\n', { status: 404 }) });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb'] });
    const renders = [];
    for (const vp of VIEWPORTS) for (const scheme of SCHEMES) renders.push(await render(browser, dev.url, out, vp, scheme));
    const noJs = await render(browser, dev.url, out, VIEWPORTS[0], 'light', { javaScript: false, suffix: '-nojs', fullPage: false });
    const favicon = await fetch(`${dev.url}/favicon.svg`);
    const problems = [
      ...renders.filter((r) => r.horizontalOverflow).map((r) => `horizontal overflow: ${r.viewport} ${r.scheme}`),
      ...renders.flatMap((r) => r.smallTapTargets.map((t) => `tap target under 44 px (${r.viewport} ${r.scheme}): ${t}`)),
      ...[...renders, noJs].flatMap((r) => [
        ...(r.status === 200 ? [] : [`page status ${r.status}: ${r.viewport} ${r.scheme}`]),
        ...r.consoleErrors.map((e) => `console error (${r.viewport} ${r.scheme}): ${e}`),
        ...r.failedRequests.map((e) => `failed request (${r.viewport} ${r.scheme}): ${e}`),
        ...r.externalRequests.map((e) => `external request (${r.viewport} ${r.scheme}): ${e}`),
      ]),
      ...(favicon.ok ? [] : [`favicon status ${favicon.status}`]),
    ];
    const summary = {
      generated_at: new Date().toISOString(),
      chromium: browser.version(),
      origin: dev.url,
      ok: problems.length === 0,
      problems,
      horizontal_overflow: Object.fromEntries(renders.map((r) => [`${r.viewport}-${r.scheme}`, r.horizontalOverflow])),
      transferred_bytes: Math.max(...renders.map((r) => r.transferredBytes)),
      first_rule_in_first_viewport: Object.fromEntries(renders.map((r) => [`${r.viewport}-${r.scheme}`, r.firstRule?.inFirstViewport ?? null])),
      title_nav_baseline_delta_px: Object.fromEntries(renders.map((r) => [`${r.viewport}-${r.scheme}`, r.titleNavBaselineDelta])),
      nav_link_gaps_px: Object.fromEntries(renders.map((r) => [`${r.viewport}-${r.scheme}`, r.navLinkGaps])),
      console_errors: renders.reduce((n, r) => n + r.consoleErrors.length, noJs.consoleErrors.length),
      base_url: { with_javascript: renders[0].baseUrl, without_javascript: noJs.baseUrl },
      favicon: { status: favicon.status, content_type: favicon.headers.get('content-type'), bytes: (await favicon.arrayBuffer()).byteLength },
      renders,
      no_javascript: noJs,
    };
    await writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`rendered ${renders.length * 2 + 1} PNGs to ${out}; ${summary.transferred_bytes} bytes; ${problems.length} problems`);
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    await browser?.close();
    await dev.close();
  }
}

main().catch((err) => {
  console.error(`render-landing failed: ${err.message}`);
  process.exit(2);
});
