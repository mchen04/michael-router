# Benchmarks

How Michael Router's latency is measured, what each number means, and the summary of every
measurement round. Local numbers are mocked evidence: a local fake upstream and a local fake
Upstash, never a real provider, store or credential. Raw distributions are written to the
gitignored `evidence/` directory; this file holds summaries only. DESIGN §12 sets the rules.

Rounds 0–3 all ran on one shared arm64 macOS machine (10 cores, 24 GB, Node 24.22) while other
work was running on it, so their results are subject to interference. That machine is no longer
used for benchmarks. Every local number below is a result measured on that host, not a guarantee
for a Vercel deployment. The deployment-relevant numbers are the live ones, measured with
`bench/live.mjs` against a deployment (DEPLOY.md §7).

## 1. Method

### Gateway overhead (`bench/overhead.mjs`)

- Processes: `bench/fake-upstream.mjs` (fixed OpenAI-compatible and Anthropic Messages replies,
  serialized once at startup); for each store delay, one `dev/fake-upstash.js --delay-ms <d>` and
  one `dev/server.js`. The router uses the production settings apart from TLS: the Upstash REST
  store protocol, a scrypt password hash with the production parameters (logN 15), and fake
  provider keys. The password, its hash, `ROUTER_SECRET` and the store token are generated per
  run. The benchmark process is the client: node:http with keep-alive.
- Four targets per iteration, sent back to back in ABBA order (reversed on odd iterations, so
  drift cancels within each pair):
  - `direct_openai`: client → fake upstream.
  - `gw_gemini`: client → router (Gemini pass-through) → the same fake.
  - `direct_anthropic`: client → fake `/v1/messages`, with the exact body the Claude adapter sends.
  - `gw_claude`: client → router (Claude adapter) → the same fake.
- Phases:
  - sequential, 1000 iterations;
  - 8 concurrent workers, 2000 iterations.

  Each phase runs non-streaming and streaming, every one after 100 discarded warm-up
  iterations. Each phase runs at every store delay (0 and 3 ms) before the next phase starts. A
  streamed reply is 8 text deltas, 1 ms apart, plus the closing events.
- Every response is checked: status 200 and the expected end of the body. A run with any failed
  request aborts.

### Cold start (`bench/coldstart.mjs`)

- Fresh processes, alternating on every iteration: `bench/hello-server.mjs` (a node:http
  hello-world, the baseline) and `dev/server.js` configured as above. 30 of each, after 3
  discarded warm-ups.
- Per process:
  - spawn → listening;
  - spawn → first successful protected response (`GET /v1/models` with the password);
  - that first request alone;
  - a second request on the same connection.

  The router's first response must carry `x-router-cold: 1`, and the second must not.
- Import time: fresh `node` processes timing `await import(<module>)`, 30 per module, rotating
  order. The modules are an empty module (the cost of a first dynamic import), `node:http`,
  `@vercel/functions`, `src/handler.js` and `api/router.js`.

### Live (`bench/live.mjs`, deployment stage)

- Sequential tiny non-streaming chat completions, 10 per configured provider by default and at
  most 30, at least 2 s apart. Interleaved with these, 20 `GET /control/health` requests. See
  DEPLOY.md §7.
- Per request it records the client TTFB and total, the router's `server-timing` and
  `x-router-cold`. It never records the password or any content.
- These are the numbers that describe a deployment; the local benchmarks above only compare
  builds on one host.

### Router instrumentation

Every authenticated response carries `server-timing`, and the first request an instance serves
also carries `x-router-cold: 1` (API.md).

