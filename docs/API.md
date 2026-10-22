# Michael Router — API

The client contract: what a request may contain, what comes back, and what every error means.
The interfaces are specified in `DESIGN.md`; security reasoning is in `SECURITY.md`.

## 1. Basics

- **Base URL**: `https://<host>/v1`, where `<host>` is your deployment's domain. Any client that
  speaks OpenAI Chat Completions can use it by setting the base URL and API key.
- **Authentication**: `Authorization: Bearer <router password>` on every request except the
  landing page. This is what OpenAI SDKs send for `api_key`. No other scheme is accepted
  (`x-api-key`, Basic and an empty bearer count as no credential).
- **Provider keys stay on the server.** Clients never send Anthropic, Gemini or OpenRouter keys;
  the gateway uses the key configured for the provider (a key stored with `mrouter keys set`
  overrides the environment variable).
- No CORS headers are sent; browsers are not supported clients.

| Method and path | Purpose |
|-----------------|---------|
| `POST /v1/chat/completions` | OpenAI Chat Completions, streaming and non-streaming |
| `GET /v1/models` | Known models of the configured providers |
| `GET /control/health` | Version, region, instance, store latency, which providers are configured |
| `GET /control/keys` | `[{provider, configured, source: "store"\|"env"\|"none", updated_at}]` (never key values) |
| `PUT /control/keys/:provider` | `{"key": "...", "verify": true}`: store an encrypted key override (with `verify`, only after the provider accepted it; see below) |
| `DELETE /control/keys/:provider` | Remove the override (falls back to the environment key) |
| `GET /control/usage?days=N` or `?since=YYYY-MM-DD` | Usage and cost per provider and model (UTC days, at most 400) |
| `GET /control/errors?limit=N&kind=auth\|upstream\|gateway` | Recent events, newest first (at most 200 kept) |

Unknown paths under `/v1/` and `/control/` answer 404 and wrong methods 405, but only after
authentication, so the route table cannot be probed without the password.

**Key verification.** With `"verify": true` (the CLI default), the gateway checks the key against
the provider's model or key endpoint (no tokens are spent) *before* storing it, so a bad key never
replaces a working one:

- accepted: the key is stored; 200 `{provider, configured: true, source: "store", updated_at,
  verified: true, upstream_status}`;
- rejected by the provider (a 4xx other than 408 or 429): 400 `key_rejected`, nothing stored;
- the check could not be completed (network failure, redirect, timeout, 408, 429 or 5xx): 502
  `key_verification_unavailable`, nothing stored. Retry later, or send `"verify": false`.

Both failures are `upstream_error` envelopes with `provider` and, when the provider answered,
`upstream_status`. With `"verify": false` the key is stored without a check: 200 `{provider,
configured: true, source: "store", updated_at}`.

## 2. Model routing

`model` must match `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`. The first matching rule wins:

| Rule | Provider | Example |
|------|----------|---------|
| contains `/` | `openrouter` (name forwarded unchanged) | `openrouter/auto`, `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash-lite` |
| starts with `claude-` | `claude` (Anthropic Messages API, translated) | `claude-sonnet-4-6`, `claude-haiku-4-5` |
| starts with `gemini-` | `gemini` (Gemini's OpenAI-compatible endpoint) | `gemini-2.5-flash` |
| anything else | 400 `model_not_routable` | `gpt-5` |

Model names are not checked against a list: any name a provider accepts works. `/v1/models`
lists the models the gateway has metadata and prices for.

## 3. Chat completions

`POST /v1/chat/completions` with a JSON object body of at most 4 MiB.

What every provider route shares:

- The upstream request carries only `content-type: application/json`, the provider's auth header
  and `user-agent: michael-router/<version>`. Nothing from the client's headers is forwarded.
- Redirects from a provider are never followed (the request fails with 502
  `upstream_unreachable`), so a key or prompt cannot be re-sent to another origin.
- The upstream timeout is 295 s for the whole response, including the stream.
- A client disconnect aborts the upstream request.

### 3.1 Gemini and OpenRouter (pass-through)

The request body is forwarded byte for byte, so every field the provider's OpenAI-compatible
endpoint supports works as documented by that provider (tools, `response_format`,
`reasoning_effort`, provider-specific extras). One exception: for `gemini` with `stream: true`
the gateway sets `stream_options.include_usage = true` so it can record usage; if the client did
not ask for usage itself, the usage-only chunk (`choices: []`) is removed from what it receives.

Non-streaming success responses are the provider's bytes, status and `content-type`, unchanged.
A 200 response whose body is an error object without `choices` (OpenRouter does this) is turned
into an error response (§6).

### 3.2 Claude (translated to the Messages API)

Claude models go to `POST /v1/messages` with `anthropic-version: 2023-06-01`. The gateway
translates the request and the response, so behavior differs from OpenAI's in the ways below.

**Request fields**

| OpenAI field | Becomes / behavior |
|--------------|--------------------|
| `system` and `developer` messages (anywhere) | top-level `system` text blocks, in order |
| `user` content: string or `text` parts | text blocks |
| `user` `image_url` part | data URL (png, jpeg, gif, webp, base64) → base64 image; `http(s)` URL → URL image |
| other `user` part types (audio, files, …) | 400 `unsupported_content` |
| `assistant` content and `tool_calls` | text blocks and `tool_use` blocks (`arguments` must be a JSON object; empty = `{}`; anything else → 400 `invalid_tool_arguments`) |
| consecutive `tool` messages (and a following `user` message) | one `user` message: all `tool_result` blocks first, then the user content |
| other roles (`function`, …) | 400 `invalid_parameter` |
| `max_completion_tokens` / `max_tokens` | `max_tokens`; default: the model's maximum output capped at 32000, or 8192 for models the gateway has no metadata for |
| `stop` | `stop_sequences` (whitespace-only entries removed) |
| `stream` | `stream` |
| `tools[]` (`type: "function"` only) | `{name, description, input_schema, strict}`; a missing `parameters` becomes an empty object schema; other tool types → 400 `unsupported_parameter` |
| `tool_choice`: `auto` / `none` / `required` / `{type:"function", function:{name}}` | `{type:"auto"}` / `{type:"none"}` / `{type:"any"}` / `{type:"tool", name}` (passed on as is, even where a model rejects it) |
| `parallel_tool_calls: false` | `disable_parallel_tool_use: true` (not with `tool_choice: "none"`) |
| `response_format` `json_schema` | `output_config.format = {type:"json_schema", schema}` |
| `response_format` `json_object` | 400 `unsupported_parameter` (no faithful equivalent; use `json_schema`) |
| `response_format` `text` | nothing |
| `reasoning_effort` `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` | `output_config.effort` (`none` and `minimal` → `low`) |
| `temperature`, `top_p` | forwarded (`temperature` capped at 1). Claude models reject both in one request, so when both are sent `top_p` is dropped; models that reject non-default sampling get neither. Dropped parameters are named in `x-router-dropped-params` |
| `n` > 1, `audio`, `modalities` containing `"audio"` | 400 `unsupported_parameter` |
| `logprobs`, `top_logprobs`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `user`, `metadata`, `store`, `service_tier`, other fields | ignored |
| `anthropic` (an object; with OpenAI SDKs pass it in `extra_body`) | shallow-merged into the Messages body last: the escape hatch for `thinking`, `output_config`, `cache_control`, … (`model` and `stream` inside it are ignored) |

**Prompt caching.** The gateway adds top-level `cache_control: {"type": "ephemeral"}` (automatic
caching of the longest reusable prefix). Turn it off per request with the request header
`x-router-cache: off`, or replace it by sending `anthropic.cache_control` (`null` removes it).
Prompts shorter than the model's minimum cacheable length are simply not cached.

**Response.** `id` is the Anthropic message id, `object: "chat.completion"`, `created` is the
gateway's clock, `model` is the requested name. Text blocks are concatenated into
`message.content` (`null` when there are only tool calls); `tool_use` blocks become
`message.tool_calls` (`arguments` is the JSON-encoded input); non-empty thinking text is returned
as `message.reasoning_content`. `finish_reason`: `end_turn`, `stop_sequence`, `pause_turn` →
`stop`; `max_tokens`, `model_context_window_exceeded` → `length`; `tool_use` → `tool_calls`;
`refusal` → `content_filter`. `usage`: `prompt_tokens` = input + cache reads + cache writes,
`prompt_tokens_details.cached_tokens` = cache reads, `prompt_tokens_details.cache_write_tokens` =
cache writes, `completion_tokens` = output, `total_tokens`.

**Thinking is not round-tripped.** Chat Completions messages have no place for thinking blocks
and their signatures, so assistant messages sent back to the gateway carry text and tool calls
only (`reasoning_content` on them is ignored). Plain conversations are unaffected, but a
follow-up turn in a tool loop may be rejected (400 from the provider) when thinking was enabled
through `anthropic.thinking`, in particular budget-style `{"type": "enabled", "budget_tokens": …}`
thinking, because the provider expects the earlier turn's thinking block back. Leave thinking
off for tool loops, or use the Anthropic Messages API directly when you need both.

## 4. Streaming

With `stream: true` the response is `text/event-stream` with status 200 and events are relayed
as the provider produces them (no buffering).

- `gemini`, `openrouter`: the provider's events, re-serialized (comment lines such as
  `: OPENROUTER PROCESSING` are kept).
