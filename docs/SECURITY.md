# Michael Router — security notes

Scope: the platform layer (authentication, limiter, store, key storage, events, logging, control
routes), the proxy (forwarding to the providers, streaming, usage recording), the deployment
tooling in `scripts/` (§9) and the PostgreSQL store as a trust boundary (§10). The settled
interfaces are in `DESIGN.md`; this file explains the security reasoning behind them and what the
implementation does and does not protect against.

## 1. Threat model

Assets, in order of value:

1. **Provider API keys** (Anthropic, Gemini, OpenRouter). They spend the deployment owner's money.
2. **The router password.** Anyone holding it can spend through the keys and read usage.
3. **Usage and event data** (models used, token counts, costs, client IPs of failed logins).

Adversaries considered:

| Adversary | Capability | Mitigation |
|-----------|------------|------------|
| Internet scanner / password guesser | sends arbitrary requests to the public URL | bearer password verified with scrypt; per-source slowdown and blocking shared across instances (§3); route table not enumerable without the password |
| Concurrent guesser | many parallel requests from one source, spread over instances | inflight cap per source in the shared store; evaluations bounded (§3.3) |
| Distributed guesser | many source IPs | each source gets its own budget (known limitation, §8) — the password must be long and random |
| Log / store reader | read access to Vercel logs or the PostgreSQL database | no secrets in logs; provider keys stored only as AES-256-GCM ciphertext under a key derived from `ROUTER_SECRET`; source ids are keyed HMACs (§10) |
| Browser-based attacker | tricks the owner's browser into sending requests | no CORS headers; the credential is a bearer header a browser never attaches automatically; strict CSP and `frame-ancestors 'none'` on the static page |

Out of scope: compromise of the Vercel account or its environment variables (they contain the
password hash or password, `ROUTER_SECRET`, the env provider keys and the database URL),
compromise of the database provider's account, compromise of the owner's
machine or of the CLI credentials file, and the upstream providers themselves.

## 2. Authentication

- Credential: `Authorization: Bearer <password>` only. Any other scheme (Basic, `x-api-key`, an
  empty bearer) counts as no credential: 401 `missing_credentials`, no store call, not counted.
- `ROUTER_PASSWORD_HASH` is `scrypt$<logN>$<r>$<p>$<salt>$<hash>` (base64url, salt ≥ 16 bytes,
  hash 32–64 bytes). Accepted parameters: logN 10–17, r 1–16, p 1–4, and 128·N·r ≤ 256 MiB, so
  a hostile or mistyped hash cannot make each verification allocate unbounded memory. New hashes
  (`hashPassword`, used by `mrouter hash-password`) use logN 15, r 8, p 1 (32 MiB, tens of ms).
- Comparison uses `crypto.timingSafeEqual` on equal-length buffers.
- Exactly one trailing line ending (`\n` or `\r\n`) is removed from `ROUTER_PASSWORD_HASH` and
  `ROUTER_PASSWORD` before they are checked, so a value piped into `vercel env add` with its
  newline still works. Anything more (a second newline, other whitespace) is kept and makes a
  hash malformed (503 `server_misconfigured`) or becomes part of the password.
- `ROUTER_PASSWORD` (the password itself, at least 12 characters) is accepted instead of the hash;
  exactly one of the two may be set. The presented and configured values are each reduced to
  HMAC-SHA256(random per-instance key, value) and the 32-byte digests compared with
  `timingSafeEqual`, so neither the password's length nor a matching prefix shows in the timing.
  This skips scrypt, which only matters to someone who can read the environment (they get the
  password itself rather than a hash to crack); online guessing is bounded by the limiter either
  way. The hash remains the recommended form.
- Per-instance cache: credentials that verified correctly are remembered as
  HMAC-SHA256(random per-instance key, presented) — at most 4 entries, never the plaintext, never
  wrong credentials. The cache only skips scrypt; the limiter precheck still runs on every
  request, so a blocked source is refused even with a cached correct password.

## 3. Wrong-password limiter (`src/limiter.js`)

### 3.1 Source identity