| entry | meaning |
|---|---|
| `auth` | credential check: scrypt on a cache miss (about 43 ms at logN 15 on the benchmark host, §5.5), about 0 ms once cached |
| `store` | sum of this request's store round trips completed before the first byte: the limiter precheck (on the critical path) and, when it finishes first, the background release of the request's in-flight slot, which is sent once the password checks out and overlaps the upstream call |
| `upstream` | time from sending the upstream request to its response headers (the provider's own latency) |
| `gw` | router time from the start of the request until the first response byte is handed to the runtime |

`gw − upstream` ("in-router") is the time the router adds before the first byte. Values have
0.1 ms resolution.

## 2. Commands

```sh
node bench/overhead.mjs --out evidence/speed/round-N/overhead-a        # repeat as -b, -c for noise
node bench/overhead.mjs --out evidence/speed/round-N/profile --cpu-prof # separate run, CPU profile only
node bench/overhead.mjs --out evidence/speed/round-N/upstream10 --upstream-delay-ms 10
node bench/coldstart.mjs --out evidence/speed/round-N/coldstart-a
<password source> | node bench/live.mjs --url https://<host>          # DEPLOY.md §7
```

Each run writes `samples.json`, `summary.json` and `summary.md` into `--out`, together with:

- the command line;
- the Node and V8 versions;
- a generic host description;
- load averages before and after the run and around every block;
- the build identity: the git commit and dirty flag, or `BENCH_GIT_REV=<label>` when the tree is
  not a git checkout, plus a digest of the source files.

Other overhead flags:

- `--store-delays 0,3`, `--n`, `--n-concurrent`, `--warmup`, `--concurrency`;
- `--chunks`, `--interval-ms`: the stream shape;
- `--resamples`: bootstrap resamples.

## 3. Reading the numbers

- **ttfb**: client time to the first body byte. **total**: client time to the last byte.
- **Overhead**: gateway − direct, in ms, with the router's store round trip included.
  - **diff of percentiles**: gateway pN − direct pN.
  - **paired**: percentiles of the per-iteration differences (gateway minus the direct request
    taken next to it). Its median comes with a bootstrap 95% confidence interval.

  The tables below use paired values.
- **Noise**: the bootstrap interval only describes one run. Repeated runs of the same build vary
  much more, so a change counts as a gain only if it beats the run-to-run spread measured in the
  same round, on the same host (DESIGN §12). §5.2 shows the ranges on the host used so far.
- **Cold-start rows**:
  - `listening`: spawn to the "listening" line.
  - `first response`: spawn to the first protected response.
  - `first request`: that request alone.
  - `second request`: the next request on the same connection.

  "router − hello" is paired by iteration.
- **Live overhead**: client total − `upstream`, which is the router plus the client↔router
  network, plus delivering the (tiny) body after the upstream headers. In-router is
  `gw − upstream`.

## 4. Caveats

- **Store latency.** The fake store's round trip is not Upstash's. Store delay 3 ms is a modelled
  same-region round trip, and on the benchmark host it cost about 3.6 ms (`store` p50), because of
  timer granularity. A function instance's first store call also pays for TCP and TLS, which a
  local run does not.
- **No TLS anywhere locally.** Production mode requires https, so the router runs in development
  mode with the production store protocol, hashing and keys.
- **Host.** Rounds 0–3 ran on one shared, interference-prone 10-core arm64 macOS machine with
  24 GB and Node 24.22, not Vercel hardware. It is no longer used for benchmarks. Its numbers are
  results from that host, not guarantees for a Vercel deployment, and absolute values transfer
  only roughly. Compare builds measured on the same host in the same round.
- **Idle wake-up.** On the benchmark host, each process hop that had to wake from idle added
  roughly 1 ms. Non-streaming sequential requests kept every process busy, so they measured the
  router's own cost (about 0.27 ms on that host). Streaming, the 3 ms store delay and the 10 ms
  upstream diagnostic (§5.4) left processes idle between events and added this wake-up latency. A
  busy production instance may not see it.
- **Load.** The host was shared, and other work ran during every round. In round 0, runs B and C,
  the profile and parts of the diagnostic ran while that work held the 1-minute load average at
  14–22, against 2.5–4.7 for run A; the noise table (§5.2) included that effect on purpose. In
  rounds 1–3 the 1-minute load average was about 3–12.
- **Profiling.** CPU-profiled runs are slower. Use them for where time goes, never for timings.
- **Cold start.** Cold start was measured on a fresh Node process running `dev/server.js`, not on
  a Vercel instance. Vercel adds its own sandbox start, bundle load and the TLS handshake to the
  store. The scrypt check on an instance's first request is deliberate. On the benchmark host it
  took about 43 ms (§5.5), after which the verified-credential cache kept it at about 0 ms.

## 5. Round 0: baseline (2026-10-22)

Build digest `c4e4bcca59d0db07`, the tree before any speed change. Three overhead runs (A, B, C)
and three cold-start runs of the same build.

| run | 1-min load before → after |
|---|---|
| overhead A | 2.48 → 4.65 |
| overhead B | 15.38 → 16.15 |
| overhead C | 14.71 → 22.36 |
| overhead, CPU profile | 21.01 → 16.16 |
| overhead, upstream 10 ms | 4.33 → 14.70 |
| cold start A | 4.36 → 4.51 |
| cold start B | 16.15 → 15.19 |
| cold start C | 22.36 → 19.57 |

### 5.1 Gateway overhead, run A (paired, ms)

Direct baselines (p50):

- non-streaming total: 0.06 ms sequential, 0.07 ms concurrent;
- streaming ttfb: 0.39 ms sequential, 0.20 ms concurrent;
- streaming total: 9.5 ms sequential, 8.7 ms concurrent.

| scenario | store ms | metric | gemini p50 [95% CI] | p90 | p99 | claude p50 [95% CI] | p90 | p99 |
|---|---|---|---|---|---|---|---|---|
| sequential, non-streaming | 0 | total | 0.27 [0.27, 0.28] | 0.35 | 1.17 | 0.27 [0.27, 0.28] | 0.34 | 1.03 |
| sequential, non-streaming | 3 | total | 5.10 [5.04, 5.21] | 6.49 | 9.28 | 5.11 [5.05, 5.17] | 6.33 | 8.98 |
| sequential, streaming | 0 | ttfb | 1.99 [1.95, 2.02] | 2.55 | 3.37 | 1.82 [1.76, 1.85] | 2.40 | 3.56 |
| sequential, streaming | 0 | total | 2.10 [2.03, 2.16] | 3.50 | 5.08 | 1.93 [1.84, 2.02] | 3.50 | 4.92 |
| sequential, streaming | 3 | ttfb | 5.66 [5.63, 5.69] | 6.23 | 7.50 | 5.52 [5.49, 5.56] | 6.09 | 7.35 |
| sequential, streaming | 3 | total | 5.78 [5.72, 5.84] | 7.26 | 8.62 | 5.64 [5.55, 5.71] | 7.17 | 8.73 |
| concurrency 8, non-streaming | 0 | total | 1.47 [1.46, 1.48] | 2.21 | 6.57 | 1.46 [1.45, 1.47] | 2.15 | 6.87 |
| concurrency 8, non-streaming | 3 | total | 5.13 [5.05, 5.21] | 7.30 | 11.45 | 5.10 [5.01, 5.22] | 7.36 | 11.30 |
| concurrency 8, streaming | 0 | ttfb | 1.40 [1.36, 1.44] | 2.74 | 8.62 | 1.39 [1.35, 1.43] | 2.71 | 8.40 |
| concurrency 8, streaming | 0 | total | 1.62 [1.52, 1.70] | 4.04 | 9.12 | 1.61 [1.52, 1.72] | 3.87 | 8.34 |
| concurrency 8, streaming | 3 | ttfb | 5.27 [5.20, 5.34] | 6.86 | 13.69 | 5.25 [5.18, 5.30] | 6.94 | 13.21 |
| concurrency 8, streaming | 3 | total | 5.36 [5.28, 5.43] | 7.87 | 14.49 | 5.42 [5.32, 5.51] | 8.03 | 13.45 |

### 5.2 Noise: paired p50 across runs A / B / C (ms)

"range" is the largest minus the smallest of the six values in the row. These ranges were
specific to that host and its load at the time, and are not a standing threshold. A later round
measures its own A–A and B–B spreads on its own host, and a change has to beat those.

| scenario | store ms | metric | gemini A / B / C | claude A / B / C | range |
|---|---|---|---|---|---|
| sequential, non-streaming | 0 | total | 0.27 / 0.29 / 0.32 | 0.27 / 0.29 / 0.32 | 0.04 |
| sequential, non-streaming | 3 | total | 5.10 / 5.51 / 5.39 | 5.11 / 5.67 / 5.35 | 0.57 |
| sequential, streaming | 0 | ttfb | 1.99 / 3.04 / 2.08 | 1.82 / 2.70 / 1.92 | 1.22 |
| sequential, streaming | 0 | total | 2.10 / 3.30 / 2.26 | 1.93 / 2.95 / 2.15 | 1.37 |
| sequential, streaming | 3 | ttfb | 5.66 / 8.03 / 6.63 | 5.52 / 7.32 / 6.36 | 2.50 |
| sequential, streaming | 3 | total | 5.78 / 8.13 / 7.06 | 5.64 / 7.78 / 6.71 | 2.48 |
| concurrency 8, non-streaming | 0 | total | 1.47 / 1.46 / 1.79 | 1.46 / 1.46 / 1.79 | 0.33 |
| concurrency 8, non-streaming | 3 | total | 5.13 / 5.06 / 4.98 | 5.10 / 5.03 / 4.97 | 0.16 |
| concurrency 8, streaming | 0 | ttfb | 1.40 / 1.32 / 1.21 | 1.39 / 1.28 / 1.22 | 0.19 |
| concurrency 8, streaming | 0 | total | 1.62 / 1.89 / 1.80 | 1.61 / 1.90 / 1.84 | 0.29 |
| concurrency 8, streaming | 3 | ttfb | 5.27 / 5.39 / 5.31 | 5.25 / 5.31 / 5.32 | 0.14 |
| concurrency 8, streaming | 3 | total | 5.36 / 5.75 / 5.73 | 5.42 / 5.59 / 5.63 | 0.39 |

### 5.3 Router `server-timing`, run A (gemini, medians in ms; claude is within 0.2 ms)

| scenario | store ms | gw | upstream | gw − upstream p50 / p90 | store | auth |
|---|---|---|---|---|---|---|
| sequential, non-streaming | 0 | 0.3 | 0.1 | 0.2 / 0.2 | 0.2 | 0.0 |
| sequential, non-streaming | 3 | 4.9 | 0.6 | 4.2 / 5.5 | 3.6 | 0.0 |
| sequential, streaming | 0 | 1.8 | 0.6 | 1.2 / 1.5 | 1.5 | 0.0 |
| sequential, streaming | 3 | 5.5 | 0.6 | 4.9 / 5.3 | 4.5 | 0.0 |
| concurrency 8, non-streaming | 0 | 1.2 | 0.6 | 0.6 / 0.8 | 1.0 | 0.0 |
| concurrency 8, non-streaming | 3 | 4.7 | 0.6 | 3.9 / 5.0 | 3.8 | 0.0 |
| concurrency 8, streaming | 0 | 1.1 | 0.5 | 0.6 / 1.0 | 1.0 | 0.0 |
| concurrency 8, streaming | 3 | 4.8 | 0.7 | 4.0 / 4.8 | 3.8 | 0.0 |

In this run, most of the overhead at a 3 ms store delay was the limiter's single store round trip
on the critical path. On that host, the rest of the router took about 0.2 ms before the first
byte.

### 5.4 Diagnostic: upstream answers after 10 ms (one run, paired, ms)

This run measures the idle wake-up effect. With a 10 ms upstream delay, every process idles during
each request. The same router's sequential non-streaming overhead rises from 0.27 to about 3 ms.
The direct path itself takes 12.5 ms rather than 10 ms.

| scenario | store ms | metric | direct p50 | gemini p50 / p90 / p99 | claude p50 / p90 / p99 | run A gemini p50 |
|---|---|---|---|---|---|---|
| sequential, non-streaming | 0 | total | 12.50 | 3.00 / 4.57 / 5.95 | 2.68 / 4.06 / 5.08 | 0.27 |
| sequential, non-streaming | 3 | total | 12.66 | 7.29 / 8.80 / 10.82 | 6.70 / 8.37 / 10.86 | 5.10 |
| sequential, streaming | 0 | ttfb | 12.57 | 3.95 / 6.05 / 7.47 | 3.64 / 5.75 / 7.97 | 1.99 |
| sequential, streaming | 3 | ttfb | 12.60 | 6.86 / 9.42 / 11.33 | 6.52 / 8.91 / 10.60 | 5.66 |
| concurrency 8, non-streaming | 0 | total | 10.80 | 3.65 / 7.47 / 12.00 | 3.52 / 7.43 / 11.64 | 1.47 |
| concurrency 8, non-streaming | 3 | total | 10.69 | 6.88 / 10.55 / 15.14 | 6.80 / 10.50 / 15.41 | 5.13 |
| concurrency 8, streaming | 0 | ttfb | 10.79 | 4.14 / 7.66 / 11.39 | 4.17 / 7.37 / 10.86 | 1.40 |
| concurrency 8, streaming | 3 | ttfb | 10.63 | 6.51 / 9.65 / 15.58 | 6.51 / 9.57 / 13.95 | 5.27 |

### 5.5 Cold start (ms, medians; runs A / B / C)

| measure | hello | router | router − hello, paired p50 [95% CI] |
|---|---|---|---|
| spawn → listening | 34.4 / 36.3 / 38.3 | 41.1 / 38.9 / 43.8 | A 6.2 [5.4, 7.1]; B 6.0; C 6.3 |
| spawn → first protected response | 36.4 / 38.2 / 40.4 | 96.8 / 93.2 / 103.5 | A 60.2 [58.4, 61.6]; B 56.5; C 61.6 |
| first request alone | 1.95 / 1.88 / 2.09 | 55.5 / 52.3 / 59.5 | A 53.3 [52.8, 54.1]; B 50.5; C 57.3 |
| second request | 0.53 / 0.51 / 0.55 | 2.35 / 2.17 / 2.27 | A 1.76 [1.71, 1.82]; B 1.67; C 1.74 |

Router `server-timing` medians:

| request | auth (A / B / C) | store | gw |
|---|---|---|---|
| first | 43.6 / 41.5 / 46.7 | 6.8 / 6.4 / 6.9 | 52.1 / 49.3 / 55.7 |
| second | 0.0 / 0.0 / 0.0 | 1.2 / 1.1 / 1.2 | 1.6 / 1.5 / 1.6 |

In all 90 router starts, `x-router-cold: 1` was on the first response and absent from the second.
The first request's extra time was the scrypt check (about 43 ms) plus the first store call (about
6.8 ms, which included opening the connection and loading the fetch implementation).

