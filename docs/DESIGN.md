# Michael Router — design and interfaces

Status: v1 interfaces.

## 1. What it is

A private, password-protected, OpenAI-compatible HTTP gateway deployed on Vercel. A request's
`model` name selects one of three upstream providers, called with the deployment owner's
provider API keys:

| Provider id  | What it is                          | Upstream and protocol                                           |
|--------------|-------------------------------------|-----------------------------------------------------------------|
| `claude`     | Claude API (an Anthropic API key — never a Claude subscription) | native Messages API `POST https://api.anthropic.com/v1/messages` via the adapter in §5.5 |
| `gemini`     | Gemini API (Google AI Studio key)   | pass-through to `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` (`Authorization: Bearer`) |
| `openrouter` | OpenRouter                          | pass-through to `https://openrouter.ai/api/v1/chat/completions` (`Authorization: Bearer`) |

Why Claude is not a pass-through: Anthropic's own OpenAI-compatibility layer is documented as
"not considered a long-term or production-ready solution", silently ignores `response_format` and
`reasoning_effort`, does not support prompt caching and reports no cached tokens. A silent ignore
would turn a client's structured-output request into a successful-looking wrong answer, so the
Claude route translates OpenAI Chat Completions to the Messages API itself (raw `fetch`, no SDK,
to keep the function dependency-free and its cold start small).

Plus: a CLI (`mrouter`), a static informational landing page, a deterministic key-copy script
for Vercel, and benchmark tooling. There is no web login and no admin UI.

## 2. Stack

- Plain Vercel project, no framework. Node.js runtime (24.x), ESM JavaScript (`"type": "module"`),
  JSDoc types, two runtime dependencies: `@vercel/functions` (`waitUntil`, `attachDatabasePool`)
  and `pg` (node-postgres).
- One function, `api/router.js`, receives every API path via `vercel.json` rewrites, so all
  traffic shares one warm instance pool. Whether Vercel shows the function the original or the
  rewritten URL is not documented, so the rewrite carries the route explicitly:
  `/v1/:path*` → `/api/router?__route=v1/:path*` and `/control/:path*` →
  `/api/router?__route=control/:path*`. The handler uses `__route` when the pathname is
  `/api/router`, else the pathname (dev server). `supportsCancellation: true`, `maxDuration: 300`.
  Static landing page lives in `public/` (`"framework": null`, `outputDirectory: "public"`).
- Function region: `"regions": ["cle1"]` in `vercel.json`, next to the database (AWS us-east-2):
  every protected request makes at least one store round trip before it is answered
  (`DEPLOY.md` step 5.1).
