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

- Claude: `claude-opus-5-5`. Names start with `claude-`.
- OpenAI: `gpt-6.1-sol`. Names start with `gpt-`, or use `o3`.
- Gemini: `gemini-3.5-flash-lite`. Names start with `gemini-`.
- OpenRouter free: `openrouter/free`. IDs contain `/` and must end in `:free`, except this default.

Read [tested models](https://michael-router.vercel.app/docs/providers.html) before choosing another ID.
Never use a paid OpenRouter ID.

Effort defaults to medium for Claude, OpenAI, and Gemini.
Set `"reasoning_effort": "low" | "medium" | "high"` to change it; higher costs more.
OpenRouter keeps its own default.

## Handle replies

Set `stream: true` to stream. Read `choices[0].delta.content` and skip empty `choices` arrays.
Treat an error event or missing `data: [DONE]` as failure.

Stop on 401 and check the password. Do not retry repeatedly.
For 400, fix the request or choose a tested model.
For 429, wait for `Retry-After`.
For 502 or 503, retry later. Contact the owner if the error persists.
Keep the password unchanged for `provider_auth_failed` or `provider_not_configured`.
Read the [API guide](https://michael-router.vercel.app/docs/api.html) for error details.
