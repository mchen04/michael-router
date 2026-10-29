# Use Michael Router

Send requests to `https://michael-router.vercel.app/v1` in OpenAI Chat Completions format.
A successful request returns a chat completion or a complete event stream ending in `data: [DONE]`.

## Authentication

Set `OPENAI_BASE_URL=https://michael-router.vercel.app/v1` and set `OPENAI_API_KEY` to the password you received.
Read both values from the local environment. Replace `<password>` placeholders locally; never commit a real password.
Send `Authorization: Bearer <router password>` on every API request.
Never hard-code, print, commit, or include the password in a command argument.
Do not send provider keys. The router holds them.
Stop if the password is missing. Ask the user to set it through a secure channel.

## Model routing

The first matching rule wins:

- IDs containing `/` route to OpenRouter. Use only IDs ending in `:free` or `openrouter/free`.
- `claude-*` routes to Claude. Example: `claude-haiku-5-5`.
- `gpt-*` and reasoning IDs such as `o3` or `o4-mini` route to OpenAI. Example: `gpt-6.1-sol`.
- `gemini-*` routes to Gemini. Example: `gemini-3.5-flash-lite`.

Paid OpenRouter IDs are refused. Do not retry with a paid ID.
The free list changes. Read [Providers and models](https://michael-router.vercel.app/docs/providers.html) for the catalog.
`GET /v1/models` lists known models for configured providers, with context and output limits when known.

## OpenAI SDK setup

Install the `openai` package for your language. Use the password already set in the environment.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["OPENAI_BASE_URL"],
    api_key=os.environ["OPENAI_API_KEY"],
)
response = client.chat.completions.create(
    model="claude-haiku-5-5",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});
const response = await client.chat.completions.create({
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0].message.content);
```

## Anthropic-style clients and coding agents

Configure an OpenAI-compatible adapter and choose a `claude-*` model.
Send `messages` through `client.chat.completions.create`, as in the Python example above.
The router translates OpenAI messages and tools into Anthropic's Messages API.
Do not call `/v1/messages` or send `x-api-key`; this router does not expose the native Anthropic API.
Pass Claude-only options through Python's `extra_body={"anthropic": {...}}` when needed.
Leave `anthropic.thinking` off in tool loops; signed thinking blocks cannot round-trip through this format.

Set these variables before running any example:

```sh
export OPENAI_BASE_URL=https://michael-router.vercel.app/v1
export OPENAI_API_KEY='<password>'
```

For Codex or Claude Code, use these variables only with an adapter that sends Chat Completions.
These variables alone do not convert a native client to that protocol.
This router does not expose the Responses API or the native Anthropic Messages API.
Codex provider settings may also require an explicit `env_key`; see [official environment documentation](https://learn.chatgpt.com/docs/config-file/environment-variables).

## Streaming

Set `stream: true`; read `choices[0].delta.content` as text arrives.
Use `stream_options: {"include_usage": true}` to request usage.
Skip chunks with empty `choices`; they can contain usage.
A stream error can follow HTTP 200. Treat an error event or missing `data: [DONE]` as failure.
Do not report incomplete output as a completed answer.

## Errors

Read `error.code`, `error.message`, and `x-router-request-id`.

- 400: Fix the model, JSON, or unsupported parameter. Do not repeat unchanged requests.
- 401: Stop. The router password is missing or incorrect. Do not rotate provider keys or retry repeatedly.
- 402 or 403: Ask the router owner to fix provider billing or access.
- 404 or 405: Fix the API path or HTTP method.
- 413: Reduce the body below 4 MiB for chat.
- 429: Wait for `Retry-After` before retrying. This includes authentication blocks and provider rate limits.
- 500: Retry with backoff. Report repeated failures.
- 502 `provider_auth_failed`: Ask the owner to fix the provider key. Keep the router password unchanged.
- 502 `provider_error` or `upstream_unreachable`: Retry with backoff.
- 503 `provider_not_configured`: Ask the owner to configure that provider, or choose a configured provider.
- 503 `server_misconfigured`: Ask the owner to fix deployment settings.
- 503 `store_unavailable`: Retry with backoff.
- 504 `upstream_timeout`: Check before retrying; the provider may already have billed the request.

Read [API reference](https://michael-router.vercel.app/docs/api.html) for the full client contract.