`S = HMAC-SHA256(source-key, normalized IP)[0..16]` as hex, where `source-key` is
HKDF-SHA256(`ROUTER_SECRET`, info `source-id-v1`). IPv4 addresses (including IPv4-mapped IPv6)
use the full address; IPv6 uses the /64 prefix, so one subscriber's /64 is one source. Anything
unparseable shares the `unknown` bucket. Raw IPs never appear in store keys; the display form
(`203.0.113.7` or `2001:db8:1:2::/64`) is stored only inside auth events.

The client IP comes from the TCP socket, or — only when `TRUST_PROXY_HEADERS=1` or on Vercel
(`VERCEL` set) — from `x-vercel-forwarded-for`, then `x-real-ip`. `X-Forwarded-For` is never read.

### 3.2 Algorithm

State: one `michael_router.auth_sources` row per source `S` (DESIGN §2, §5.2): the failure count
and its window end, the wait end, the block end, the strike count and its end (7 days), and the
inflight count and its end (60 s). End times are epoch milliseconds from the router's clock; a
field counts only while its end time is later than now, so each one expires on its own. Every
step is one SQL statement that locks only that source's row (`INSERT … ON CONFLICT DO UPDATE`, or
`SELECT … FOR UPDATE` in a release), so concurrent requests for one source serialize on the row
across all instances and each sees the latest committed counts.

For every protected request that presents a credential:

1. **Precheck**, one statement and round trip: take an inflight slot (the count restarts at 1
   when its end time has passed; the end becomes now + 60 s) and return the active block end,
   wait end and failure count, the new inflight count and every provider key record. Rejections,
   in order: block active → 429 `source_blocked` (Retry-After = remaining block); wait active →
   429 `auth_backoff`; failures ≥ `AUTH_MAX_FAILURES` → 429 `source_blocked`; inflight >
   `AUTH_MAX_INFLIGHT` → 429 `auth_busy`. A rejected request releases its inflight slot in the
   background and **never evaluates the password**.
2. **Verify** with scrypt (or the verified cache).
3. **Correct** → release the inflight slot (never below 0; the row is deleted once nothing in it
   is active), continue to the route.
4. **Wrong** → one statement: `f` = (window active ? count : 0) + 1, the first failure fixing the
   window end at now + `AUTH_WINDOW_SECONDS` (a fixed window); release the inflight slot; at
   exactly `f = AUTH_MAX_FAILURES`, strikes = (active ? strikes : 0) + 1 with the end now + 7 days.
   The row lock gives each failure a distinct `f`, so exactly one request per window makes that
   transition, even in a concurrent burst; requests with `f > AUTH_MAX_FAILURES` only get 401
   (the precheck already refuses the source on `fail ≥ AUTH_MAX_FAILURES` and on the block). A
   second statement sets the wait to `min(AUTH_BACKOFF_BASE_MS · 2^(f−2), AUTH_BACKOFF_MAX_MS)`
   from `f = 2` and, on a strike, the block to `min(AUTH_BLOCK_SECONDS · 2^(strikes−1), 86400)` s,
   as end times that never shorten one already set. An auth event is recorded, the response is
   delayed by `min(wait, 1000)` ms, then 401 `invalid_credentials` (with Retry-After when a wait
   or block was set).

Defaults: 8 failures per 3600 s window, 1 h first block doubling per strike up to 24 h,
32 concurrent evaluations, backoff 250 ms doubling to 30 s.

### 3.3 The bound

A password is evaluated only after a precheck that saw no block, no wait, `fail <
AUTH_MAX_FAILURES` and an inflight count ≤ `AUTH_MAX_INFLIGHT`. So at any moment at most
`AUTH_MAX_INFLIGHT` evaluations per source are past the
precheck and not yet counted, across all instances: each precheck's inflight count comes from
one locked row, so two prechecks never see the same count. Every evaluation that started before the
failure counter reached `AUTH_MAX_FAILURES` is either among the first `AUTH_MAX_FAILURES − 1`
counted failures or was in flight at that moment. Hence, per source and window:

> wrong-password evaluations ≤ `AUTH_MAX_FAILURES + AUTH_MAX_INFLIGHT`,

after which the source is refused — including the correct password — until the block (and the
failure window) expires. The integration test sends 200 concurrent wrong guesses for one source
split across two server processes sharing one PostgreSQL database and asserts this bound, that every other
request got a 429, and that the correct password is then refused with `source_blocked`.

### 3.4 Fail closed

