# Michael Router — CLI (`mrouter`)

`mrouter` is the command-line client for a Michael Router deployment. It logs in, manages the
provider keys stored on the router, sends prompts, runs smoke tests, and shows usage, cost and
recent errors. It has no dependencies beyond Node.js. The design summary is in `DESIGN.md` §9,
and the HTTP contract it uses is in `API.md`.

## Install

You need Node.js 24. Install from a checkout of the repository, `github.com/mchen04/michael-router`:

```sh
git clone https://github.com/mchen04/michael-router.git
cd michael-router
npm install -g .      # or: npm link
mrouter --version
```

Either one puts `mrouter` on your `PATH` and links it to `cli/mrouter.js` in the checkout. You
can also run `node cli/mrouter.js …` without installing anything.

## Configuration and credential storage

| Path | Contents | Mode |
|------|----------|------|
| `$XDG_CONFIG_HOME/michael-router/` (default `~/.config/michael-router/`) | config directory | `0700` |
| `…/config.json` | `{"url": "https://<host>"}`, written by `login` | `0600` |
| `…/credentials` | the router password, written by `login` | `0600` |

- `login` saves both files, and only after the router has accepted the password.
- Each file is written atomically: a new `0600` file is created exclusively next to the target,
  synced to disk, then renamed over it. A symlink planted at the target is replaced, never
  written through.
- When `login` writes the files, a directory wider than `0700` is tightened. The credentials
  file is never read through a symlink. If other users can read it, every command that uses it prints a warning
  together with the `chmod` command that fixes it.
- `XDG_CONFIG_HOME` is only used when it is an absolute path.

Where the router URL comes from, in order:

1. `--url`
2. `MROUTER_URL`
3. `config.json`

