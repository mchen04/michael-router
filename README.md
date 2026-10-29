# Michael Router

Michael Router is a password-protected gateway that speaks the OpenAI Chat Completions API and
forwards each request to Claude (Anthropic Messages API), Gemini, OpenRouter or OpenAI, chosen by the
request's `model` name. It runs as one Vercel function, keeps its state (stored key overrides,
usage counters, the wrong-password limiter and recent errors) in a PostgreSQL database (schema
`michael_router`), records usage and cost per provider and model, and comes with a command-line
client, `mrouter`.

## Routing

The first matching rule wins:

| `model` | Provider |
|---------|----------|
| contains `/` (for example `openrouter/free`) | OpenRouter, name forwarded unchanged |
| starts with `claude-` | Claude, translated to the Anthropic Messages API |
| starts with `gemini-` | Gemini, through its OpenAI-compatible endpoint |
| starts with `gpt-` or matches `^o\d` | OpenAI Chat Completions |
| anything else | refused: 400 `model_not_routable` |

OpenRouter accepts only names ending in `:free` and `openrouter/free`.
Paid models, model fallbacks, routing overrides, presets and plugins return 400 before any upstream call.
The router also sets a zero-price provider guard.

Each provider supports an optional fallback environment key ending in `_API_KEY_2`.
The router retries billing or exhausted-credit errors once, before sending any response bytes.
Plain rate limits do not trigger retries.
Usage records count requests by key slot without storing keys.

## Requirements

- Node.js 24
- a Vercel project
- PostgreSQL for the store: Neon in production, PostgreSQL 14 or later (the tests run on 18); the
  router refuses protected requests without one, and `scripts/migrate.mjs` creates its schema
  (`docs/DEPLOY.md` step 3)
- API keys for the providers you use: Anthropic, Gemini, OpenRouter, OpenAI

## Documentation

- `docs/API.md`: the HTTP API, routing, the Claude translation, streaming, usage and cost, errors and client setup.
- `docs/CLI.md`: the `mrouter` command-line client.
- `docs/DEPLOY.md`: the deployment runbook.
- `docs/SECURITY.md`: the threat model and what the router does and does not protect against.
- `docs/DESIGN.md`: the design and interfaces.
- `docs/BENCHMARKS.md`: how latency is measured, and the results.

## Development

```sh
npm install
npm run check              # syntax-check every script and parse the JSON configs
npm test                   # all tests; fake providers and a task-local PostgreSQL, no network or real credentials
npm run test:unit          # one group: test:unit, test:integration, test:cli or test:scripts
npm run dev                # the local server; configuration from the environment (docs/API.md §10)
npm run scan               # secret scan of the working tree and the git history
```

The store tests start their own PostgreSQL server per test file on a unix socket and delete it
afterwards. They need the PostgreSQL server binaries (`initdb`, `postgres`) on `PATH`, or
`PG_BIN` set to the directory that holds them. The cluster lives in a private `mr-pg-*`
directory under the system temp directory (`TMPDIR`), and so does its socket. A long `TMPDIR`
puts the socket path over the unix socket limit (104 bytes); then set `MR_TEST_SOCKET_ROOT` to
a short directory you own (an absolute path, not under `/tmp`, `/private/tmp` or `/var/tmp`),
and the socket gets its own private `mr-pg-*` directory there. Without it those tests fail with
an error that says so. There is no fallback: nothing goes to `/tmp` unless `TMPDIR` points there.

`tools/render-landing.mjs` renders the landing page in `public/` with headless Chromium at
phone, tablet and desktop sizes in light and dark mode. It writes screenshots and a
`summary.json` of layout checks, and exits 1 on horizontal overflow, tap targets under 44 px,
console errors, failed requests or requests to other origins. playwright-core is not a
dependency of this repository: set `PLAYWRIGHT_CORE_PATH` to a directory that contains
`node_modules/playwright-core`. Write the output under the gitignored `evidence/` directory:

```sh
PLAYWRIGHT_CORE_PATH=<dir> node tools/render-landing.mjs --out evidence/landing
```

## Secrets

The access password exists only as a Vercel sensitive environment variable
(`ROUTER_PASSWORD_HASH`, a scrypt hash, or `ROUTER_PASSWORD`), never in the repository. Provider
keys come from environment variables or are stored encrypted on the router, and are never
accepted as command arguments or written to logs.