### 5.6 Module import time (ms, fresh process, 30 per module)

Node's own start-up before user code is 10.7–12.1 ms (median) in every set.

| module | import p50 (A / B / C) | p90 (A) |
|---|---|---|
| empty module | 0.24 / 0.22 / 0.26 | 0.26 |
| `node:http` | 11.2 / 10.8 / 12.2 | 12.6 |
| `@vercel/functions` | 3.4 / 3.3 / 3.6 | 3.6 |
| `src/handler.js` | 8.3 / 8.0 / 8.7 | 9.3 |
| `api/router.js` | 11.2 / 10.9 / 11.7 | 12.1 |

### 5.7 CPU profile of the router

The profile run used the same workload as §5.1. The table shows shares of busy CPU (idle
excluded): 20.2 s at a 0 ms store delay and 26.8 s at 3 ms.

| category (self time) | store 0 ms | store 3 ms |
|---|---|---|
| Node internals (undici fetch, streams, http, timers) | 60.6% | 61.8% |
| V8 and native | 23.2% | 23.0% |
| gateway code (`src/`) | 10.6% | 10.2% |
| garbage collector | 3.7% | 3.2% |
| dev server adapter and other | 1.9% | 1.9% |

Inclusive shares count a function's callees too, so these rows overlap: the store client calls
`fetch`.