The URL must use `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and
`[::1]`. Credentials, a query or a fragment in the URL are refused. A trailing `/` or `/v1` is
removed, so the OpenAI base URL works as well. The URL is used as written: a backslash,
whitespace, a control character, or a host that the URL parser would read differently from how
it is typed (a percent-encoded or shortened host such as `127.1`) is refused with exit code 2.
Only letter case and a default port (`:443`, `:80`) are normalized.

Where the password comes from:

1. `MROUTER_PASSWORD`, which overrides the stored password.
2. The stored password. It is only sent to the URL it was saved with: running against another
   URL fails with exit code 2 and tells you to log in there or set `MROUTER_PASSWORD`.

Both must be one line of printable ASCII without leading or trailing spaces. A malformed
credentials file fails with exit code 2, before anything is sent, and asks you to run
`mrouter login` again.

## Global flags

| Flag | Meaning |
|------|---------|
| `--url URL` | Router URL for this command |
| `--json` | Print the result as JSON (every command) |
| `--timeout S` | Request timeout in seconds, 0.1 to 3600. Defaults: 30 for control commands, 300 for `ask` and `test`. For a stream it covers the whole stream. |
| `--no-color` | No colors. Colors are only ever used on a terminal, and never when `NO_COLOR` is set. |
| `-h`, `--help` | Help for the command (`mrouter <command> --help` or `mrouter help <command>`) |
| `--version` | Print the version |

Global flags can go anywhere. A command's own flags go after the command. `--` ends the flags,
for example `mrouter ask -- -1 is negative`.

## Commands

### `login [--url URL]`

Reads the password from a hidden prompt, or from stdin when piped. It then checks the password
with `GET /control/health` and only on success saves the URL and the password. `login` takes no
password flag and no arguments.

```sh
mrouter login --url https://router.example.com
mrouter login --url https://router.example.com < password-file
```

### `logout`

Deletes the stored password. It also warns if `MROUTER_PASSWORD` is still set.

```sh
mrouter logout
```

### `status`

Shows the URL and where it came from, whether a password is stored (and for which URL), and the
config paths with their modes. It is local only: nothing is sent, and the password is never
shown.

```sh
mrouter status
```

### `health`

Shows the router's status, version, region, instance (start time, cold or warm), store kind
(`postgres` in a deployment, `memory` in local development) and latency, which providers are
configured, and the round-trip time. `--json` prints the router's answer as is, including the
store's `schema_version` (`API.md` §1).

```sh
mrouter health --json
```

### `keys list`

Shows each provider with whether it is configured, the key source (`store`, `env` or `none`) and
when the stored key was last updated. Key values are never shown.

```sh
mrouter keys list
```

### `keys set <claude|gemini|openrouter> [--no-verify]`

Reads the key from a hidden prompt, or from stdin when piped. It checks the key's shape locally,
then sends it to the router. Unless `--no-verify` is given, the router first checks the key
against the provider's model or key endpoint, which spends no tokens, and stores it (encrypted)
only if the provider accepts it. A refused key never replaces the key in use. The result is one
of:

- `Verified: <provider> accepted the key (HTTP 200).` (exit 0)
- `<provider> rejected the key (HTTP n); it was not stored` (exit 4)
- `could not verify the <provider> key (the provider could not be reached); it was not stored`,
  or `(the provider answered HTTP n)` for a rate limit or provider outage (exit 4). Retry later,
  or store the key with `--no-verify`.

With `--no-verify` the key is stored as given and the output ends `Not verified (--no-verify).`

```sh
mrouter keys set claude
mrouter keys set gemini < gemini-key-file
```

### `keys unset <claude|gemini|openrouter>`

Removes the stored key. The provider then uses its environment key, or has no key at all.

```sh
mrouter keys unset openrouter
```

### `models`

Lists the models the router has metadata and prices for, for the configured providers, with
context length and maximum output.

```sh
mrouter models
```

### `ask [-m MODEL] [-s SYSTEM] [--no-stream] [--max-tokens N] [--show-reasoning] [PROMPT...]`

The prompt is the arguments joined with spaces. When stdin is not a terminal, it is read to its
end and appended after a blank line, or is the whole prompt when there are no arguments. A
program that leaves stdin open without writing to it makes `ask` wait, so run `ask` from such a
program with `</dev/null`. The default model is the Claude smoke model (`smoke_models.claude` in
`src/pricing.json`).

- The reply streams to stdout as it arrives.
- A footer goes to stderr: provider, model, tokens (prompt, cached, completion), cost and
  latency (time to first byte, total).
- Tokens and cost are counted the way the router records them, so they match `usage`. For
  Gemini, hidden thinking tokens count as completion tokens.
- The cost in the footer is labeled `exact` (reported by the provider), `estimated` (from the
  price table) or `unknown`.
- Reasoning text is hidden unless `--show-reasoning` is given; it then goes to stderr.
- On a terminal, control characters other than newline and tab (C0, DEL and C1) are removed
  from the reply and the reasoning, so a reply cannot move the cursor or send escape sequences.
  A pipe or a file gets the text exactly as sent.
- `--json` prints the response JSON instead of the text. For a stream, that is the assembled
  `chat.completion`.
- A stream that fails part-way exits 4 if the provider sent an error, or 5 if it ended without
  `[DONE]`.

```sh
mrouter ask "Explain HTTP/2 in one sentence"
git diff | mrouter ask -m gemini-2.5-flash "Review this diff:"
```

### `test [claude|gemini|openrouter...] [-m MODEL]`

For each provider, sends one non-streaming and one streaming request: the prompt
`Reply with the single word: pong` with `max_tokens` 256, using the provider's cheap smoke model
from `smoke_models` in `src/pricing.json`.

- With no providers given, it tests every provider the router has a key for.
- `-m`/`--model` tests that model on the provider it routes to; a model that cannot be routed
  exits 2 before anything is sent.
- The table shows result, HTTP status, time to first byte, total time, tokens and cost.
- A check that fails, including a connection that breaks part-way through a response, is a
  failed row; the remaining checks still run. Failures are listed below the table, and the
  command exits 4 if any check failed.
- The command stops early when the router cannot be reached at all (exit 5) or refuses the
  password or the rate (exit 3).

```sh
mrouter test
mrouter test gemini --json
mrouter test -m claude-sonnet-4-6
```

### `usage [--days N | --since YYYY-MM-DD]`

Usage per provider and model over UTC days, with a totals row. The default is the last 30 days,
and at most 400 are covered. `--since` must be a real calendar date, not after today (UTC) and
at most 400 days ago; otherwise the command fails with exit code 2 before anything is sent. The
cost column is marked:

| Marker | Meaning |
|--------|---------|
| `$x exact` | reported by the provider |
| `$x est` | estimated from the price table |
| `$x mixed` | some exact, some estimated |
| `unknown` | no price for the model, or no usage reported |
| `≥ $x partial` | some requests have no known cost, so the sum is a lower bound |

A note under the table counts the requests that reported no usage.

```sh
mrouter usage --days 1
mrouter usage --since 2026-10-01 --json
```

### `errors [--limit N] [--kind auth|upstream|gateway]`

Recent error and authentication events, newest first: time, kind, code, status,
provider/model, source and message. The message is the gateway's fixed text for the code (for
example "The provider rate-limited the request."), never the provider's own message: events
keep no request or provider text. `--json` also shows `upstream_status` and `request_id`.
`--limit` takes 1 to 200 and defaults to 50.

```sh
mrouter errors --kind auth --limit 10
```

### `hash-password`

Reads a new router password and prints the value for the server's `ROUTER_PASSWORD_HASH`
variable on stdout. On a terminal the hidden prompt asks for the password twice; it can also be
piped on stdin. Passwords must be at least 12 printable ASCII characters, without leading or
trailing spaces. The hash ends with a newline only when stdout is a terminal.

Give the hash to your hosting provider's CLI on stdin, so it never appears in an argument or in
shell history. Do it in two steps: piping `hash-password` straight into `vercel env add` makes
both programs read the terminal at the same time. On Vercel, store it as a sensitive
environment variable, then delete the file:

```sh
(umask 077; mrouter hash-password > router-password.hash)
vercel env add ROUTER_PASSWORD_HASH production --sensitive < router-password.hash
rm router-password.hash
```

The deploy copy script's `scrypt-hash` transform does the same in one step (`DEPLOY.md` §4). The
server ignores one trailing newline on the variable, so a value saved with one still works.

### `help [command]`

Same as `mrouter <command> --help`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error: an unexpected response, a router-side 4xx/5xx other than 401/429 (including `ask` with a model the router cannot route), or a Vercel platform error (a response with `x-vercel-error` and no router headers, printed with its HTTP status and code). The platform error is not 4 because no provider was involved: the request never reached the router, or the router function itself failed (for example `FUNCTION_INVOCATION_TIMEOUT`). |
| 2 | Usage: unknown command or flag (with a one-line hint), bad flag value, missing URL or password, or invalid input, including `test -m` with a model that cannot be routed (checked locally; nothing is sent) |
| 3 | The router refused the request: wrong password (401), or slowed down or blocked (429). The code and `Retry-After` are printed. |
| 4 | Upstream or provider error: the provider, HTTP status, provider status, code and message are printed, plus `Retry-After` when the provider sent one. Also used when a smoke test fails or a key is rejected or cannot be verified (the key is then not stored). |
| 5 | Network: router unreachable, timed out, answered with a redirect, or the connection or stream broke before the response was complete |
| 130 | Cancelled with Ctrl-C at a prompt |

## Secret handling guarantees

- **Never from arguments.** The router password and provider keys are read only from a hidden
  prompt or from stdin.
  - `login` and `hash-password` take no arguments.
  - `keys set` refuses an extra argument, or a provider argument that looks like a key, with
    `provider keys are never accepted as arguments; pipe them on stdin or use the prompt`.
  - Flags such as `--password` or `--key` do not exist. Unknown commands and flags are reported
    without echoing secret-looking text.
- **Hidden prompt.**
  - The terminal is switched to raw mode before the prompt is shown, so nothing typed is echoed.
  - Backspace and Ctrl-U edit the input, and arrow keys and other escape sequences are ignored.
  - Enter or Ctrl-D submits. Ctrl-C restores the terminal and exits 130.
- **Piped input.** All of stdin is read and one trailing newline is removed. Empty or
  multi-line input is refused.
- **Never printed.**
  - Secrets never appear in stdout, stderr, `--json` output or error messages.
  - As a last line of defense, every error message, table and `--json` output (including the
    failure text in `test`) is scrubbed of the values read in that run. Only the streamed
    model reply is written as received.
  - Text from the server has control characters removed before it is printed. Model output is
    filtered the same way on a terminal (see `ask`).
- **No redirects.** Every request uses `redirect: "error"`, so the password is never sent on to
  another origin. A redirect fails with exit code 5.
- **Bound to one URL.** The stored password is only sent to the URL it was saved for. It is only
  sent over `https://`, or `http://` to the local machine.
- **Stored privately.** The config directory is `0700` and its files are `0600`, written
  atomically, with a warning if the credentials file is readable by others.