- `claude`: OpenAI `chat.completion.chunk` events, all with the same `id`, `created` and `model`.
  The first chunk is `delta: {role: "assistant", content: ""}`; text arrives as
  `delta.content`, thinking as `delta.reasoning_content`, tool calls as `delta.tool_calls`
  (`id`, `type` and `function.name` first, then `function.arguments` fragments at the same
  `index`; a tool call without input gets one `"{}"` fragment); a chunk with `finish_reason`
  follows. A usage-only chunk (`choices: []` plus
  `usage`) is sent last only when the request set `stream_options.include_usage: true`.
- A completed stream ends with `data: [DONE]`.

A stream can fail after the 200 status was sent. It then ends with exactly one error event and
**no** `[DONE]`:

```
data: {"error":{"message":"...","type":"upstream_error","code":"...","param":null,"provider":"claude"}}
```

`code` is the provider's error code or type (for example `overloaded_error`), one of the mapped
codes in §6 when the provider names an HTTP status, `upstream_stream_incomplete` when the stream
broke or ended early, or `upstream_timeout` when it ran past 295 s. A `[DONE]` the provider sends
after its error is dropped. Treat a stream without `[DONE]` as failed.

## 5. Models, usage and cost

### 5.1 `GET /v1/models`

```json
{"object": "list", "data": [
  {"id": "claude-sonnet-4-6", "object": "model", "created": 0, "owned_by": "claude",
   "context_length": 1000000, "max_output_tokens": 128000},
  {"id": "gemini-2.5-flash", "object": "model", "created": 0, "owned_by": "gemini", "context_length": 1048576}
]}
```

Only providers with a key appear. `context_length` and `max_output_tokens` are present when
known. The list comes from the gateway's price table, so it is not exhaustive (§2).

### 5.2 Usage accounting

Usage is recorded after each response (or at the end of a stream) per UTC day, provider and model:
`requests`, `errors`, `prompt_tokens`, `completion_tokens`, `cached_tokens`,
`cache_write_tokens`, `reasoning_tokens`, `cost_nusd` (nano-USD), and one cost class per
request:

| Class | Meaning |
|-------|---------|
| `cost_exact` | the provider reported the cost (OpenRouter `usage.cost`; OpenRouter credits are USD) |
| `cost_estimated` | tokens × the gateway's price table (`src/pricing.json`, dated and sourced) |
| `cost_unknown` | no price (model not in the table, or its price is past its `valid_until` date), incomplete usage (a stream that failed or was cancelled after usage started), or no usage at all |

A stream's usage counts as complete only when the stream ended normally or the usage came with
the last chunk: for Claude, `message_delta`; for Gemini and OpenRouter, the usage-only chunk, a
chunk with a `finish_reason`, or `[DONE]`. Usage seen earlier in a stream that then breaks, times
out or is cancelled is recorded as tokens with `cost_unknown`.

**Gemini thinking tokens.** Gemini's OpenAI-compatible endpoint can leave thinking tokens out of
`completion_tokens` while counting them in `total_tokens`. Gemini bills them as output, so the
gateway records output tokens as `max(completion_tokens, total_tokens - prompt_tokens)` and the
difference, when positive, as `reasoning_tokens`. The response body is passed through unchanged.