| inclusive | store 0 ms | store 3 ms |
|---|---|---|
| store client (`src/store/upstash.js` `post`) | 11.0% | 12.1% |
| undici `fetch` (store calls and upstream calls) | 10.7% | 11.7% |
| stream relay (`src/proxy.js` `pull`) | 10.7% | 8.7% |
| `AbortSignal.timeout` firing after completed store calls (incl. `DOMException`) | 8.4% | 7.9% |
| dev server response writer (`dev/server.js`) | 3.7% | 3.9% |
| request log line | 2.3% | 2.2% |
| credential check (cached HMAC) | 0.8% | 1.3% |

## 6. Round 1: timeouts without a per-call `AbortSignal.timeout` (2026-10-22, kept)

The change: the store client (`src/store/upstash.js`) and the upstream call (`src/proxy.js`) each
use one `AbortController` and a timer that is cleared when the call is over. Before, every call
created an `AbortSignal.timeout`, and its timer still fired, allocating an error, after the call
had finished: 1.5 s later for every store call, and 295 s later for every upstream call. The
timeouts and error codes are unchanged: the store times out after 1.5 s (503
`store_unavailable`), and the upstream after `UPSTREAM_TIMEOUT_MS` across the headers and the whole
body (504, or an `upstream_timeout` chunk in a stream).

