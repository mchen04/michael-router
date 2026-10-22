# Michael Router — deployment runbook

This runbook is for whoever deploys Michael Router to Vercel. Follow the steps in order; each one
ends with a check. The interfaces are specified in `DESIGN.md`, and the security reasoning behind
the tooling is in `SECURITY.md` §9.

Rules for the whole run:

- **Secrets only travel from their source to the stdin of the next program.** Never put a
  password, provider key or token in a command argument, a file inside the repository, shell
  history, a chat or a ticket. `vercel env pull` is not part of this runbook.
- **Stop at the first unexpected result** and note it for the account owner. Do not work around
  it, for example by reading a secret from a different source than the one designated.
- **No plan or billing changes** (Vercel, the Redis provider, the AI providers) unless the
  account owner has decided on them. Stop if a step asks for payment details.
- Raw outputs you keep go under the gitignored `evidence/` directory, and only in redacted
  form (the scripts and the CLI never print secrets).

## 1. Prerequisites

- Node.js 24 and a checkout of the repository at the commit you are deploying
  (`git rev-parse HEAD`).
- The `mrouter` CLI from that checkout, for step 6: `npm link` (or `npm install -g .`) puts it on
  your `PATH`, or run `node cli/mrouter.js …` without installing anything (`CLI.md`).
- The Vercel CLI, logged in: `vercel whoami` prints the account or team you deploy to. Log in
  with `vercel login`. The copy script does not pass `VERCEL_TOKEN` on to the CLI. It must list
  `--sensitive` in `vercel env add --help`; older versions are refused (step 4.2).
- A store (step 3): either a free database slot on the Redis provider's plan (through the Vercel
  Marketplace or directly), or an existing Upstash-REST-compatible store that the account owner
  agrees to use. Without one the router answers 503 on every protected route.
- The **names** of the permitted secret sources for the provider keys and the router password:
  keychain items (`security`, macOS), 1Password references (`op`), or dotenv files. If you use
  `op`, sign in through the 1Password app integration: the copy script passes `OP_ACCOUNT` to
  `op` but no session variables.

## 2. Link the project

```sh
vercel link
```

Create a new project (for example `michael-router`) or choose the existing one, in the scope
you deploy to. Then check, in the project settings:

- **Node.js version** is 24.x (`package.json` declares `"engines": {"node": "24.x"}`).
- **Function region**: pick one and keep it. Create the Redis database (step 3) in the same or
  the nearest region, because every protected request makes one store round trip before it is
  answered.

## 3. Store (required)

**The router fails closed without a store.** Without store variables, every protected route
(`/v1/*`, `/control/*`) answers 503 `server_misconfigured`, naming
`KV_REST_API_URL/KV_REST_API_TOKEN`. With store variables but an unreachable or failing store,
it answers 503 `store_unavailable`. Only the static landing page keeps working. There is no
in-memory fallback in production, because the wrong-password limiter must be shared by every
instance.

Any Redis that speaks the Upstash REST protocol works. Connect it in one of two ways:

| Option | How | Variables |
|--------|-----|-----------|
| A. Vercel Marketplace | Project → Storage → Upstash for Redis, connected to the Production environment | Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` (and a few others the router does not use) |
| B. Created directly | A database created at the Redis provider; copy its REST URL (`https://…`) and token into the sources the copy script reads (step 4) | `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, both as manifest entries |

If both pairs are present, the router uses `KV_REST_API_*`.