`usage_missing` counts billable requests that reported no usage (no usage in the response, an
upstream timeout, or a client that disconnected before the response). Requests the provider
refused with an HTTP error count in `requests` and `errors` only. Unknown costs are never counted
as zero: they are left out of `cost_nusd`.

`GET /control/usage` returns `{from, to, days, models: [...], providers: [...], totals}`; each row
has the metrics above, `cost_usd` and `cost_status`: `exact`, `estimated`, `mixed` (both),
`unknown`, or `partial` (some requests unknown, so `cost_usd` is a lower bound).

## 6. Errors

Errors are never a 2xx and always use the OpenAI envelope:

```json
{"error": {"message": "...", "type": "gateway_error", "code": "model_not_routable", "param": null}}
```

`type` is `gateway_error` when the gateway refused the request and `upstream_error` when the
provider failed; the `x-router-error-source` header says the same (`gateway` or `upstream`).
Upstream errors also carry `provider` and, when the provider answered, `upstream_status`. Provider
messages are kept but scrubbed of anything key-like and truncated to 1000 characters.

| Status | `code` | Meaning | Retry? |
|--------|--------|---------|--------|
| 400 | `invalid_json` | body is not a JSON object | no |
| 400 | `model_required` | no `model` | no |
| 400 | `invalid_model` | `model` breaks the naming rule (§2) | no |
| 400 | `model_not_routable` | no routing rule matches | no |
| 400 | `invalid_parameter` | a field has the wrong shape (messages, tools, `max_tokens`, …) | no |
| 400 | `unsupported_parameter` | Claude: a feature with no faithful translation (§3.2) | no |
| 400 | `unsupported_content` | Claude: a content part type it cannot take | no |
| 400 | `invalid_tool_arguments` | Claude: assistant `tool_calls` arguments are not a JSON object | no |
| 400 | `invalid_provider`, `invalid_key` | control routes: unknown provider id, malformed key | no |
| 400 | `key_rejected` | `PUT /control/keys` with `verify`: the provider rejected the key; it was not stored | no: check the key |
| 401 | `missing_credentials` | no bearer credential | no: send the password |
| 401 | `invalid_credentials` | wrong password | no: repeated failures slow down and then block the source |
| 404 | `not_found` | unknown path | no |
| 405 | `method_not_allowed` | wrong method (`Allow` lists the right one) | no |
| 413 | `payload_too_large` | body over 4 MiB (16 KiB for control routes) | no |
| 429 | `auth_backoff` | recent wrong passwords from this source | after `Retry-After` |
| 429 | `source_blocked` | too many wrong passwords: the source is blocked, even for the right password | after `Retry-After` |
| 429 | `auth_busy` | too many concurrent authentications from this source | after `Retry-After` (1 s) |
| 500 | `internal_error` | unexpected gateway failure | maybe |
| 503 | `server_misconfigured` | required configuration missing or invalid (the message names the variables) | no: fix the deployment |
| 503 | `store_unavailable` | the store failed or was slower than 1.5 s; the request was refused | yes, with backoff |
| 503 | `provider_not_configured` | the routed provider has no key | no: configure a key |
| 502 | `provider_auth_failed` | the provider rejected the router's key for it (an upstream 401, or a Gemini 400 saying "API key not valid" or "API key expired", or with reason `API_KEY_INVALID`) | no: fix the provider key |
| 502 | `key_verification_unavailable` | `PUT /control/keys` with `verify`: the check could not be completed; the key was not stored | yes, or store with `"verify": false` |
| 402 | `provider_billing` | upstream 402: credits or billing | no |
| 403 | `provider_forbidden` | upstream 403: permission or moderation | no |
| 429 | `provider_rate_limited` | upstream 429 (the provider's `Retry-After` is passed on) | after `Retry-After` |
| same as upstream | provider's code or type, else `provider_error` | any other upstream 4xx or 5xx (including 529), or a 2xx error body | 4xx no; 5xx/529 yes, with backoff |
| 502 | `provider_error` | the provider answered with something unusable (unreadable body, no event stream for a stream) | yes |
| 502 | `upstream_unreachable` | connection failed, or the provider redirected | yes, with backoff |
| 504 | `upstream_timeout` | no complete response within 295 s | maybe: the provider may have done (and billed) the work |

The gateway itself never answers 403, and a provider key failure is 502, never 401: a 401 always
means the router password, so clients that react to 401 (by rotating credentials or prompting)
are not misled by a provider-side problem.

## 7. Headers

Request headers the gateway reads: `Authorization`, `content-length` (a declared size over the
limit is refused before the body is read), `x-router-cache: off` (Claude only, §3.2), and, only
when proxy headers are trusted (on Vercel, or with `TRUST_PROXY_HEADERS=1`),
`x-vercel-forwarded-for` and then `x-real-ip` for the source address the wrong-password limiter
uses. Bodies are parsed as JSON whatever `content-type` says. Everything else is ignored.

Response headers on protected routes:

| Header | Value |
|--------|-------|
| `x-router-request-id` | the request id (also in the gateway's log line and in events) |
| `x-router-provider` | the provider a chat request was routed to |
| `x-router-error-source` | `gateway` or `upstream`, on errors |
| `x-router-dropped-params` | Claude: comma-separated parameters that were dropped (`temperature, top_p`) |
| `server-timing` | `auth`, `store`, `upstream` (time to the provider's response headers), `gw` (gateway total before the first byte), in ms |
| `x-router-cold` | `1` on the first request a function instance serves (when that request is authenticated); absent otherwise |
| `retry-after` | on 429s, and on 401s after a wait was imposed |
| `cache-control` | `no-store` |

## 8. Limits

| Limit | Value |
|-------|-------|
| Chat request body | 4 MiB (Vercel's request limit is 4.5 MB) |
| Control request body | 16 KiB |
| `model` length | 128 characters |
| Upstream timeout | 295 s (including streaming) |
| Wrong passwords per source | 8 per hour, then a block of 1 h doubling per repeat up to 24 h (defaults; see `SECURITY.md`) |

## 9. Client configuration

curl:

```sh
curl https://<host>/v1/chat/completions \
  -H "Authorization: Bearer $MROUTER_PASSWORD" \
  -H "content-type: application/json" \
  -d '{"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": "Hello"}]}'
```

OpenAI SDK for Python:

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://<host>/v1", api_key=os.environ["MROUTER_PASSWORD"])
stream = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")

# Claude-specific Messages fields go through extra_body:
client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Plan a three-day trip."}],
    extra_body={"anthropic": {"thinking": {"type": "adaptive"}}},
)
```

OpenAI SDK for JavaScript:

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'https://<host>/v1', apiKey: process.env.MROUTER_PASSWORD });
const res = await client.chat.completions.create({
  model: 'openrouter/auto',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(res.choices[0].message.content, res.usage);
```

Hermes and other agents with a custom OpenAI-compatible provider:

- Base URL `https://<host>/v1`, API key = the router password, model = any routable name (§2).
- `GET /v1/models` supplies `context_length` (and `max_output_tokens`), which agents use to size
  their context.
- Provider key failures are 502 `provider_auth_failed`, never 401, so a broken provider key does
  not look like a wrong router password (and does not trigger credential rotation).
- Treat a stream that ends without `data: [DONE]` as failed (§4).

## 10. Local development

`dev/server.js` runs the same handler Vercel runs, and `dev/fake-providers.js` serves fake
Claude, Gemini and OpenRouter APIs on one port with a path prefix per provider, so the router is
pointed at it through the base-URL overrides:

```sh
node dev/fake-providers.js --port 9100 &
ROUTER_PASSWORD=<at least 12 characters> ROUTER_SECRET=<32+ random bytes, base64> ROUTER_STORE=memory \
ANTHROPIC_API_KEY=sk-ant-fake-local GEMINI_API_KEY=AIzaFAKE-local OPENROUTER_API_KEY=sk-or-fake-local \
ANTHROPIC_BASE_URL=http://127.0.0.1:9100/claude GEMINI_BASE_URL=http://127.0.0.1:9100/gemini \
OPENROUTER_BASE_URL=http://127.0.0.1:9100/openrouter node dev/server.js
```

The fakes reproduce each provider's wire format (Anthropic's typed events, Gemini's CRLF event
framing, OpenRouter's comment lines and `usage.cost`). A model name ending in `fake-<scenario>`
selects a behavior, for example `claude-fake-429`, `gemini-fake-midstream-error` or
`vendor/fake-truncated`; the scenarios are listed at the top of `dev/fake-providers.js`.