Method:

- A is the previous build, exported from git. B is the change.
- Runs alternated A B A B: 4 overhead runs of each build, then 4 CPU-profiled runs of each, with
  the same arguments as §5.
- The 1-minute load average was 3.9–10.2. The profiled run with the highest load (about 10) was
  an A run.
- CPU per request = the router's non-idle profile samples (including `(program)` and GC) divided
  by the 12 800 gateway requests each router process serves in a run (warm-up included).

### 6.1 Router CPU per gateway request (µs, profiled runs)

| router | A runs | A mean | A–A spread | B runs | B mean | B–B spread | B − A |
|---|---|---|---|---|---|---|---|
| store 0 ms | 1359 / 1456 / 1342 / 1373 | 1383 | 114 | 1289 / 1258 / 1245 / 1192 | 1246 | 96 | −137 (−9.9%) |
| store 3 ms | 1821 / 2012 / 1803 / 1845 | 1870 | 209 | 1667 / 1709 / 1666 / 1658 | 1675 | 51 | −195 (−10.4%) |
| both, per run | 1590 / 1734 / 1573 / 1609 | 1626 | 162 | 1478 / 1483 / 1456 / 1425 | 1460 | 58 | −166 (−10.2%) |

- Every B run used less CPU than every A run, at both store delays.
- Timer callbacks plus `AbortSignal` and `DOMException` work took 9.5–11% of A's busy CPU
  (inclusive, not double-counted). In B they took about 2%.