- **Store unavailable** — any store error (including a schema that is missing or older than the
  code needs), a client not acquired within 5000 ms, or statements slower than 1500 ms — → 503
  `store_unavailable`. On the precheck this happens before the password is
  evaluated (tests prove it with a verifier spy and with a wrong password that yields 503, not 401).
- **Misconfiguration** — a missing or malformed `ROUTER_PASSWORD_HASH` / `ROUTER_PASSWORD` (or
  both set, or a password shorter than 12 characters), `ROUTER_SECRET` (< 32 bytes), store
  variables, limiter tunables, provider env keys or base-URL overrides — makes every protected
  route answer 503 `server_misconfigured`, naming the variables, never their values. The static
  landing page keeps working.
- `ROUTER_STORE=memory` is refused when `VERCEL` is set or `NODE_ENV=production`. There is no
  silent fallback to the in-process store anywhere: without `ROUTER_STORE=memory` or a database
  URL the router is misconfigured (a per-process store would void the cross-instance bound).
- In production, provider base URLs must be `https:` and the database URL must require TLS (§10).
- Every credentialed outbound HTTP request (the providers, including key verification) is made
  with `redirect: 'error'`: a redirect is never followed, so neither a provider key nor a prompt
  can be re-sent to another origin; the proxy answers 502 `upstream_unreachable`. The store
  speaks the PostgreSQL protocol to the host in its URL only.

## 4. Provider keys at rest (`src/keys.js`)

- Effective key = store override > env var > none.
- Store record: one `michael_router.provider_keys` row per provider (`provider` = provider id,
  `record` = `{"v":1,"iv","ct","tag","updated_at"}`, base64url, and an `updated_at` column). AES-256-GCM with a fresh 96-bit IV per
  record, 128-bit tag, key = HKDF-SHA256(`ROUTER_SECRET`, info `provider-keys-v1`), and
  **AAD = provider id**, so a record moved to another provider's row fails authentication.
- A record that fails to decrypt (moved, tampered, or written under another `ROUTER_SECRET`)
  makes that provider *not configured* — it does not silently fall back to the env key the
  override was meant to replace — and records one `provider_key_undecryptable` gateway event per
  instance. Deleting the override restores the env key.
- Decrypted values are cached in memory keyed by provider + exact record (max 32 entries).
- Keys must be 8–512 printable non-space ASCII characters; error messages never echo the key.
  `PUT` never echoes the key; `GET /control/keys` returns only
  `{provider, configured, source, updated_at}` — no values, prefixes or fingerprints.
- With `verify: true`, `PUT` checks the key with the provider *before* writing it: a key the
  provider rejects (400 `key_rejected`) or that cannot be checked (502
  `key_verification_unavailable`) is not stored, so it never replaces the working key.
- Rotating `ROUTER_SECRET` orphans every stored override (they become undecryptable) and resets
  source ids; tooling never rotates it.

## 5. What is never logged or stored

Logs, events and the store keep allowlisted metadata only (codes, statuses, provider ids, routed
model names, timings, request ids, failed-login source addresses) and gateway-authored static
text. They never hold text from a request, a provider or an exception: no request bodies,
prompts, completions or request headers, no provider error messages (they can quote the prompt),
no exception messages. No response, log line, event or store value contains the password
(correct or guessed), the password hash, a provider key, `ROUTER_SECRET`, a database URL or its
password. The
only place request or provider text appears is the response to the request that sent it: a
gateway or provider error message, scrubbed of secrets, goes back to that client.

The integration test (`test/integration/logging.test.js`) uses sentinel values for all of these,
the fake providers and real dev-server processes:

- one configured with `ROUTER_PASSWORD_HASH` and a task-local PostgreSQL database runs every kind
  of request —
  control routes, proxied successes and streams for all three providers, each upstream error
  class, in-stream errors, truncation, timeouts, and a fake provider that echoes the key it
  received. No sentinel may appear in its stdout, stderr, any response, the event list or a full
  dump of the router's tables (ciphertext is expected), and the echoed key must come back as
  `[redacted]`;
