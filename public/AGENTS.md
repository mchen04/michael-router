# Use Michael Router

Read `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment.
Set the base URL to `https://michael-router.vercel.app/v1`.
Use the shared password as the API key. Never hard-code, print, or commit it.
Send `Authorization: Bearer <password>` with every request.

Call `POST /v1/chat/completions` with `model` and `messages`.
Use a client or SDK that supports OpenAI Chat Completions.
Do not call the Responses API or native Anthropic Messages API.

## Choose a model

Use these recommended defaults:

- Automatic: `automatic` tries `claude-opus-5-5`, then `gpt-6-astra`, then `deepseek-v4.1-flash` only for availability, rate or quota failure.
- Included models: exactly `kimi-k3.1-pro` or `deepseek-v4.1-flash`.
- Claude: `claude-opus-5-5`. Names start with `claude-`.
- OpenAI: `gpt-6.1-sol`. Names start with `gpt-`, or use `o3`.
- Gemini: `gemini-3.5-flash-lite`. Names start with `gemini-`.
- OpenRouter free: `openrouter/free`. IDs contain `/` and must end in `:free`, except this default.

Group access being free does not make Claude or OpenAI calls free to Michael, the owner.
Included models: zero marginal cost under a separate subscription plan, unmetered, still subject to the upstream provider's rate and capacity limits.

Read [tested models](https://michael-router.vercel.app/docs/providers.html) before choosing another ID.
Never use a paid OpenRouter ID.

Effort defaults to medium for Claude, OpenAI, and Gemini.
Set `"reasoning_effort": "low" | "medium" | "high"` to change it; higher costs more.
OpenRouter and the included models keep their own defaults.

## Handle replies

Set `stream: true` to stream. Read `choices[0].delta.content` and skip empty `choices` arrays.
Treat an error event or missing `data: [DONE]` as failure.
Automatic selection skips missing keys and active provider cooldowns.
It stops on invalid requests, authentication, permission, context limits, safety refusals and successful replies.
Fallback is possible only before the first byte, including comments, role chunks and tool calls.
After that byte an error ends the stream; it never restarts on another provider.
The router never executes tools or replays a streamed tool call.
Explicit model names have no fallback and bypass cooldowns.
Read the answering model from `model` and `x-router-model`, its provider from `x-router-provider`,
and earlier skips from `x-router-fallback`.
Cooldowns honor valid `Retry-After` delays in full, with a 1 second minimum.
Missing or malformed values use 30 seconds. Extreme values are capped only at the largest representable end time.
Contact the owner to clear a stuck cooldown. Explicit model requests are never blocked by cooldowns.
For `all_providers_unavailable`, wait for the returned `Retry-After` before a new request.

Stop on 401 and check the password. Do not retry repeatedly.
For 400, fix the request or choose a tested model.
For 429, wait for `Retry-After`.
For 502 or 503, retry later. Contact the owner if the error persists.
Keep the password unchanged for `provider_auth_failed` or `provider_not_configured`.
Read the [API guide](https://michael-router.vercel.app/docs/api.html) for error details.