- Excluding `(program)` and GC, the drop is 8.5% (−124 µs per run, against an A–A spread of
  144 µs).

### 6.2 Paired overhead (gemini, ms; means of 4 runs per build)

| scenario | store ms | metric | A p50 | B p50 | B − A | larger spread | A p90 | B p90 |
|---|---|---|---|---|---|---|---|---|
| sequential, non-streaming | 0 | total | 0.34 | 0.31 | −0.03 | 0.13 | 0.52 | 0.46 |
| sequential, non-streaming | 3 | total | 5.34 | 5.30 | −0.05 | 0.53 | 7.03 | 6.81 |
| sequential, streaming | 0 | ttfb | 2.41 | 2.40 | −0.00 | 0.85 | 3.66 | 3.51 |
| sequential, streaming | 0 | total | 2.61 | 2.58 | −0.03 | 0.88 | 4.45 | 4.27 |
| sequential, streaming | 3 | ttfb | 6.41 | 6.32 | −0.09 | 0.62 | 7.56 | 7.46 |
| sequential, streaming | 3 | total | 6.58 | 6.56 | −0.03 | 0.74 | 8.46 | 8.35 |
| concurrency 8, non-streaming | 0 | total | 1.47 | 1.44 | −0.02 | 0.16 | 2.23 | 2.81 |
| concurrency 8, non-streaming | 3 | total | 5.13 | 5.07 | −0.06 | 0.30 | 7.48 | 7.47 |
| concurrency 8, streaming | 0 | ttfb | 1.38 | 1.44 | +0.06 | 0.12 | 3.45 | 3.24 |
| concurrency 8, streaming | 0 | total | 1.70 | 1.74 | +0.04 | 0.16 | 4.29 | 4.30 |
| concurrency 8, streaming | 3 | ttfb | 5.33 | 5.25 | −0.08 | 0.11 | 7.33 | 7.18 |
| concurrency 8, streaming | 3 | total | 5.52 | 5.46 | −0.06 | 0.17 | 8.32 | 8.27 |