**Plan limits are the account owner's decision.** Free plans limit the number of databases and
the commands per month. If creating a database fails because the account has reached its
database quota, the options are to free a slot (delete a database nobody uses), to reuse an
existing database (the router's keys all start with `mr:v1:`, but whoever can read that
database can read the router's usage and events), or to choose a paid plan. Nothing in this
repository creates, deletes or upgrades a database. The router stores little: daily usage
counters (kept 400 days), at most 200 events, short-lived limiter keys and encrypted key
overrides. Each protected request costs a few store commands (one round trip for the limiter
check, plus background writes), so a plan's command limit bounds the request volume.

Check: `vercel env ls production` lists `KV_REST_API_URL` and `KV_REST_API_TOKEN` (option A),
or, after step 4, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (option B).

## 4. Secrets

| Variable | Source | Notes |
|----------|--------|-------|
| `ROUTER_PASSWORD_HASH` | `stdin` with `"transform": "scrypt-hash"` | Preferred. The script hashes the password with the server's own function and uploads only the hash. |
| `ROUTER_PASSWORD` | any source | The simpler alternative: the password itself (at least 12 characters), see `SECURITY.md` §2. |
| `ROUTER_SECRET` | `generate` with `"onlyIfAbsent": true` | Created once and never overwritten: changing it makes stored key overrides undecryptable and resets source ids. |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | the designated sources | A provider without a key answers 503 `provider_not_configured`. Keys can also be set later with `mrouter keys set` (stored encrypted in Redis, overriding the variable). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | the designated sources | Only for a store created outside the Marketplace (step 3, option B). |

Set **exactly one** of `ROUTER_PASSWORD_HASH` and `ROUTER_PASSWORD`: with both, every protected
route answers 503. The copy script refuses a manifest with both, and stops before transferring
anything if the other one already exists in Vercel (remove it with
`vercel env rm <NAME> production` first). Use a long random password (at least 128 bits, for
example 32 random characters from a password manager) and keep it in a secret store, from
which you pipe it in.

### 4.1 The manifest

Copy `scripts/key-sources.example.json` to `scripts/key-sources.json` (gitignored), or keep the
manifest outside the repository, and replace every placeholder with the designated source
names and the target project's ids. Each entry names one variable and exactly one source;
entries run in manifest order.

| Field | Value |
|-------|-------|
| `version` | `1` |
| `environment` | `"production"` |
| `project` | required: `{"orgId": "team_…", "projectId": "prj_…"}`, the Vercel project that receives the keys; no other keys |
| `entries` | the variables, in order, each `{"env": <NAME>, "source": {…}}` plus the optional `"transform"` and `"onlyIfAbsent"` |

Read the two ids from the Vercel dashboard (the Project ID in the project's Settings, the Team
ID in the team's Settings), or from `.vercel/project.json` (`projectId`, `orgId`) after
`vercel link` (step 2). They are identifiers, not secrets: the plan prints them, and the plan
digest covers them. A missing or malformed `project` is a usage error (exit 2). Every `vercel`
command of the script runs from the repository root with `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` set to these ids (the Vercel CLI prefers that pair to any link), so neither
the shell's variables nor the current directory's link choose the project. With `--check` or
`--yes`, the script stops before reading anything if the shell sets either variable to a
different id, or if the repository's `.vercel/project.json` links a different project.

| Source | Fields | Read with |
|--------|--------|-----------|
| `keychain` | `service`, `account` | `security find-generic-password -s <service> -a <account> -w` |
| `op` | `ref` (`op://vault/item/field`) | `op read <ref>` |
| `file` | `path`, `var` | one variable from a dotenv file: no shell expansion, no evaluation, quotes stripped; a variable set twice is refused |
| `stdin` | – | all of stdin, one trailing newline removed; at most one entry |
| `generate` | `bytes` (32–64) | random bytes, base64url; `ROUTER_SECRET` with `"onlyIfAbsent": true` only |

A `file` path must be absolute or start with `~/`. Paths under `~/.hermes`, `~/.claude`,
`~/.codex`, `~/.cache` (for both `$HOME` and the account's home directory from the user
database), `/tmp`, `/private`, `/var/folders`, `$TMPDIR` or `/etc`, and shell rc files (`.zshrc`,
`.bashrc`, `.profile`, …), are refused. The check is repeated when the file is read: after
resolving symlinks, and by device and inode for every parent directory, so a prohibited
directory reached under another name (for example through the macOS `/System/Volumes/Data`
firmlink) is refused too, as is a file with more than one hard link. Unknown keys, unknown or
repeated variable names, a second `stdin` entry, any environment other than `production`, and a
source name that looks like a key (a value pasted where a name belongs) are refused as well; the
error never repeats the text.

### 4.2 Transfer

Every run prints the plan first: the target project, variable ← source name, in order, and a
plan digest (SHA-256 over the project, the names and the source descriptors, never values). Run
the three steps with the same manifest; the digest must not change between them.
`<password source>` stands for the command that prints the password from its designated store,
for example
`security find-generic-password -s <service> -a <account> -w` or `op read 'op://<vault>/<item>/password'`.

```sh
# 1. Review the plan. Nothing is read.
node scripts/copy-keys-to-vercel.mjs --manifest scripts/key-sources.json

# 2. Read and validate every source. Nothing is transferred ("ok" per entry).
<password source> | node scripts/copy-keys-to-vercel.mjs --manifest scripts/key-sources.json --check

# 3. Transfer, in order.
<password source> | node scripts/copy-keys-to-vercel.mjs --manifest scripts/key-sources.json --yes
```

`--yes` first checks that `vercel env add --help` lists `--sensitive`: every managed variable is
a secret, so with an older CLI it stops before reading anything. It then sends each value on
stdin to `vercel env add <NAME> production --force --sensitive`, prints one status line per
entry, and finishes with the variable names present in Vercel (names only) and whether a store
pair is present. `onlyIfAbsent` entries (`ROUTER_SECRET`) are skipped when `vercel env ls`
lists the name, and are sent without `--force`, so if the listing missed an existing variable,
Vercel refuses to overwrite it and the entry is reported as skipped. It exits 0 only when every
manifest name is present.

**On a `STOPPED at …` line, stop.** The line names the variable, the source and a scrubbed
reason, for example `STOPPED at ANTHROPIC_API_KEY (source keychain:<service>/<account>):
security: … User interaction is not allowed.` Do not retry with another source or set the value
by hand; report the line as it is to whoever owns the sources. Entries before the stopped one
have been set; a later rerun sets them again (`--force`; the password hash gets a new salt),
except `onlyIfAbsent` entries, which are skipped.

| Exit | Meaning |
|------|---------|
| 0 | plan printed, check passed, or transfer complete with every name present |
| 1 | unexpected error (a bug or an environment problem): the run ended at that point, and entries already reported as `set` stay set; check `vercel env ls production` and note the message for the account owner |
| 2 | usage error or invalid manifest; nothing was read or transferred |
| 3 | `STOPPED`: the project pin (a different id in the environment or in `.vercel/project.json`), a source, a value check, a `vercel` command (including a CLI without `--sensitive`), the password-variable pre-check or the final check failed |

The recommended way to set `ROUTER_PASSWORD_HASH` is the `scrypt-hash` transform above. To set
it by hand instead, use two steps, so that no hidden prompt competes with another program for
the terminal, and delete the file afterwards:

```sh
(umask 077; mrouter hash-password > router-password.hash)
VERCEL_ORG_ID=<orgId> VERCEL_PROJECT_ID=<projectId> vercel env add ROUTER_PASSWORD_HASH production --sensitive < router-password.hash
rm router-password.hash
```

`mrouter hash-password` writes no trailing newline when its output is not a terminal. The server
also ignores exactly one trailing newline (`\n` or `\r\n`) on `ROUTER_PASSWORD_HASH` and
`ROUTER_PASSWORD`, so a value stored with one still works.

## 5. Deploy

Deploy from a clean clone at the reviewed commit, not from a working checkout, and pin the
project as in step 4:

```sh
git clone <repository> michael-router-deploy && cd michael-router-deploy
git checkout --detach <reviewed commit>
git status --short                                   # must print nothing
VERCEL_ORG_ID=<orgId> VERCEL_PROJECT_ID=<projectId> vercel deploy --prod
```

`.vercelignore` is an upload allowlist: it excludes everything at the top level and re-includes
only `api/`, `src/`, `public/`, `package.json`, `package-lock.json` and `vercel.json`, the files
the function and the static page need. Inside those it excludes secret-shaped names anywhere
(`.env*`, `*.hash`, `key-sources*.json`, `*.pem`, `*.key`). So docs, tests, scripts, a manifest,
`evidence/` or a leftover `router-password.hash` are not uploaded even from a working checkout.
The test suite checks the file with git's own ignore engine (the same syntax); how Vercel
applies it is verified only at deploy time: in the deployment's Source view in the dashboard,
the file listing must show only those paths.

Note the production URL. Environment variable changes take effect only with a new deployment,
so redeploy after changing any of them.

## 6. Verify

```sh
<password source> | mrouter login --url https://<host>
mrouter health
mrouter keys list
mrouter test
mrouter ask -m <model> "Reply with the single word: pong"    # once per provider
mrouter usage --days 1
mrouter errors --limit 10
<password source> | node scripts/live-smoke.mjs --url https://<host>
```

`mrouter login` checks the password against the router and saves it, with the URL, in the
`0600` credentials file of your user's config directory (`CLI.md`). Do that only on a machine
that is one of your clients. On any other machine, run `mrouter logout` when you are done, or
skip `login` and give the password to each command through `MROUTER_PASSWORD` for that session.

Use the smoke models from `smoke_models` in `src/pricing.json` for `ask`. Keep outputs under
`evidence/live/` (for example `mrouter health --json > evidence/live/health.json`).
`live-smoke.mjs` writes `evidence/live/<timestamp>.json` and a markdown summary next to it by
default (`--out` changes the path). It checks every string in both, and every progress line,
for the password first, writes nothing if it is found, and drops a reply snippet that shares 8
or more characters with the password.

`live-smoke.mjs` runs: health, key status (read only), a non-streaming and a streaming request
per provider, one tool-call request for Claude, usage, recent errors and one request without
credentials (expects 401). It sends no wrong password unless you add `--probe-wrong-password`,
which ends the run with one (expects 401). Each wrong password counts a failure for the source
address it comes from, and failures add up per source within `AUTH_WINDOW_SECONDS` (1 hour by
default, from the first failure; a correct password does not reset them): from the second
failure, requests sent during a short, growing backoff get 429 `auth_backoff`, and at
`AUTH_MAX_FAILURES` (8) the source is blocked, even for the correct password. So use the probe once, not in a loop, and not from a source address
your clients depend on.

| Exit | Meaning | What to do |
|------|---------|------------|
| 0 | every check passed | – |
| 1 | a check failed (see the summary table) | `provider_auth_failed`: the provider rejected its key; `provider_not_configured`: no key for it; `no_tool_call`: the model answered without calling the tool |
| 2 | usage error | – |
| 3 | the deployment is not usable | `store missing or invalid`: step 3; `store unavailable`: the database is unreachable, deleted, over its limits, or its token changed; `server misconfigured`: fix the named variables and redeploy; password refused (401): stop, each attempt counts a failure; source blocked (429): wait for `Retry-After` |
| 4 | the evidence would have contained the password; nothing was written | stop and note it for the account owner |
| 5 | unexpected error, for example the evidence path cannot be written; the evidence and summary may be missing or incomplete | fix the cause (the message names the error code) and run again |

## 7. Live performance

```sh
<password source> | node bench/live.mjs --url https://<host>
```

The password comes from `MROUTER_PASSWORD` or stdin. The script sends 20 `GET /control/health`
and, per configured provider, 10 tiny non-streaming chat completions on its smoke model, one at a
time and at least 2 s apart (`--n` sets the chat count, at most 30 per provider; `--health-n`,
`--gap-ms` and `--providers` adjust the rest). The chat requests spend a few tokens per provider.
It writes `evidence/speed/live/<timestamp>.json` and a markdown summary next to it (`--out`
changes the path), reporting per provider the client time, the provider time (`server-timing`
`upstream`) and the gateway overhead between them; `BENCHMARKS.md` explains the numbers.

## 8. Abuse check (last)

This check blocks the source address it runs from for `AUTH_BLOCK_SECONDS` (1 hour by default),
so run it after everything else, before any client depends on the deployment, and **never from a
source address your own clients depend on** (use another network, or an IPv6 /64 your clients do
not use; IPv6 sources are tracked per /64).

From that source, send `AUTH_MAX_FAILURES` (default 8) wrong passwords, waiting out the backoff
between attempts (it doubles from 250 ms; 10 s between attempts is enough at the defaults). A
wrong password is not a secret:

```sh
for i in 1 2 3 4 5 6 7 8; do
  curl -s -o /dev/null -D - -H "Authorization: Bearer wrong-guess-$i" https://<host>/control/health | grep -iE '^(HTTP|retry-after)'
  sleep 10
done
curl -s -H "Authorization: Bearer wrong-guess-9" https://<host>/control/health
```

Expect 401 `invalid_credentials` for the eight attempts (with `Retry-After` from the second),
429 `auth_backoff` for any attempt sent before its wait ended, and then 429 `source_blocked`.
From the same source the correct password is now refused too (`mrouter health` exits 3 with
`source_blocked`). From a different source, `mrouter health` still works and
`mrouter errors --kind auth` lists the failed attempts. Repeated blocks double, up to 24 hours.

## 9. Record the result

Note for the account owner: the production URL, the deployed commit (`git rev-parse HEAD`;
`/control/health` reports it as `commit`), the variable names present in Vercel (the copy
script's final line), the evidence paths, and anything skipped with the reason. Never values.

## Before the repository is published

Run the secret scan over the working tree and the full git history:

```sh
npm run scan                                                     # pattern rules
<values, one per line> | node scripts/scan-secrets.mjs --literals-stdin
```

The literal run is required before anything is pushed to a public remote. Whoever holds the
values pipes them in from their permitted sources (for example
`{ security find-generic-password -s <service> -a <account> -w; op read '<ref>'; } | node scripts/scan-secrets.mjs --literals-stdin`).
The scan prints only locations and rule names, never matched text, and exits 0 when clean,
1 with findings, 2 on a usage or git error.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| every protected route: 503 `server_misconfigured` naming `KV_REST_API_URL/KV_REST_API_TOKEN` | no store connected (step 3), or the deployment predates it: redeploy |
| 503 `server_misconfigured` naming `ROUTER_PASSWORD_HASH` and `ROUTER_PASSWORD` | both are set: remove one, redeploy |
| 503 `store_unavailable` | the store failed or answered slower than 1.5 s: database deleted, over its limits, or token rotated |
| 503 `provider_not_configured` | no key for the routed provider |
| 502 `provider_auth_failed` | the provider rejected the router's key for it (never shown as 401) |
| `mrouter keys set`: 400 `key_rejected` / 502 `key_verification_unavailable` | the provider refused the key / could not be asked; nothing was stored |
| `STOPPED at …` from the copy script | see step 4.2: stop and pass the line to whoever owns the sources |