- Durable store: PostgreSQL (Neon in production, through its pooled endpoint) over the wire
  protocol with `pg`, behind the domain interface in `src/store/contract.js`
  (`src/store/postgres.js`; `src/store/memory.js` implements the same interface for
  `ROUTER_STORE=memory` and in-process tests). Every router table lives in schema
  `michael_router`; nothing outside it is read for router state or changed.
  - Pool: `max` 5, idle clients closed after 10 s, `connectionTimeoutMillis` 5000 (covers a cold
    compute wake and waiting for a pool client), `application_name=michael-router`. On Vercel the
    pool is handed to `attachDatabasePool`, which closes idle clients before the instance suspends.
  - Statements: parameterized, every table written `michael_router.<table>` (no dependence on
    `search_path`), one autocommitted statement per method (events: insert, then trim). No `SET`,
    interactive transactions or session advisory locks, so they work through PgBouncer in
    transaction mode; no `statement_timeout` or `options` startup parameters.
  - Atomicity: an `auth_sources` statement locks only the source's row (`INSERT … ON CONFLICT DO
    UPDATE`, or `SELECT … FOR UPDATE` in a release), so concurrent requests on one source
    serialize on that row and every count is exact across instances. Usage upserts lock their
    rows in one byte order (`ORDER BY … COLLATE "C"`), and the sweeps and trims take their locks
    with `SKIP LOCKED`: no statement waits on more than one lock, so none can deadlock.
  - Sweep: each wrong-password statement also deletes up to 100 dead `auth_sources` rows of other
    sources (every end time passed), oldest first, skipping locked rows; a release deletes its own
    row once nothing in it is active. The table stays bounded by the sources seen recently.
  - Timeouts (fail closed): acquiring a client is bounded by 5000 ms, then each method's
    statements by 1500 ms on the client side. A late call rejects and its client is destroyed
    (`release(true)`), never reused. `failClosed` adds an outer 7000 ms timer. A late statement
    may still finish on the server; a precheck slot it took expires with its 60 s end time.
  - TLS: `sslmode` `require`, `verify-ca` or `verify-full` connects with
    `ssl: {rejectUnauthorized: true}` (verify-full semantics with the system CAs; the URL's
    `sslmode` and `channel_binding` are removed before pg sees it, so pg's sslmode handling and
    its warning never apply). `channel_binding=require` or `prefer` enables pg's
    `enableChannelBinding` (SCRAM-SHA-256-PLUS with tls-server-end-point when the server offers
    it); pg 8.23 does not refuse a server that offers no binding, so certificate and host
    verification is what binds the connection to the server. Production refuses a URL whose
    `sslmode` is missing, `disable`, `allow` or `prefer`. Outside production, TLS may be off only
    for a loopback host or a unix-socket `host=` directory (tests).
  - Errors: every pg failure becomes a generic `StoreError` (never the URL, host, user, password,
    SQL or parameters), keeping only a 5-character SQLSTATE as a property. `bigint` values arrive
    as text and are converted with `Number`; an unsafe integer is a malformed row.
  - Schema (`src/store/migrations.js`, frozen and append-only): `schema_migrations (version,
    name, checksum, applied_at)`; `auth_sources` (one row per source: failure count and window
    end, wait end, block end, strikes and their end, inflight and its end, `expires_ms` = the
    latest end, indexed for the sweep; end times are epoch ms from the router's clock);
    `provider_keys (provider, record, updated_at)`; `usage_daily (day, provider, model, metric,
    value bigint)`; `events (id identity, event json)` (`json` keeps the stored text exactly).
  - Migrations (`src/store/migrate.js`) run only from the operator's migrate command
    (`scripts/migrate.mjs`, §10.2), never at request time, and `src/store/migrate.js` is not
    uploaded with the deployment; `ping` (health) fails closed when the schema is missing or older than the code
    needs. Planning runs in a `BEGIN READ ONLY` transaction. Applying runs each pending migration
    in its own transaction: `SET LOCAL` lock and statement timeouts, `pg_advisory_xact_lock` on
    a fixed key (works through a pooler), re-read the applied versions under the lock, run the
    SQL, record `{version, name, sha256 checksum}`, commit. Every statement is additive and
    confined to `michael_router` (checked statically by the tests). Refused, changing nothing:
    the schema holds objects but no `schema_migrations`; the database records a version the code
    does not know (it is newer); a recorded checksum differs from the code's.
- Local adapter `dev/server.js` wraps the same handler with `node:http` so tests and benchmarks
  run the exact code Vercel runs.
- Tests: `node:test`, all offline against local fakes and a task-local PostgreSQL that
  `test/helpers/postgres.js` starts per test file (binaries from `PG_BIN`, else `PATH`; unix
  socket only; stopped and deleted afterwards). Real providers only for final smoke.

## 3. Repository layout and ownership

```
api/router.js            Vercel entry: export default { fetch(request) } -> src/handler.js
src/handler.js           route table + top-level error boundary
src/config.js            env parsing (frozen), defaults, provider table
src/http.js              JSON responses, the OpenAI-style error envelope, bounded body reads
src/version.js           version (package.json) and short commit (VERCEL_GIT_COMMIT_SHA)
src/source.js            client source id (trusted IP header on Vercel; IPv6 -> /64)
src/auth.js              password hash verify (scrypt) + per-instance verified cache
src/limiter.js           wrong-password slowdown / block, shared via the store
src/store/contract.js    store interface: method list, limiter lifetimes, input checks, StoreError
src/store/postgres.js    PostgreSQL store (pg pool, one statement per method)
src/store/memory.js      in-process store with the same interface and semantics
src/store/database-url.js  database URL checks and the TLS options passed to pg (no pg import)
src/store/migrations.js  frozen, append-only schema migrations
src/store/migrate.js     migration plan and apply (operator command and tests; not uploaded)
src/store/index.js       factory; fail closed in production when unconfigured
src/keys.js              provider key resolution (store override > env), AES-256-GCM
src/routing.js           model name -> provider
src/proxy.js             forward chat completions, streaming tap, error mapping
src/providers/claude.js  OpenAI Chat Completions <-> Anthropic Messages adapter (§5.5)
src/providers/passthrough.js  gemini/openrouter request/response specifics
src/sse.js               incremental SSE parser/serializer
src/usage.js             usage + cost recording and aggregation
src/pricing.js           price lookup; data in src/pricing.json (dated, sourced)
src/events.js            recent error/auth event log (allowlisted metadata, static text)
src/redact.js            secret scrubber used by events and logs
src/log.js               allowlisted structured logger
src/control.js           /control/* routes
cli/mrouter.js           CLI entry (package.json "bin": {"mrouter": ...})
cli/lib/*.js             CLI internals
scripts/check.mjs                 `npm run check`: node --check every script, parse the JSON configs
scripts/copy-keys-to-vercel.mjs   deterministic secret transfer (§10.1)
scripts/key-sources.example.json  key manifest example (real manifest is gitignored)
scripts/database-sources.example.json  database URL manifest example (real manifest is gitignored)
scripts/migrate.mjs               migration plan and apply, URL from stdin (§10.2)
scripts/lib/env-document.mjs      strict dotenv parser and bounded stdin reader for the scripts
scripts/scan-secrets.mjs          tree + full-history secret scan, never prints matches (§13)
scripts/live-smoke.mjs            post-deploy smoke run against a deployment (DEPLOY.md step 6)
tools/render-landing.mjs          headless render + layout checks of public/ (needs playwright-core)
dev/server.js            local node:http adapter + static file server
dev/fake-providers.js    fake claude/gemini/openrouter compat servers with scenarios
bench/                   gateway-overhead and cold-start benchmarks (§12)
test/{unit,integration,cli,scripts}/   node:test suites
test/helpers/            shared fixtures, request harness, process and fake-tool helpers,
                         task-local PostgreSQL (postgres.js)
README.md docs/API.md docs/CLI.md docs/SECURITY.md docs/DEPLOY.md docs/BENCHMARKS.md
public/                  landing page (static, no JS required)
.vercelignore            deployment upload allowlist (DEPLOY.md step 5)
```

Raw evidence (design renders, benchmark distributions, redacted live output) is written to a
gitignored `evidence/` directory or outside the repository; only summaries are committed
(`docs/BENCHMARKS.md`).

## 4. Configuration (server environment)

| Name | Required | Meaning |
|------|----------|---------|
| `ROUTER_PASSWORD_HASH` or `ROUTER_PASSWORD` | exactly one | The access password exists only as a Vercel sensitive environment variable — never in repository files, history, logs or command arguments. Preferred: `ROUTER_PASSWORD_HASH` = `scrypt$<logN>$<r>$<p>$<salt b64url>$<hash b64url>`, produced from stdin by `mrouter hash-password` or the copy script's `scrypt-hash` transform. Accepted: `ROUTER_PASSWORD` (the password itself, ≥ 12 characters), compared as HMAC digests with `timingSafeEqual`. Both set → 503 `server_misconfigured`. |
| `ROUTER_SECRET` | yes | ≥32 random bytes, base64/base64url. HKDF-SHA256 derives the key-encryption key (`info="provider-keys-v1"`) and the source-id HMAC key (`info="source-id-v1"`). Never rotated by tooling (rotation orphans stored keys). |
| `ANTHROPIC_API_KEY` `GEMINI_API_KEY` `OPENROUTER_API_KEY` | no | Env-provided provider keys. A CLI-set key stored in the store overrides the env key. |
| `DATABASE_URL_POOLED` (preferred) or `DATABASE_URL` | yes, unless `ROUTER_STORE=memory` | PostgreSQL URL of the store (Neon: the `-pooler` endpoint for `DATABASE_URL_POOLED`). In production `sslmode` must be `require`, `verify-ca` or `verify-full`; `channel_binding` may be `require`, `prefer` or `disable`; any other `ssl*` parameter or `uselibpqcompat` is refused (pg would let it override the TLS settings). A refused URL is reported as its variable's name; neither set → `DATABASE_URL_POOLED/DATABASE_URL`. Both values and the passwords in them are scrubbed from every output (§8). |
| `ROUTER_STORE=memory` | dev/test only | Refused when `VERCEL` is set or `NODE_ENV=production`. |
| `ANTHROPIC_BASE_URL` `GEMINI_BASE_URL` `OPENROUTER_BASE_URL` | no | Upstream origin overrides (tests/bench). |
| `TRUST_PROXY_HEADERS` | no | Take the client IP from `x-vercel-forwarded-for`, then `x-real-ip` (Vercel overwrites both; client-supplied values are not forwarded). Implied true when `VERCEL=1`; tests set it to simulate many sources. Otherwise the socket address is used. |
| `AUTH_MAX_FAILURES` (8) `AUTH_WINDOW_SECONDS` (3600) `AUTH_BLOCK_SECONDS` (3600) `AUTH_MAX_INFLIGHT` (32) `AUTH_BACKOFF_BASE_MS` (250) `AUTH_BACKOFF_MAX_MS` (30000) | no | Limiter tunables; defaults in parentheses. |

A missing required variable makes every protected route return 503 `server_misconfigured`
(naming the variable, never a value). The landing page keeps working.

## 5. HTTP surface

All routes below except the landing page are protected. Every protected response carries
`Cache-Control: no-store` and `x-router-request-id`. No CORS headers are sent (browsers are not
supported clients).

| Method + path | Purpose |
|---------------|---------|
| `POST /v1/chat/completions` | OpenAI Chat Completions, streaming and non-streaming |
| `GET /v1/models` | OpenAI model list: known models of configured providers from the price table, each with `owned_by` = provider and, when known, `context_length` and `max_output_tokens` (Hermes reads context length from here) |
| `GET /control/health` | version, commit, region, instance age/cold flag, store kind, latency and schema version, provider configured flags |
| `GET /control/keys` | `[{provider, configured, source: "store"\|"env"\|"none", updated_at}]` — never values or fingerprints |
| `PUT /control/keys/:provider` | body `{"key": "...", "verify": true}`; stores encrypted override; optional verification against the provider's model-list endpoint (no token spend), done before storing: rejected → 400 `key_rejected`, unverifiable → 502 `key_verification_unavailable`, nothing stored |
| `DELETE /control/keys/:provider` | remove override (falls back to env) |
| `GET /control/usage?days=N` or `?since=YYYY-MM-DD` | usage and cost by provider/model (UTC days, max 400) |
| `GET /control/errors?limit=N&kind=auth\|upstream\|gateway` | recent events, newest first (max 200 kept) |

Anything else under `/v1/` or `/control/` → 404 `not_found` (still requires auth first, so the
route table is not enumerable). Wrong method → 405.

### 5.1 Authentication

- Credential: `Authorization: Bearer <password>` only (what OpenAI SDKs send as `api_key`).
- Verification: scrypt with the parameters in the hash, `timingSafeEqual` (or, with
  `ROUTER_PASSWORD`, HMAC digests of both values compared with `timingSafeEqual`). A per-instance cache
  holds HMAC(instance-random-key, presented) for credentials that verified correctly (max 4
  entries); wrong credentials are never cached.

### 5.2 Wrong-password slowdown and blocking (`src/limiter.js`)

Source id `S` = HMAC(source-key, normalized IP) truncated to 16 bytes hex. IPv4 uses the full
address; IPv6 uses its /64 prefix. Unknown IP → the shared `unknown` bucket. The display form
(IPv4 address or `prefix::/64`) is recorded only in auth events.

State: one `michael_router.auth_sources` row per source (§2) with the failure count and its
window end, the wait end, the block end, the strike count and its end (7 days), and the inflight
count and its end (60 s). End times come from the router's clock; a field counts only while its
end time is later than now, so each one expires on its own. The policy below lives in
`src/limiter.js`; the store implements each step as one atomic statement.

Order on every protected request that presents a credential (no credential → 401
`missing_credentials`, no store call, not counted):

1. **Precheck** (`authPrecheck`, one statement and round trip): take an inflight slot (the count
   restarts at 1 when its end time has passed; the end becomes now + 60 s) and return the active
   block end, wait end and failure count, the new inflight count, and every provider key record.
   - blocked → 429 `source_blocked`, `Retry-After` = remaining seconds.
   - waiting → 429 `auth_backoff`, `Retry-After` = remaining seconds, rounded up.
   - failures ≥ `AUTH_MAX_FAILURES` → 429 `source_blocked`, `Retry-After` = `AUTH_WINDOW_SECONDS`.
   - inflight > `AUTH_MAX_INFLIGHT` → 429 `auth_busy`, `Retry-After: 1`.
   - Every rejection releases its inflight slot (`authRelease`, via `waitUntil`) and evaluates no
     password.
2. **Verify** the password (§5.1).
3. **Correct** → `authRelease` via `waitUntil` (inflight − 1, never below 0; the row is deleted
   once nothing in it is active); continue to the route.
4. **Wrong** → `authFailure`, one statement: `f` = (window active ? count : 0) + 1, the first
   failure fixing the window end at now + `AUTH_WINDOW_SECONDS` (a fixed window); release the
   inflight slot; when `f = AUTH_MAX_FAILURES` (exactly one request per window), strikes =
   (active ? strikes : 0) + 1 with the end now + 7 days. Then `authPenalty` sets the wait to
   `min(base·2^(f-2), max)` ms when `f ≥ 2` and, on a strike, the block to
   `AUTH_BLOCK_SECONDS·2^(strikes-1)` capped at 86400 s, as end times that never shorten one
   already set. Record an `auth` event. Respond 401 `invalid_credentials` after sleeping
   `min(wait, 1000)` ms, with `Retry-After` when a wait is set.
5. **Store unavailable** at any step (an error, a client not acquired within 5000 ms, or
   statements slower than 1500 ms) → 503 `store_unavailable`, fail closed, no password
   evaluation.

Guarantee to test: across any number of instances and any concurrency, wrong-password
evaluations per source per window ≤ `AUTH_MAX_FAILURES + AUTH_MAX_INFLIGHT`, after which the
source is blocked even for the correct password until the block expires. It holds because every
precheck and failure of one source serializes on that source's row lock and acts on the latest
committed row, so each request gets a distinct inflight and failure count.

### 5.3 Model routing (`src/routing.js`)

`model` must match `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`, else 400 `invalid_model`. First match:

1. contains `/` → `openrouter`, model forwarded unchanged (`anthropic/claude-…`, `openrouter/auto`)
2. starts with `claude-` → `claude`
3. starts with `gemini-` → `gemini`
4. otherwise → 400 `model_not_routable` (message lists the three rules)

Selected provider without a key → 503 `provider_not_configured`.

### 5.4 Forwarding (`src/proxy.js`, `src/providers/*`)

- Body ≤ 4 MiB (Vercel's request limit is 4.5 MB) else 413 `payload_too_large`; must be a JSON
  object else 400 `invalid_json`; `model` required (400 `model_required`).
- `gemini` and `openrouter` are pass-through: the body is forwarded unchanged except, for
  `gemini` with `stream: true`, `stream_options.include_usage = true` is set (if the client did
  not ask for it, the usage-only chunk — `choices: []` with `usage` — is removed from the client
  stream). OpenRouter already returns usage and `usage.cost` on every response (its
  `usage.include` flag is deprecated), so nothing is injected for it.
- `claude` goes through the Messages adapter (§5.5).
- Upstream headers: `content-type: application/json`, the provider auth header, and
  `user-agent: michael-router/<version>`. No attribution headers (`HTTP-Referer`, titles) are
  sent. Nothing from the client is forwarded (no client auth, cookies, IP headers, `X-Stainless-*`).
- Client disconnect aborts the upstream request (`request.signal`; `supportsCancellation` on Vercel).
- Upstream total timeout 295 s (function `maxDuration` 300).

Responses:

- Success, non-streaming, pass-through: upstream bytes returned unchanged with upstream status;
  body parsed only to read `usage`. A 200 body that has `error` and no `choices` (OpenRouter
  does this) is an error, not a success: mapped per the table below using `error.code` when it
  is an HTTP status, else 502.
- Success, streaming: `text/event-stream`, status 200, events relayed as they arrive (SSE
  comment lines such as `: OPENROUTER PROCESSING` are relayed unchanged); the tap reads `usage`
  and any in-stream error.
- Added headers: `x-router-provider`, `x-router-request-id`, `server-timing`
  (`auth`, `store`, `upstream` = time to upstream response headers, `gw` = gateway total before
  first byte), `x-router-error-source: gateway|upstream` on errors,
  `x-router-dropped-params` when §5.5 drops a parameter, and `x-router-cold: 1` on the first
  request an instance serves (authenticated responses only, like `server-timing`).
- Upstream error bodies are parsed tolerantly: OpenAI/OpenRouter `{error:{…}}`, Anthropic
  `{type:"error", error:{type,message}}`, Gemini's sometimes array-wrapped `[{error:{…}}]`, or
  plain text.

Errors always use the OpenAI envelope
`{"error":{"message","type","code","param":null,"provider"?,"upstream_status"?}}` and are never a
2xx:

| Situation | Status | `type` / `code` |
|-----------|--------|-----------------|
| Gateway auth/limit/config/validation | as in §5.1–5.3 | `gateway_error` / specific code |
| Upstream 401, or a Gemini 400 whose message says the API key is invalid (provider rejected *our* key) | 502 | `upstream_error` / `provider_auth_failed` — never 401, so clients (Hermes rotates credentials on 401) don't confuse it with a wrong router password |
| Upstream 402 | 402 | `upstream_error` / `provider_billing` |
| Upstream 403 (permission, moderation) | 403 | `upstream_error` / `provider_forbidden` (the gateway itself never sends 403) |
| Upstream 429 | 429 | `upstream_error` / `provider_rate_limited` (+ upstream `Retry-After`) |
| Upstream other 4xx/5xx (incl. 529) | same status | `upstream_error` / upstream code or `provider_error`; upstream message kept (scrubbed) |
| Upstream unreachable / timeout | 502 / 504 | `upstream_error` / `upstream_unreachable` / `upstream_timeout` |
| Error inside a 200 stream | — | relay/emit `data: {"error":{…}}`, then end the stream **without** `[DONE]` (a `[DONE]` the upstream sends after its error is swallowed) |
| Stream ends without `[DONE]` | — | emit `data: {"error":{"type":"upstream_error","code":"upstream_stream_incomplete",…}}` |

### 5.5 Claude adapter (`src/providers/claude.js`)

`POST {ANTHROPIC_BASE_URL}/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`.
Model-list verification uses `GET /v1/models` with the same headers.

Request translation (OpenAI → Messages):

| OpenAI field | Messages field |
|--------------|----------------|
| `system`/`developer` messages (anywhere) | hoisted in order into top-level `system` text blocks (what Anthropic's own compat layer does) |
| `user` string / parts | `text` → text block; `image_url` data URL → base64 image; http(s) URL → URL image; other part types → 400 `unsupported_content` |
| `assistant` content + `tool_calls` | text block(s) + `tool_use` blocks (`arguments` JSON-parsed; invalid → 400 `invalid_tool_arguments`) |
| consecutive `tool` messages (+ a following `user` message) | one `user` message: `tool_result` blocks first (all parallel results together), then user content |
| `max_tokens` / `max_completion_tokens` | `max_tokens`; default = the model's `max_output` from the price table capped at 32000, unknown models 8192 |
| `stop` | `stop_sequences` (whitespace-only entries removed) |
| `stream` | `stream` |
| `tools[].function` {name, description, parameters, strict} | `{name, description, input_schema, strict}` (`input_schema` defaults to an empty object schema) |
| `tool_choice` auto / none / required / {function} | `{type:auto}` / `{type:none}` / `{type:any}` / `{type:tool,name}` (current models 400 on any/tool — passed through honestly) |
| `parallel_tool_calls: false` | `disable_parallel_tool_use: true` on `tool_choice` |
| `response_format` json_schema | `output_config.format = {type:"json_schema", schema}` |
| `response_format` json_object | 400 `unsupported_parameter` (no faithful equivalent; message says to use json_schema) |
| `reasoning_effort` none/minimal/low/medium/high/xhigh/max | `output_config.effort` (none and minimal → low) |
| `temperature` / `top_p` | forwarded (temperature clamped to ≤ 1) unless the price table marks the model `sampling: false` (current Claude models reject non-default sampling with a 400); then dropped and named in `x-router-dropped-params`. Both together are rejected by Claude models, so `top_p` is then dropped (and named) |
| `n` > 1, `audio`, `modalities` containing audio | 400 `unsupported_parameter` |
| `logprobs`, `seed`, penalties, `logit_bias`, `user`, `metadata`, `store`, vendor extras | ignored (documented) |
| top-level `anthropic` object (via OpenAI SDK `extra_body`) | shallow-merged into the Messages body last (escape hatch for `thinking`, `output_config`, …) |

Prompt caching: top-level `cache_control: {"type":"ephemeral"}` is added unless the request
sends header `x-router-cache: off` or sets `anthropic.cache_control`. Prefixes below the model's
minimum cacheable size simply don't cache (no write cost).

Response translation (Messages → OpenAI): text blocks concatenated into `message.content`
(`null` when only tool calls); `tool_use` → `tool_calls[{id, type:"function", function:{name,
arguments: JSON.stringify(input)}}]`; non-empty thinking text → `message.reasoning_content`
(empty/omitted thinking is dropped). `finish_reason`: end_turn/stop_sequence/pause_turn → stop,
max_tokens/model_context_window_exceeded → length, tool_use → tool_calls, refusal →
content_filter. `usage`: `prompt_tokens` = input + cache_read + cache_creation,
`prompt_tokens_details.cached_tokens` = cache_read, `prompt_tokens_details.cache_write_tokens` =
cache_creation, `completion_tokens` = output, `total_tokens`. `id` = Anthropic message id,
`object: "chat.completion"`, `created` = now, `model` = requested model.

Streaming translation: `message_start` → first chunk `delta:{role:"assistant", content:""}`;
`text_delta` → `delta.content`; `tool_use` block start → `delta.tool_calls[{index, id,
type:"function", function:{name, arguments:""}}]`; `input_json_delta` → `function.arguments`
fragment at that index; non-empty `thinking_delta` → `delta.reasoning_content`; `message_delta`
→ chunk with `finish_reason`; `message_stop` → the usage-only chunk (`choices: []`, only if the
client set `stream_options.include_usage`), then `data: [DONE]`; `ping` ignored; `error` event →
error chunk, no `[DONE]`. Every chunk carries the same `id`, `object: "chat.completion.chunk"`,
`created`, `model`.

Every upstream or gateway error (except plain 401s, which are `auth` events) appends an event
(§8) that keeps the code and status, not the message the client received.

## 6. Provider keys (`src/keys.js`)

Effective key per provider = stored override (`michael_router.provider_keys` row: `provider` =
provider id, `record` = JSON `{v:1, iv, ct, tag, updated_at}`, AES-256-GCM, AAD = provider id;
`updated_at` column for operators) else env var else none. Every precheck returns all records
(§5.2), so resolving a key costs no extra round trip.
Keys must be 8–512 printable non-space ASCII. Decrypted values may be cached in memory keyed by
provider id + the whole stored record (so a changed or moved record is decrypted afresh). `PUT` never echoes the key; `verify:true` calls the provider's model-list endpoint
before storing and stores only a key the provider accepted (reporting `verified: true` plus the
upstream status); a rejected or unverifiable key is refused and not stored.

## 7. Usage and cost (`src/usage.js`, `src/pricing.json`)

Recorded after the response (non-streaming) or at stream end, via `waitUntil`, as one
`addUsage` statement adding `n` to the `usage_daily` row (UTC day, provider, model, metric) for
metrics `requests`,
`errors`, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `cost_nusd` (integer nano-USD), `cost_exact` (provider-reported count),
`cost_estimated`, `cost_unknown`, and `usage_missing` (a billable request that reported no
usage); only non-zero metrics are written. The same statement deletes days older than 400 days
(UTC). Concurrent writers never lose an update (`ON CONFLICT DO UPDATE SET value = value + n`)
and never deadlock (§2); totals beyond 2^53 − 1 are skipped as malformed when read.

Cost per request, in priority order:
1. provider-reported (`usage.cost` from OpenRouter; OpenRouter credits are USD) → `exact`;
2. price table (USD per 1M tokens: `input`, `output`, `cache_read`, `cache_write`; optional
   prompt-size `tiers`) with uncached prompt = `prompt_tokens − cached_tokens − cache_write_tokens`
   → `estimated`;
3. otherwise `unknown` — tokens still counted, cost not added, request counted in `cost_unknown`.
   This includes a table entry past its `valid_until` date (announced price changes), and a
   response with no usage at all (`usage_missing` counted).

Price-table entry fields: `provider`, `input`, `output`, `cache_read`, `cache_write` (USD per
1M tokens; null = unknown), `assumed` (an array naming the price fields derived from a multiplier
rather than published, e.g. `["cache_write"]`), `tiers` (prices `above_prompt_tokens`),
`valid_until`, `context_length`, `max_output`, `sampling` (false = model rejects non-default
temperature/top_p), and `priced: false` for a model listed without prices (never estimated; for
example OpenRouter models, whose cost the provider reports). Sources are not per entry: the
top-level `sources` holds one per provider. Gemini output prices include thinking tokens.

Aggregates report `cost_usd` plus `cost_status` ∈ `exact|estimated|mixed|unknown|partial`
(`partial` = some requests unknown). Totals with unknown requests are shown as lower bounds.
`pricing.json` records `updated` and a source URL per provider; unknown models are never priced
as zero.

## 8. Events, logging, redaction

- `michael_router.events` rows; each append inserts, then deletes all but the newest 200 (ids
  above the highest minus 200, skipping rows another trim holds), so concurrent appends leave at
  most 200. Listed newest first. Event: `{ts, kind: auth|upstream|gateway, code,
  status, upstream_status?, provider?, model?, message, source? (auth only, display form),
  request_id}`. `message` is a fixed gateway sentence chosen by `code` (`EVENT_MESSAGES` in
  `src/events.js`; for a provider's own code, "The provider answered HTTP n." or, for an error
  inside a stream, "The provider reported an error inside the stream."). It interpolates only
  numbers (a block duration, an HTTP status).
- Never stored or logged anywhere: request bodies, prompts, completions, headers, the password,
  the password hash, provider keys, `ROUTER_SECRET`, the database URLs and passwords, and no provider, client or
  exception text at all: provider error messages can quote the prompt, so only the client that
  sent the request receives them (scrubbed).
- `src/redact.js` replaces configured provider keys, the database URLs and the passwords in them
  (as written and percent-decoded), the presented bearer value and patterns
  (`sk-ant-…`, `sk-or-…`, `AIza…`, `Bearer …`, long base64/hex tokens) with `[redacted]`.
- `src/log.js` emits one JSON line per request with allowlisted fields only:
  `request_id, route, method, status, provider, model, duration_ms, upstream_ms, store_ms,
  error_code, cold`. Unknown fields are dropped. Unexpected exceptions log `request_id` and the
  exception name only, never the message or stack.

## 9. CLI (`mrouter`)

Zero-dependency Node ESM. Config `${XDG_CONFIG_HOME:-~/.config}/michael-router/` (dir 0700):
`config.json` `{url}` and `credentials` (password), both 0600. Env overrides `MROUTER_URL`,
`MROUTER_PASSWORD`. Secrets are read from a no-echo TTY prompt or from stdin when piped — never
from argv; a command given a secret-looking extra argument refuses and explains.

Global flags: `--url`, `--json`, `--timeout <s>`, `--no-color`, `-h/--help`, `--version`.
Exit codes: 0 ok, 1 error, 2 usage, 3 gateway auth/limit, 4 upstream/provider error, 5 network,
130 cancelled with Ctrl-C at a prompt.

| Command | Behavior |
|---------|----------|
| `login [--url URL]` | read password (hidden/stdin), verify with `/control/health`, save only on success |
| `logout` | delete stored credentials |
| `status` | URL, whether a password is stored (never the value), config paths |
| `health` | `/control/health` table |
| `keys list` | provider, configured, source, updated |
| `keys set <claude\|gemini\|openrouter> [--no-verify]` | read key hidden/stdin, `PUT /control/keys/:p` |
| `keys unset <provider>` | `DELETE /control/keys/:p` |
| `models` | `/v1/models` |
| `ask [-m MODEL] [-s SYSTEM] [--no-stream] [--max-tokens N] [--show-reasoning] [PROMPT…]` | prompt from args, piped stdin, or both (args, blank line, stdin); streams text to stdout; reasoning text to stderr only with `--show-reasoning`; footer (provider, model, tokens, cost + status, latency) to stderr |
| `test [provider…] [-m/--model M]` | per configured provider, one non-streaming and one streaming tiny request with a cheap default model; table of ok/latency/tokens/cost; nonzero exit if any fail |
| `usage [--days N \| --since DATE]` | by-model table + totals, explicit unknown/estimated markers |
| `errors [--limit N] [--kind K]` | recent events |
| `hash-password` | read password hidden/stdin, print `ROUTER_PASSWORD_HASH` value to stdout (newline only on a terminal) |

## 10. Operator scripts

### 10.1 Deterministic key copy to Vercel (`scripts/copy-keys-to-vercel.mjs`)

Run by whoever deploys, on the machine that holds the permitted sources. Input: a manifest
(kept outside the repository or in the gitignored `scripts/key-sources.json` or
`scripts/database-sources.json`) pinning the target
project (`"project": {"orgId": "team_…", "projectId": "prj_…"}`, required) and naming, for each Vercel env
var, exactly one source. Source types: `keychain` (`security find-generic-password -s S -a A -w`,
value read from the child's stdout pipe), `file` (absolute path + variable name in a dotenv
file), `op` (`op read <ref>`), `stdin` (at most one entry), `stdin-env` (`var`: one variable of
a dotenv document on stdin, read once and shared by every `stdin-env` entry; never together with
`stdin`; descriptor `stdin-env:<NAME>`), `generate` (random bytes, `onlyIfAbsent`). Optional
`transform: "scrypt-hash"` (for the password). Fixed order = manifest order. Dotenv documents
(files and stdin) go through one strict parser (`scripts/lib/env-document.mjs`): `NAME=value`
lines, comments and `export`, quotes stripped, no expansion; any other line or a variable set
twice is refused.

Values are checked against the server's own rules for their variable before anything is sent.
`DATABASE_URL_POOLED` and `DATABASE_URL` (kind `database-url`): scheme `postgres:` or
`postgresql:`; host, user and password present; `sslmode` `require` or `verify-full`; accepted by
the store's production URL check (§4); on a `*.neon.tech` host, `DATABASE_URL_POOLED` must be the
`-pooler` endpoint and `DATABASE_URL` must not be. The reason never names a part of the value.

Rules: refuse manifest entries outside these types, and source descriptors that hold key-shaped
text; refuse file paths under prohibited roots (agent and tool homes `.hermes`, `.claude`,
`.codex`, `.cache` under both `$HOME` and the account's passwd home; temp dirs `/tmp`, `/private`,
`/var/folders`, `$TMPDIR`; `/etc`), checked lexically, after `realpath` and by device/inode of every
parent directory (firmlinks, bind mounts), files with more than one hard link, any `.env` file
outside the manifest, and any path not explicitly named;
child processes get an allowlisted environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`LC_ALL`, `TERM`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `OP_ACCOUNT`, when set) so no
unrelated credential reaches them; every `vercel` child runs from the repository root with
`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` set to the pinned ids (never the inherited ones), and with
`--check` or `--yes` a different id in the environment or in the repository's
`.vercel/project.json` stops the run before any source is read; the plan prints the project and
its digest covers it; never
print, log or pass a value in argv (the CLI's
`--value` flag is never used); send each value on stdin to
`vercel env add <NAME> <environment> --force --sensitive` (overwrites deterministically; a CLI
without `--sensitive` stops the run before any source is read; `onlyIfAbsent` entries omit
`--force`, so Vercel's "already exists" refusal means skipped and an existing `ROUTER_SECRET` is
never replaced); stop at the first failure — including a guard refusal — printing the env
name, source name and the scrubbed refusal text, with no fallback to other sources; finish by
listing env names present in Vercel (names only). `--check` validates access and value shape
without transferring.
The repository ships only `scripts/key-sources.example.json` and
`scripts/database-sources.example.json` with placeholder source names; the real manifests and any
machine-specific deployment steps live with the operator, not in the repo.

### 10.2 Migrations (`scripts/migrate.mjs`)

`<database env source> | node scripts/migrate.mjs [--var NAME] [--apply]`. Stdin holds a dotenv
document (`--var` names the variable, default `DATABASE_URL`, the direct endpoint) or one bare
`postgres://` line; a terminal, more than 64 KiB, a variable set twice or missing, or a URL the
store would not accept is a usage error naming the variable. The URL is turned into pg options by
the store's own function (`pgConnectionOptions` in `src/store/database-url.js`); every `PG*`
variable is removed first and `~/.pgpass` is never read, so the URL alone decides the target.

Without `--apply` it prints the server's major version, whether schema `michael_router` exists,
the applied and pending versions and any refusal, and changes nothing (read-only transaction).
`--apply` plans, applies the pending migrations (§2), prints each version applied, then plans
again and prints the final state. Exit codes: 0 up to date or applied, 4 pending, 3 refused,
2 usage, 1 connection or unexpected error. No output line holds the URL, host, user, database
name or password; errors are a fixed description plus the SQLSTATE.

## 11. Landing page (`public/`)

Static, no login, no admin UI, no account state, no external requests (no web fonts, analytics or
CDNs), works without JavaScript. Content: what the router is; the model → provider routing
table; base URL and quickstart (curl, OpenAI Python/JS) with a placeholder for the password;
streaming/usage/cost/error/security behavior in plain language; CLI command overview.
Security headers via `vercel.json` (strict CSP, `nosniff`, `no-referrer`,
`frame-ancestors 'none'`); `noindex` and a disallowing `robots.txt`.

Design constraints (anti-"AI slop"): no gradient blobs/mesh backgrounds, no glassmorphism,
no purple-indigo defaults, no emoji, no icon-card feature grids, no fake metrics,
testimonials or logos, no generic hero copy. Typography-led technical-document look, one accent
colour, real content (the routing table is the centrepiece), light and dark schemes, no
horizontal scroll at 360 px.

## 12. Performance measurement (`bench/`)

- Gateway overhead: identical requests sent (a) directly to a fixed-latency local fake upstream and
  (b) through `dev/server.js` → same fake; overhead = (b) − (a). Non-streaming total and
  streaming TTFB, sequential and concurrent, N ≥ 500, distributions (p50/p90/p99/max) saved
  as JSON + markdown under `evidence/speed/round-N/`. The router uses the in-process memory store:
  a PostgreSQL round trip is not modelled (a fixed delay would not represent its pool, TLS and
  server time honestly), so the store's cost is measured only live.
- Cold start: fresh process → first successful protected response, N ≥ 30, against a
  hello-world handler baseline; plus module import time of `api/router.js`.
- Live (deployment stage): small N through-router vs direct provider with the same tiny request,
  plus `server-timing` breakdown; provider latency reported separately from gateway overhead.
- Keep a change only if its measured gain exceeds run-to-run noise (report both).

## 13. Publication and secret hygiene

The repository is public. Nothing in it may identify a machine, a home directory, a host name or
an operator workflow, and nothing in it or its history may contain a provider key, the access
password, its hash, `ROUTER_SECRET`, a database URL with its password or a real prompt.

- Test fixtures use fake values whose shape does not match a real key (`sk-ant-fake-…`, never
  `sk-ant-api03-…` of real length), and generate password hashes at runtime. Database URLs in
  fixtures use hosts under the reserved `.test` top-level domain or a local socket, with
  generated or `SENTINEL` passwords.
- `scripts/scan-secrets.mjs` scans the working tree (`git ls-files -co --exclude-standard`, paths
  of every entry), every path of every commit, every object reachable from any ref
  (`git rev-list --objects --all`, including directly tagged blobs and trees and nested tags) and
  every commit and tag object, for: real-shaped provider keys (Anthropic `sk-ant-api…`/
  `sk-ant-admin…` and OAuth `sk-ant-oat…`/`sk-ant-ort…`, OpenRouter `sk-or-v1-<64 hex>`, Google
  `AIza<35>`), `scrypt$…` password hashes (also escaped or URL-encoded), private-key blocks,
  token shapes assigned to the Vercel and former REST-store token variables, `redis://` and
  `postgres://` URL credentials (not on `.test` hosts) and absolute home-directory paths; plus
  exact literal values supplied on stdin (one per line, also checked in base64, base64url,
  URL-encoded and JSON-escaped forms). Archives, missing objects and very large files are
  reported as unscanned findings, never passed as clean. Output is counts and locations only
  (`<commit-or-worktree>:<path>:<line> <rule>`), never the matched text or any part of it.
  Exit 0 clean, 1 findings, 2 usage error. A literal-value run is required before anything is
  pushed to the public remote; whoever holds the values pipes them in from their permitted
  sources.