The Claude route gives the same picture: no |B − A| exceeds 0.71 of its spread on either route.
The concurrency-8 non-streaming p90 at store 0 ranged from 1.9 to 3.6 ms between runs of either
build.

### 6.3 Verdict

- **CPU:** a measured gain. Busy CPU per request fell 10.2% (166 µs), more than the A–A spread
  (162 µs). The margin is narrow:
  - at the 3 ms store delay alone, the drop (195 µs) is just under that router's A–A spread
    (209 µs);
  - without `(program)` and GC, the drop stays under the spread.
- **Latency:** no measured gain and no regression.

## 7. Round 2: leaner pass-through stream relay (2026-10-22, no measured gain, reverted)

- The change: a pass-through stream forwarded an upstream chunk unchanged, without parsing and
  re-serializing it, when the chunk held only plain `data:` events that could not carry `usage`
  or `error`. The Claude adapter was untouched.
- Method as in round 1: 4 overhead runs and 4 CPU-profiled runs of each build, alternating. The
  1-minute load average was 2.9–12.4.
- Latency: no scenario moved by more than 0.20 of its larger spread on either route. The targeted
  concurrency-8 streaming rows moved by −0.03 to +0.04 ms.
- CPU per request (µs, A → B): 1250 → 1191 at a 0 ms store delay (−60, A–A spread 98), 1692 →
  1733 at 3 ms (+41, spread 133), 1471 → 1462 per run (−9, spread 115).
- The relay itself did get cheaper: pass-through event handling fell from about 21 to 5 µs per
  request, and the new check cost about 9 µs. The net saving, about 1% of busy CPU, was well
  under the noise.

## 8. Round 3: cold-start import cost (2026-10-22, no measured gain, reverted)

- Attribution: a fresh-process import of `api/router.js` took about 10–11 ms, or about 7 ms when
  `node:http` was already loaded, as it is in any process serving HTTP. Imported alone,
  `@vercel/functions` took 3.3 ms, `node:crypto` 2.6 ms and `node:net` 1.0 ms. Each of the
  gateway's own modules took about 0.2 ms. Work at module scope was about 0.15 ms.
- The change: load `src/control.js` on the first `/control/*` request instead of at import. It was
  the largest item that could be deferred safely without moving its cost onto `/v1` requests.
- Method: `bench/coldstart.mjs`, 6 runs of each build, alternating, plus 2 overhead runs of each
  as a warm-latency check. The 1-minute load average was 3.0–6.8.
- Results (A → B medians):
  - `api/router.js` import p50: 10.11 → 9.94 ms (−0.17; spreads 0.94 and 1.06);
  - spawn → listening, router − hello: +0.06 ms (spread 1.07);
  - spawn → first protected response, router − hello: −0.15 ms (spread 5.29).
- Warm latency: the means differed by at most 0.14 ms, in both directions.
- A finer probe alternated A and B within each run (4 runs of 40 imports each). It measured −0.23
  ms on a bare import (spreads 0.08 and 0.09) and −0.15 ms with `node:http` loaded (spreads 0.10
  and 0.15). It was recorded but not counted, because the round had settled in advance that the
  cold-start runs would decide. About 0.2 ms is roughly 0.3% of the first protected response.