- one configured with `ROUTER_PASSWORD_HASH` and its own database sends a marker in the
  prompt to fake providers whose errors quote it (an HTTP error and an in-stream error for each
  provider, OpenRouter's 200-with-error body) and in client fields the gateway's own errors
  quote. The marker must reach the client and must not appear in stdout, stderr, the event list
  or the store dump;
- one configured with `ROUTER_PASSWORD` and the in-process memory store (not dumped) runs
  successes, wrong passwords, the echoing provider and the event list. No sentinel may appear in
  its stdout, stderr or any response.

- **Logs** (`src/log.js`): one JSON line per API request with only `request_id, route, method,
  status, provider, model, duration_ms, upstream_ms, store_ms, error_code, cold`; unknown and
  non-primitive fields are dropped and string values are scrubbed. `model` is logged only once
  it passed the model-name rule and routed. Unexpected exceptions log a separate line with only
  `request_id, exception` (the error name) — never the message or the stack.
- **Events** (`michael_router.events`, newest 200): `{ts, kind, code, status, upstream_status?, provider?,
  model?, message, source?, request_id}`; `source` only on auth events; `message` is a fixed
  gateway sentence chosen by `code` (`src/events.js`), never provider or request text. Recorded: wrong passwords (auth), gateway errors after successful
  authentication, undecryptable key records, and upstream errors (including errors inside a
  stream). Not recorded: requests without credentials and limiter 429s, so an unauthenticated
  flood cannot cost a store write per request or churn the list beyond the per-source failure
  budget.
- **Redaction** (`src/redact.js`) replaces configured secrets (provider keys from env and store,
  `ROUTER_SECRET`, the database URLs and the passwords in them, password hash or
  `ROUTER_PASSWORD`), the presented bearer value,
  and patterns: `sk-ant-…`, `sk-or-…`, `AIza…`, `Bearer …`, hex runs ≥ 32 and base64/base64url
  runs ≥ 40 that mix digits with upper- and lower-case letters.

## 6. HTTP surface hardening

- Protected responses carry `Cache-Control: no-store` and `x-router-request-id`; no CORS headers
  are ever sent, and preflight `OPTIONS` is just another unauthenticated request (401).
- Unknown paths and wrong methods under `/v1/` and `/control/` answer 404/405 only after
  authentication, so the route table cannot be enumerated.
- Static responses (and, on Vercel, all responses) carry the `vercel.json` headers: strict CSP
  (`default-src 'none'`, `frame-ancestors 'none'`, no inline script or style), `nosniff`,
  `Referrer-Policy: no-referrer`, a deny-all `Permissions-Policy`, `X-Robots-Tag: noindex`.
  `dev/server.js` reads the same headers from `vercel.json`.
- Control request bodies are capped at 16 KiB (413), must be a JSON object (400).

## 7. Proxy surface (`src/proxy.js`, `src/providers/*`)

- **Nothing from the client reaches a provider** except the body: the upstream request carries
  only `content-type`, the provider's auth header (the effective key, never the router password)
  and the gateway's `user-agent`. Client authorization, cookies, IP and SDK headers are dropped.
  For Claude the body is rebuilt by the adapter; for Gemini and OpenRouter it is forwarded as is.
- **Upstream error messages are scrubbed** with the same redactor (configured keys plus key-shaped
  patterns) and truncated before they reach the response, so a provider that echoes the key it
  received does not leak it. They reach only that response, never an event or a log line. Errors inside a stream are not relayed raw: the gateway
  emits one normalized, scrubbed error chunk and ends the stream.
- **A provider key failure is 502 `provider_auth_failed`, never 401**, so a 401 always means the
  router password and clients do not rotate or re-prompt for the wrong credential.
- **Bounded work per request**: bodies over 4 MiB are refused before parsing, the upstream request
  has a 295 s total timeout, error bodies are read up to 64 KiB, and a client disconnect aborts
  the upstream request (no tokens are spent on a response nobody reads).
- **Usage recording** stores only counters per day, provider and model (token counts, costs) —
  never content. It runs in the background and never fails the request.
- Key verification (`PUT /control/keys/:p` with `verify: true`) calls only the provider's
  model-list endpoint (no token spend), runs before the key is stored, and reports only the
  outcome and the upstream status.

## 8. Known limitations

- **Distributed attackers** each get the full per-source budget (`AUTH_MAX_FAILURES +
  AUTH_MAX_INFLIGHT` evaluations per window, then exponentially longer blocks). An attacker with
  many IPv4 addresses or many /64s scales linearly. The defense is a long random password
  (≥ 128 bits), which makes online guessing hopeless regardless of source count. There is no
  global (all-sources) limit, so the limiter cannot be used to lock the owner out from their own
  IP.
- **IP header trust on Vercel**: the source id relies on Vercel setting `x-vercel-forwarded-for`
  / `x-real-ip` and not forwarding client-supplied values (documented platform behavior). If the
  router were deployed behind another proxy with `TRUST_PROXY_HEADERS=1`, a client could choose
  its own source id. Requests without either header share the `unknown` bucket.
- **Per-instance verified-credential cache**: a warm instance skips scrypt for a password it
  already verified. Changing `ROUTER_PASSWORD_HASH` or `ROUTER_PASSWORD` requires a redeploy,
  which starts new instances with empty caches, so this does not extend an old password's life.
- **Strikes count blocks, not failures**: a concurrent burst (for example the owner's own
  misconfigured client) is one strike and one `AUTH_BLOCK_SECONDS` block, not an escalation to
  24 h. If the one request that reaches `f = AUTH_MAX_FAILURES` dies between its failure statement
  and the one that sets the block, the source is still refused for the rest of the failure
  window (`fail ≥ max`) and the strike is counted, but no block follows the window. A 401 with `f > AUTH_MAX_FAILURES` carries only the backoff
  Retry-After; the next request gets the exact remaining block time with its 429.
- **Inflight slots** are released in the background; an instance killed between precheck and
  release leaks a slot until the count's 60 s end time passes (each precheck extends it). A
  release never takes the count below 0, and a precheck after the end time restarts it at 1, so
  a late release (a stalled instance) cannot leave the count negative and let later requests
  exceed `AUTH_MAX_INFLIGHT`.
- **Retry-After** for a failure count at the limit without a block key is the window length (an
  upper bound); the block key's own value gives an exact remaining time.
- **Event list churn**: distributed wrong guesses can push older events out of the 200-entry list.
- **Store compromise** (the database URL, or the database provider's account) exposes usage,
  events (with failed-login source addresses) and ciphertext, but not provider keys without
  `ROUTER_SECRET`. A writer can also reset the limiter for every source or delete key overrides
  (§10).
- The dev server is for local use and tests only; the in-process memory store is refused in
  production.

## 9. Deployment tooling (`scripts/`)

The scripts that move secrets into Vercel, check a deployment and scan the repository follow the
same rules as the gateway: a secret goes from its source to the stdin of the program that needs
it, and nowhere else. The procedure that uses them is `DEPLOY.md`. A deployment uploads only the
`.vercelignore` allowlist (`api/`, `src/`, `public/`, `package.json`, `package-lock.json`,
`vercel.json`, without secret-shaped names such as `.env*` or `*.hash`), so local secret files in
a checkout are not uploaded (`DEPLOY.md` step 5).

### 9.1 Key copy (`copy-keys-to-vercel.mjs`)

- **Explicit sources only.** A manifest names, per variable, exactly one source: a keychain item
  (`security find-generic-password … -w`), a 1Password reference (`op read`), one variable of a
  named dotenv file, stdin (at most one entry), one variable of a dotenv document on stdin
  (`stdin-env`: stdin is read once and shared by every such entry, never together with a `stdin`
  entry), or random bytes (`ROUTER_SECRET`, only if absent). Nothing is discovered or searched
  for. Unknown keys anywhere, unknown or repeated variable names (only the eight variables listed
  in `DEPLOY.md` steps 3.2 and 4 are accepted), a second `stdin` entry, `stdin` with `stdin-env`,
  and `ROUTER_PASSWORD_HASH` together with `ROUTER_PASSWORD` are refused before anything runs. So
  is a source descriptor (keychain service or account, `op://` reference, file path or variable)
  that the scrubber would change, that is, key-shaped text pasted where a name belongs; the error
  does not repeat it.
- **Pinned project.** The manifest must name the target project (`"project": {"orgId",
  "projectId"}`, Vercel id shapes only). The plan prints both ids and its digest covers them.
  Every `vercel` child runs from the repository root with `VERCEL_ORG_ID` and
  `VERCEL_PROJECT_ID` set to the pinned ids, which the Vercel CLI prefers to any
  `.vercel/project.json` link; the operator's own values are never passed on. With `--check` or
  `--yes`, a different `VERCEL_ORG_ID` or `VERCEL_PROJECT_ID` in the operator's environment, or a
  repository `.vercel/project.json` that links another project (or cannot be parsed), stops the
  run before any source is read (`STOPPED at project pin: …`, exit 3). A value that is not shaped
  like a Vercel id is not echoed.
- **Prohibited locations.** `file` sources must be absolute (`~/` is expanded) and may not lie
  under agent and tool homes (`.hermes`, `.claude`, `.codex`, `.cache` in both `$HOME` and the
  account's home directory from the user database, so a changed `$HOME` does not hide them), temp
  directories (`/tmp`, `/private`, `/var/folders`, `$TMPDIR`) or `/etc`, nor be a shell rc file.
  This is checked lexically, again after `realpath`, and by device and inode: every parent
  directory of the opened file is compared with every root, so a root reached under another
  name (an APFS firmlink such as `/System/Volumes/Data/private`, a bind mount) is refused. The
  file is opened without following a final symlink, must be a regular file with exactly one hard
  link (another link could sit under a prohibited root), and must still be the file at the
  resolved path. Dotenv parsing does no expansion and no evaluation; a variable set twice is
  refused rather than guessed.
- **No secret in argv, child environments, output or files.** Values are read from a child's
  stdout pipe, a file or stdin, kept in `Buffer`s that are zero-filled after use, and written to
  `vercel env add <NAME> production --force --sensitive` on its stdin. Every managed variable is a
  secret, so a Vercel CLI whose `env add --help` does not list `--sensitive` stops the run before
  any source is read. `onlyIfAbsent` entries (`ROUTER_SECRET`) never use `--force`: if
  `vercel env ls` missed an existing variable, Vercel refuses the add and the entry is skipped,
  so the secret is never replaced.
  Child processes get only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`,
  `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `OP_ACCOUNT` (when set), plus the pinned
  `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` for `vercel`, so no unrelated credential in the
  operator's environment reaches them.
  Their output is never printed: `vercel env ls` is reduced to variable names, and a failing
  child contributes one line, scrubbed of the value and of key-shaped text (`src/redact.js`). The
  script writes no files.
- **Validated values.** One trailing newline is removed; the value must be 1–4096 printable ASCII
  bytes without whitespace, and pass the server's own check for its variable (provider key shape,
  password length, a parseable `scrypt$` hash, a `ROUTER_SECRET` of at least 32 bytes, a
  database URL the router accepts in production). A database URL must also hold a host, a user
  and a password and set `sslmode` `require` or `verify-full`; on a Neon host,
  `DATABASE_URL_POOLED` must be the `-pooler` endpoint and `DATABASE_URL` the direct one. The
  reason never names a part of the URL. The `scrypt-hash` transform uses `hashPassword` from `src/auth.js`, so the
  uploaded hash is exactly what the server verifies.
- **Fail fast, no fallback.** The first failure of any kind (missing source, a guard refusal from
  `security` or `op`, a validation failure, a `vercel` error) stops the run with
  `STOPPED at <ENV> (source <type:name>): <reason>` and exit 3; no other source is tried and no
  later entry runs. Before transferring, the script stops if the run would leave both password
  variables in the environment, and after it, it exits 0 only if every manifest name is present.
- **Reviewable.** Without `--yes` it prints the plan (the project, names and source descriptors,
  never values) with a SHA-256 digest of its canonical form, and reads nothing; `--check` reads and validates
  every source and transfers nothing.
- Limits: a value necessarily exists in the script's memory while it is checked and sent, and
  JavaScript strings made from it (for validation, hashing and scrubbing) cannot be zeroed.
  The script trusts the `vercel`, `security` and `op` executables found on `PATH`.

### 9.2 Secret scan (`scan-secrets.mjs`, `npm run scan`)

- Scans the working tree (every entry of `git ls-files -co --exclude-standard`: the path of each,
  including symlinks, gitlinks and files deleted from disk; the content of regular files and the
  target text of symlinks, never followed), every path of every commit's tree (each distinct path
  once, separately from the blob deduplication, so a renamed file's new name is scanned), every
  object reachable from any ref (`git rev-list --objects --all`: also blobs and trees that a ref
  or tag points to directly, and tags reached only through another tag), each distinct blob once
  through one `git cat-file --batch`, and every commit and tag object (message and headers).
- Pattern rules: real-shaped Anthropic keys (`sk-ant-api…`/`sk-ant-admin…` with at least 80 key
  characters) and OAuth tokens (`sk-ant-oat…`/`sk-ant-ort…`), OpenRouter (`sk-or-v1-` plus 64 hex)
  and Google (`AIza` plus 35) keys; complete `scrypt$` hashes (salt at least 16 bytes, hash at
  least 32, the server's own minimums), also with escaped (`\$`) or URL-encoded (`%24`)
  separators; PEM private-key headers; token-shaped values assigned to
  `UPSTASH_REDIS_REST_TOKEN`, `KV_REST_API_TOKEN`, `VERCEL_TOKEN` or `--token` (by context, to stay
  conservative); credentials in `redis://`, `rediss://`, `postgres://` and `postgresql://` URLs
  (a password of at least 8 characters; not reported: a password that is a template placeholder
  such as `${password}`, and database URLs on a host under the reserved `.test` top-level domain,
  which never resolves: test fixtures); absolute home paths
  (`/Users/<name>`, `/home/<name>`, with or without a trailing slash, also as `HOME=…`, not inside
  URLs or longer paths). Test fixtures are fake-shaped on purpose (`sk-ant-fake-…`, `AIzaFAKE…`
  shorter than a real key), and placeholders such as `/Users/<name>` do not match.
- `--literals-stdin` adds exact values read from stdin, one per line (never argv, at least 8
  characters), also in base64 and base64url at each of the three byte alignments, URL-encoded
  with upper- and lowercase hex, and JSON-escaped (`\"`, `\\`, also with `\/`).
- Compressed archives (zip and its `.docx`/`.xlsx`/`.jar` kin, gzip, bzip2, xz, zstd, 7z, by magic
  bytes) cannot be searched inside; each is reported as `unscanned-archive` (its raw bytes are
  still searched). Missing objects are reported as `unscanned-missing-object` and never fetched
  (`--missing=print`, `GIT_NO_LAZY_FETCH=1`), and files over 64 MiB as `unscanned-large-file`, so
  none of them can pass as clean.
- Output is only `<location>:<path>:<line> <rule>` and a count; a file path that itself matches is
  shown as `[redacted path]`. Exit 0 clean, 1 findings, 2 usage or git error. Git runs with an
  allowlisted environment, `core.fsmonitor` disabled and replace objects ignored.
- Outside a git work tree it scans the files on disk (skipping `.git`, `node_modules` and the
  top-level `.gitignore` patterns) and says so; it never silently skips the history of a
  repository that git cannot read. Objects only reachable from reflogs are not scanned.

### 9.3 Live smoke (`live-smoke.mjs`)

- The router password comes from `MROUTER_PASSWORD`, stdin or a hidden prompt, and is sent only
  to the `--url` origin with `redirect: "error"`.
- Per call it records only provider, model, mode, HTTP status, `x-router-*` headers,
  `server-timing`, TTFB and total time, token usage, cost and cost status, `finish_reason`, the
  first 60 characters of the reply and the result; from `/control/errors` it keeps neither the
  messages nor the failed-login source addresses. Keys are only read (`GET /control/keys`).
- Before writing, it searches every string in the evidence object (before serialization can
  escape it) and the serialized JSON and markdown for the password, also base64, base64url,
  URL-, JSON- and markdown-escaped, and writes nothing if it is found (exit 4). A reply snippet
  that shares 8 or more characters with the password is dropped (recorded as `null`). Progress
  lines on stderr carry fixed labels and code-shaped results only (other error codes become
  `unrecognized_error_code`), and a line that would contain the password is withheld.
- It stops after the health check when the deployment is not usable (missing or unavailable
  store, misconfiguration, refused password, blocked source), so a refused password is never
  repeated. It sends a wrong password only with `--probe-wrong-password`, once, last: failures
  add up per source within the limiter window and end in a block (§3).
- Exit codes are distinct: 1 a check failed (evidence written), 3 not usable, 4 leak (nothing
  written), 5 unexpected error (evidence and summary may be missing).

### 9.4 Migrations (`migrate.mjs`)

- The URL comes from stdin only (a dotenv document, `--var` picks the variable, default
  `DATABASE_URL`; or one bare `postgres://` line), never from arguments, the environment or a
  file; a terminal, more than 64 KiB, a variable set twice, a missing variable and a URL the
  store would not accept are refused (exit 2), naming the variable, never a value.
- The URL alone decides where to connect and how to log in: every `PG*` variable is removed from
  the process before connecting, and a URL without a password does not fall back to `~/.pgpass`.
  Plaintext is allowed only to a loopback host or a unix socket.
- Output holds no part of the URL (host, user, database name, password, as written and
  decoded): every line goes through the redactor, and errors are reduced to a fixed description
  and the SQLSTATE.
- Planning runs in a read-only transaction and changes nothing; only `--apply` writes, under the
  migration lock (DESIGN §2). Exit 0 up to date or applied, 4 pending, 3 refused, 2 usage,
  1 unexpected or connection error.

## 10. The store (PostgreSQL)

**Trust boundary.** The database is outside the function and trusted with the router's state,
not with its secrets. It holds: source ids (keyed HMACs of client addresses) with their limiter
counts and end times; auth events with the display form of the failed-login source address,
for the newest 200 events only; the provider key records as AES-256-GCM ciphertext; daily usage
counts per provider and model; and the applied migration versions. It never holds the password,
its hash, `ROUTER_SECRET`, a provider key in plaintext, a prompt or a completion. Whoever can
read the database learns usage, event metadata and failed-login addresses; whoever can write it
can reset the limiter, delete or corrupt key overrides (a corrupt record makes that provider
not configured, never a fallback) and change usage figures, but cannot decrypt keys or log in.

**Connection strings are secrets.** `DATABASE_URL_POOLED` and `DATABASE_URL` carry the database
password. They live only as Vercel sensitive variables (the deployment needs only the pooled
one) and in the operator's designated source; they travel on stdin only (`DEPLOY.md` steps 3.1
and 3.2). The router scrubs both URLs and the passwords in them, as written and percent-decoded,
from every response, log line and event; a refused URL is reported by its variable name. Store
errors keep only the SQLSTATE. The secret scan reports database URLs with credentials (§9.2).

**TLS.** In production the URL must set `sslmode` `require`, `verify-ca` or `verify-full`; each
connects with certificate and host-name verification against the system CAs (verify-full
semantics, stricter than libpq's `require`). With `channel_binding=require` (or `prefer`), pg
uses SCRAM-SHA-256-PLUS when the server offers it, but pg does not refuse a server that offers no
binding, so `channel_binding=require` is not enforced: the verified certificate is what binds
the connection to the server. Any other `ssl*` parameter is refused, since pg would let it
override these settings.

**No `PG*` variables in the deployment.** pg fills in whatever the URL leaves out from `PG*`
environment variables (for example `PGPORT` or `PGOPTIONS`, which can change session settings),
so the deployment must not set any; a database integration that adds `PG*` variables or further
copies of the URL is not used (`DEPLOY.md` step 4.3). The migrate command removes them from its
own environment (§9.4).

**Least privilege.** The router runs no DDL: at request time it reads `schema_migrations` and
reads and writes its four tables. After the migrations, the role in the deployment's URL needs
only `USAGE` on schema `michael_router` and `SELECT`, `INSERT`, `UPDATE`, `DELETE` on its tables;
the role that owns the schema and runs `migrate.mjs` belongs with the operator. For example, with
a separate runtime role:

```sql
GRANT USAGE ON SCHEMA michael_router TO <runtime role>;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA michael_router TO <runtime role>;
REVOKE INSERT, UPDATE, DELETE ON michael_router.schema_migrations FROM <runtime role>;
```

Re-run the grants after a migration adds a table. This repository does not create roles, and its
tests run the store as the owning role.

**Fail closed.** Any store error, a missing or outdated schema, a client not acquired within
5000 ms or statements slower than 1500 ms → 503 `store_unavailable` before any password is
evaluated (§3.4). Migrations never run at request time.

**Retention.** Usage rows are kept 400 days (older days are deleted as new usage is written),
events are trimmed to the newest 200 on every append, a source's limiter row is deleted once
nothing in it is active (or swept with other dead rows), and key records stay until
`mrouter keys unset`. Deleted rows can remain in the database provider's backups or
point-in-time history for as long as that provider keeps them.
