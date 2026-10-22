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
  JSDoc types, zero runtime dependencies except `@vercel/functions` (for `waitUntil`).
- One function, `api/router.js`, receives every API path via `vercel.json` rewrites, so all
  traffic shares one warm instance pool. Whether Vercel shows the function the original or the
  rewritten URL is not documented, so the rewrite carries the route explicitly:
  `/v1/:path*` → `/api/router?__route=v1/:path*` and `/control/:path*` →
  `/api/router?__route=control/:path*`. The handler uses `__route` when the pathname is
  `/api/router`, else the pathname (dev server). `supportsCancellation: true`, `maxDuration: 300`.
  Static landing page lives in `public/` (`"framework": null`, `outputDirectory: "public"`).
- Durable store: Redis over the Upstash REST protocol (Vercel Marketplace "Upstash for Redis",
  free plan). Accepts `KV_REST_API_URL`/`KV_REST_API_TOKEN` or
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`. Tests use an in-repo fake Upstash REST
  server (mocked evidence, labelled as such).
- Local adapter `dev/server.js` wraps the same handler with `node:http` so tests and benchmarks
  run the exact code Vercel runs.
- Tests: `node:test`, all offline against local fakes. Real providers only for final smoke.

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
src/store/upstash.js     Upstash REST client: command, pipeline, multi-exec
src/store/memory.js      in-process store with the same raw-command interface
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
scripts/copy-keys-to-vercel.mjs   deterministic secret transfer (§10)
scripts/key-sources.example.json  manifest example (real manifest is gitignored)
scripts/scan-secrets.mjs          tree + full-history secret scan, never prints matches (§13)
scripts/live-smoke.mjs            post-deploy smoke run against a deployment (DEPLOY.md step 6)
tools/render-landing.mjs          headless render + layout checks of public/ (needs playwright-core)
dev/server.js            local node:http adapter + static file server
dev/fake-upstash.js      fake Upstash REST server (memory store behind it)
dev/fake-providers.js    fake claude/gemini/openrouter compat servers with scenarios
bench/                   gateway-overhead and cold-start benchmarks (§12)
test/{unit,integration,cli,scripts}/   node:test suites
test/helpers/            shared fixtures, request harness, process and fake-tool helpers
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
| `ANTHROPIC_API_KEY` `GEMINI_API_KEY` `OPENROUTER_API_KEY` | no | Env-provided provider keys. A CLI-set key stored in Redis overrides the env key. |
| `KV_REST_API_URL`+`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN` | yes in production | Store. |
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
| `GET /control/health` | version, commit, region, instance age/cold flag, store latency, provider configured flags |
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

Keys (`mr:v1:` prefix): `auth:block:S` (EX), `auth:wait:S` (PX), `auth:fail:S` (counter, EX
window set NX), `auth:inflight:S` (counter, EX 60), `auth:strikes:S` (counter, EX 7 days).

Order on every protected request that presents a credential (no credential → 401
`missing_credentials`, no store call, not counted):

1. **Precheck** — one pipeline: `GET block`, `PTTL wait`, `GET fail`, `INCR inflight`,
   `EXPIRE inflight 60`, plus `HGETALL mr:v1:keys` (provider key overrides; same round trip).
   - blocked → 429 `source_blocked`, `Retry-After` = remaining seconds.
   - wait > 0 → 429 `auth_backoff`, `Retry-After` = ceil(wait).
   - fail ≥ `AUTH_MAX_FAILURES` → 429 `source_blocked`.
   - inflight > `AUTH_MAX_INFLIGHT` → 429 `auth_busy`, `Retry-After: 1`.
   - Every rejection releases its inflight slot (`DECR`, via `waitUntil`) and evaluates no password.
2. **Verify** the password (§5.1).
3. **Correct** → release inflight via `waitUntil`; continue to the route.
4. **Wrong** → one `MULTI`: `SET fail 0 EX <window> NX`, `INCR fail`, `DECR inflight` (the first
   failure starts a fixed window; no Redis 7 `EXPIRE … NX`). With `f` = new failure count: set
   `auth:wait:S` to `min(base·2^(f-2), max)` ms when `f ≥ 2`; when `f = AUTH_MAX_FAILURES` (one
   request per window), `INCR strikes` (EX 7d) and set `auth:block:S` for
   `AUTH_BLOCK_SECONDS·2^(strikes-1)` capped at 86400 s. Record an `auth` event. Respond 401
   `invalid_credentials` after sleeping `min(wait, 1000)` ms, with `Retry-After` when a wait is set.
5. **Store unavailable** at any step (error or >1500 ms timeout) → 503 `store_unavailable`, fail
   closed, no password evaluation.

Guarantee to test: across any number of instances and any concurrency, wrong-password
evaluations per source per window ≤ `AUTH_MAX_FAILURES + AUTH_MAX_INFLIGHT`, after which the
source is blocked even for the correct password until the block expires.

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

Effective key per provider = Redis override (`mr:v1:keys` hash field = provider id, value JSON
`{v:1, iv, ct, tag, updated_at}`, AES-256-GCM, AAD = provider id) else env var else none.
Keys must be 8–512 printable non-space ASCII. Decrypted values may be cached in memory keyed by
provider id + the whole stored record (so a changed or moved record is decrypted afresh). `PUT` never echoes the key; `verify:true` calls the provider's model-list endpoint
before storing and stores only a key the provider accepted (reporting `verified: true` plus the
upstream status); a rejected or unverifiable key is refused and not stored.

## 7. Usage and cost (`src/usage.js`, `src/pricing.json`)

Recorded after the response (non-streaming) or at stream end, via `waitUntil`, one pipeline:
`HINCRBY mr:v1:usage:<YYYY-MM-DD> "<provider>\t<model>\t<metric>" n` for metrics `requests`,
`errors`, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `cost_nusd` (integer nano-USD), `cost_exact` (provider-reported count),
`cost_estimated`, `cost_unknown`, and `usage_missing` (a billable request that reported no
usage); only non-zero metrics are written; `EXPIRE … 34560000` (400 d).

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

- `mr:v1:events` list, `LPUSH` + `LTRIM 0 199`. Event: `{ts, kind: auth|upstream|gateway, code,
  status, upstream_status?, provider?, model?, message, source? (auth only, display form),
  request_id}`. `message` is a fixed gateway sentence chosen by `code` (`EVENT_MESSAGES` in
  `src/events.js`; for a provider's own code, "The provider answered HTTP n." or, for an error
  inside a stream, "The provider reported an error inside the stream."). It interpolates only
  numbers (a block duration, an HTTP status).
- Never stored or logged anywhere: request bodies, prompts, completions, headers, the password,
  the password hash, provider keys, `ROUTER_SECRET`, store token, and no provider, client or
  exception text at all: provider error messages can quote the prompt, so only the client that
  sent the request receives them (scrubbed).
- `src/redact.js` replaces configured provider keys, the presented bearer value and patterns
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

## 10. Deterministic key copy to Vercel (`scripts/copy-keys-to-vercel.mjs`)

Run by whoever deploys, on the machine that holds the permitted sources. Input: a manifest
(kept outside the repository or in the gitignored `scripts/key-sources.json`) pinning the target
project (`"project": {"orgId": "team_…", "projectId": "prj_…"}`, required) and naming, for each Vercel env
var, exactly one source. Source types: `keychain` (`security find-generic-password -s S -a A -w`,
value read from the child's stdout pipe), `file` (absolute path + variable name in a dotenv
file), `op` (`op read <ref>`), `stdin` (at most one entry), `generate` (random bytes,
`onlyIfAbsent`). Optional `transform: "scrypt-hash"` (for the password). Fixed order = manifest
order.

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
The repository ships only `scripts/key-sources.example.json` with placeholder source names; the
real manifest and any machine-specific deployment steps live with the operator, not in the repo.

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
  as JSON + markdown under `evidence/speed/round-N/`. Store RTT is simulated explicitly
  (fake Upstash with configurable delay) and reported separately.
- Cold start: fresh process → first successful protected response, N ≥ 30, against a
  hello-world handler baseline; plus module import time of `api/router.js`.
- Live (deployment stage): small N through-router vs direct provider with the same tiny request,
  plus `server-timing` breakdown; provider latency reported separately from gateway overhead.
- Keep a change only if its measured gain exceeds run-to-run noise (report both).

## 13. Publication and secret hygiene

The repository is public. Nothing in it may identify a machine, a home directory, a host name or
an operator workflow, and nothing in it or its history may contain a provider key, the access
password, its hash, `ROUTER_SECRET`, a store token or a real prompt.

- Test fixtures use fake values whose shape does not match a real key (`sk-ant-fake-…`, never
  `sk-ant-api03-…` of real length), and generate password hashes at runtime.
- `scripts/scan-secrets.mjs` scans the working tree (`git ls-files -co --exclude-standard`, paths
  of every entry), every path of every commit, every object reachable from any ref
  (`git rev-list --objects --all`, including directly tagged blobs and trees and nested tags) and
  every commit and tag object, for: real-shaped provider keys (Anthropic `sk-ant-api…`/
  `sk-ant-admin…` and OAuth `sk-ant-oat…`/`sk-ant-ort…`, OpenRouter `sk-or-v1-<64 hex>`, Google
  `AIza<35>`), `scrypt$…` password hashes (also escaped or URL-encoded), private-key blocks,
  Upstash/Vercel token shapes, `redis://` URL credentials and absolute home-directory paths; plus
  exact literal values supplied on stdin (one per line, also checked in base64, base64url,
  URL-encoded and JSON-escaped forms). Archives, missing objects and very large files are
  reported as unscanned findings, never passed as clean. Output is counts and locations only
  (`<commit-or-worktree>:<path>:<line> <rule>`), never the matched text or any part of it.
  Exit 0 clean, 1 findings, 2 usage error. A literal-value run is required before anything is
  pushed to the public remote; whoever holds the values pipes them in from their permitted
  sources.
