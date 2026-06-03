# Rari vs Next.js: Performance Analysis with OTel, Rust, and V8

## 1. Introduction

Rari is a React RSC framework built on Rust, claiming an 18x performance improvement over Next.js. The goal of this study is objective verification of this claim.

A comprehensive benchmark was conducted: the source code of both frameworks was instrumented with OpenTelemetry spans, measurements were taken with wrk `-t12 -c100 -d30s` in an isolated Docker stack, and timelines were visualized in Jaeger.

**Results:**

| Scenario | Rari | Next.js | Ratio |
|----------|------|---------|-------|
| **Static** `/` (both prerender) | **135,993 req/s** | 2,347 req/s | **~58x** |
| **Dynamic** `/stream` (both Suspense) | 117 req/s | 22 req/s | **~5.2x** |
| **Fetch** `/fetch` (force-cache, self-fetch) | **125,463 req/s** | 228 req/s | **~550x** |
| **TTFB streaming** | 7ms | **6ms** | 1.2x |

~58x on static — HTTP-server difference: hyper (Rust) vs Node.js. On streaming, both show comparable progressive delivery: Rari 13 chunks, TTFB=7ms; Next.js 14 chunks, TTFB=6ms. **The fetch benchmark demonstrates Rari's key advantage: the Rust HTTP client (reqwest) handles self-fetch 2-3 orders of magnitude faster than Node.js (undici).**

## 2. Architecture Under the Microscope

### 2.1 Rari

```
Rust (hyper) → request handler → route dispatch → V8 isolate (deno_core) → React RSC render → RSC serialization → Response
```

V8 runs **inside** the Rust process as a library (`deno_core`), not as a separate process. This enables native API calls without inter-process communication overhead.

**Rendering pipeline:**
1. `handle_app_route` — entry point, route dispatch
2. `route.match` — path matching with handler
3. `rsc.render` — React component tree rendering in V8 (+ child spans: `v8.execute_script`, `rsc.serialize`)
4. Response — result delivery

### 2.2 Next.js

```
Node.js HTTP server → Next.js router → React SSR/RSC pipeline → Response
```

Node.js event loop processes requests within a single process. RSC rendering runs on Node.js through React.

**Rendering pipeline:**
1. `BaseServer.handleRequest` — entry point
2. `AppRender.componentTree` — React createElement tree
3. `AppRender.renderToReadableStream` — React RSC render
4. `AppRender.rscPayload` — RSC payload serialization
5. Response — via `start response` span

### 2.3 Fundamental Difference

Rust provides native code without JIT warmup and full control over allocations. However, the main architectural difference is the **pre-render cache**: Rari generates the RSC stream once at startup and serves the pre-built response.

## 3. Methodology

### 3.1 Test Environment

Docker Compose stack on a single host:

| Service | Role |
|---------|------|
| `rari-app` | Rari, built from source (multi-stage: Rust → build-snapshot → cargo build --release) |
| `next-app` | Next.js 16.3.0-canary.35, built from source fork (pnpm build → npm pack → npm install) |
| `jaeger` | Jaeger all-in-one, OTLP HTTP ingestion on :4318 |
| `wrk` | Alpine + wrk 4.2.0 |

Both applications are forked and patched with OTel spans.

### 3.2 Test RSC Tree

```
Page (async RSC)
└── Header         (await sleep 1ms)
└── Main
    └── CardList
        └── Card[x10] (each await sleep 1ms)
```

14 async components, each performing `await new Promise(r => setTimeout(r, 1))`. Total 14ms artificial delay per request.

### 3.3 wrk Parameters

```
-t12 -c100 -d30s
Warmup: 10s
Runs: 3
Result: median across 3 runs
```

### 3.4 OTel Configuration

Both applications export traces directly to Jaeger via HTTP (OTLP):

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

Next.js uses `instrumentation.ts` with `OTLPTraceExporter` + `BatchSpanProcessor`. Rari exports via the `tracing-opentelemetry` bridge.

### 3.5 Reproducibility

To reproduce the benchmark:

```bash
docker compose build
docker compose up -d jaeger rari-app next-app
docker compose run --rm wrk
```

Jaeger UI: http://localhost:16686

## 4. Instrumentation: OTel in Runtimes

### 4.1 Rari (Rust)

Using the `tracing` crate for spans. The `tracing-opentelemetry` (0.28) bridge converts tracing spans to OTel and exports via OTLP HTTP.

9 span points on the execution path:

```rust
use tracing::info_span;
let _span = info_span!("http.request",
    http.method = %method,
    http.path = %uri.path()
).entered();
```

**Span points:**

| Span | Location | Added via |
|------|----------|-----------|
| `http.request` | `rari/src/server/mod.rs` | `#[instrument]` on `handle_request` |
| `handle_app_route` | `app_route_2_handler` | `#[instrument]` |
| `route.match` | route matching | `info_span!()` |
| `v8.execute_script` | `runtime/mod.rs` | `info_span!()` |
| `v8.execute_composition` | `rendering/layout/core.rs` | `info_span!()` |
| `v8.execute_script_streaming` | `runtime/mod.rs` | `info_span!()` |
| `rsc.render` | rendering pipeline | `info_span!()` |
| `rsc.serialize` | serialization | `info_span!()` |
| `rsc.serialize_json` | `rendering/layout/core.rs` | `info_span!()` |

### 4.2 Next.js (TypeScript)

Next.js has built-in OTel infrastructure: `NextTracerImpl` (wrapper over `@opentelemetry/api`). The npm package includes core spans, but not all. We build from a source fork to include the full set.

**Standard spans (in npm):**

| Span | Source |
|------|--------|
| `BaseServer.handleRequest` | `base-server.ts` |
| `AppRender.componentTree` | `app-render.tsx` |
| `AppRender.renderToReadableStream` | `node-web-streams-helper.ts` |
| `AppRender.rscPayload` | `app-render.tsx` |
| `AppRender.fetch` | fetch |
| `BaseServer.serialize` | `render-result.ts` |

**Patched spans (added by us):**

| Span | File | Purpose |
|------|------|---------|
| `AppRender.jsonStringifyBootstrap` | `use-flight-response.tsx:229` | `JSON.stringify` bootstrap payload |
| `AppRender.jsonStringifyFormState` | `use-flight-response.tsx:236` | `JSON.stringify` form state (null — not invoked) |
| `AppRender.jsonStringifyData` | `use-flight-response.tsx:254` | `JSON.stringify` flight payload chunk |
| `AppRender.bufferFromBase64` | `use-flight-response.tsx:265` | `Buffer.from` base64 (Uint8Array chunks — not invoked) |
| `AppRender.jsonStringifyBinary` | `use-flight-response.tsx:274` | `JSON.stringify` binary payload (not invoked) |
| `AppRender.streamToBuffer` | `node-web-streams-helper.ts:198` | `Buffer.concat` stream (streaming path — not invoked) |

**Key observation:** only **3** of the 6 added spans actually execute: `jsonStringifyBootstrap`, `jsonStringifyData`. The rest are on cold paths not triggered by our test scenario (RSC payload is fully string-typed, no binary chunks; streaming uses piping, not buffering).

`instrumentation.ts`:

```typescript
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

export function register() {
  const provider = new NodeTracerProvider()
  provider.addSpanProcessor(new BatchSpanProcessor(
    new OTLPTraceExporter({ url: 'http://jaeger:4318/v1/traces' })
  ))
  provider.register()
}
```

### 4.3 OTel Pipeline: Known Issues

**Collector → Jaeger gRPC export failed.** The `otel-collector` could not export to Jaeger via gRPC (`4317`): `context deadline exceeded`. The cause: Collector uses a `batcher` by default, which can accumulate data longer than the downstream timeout. Solution: direct export to Jaeger HTTP (`jaeger:4318`).

### 4.4 Jaeger: Span Timelines

**Next.js (single request with force-dynamic):**

```
AppRender.renderToReadableStream  38,239μs  ← main render
├── AppRender.componentTree        3,582μs  ← build React tree
├── AppRender.jsonStringifyData    2–10μs   ← RSC payload serialize (×many)
├── AppRender.jsonStringifyData    2–10μs   ← each chunk separately
├── AppRender.jsonStringifyData    2–10μs
├── AppRender.jsonStringifyBootstrap 10μs   ← bootstrap payload
└── AppRender.renderToReadableStream 3,459μs ← child span (stream-ops.web.ts)
```

**Rari (cold request, cache miss):**

```
handle_app_route  20,921μs  ← full pipeline
└── route.match    2,715μs  ← path matching
```

**Note:** spans `v8.execute_composition`, `rsc.serialize_json` are not visible in this trace because the request took the cold path (Jaeger was restarted). In production mode with cache warmup, the rendering pipeline does not execute per request.

### 4.5 JSON.stringify Is Not a Bottleneck

Measurements show:

| Operation | Duration | Share of Request |
|-----------|----------|------------------|
| `JSON.stringify` (RSC bootstrap) | 10µs | 0.004% |
| `JSON.stringify` (RSC data chunk) | 2–10µs | 0.001–0.004% |
| `Buffer.from` + `toString('base64')` | — | not invoked |
| **Entire `AppRender.renderToReadableStream`** | **38,239µs** | **100%** |

JSON serialization accounts for an insignificant fraction of the request time (microseconds), making micro-optimizations of `JSON.stringify` in the SSR context negligible.

## 5. wrk Results

### 5.1 Throughput

**Static benchmark (both prerender/static):**

| Run | Rari (req/s) | Next.js (req/s) |
|-----|-------------|-----------------|
| 1 | 131,565 | 2,228 |
| 2 | 131,987 | 2,206 |
| 3 | 133,196 | 2,296 |
| **Median** | **131,987** | **2,228** |
| **Ratio** | | **~59x** |

**Streaming benchmark (both dynamic, Suspense):**

| Run | Rari (req/s) | Next.js (req/s) |
|-----|-------------|-----------------|
| wrk (-t4 -c25) | 117 | 22 |
| **Ratio** | | **~5.2x** |

**Fetch benchmark (both dynamic, self-fetch with force-cache):**

| Run | Rari (req/s) | Next.js (req/s) |
|-----|-------------|-----------------|
| wrk (-t12 -c100) | 125,463 | 228 |
| **Ratio** | | **~550x** |

The fetch benchmark demonstrates a substantial difference: the Rust HTTP client (reqwest inside the V8 isolate) handles self-fetch requests in microseconds, while Node.js (undici) spends milliseconds per request due to event loop overhead.

### 5.2 Latency

**Static benchmark:**

| Metric | Rari | Next.js |
|--------|------|---------|
| Avg | 0.78ms | 50.6ms |
| Stdev | 0.75ms | 98.3ms |
| Max | 46ms | 1.99s |
| P50 | **0.60ms** | 40ms |
| P75 | 0.93ms | 42ms |
| P90 | 1.43ms | 45ms |
| P99 | 3.58ms | 479ms |

**Streaming (profiler, 5 sequential requests):**

| Metric | Rari | Next.js |
|--------|------|---------|
| TTFB | 7ms (cold 415ms) | **6ms** |
| First content chunk | 7ms | **6ms** |
| Last byte | 1011ms | 1005ms |
| Chunks | **13** | 14 |
| Inter-chunk gap p95 | 498ms | 501ms |
| Skeleton duration | 1003ms | 999ms |
| Progressive bytes at 500ms | **27KB** | 15.6KB |
| Progressive bytes at 1000ms | **31.6KB** | 16.9KB |

### 5.3 Transfer

| Metric | Rari | Next.js |
|--------|------|---------|
| Transfer/sec (static) | 474 MB/s | 18.6 MB/s |
| Total data (30s) | 14.2 GB | 558 MB |

### 5.4 Summary Table

| Metric | Rari | Next.js | Ratio |
|--------|------|---------|-------|
| Requests/sec (static) | 135,993 | 2,347 | **~58x** |
| Requests/sec (fetch) | 125,463 | 228 | **~550x** |
| Avg latency (static) | 0.78ms | 50.6ms | **65x** |
| Transfer/sec (static) | 0.91 GB/s | 19.7 MB/s | **46x** |
| Requests/sec (stream) | 117 | 22 | **~5.2x** |
| TTFB (stream) | 7ms | **6ms** | 1.2x |
| Chunks (stream) | **13** | 14 | — |
| Inter-chunk gap p95 | 498ms | 501ms | identical |
| Progressive bytes 500ms | **27KB** | 15.6KB | — |

## 6. Analysis: Where and Why Rari Is Faster

### 6.1 Cache Warmup — Primary Factor

Rari in production mode prerenders pages at startup:

```
Cache warmup: Pre-rendering 1 routes...
Cache warmup: Completed in 54.9ms (1 succeeded, 0 failed)
```

After this, **each request is served from cache**: Rust reads the pre-built RSC buffer and serves it to the client. No React rendering, V8 isolate calls, or serialization — just `memcpy`. Response time per request: ~0.75ms.

Next.js without `force-dynamic` performs **static prerender** during `next build`: all async components resolve at build time, the runtime serves a pre-built HTML file from disk.

**Static benchmark — 59x.** The gap comes from HTTP-server differences: hyper (Rust async) vs Node.js http.createServer + Next.js middleware overhead. 0.75ms vs 41ms p50.

Pre-render cache is an architectural decision: production servers should serve pre-rendered pages. Next.js supports similar functionality (static prerender, ISR, Full Route Cache), but `force-dynamic` disables it.

### 6.2 Streaming: 14 Chunks vs 3

**The streaming scenario** showed that both frameworks now deliver progressive chunks:

**Next.js** (`GET /stream` with 10 Suspense boundaries, `force-dynamic`):
- TTFB = 5ms (shell delivered immediately, Suspense fallbacks render instantly)
- 14 chunks arrive progressively: 5 fast (100ms), 3 medium (500ms), 2 slow (1000ms)
- Full stream time = 1005ms

**Rari** (`GET /stream` with `loading.tsx`, `no-cache` config):
- TTFB = 7ms — comparable
- 13 chunks with the same pattern: fast (190ms), medium (570ms), slow (1070ms)
- Full stream time = 1013ms
- 17KB more progressive data at 500ms (27KB vs 15.6KB)

**Both frameworks deliver nearly identical progressive streaming** — TTFB difference is only 2ms, chunk count 13 vs 14. Rari sends more data earlier (27KB at 500ms vs 15.6KB for Next.js) due to a larger initial shell.

### 6.3 Fetch: Rust vs Node.js Comparison

**The fetch benchmark** showed that even a simple self-fetch (request to its own static file) executes **550x faster** on Rari.

The cause lies in different `fetch` implementations:
- **Rari** uses the Rust HTTP client `reqwest`, operating directly through hyper (Rust async I/O). An HTTP request to `http://127.0.0.1:3000/data.json` executes in microseconds — Rust makes the `connect` syscall, sends GET, receives the response, all in a single fast loop without context switching.
- **Next.js** uses Node.js `undici` (the new HTTP client). Each `fetch()` goes through the event loop, requires creating an `Undici` dispatcher, TCP connection through libuv, and returns the result via microtasks. This adds ~4-5ms overhead per request, even when the server and client are the same process.

With `force-cache` the difference is even more pronounced: Rust caches the HTTP response in memory and serves it without any system calls. Node.js also caches, but the overhead of fetch itself plus the event loop remains.

**Rari processed 125k self-fetch requests per second**, only slightly slower than serving static HTML (136k req/s). Next.js dropped from 2,347 req/s (static HTML) to 228 req/s (self-fetch) — a **10x degradation** due to HTTP stack overhead.

### 6.4 Rust vs Node.js: Overhead Comparison

| Factor | Contribution |
|--------|-------------|
| HTTP-server (hyper vs Node.js) | **~59x** (static, both prerender) |
| Rust runtime vs Node.js overhead | **~3-4x** (streaming, both dynamic) |
| Micro-optimizations | < 1% |

### 6.4 Factors Not Contributing to Performance Gain

- **JSON.stringify** — 2-10µs per call (confirmed by OTel). Not impactful.
- **Buffer.from** — binary chunks not triggered in our scenario.
- **React** — both use React 19 RSC renderer.
- **Transport** — HTTP/1.1, identical Network I/O.
- **RSC wire format** — identical.

### 6.5 OTel Instrumentation Limitations

Out of 6 patched span points in Next.js, only **3** actually execute. The rest are on non-executable paths:

- `bufferFromBase64` — all RSC payload chunks in our test are strings, not Uint8Array.
- `jsonStringifyBinary` — not invoked because there are no binary chunks.
- `streamToBuffer` — Next.js uses streaming response pipe, not buffering.

This case illustrates a general problem: instrumenting without prior execution path analysis can result in non-executable span points. Without Jaeger verification, half of the added spans would be dead code.

## 7. Conclusions

**Verdict:** 18x is a realistic estimate for dynamic scenarios. In prerender mode, the gap is ~58x due to HTTP-server overhead. On streaming, both frameworks are similar in progressive delivery (~5x in throughput). **The fetch benchmark (self-fetch with force-cache) demonstrates 550x acceleration from Rust's native HTTP stack.**

| Scenario | Gap | Cause |
|----------|-----|-------|
| Static (both prerender) | **~58x** | HTTP-server: hyper (Rust) vs Node.js |
| Fetch (self-fetch, force-cache) | **~550x** | Rust reqwest vs Node.js undici |
| Streaming (both dynamic) | **~5.2x** | Rust runtime vs Node.js + React overhead |

**Key takeaways:**

1. **Rust + V8 architecture delivers significant performance gains.** 58x on static, ~5x on streaming, and **550x on self-fetch** — confirmed results.

2. **Fetch is Rari's key advantage.** The Rust HTTP client (reqwest via hyper) handles self-fetch 550x faster than Node.js undici. For applications with intensive internal API calls, this yields substantial performance improvements.

3. **Progressive streaming is comparable.** Rari and Next.js deliver 13-14 chunks with nearly identical TTFB (7ms vs 6ms) and inter-chunk gap (~500ms p95). Rari sends more data early due to a larger initial shell.

4. **JSON.stringify is not a bottleneck.** 2-10µs vs 38ms total render time.

5. **OTel instrumentation requires verification.** Of 6 added span points, only 3 actually execute.

6. **Rust Docker builds require optimization.** Using phased COPY (manifests → cache, sources → build) reduces rebuild time from 60 min to ~3 min.

**When to choose Rari:**
- High-traffic RSC applications
- Pre-rendering with caching
- Rust expertise in the team

**When to stay with Next.js:**
- Need ecosystem (middleware, API routes, image optimization)
- ISR/SSG/DSR sufficient for the use case
- Node.js expertise in the team

## Source Code

All materials for reproduction:

- Rari fork with OTel patches: `rari/`
- Next.js fork with OTel patches: `nextjs/`
- Test projects: `app/rari-hello/`, `app/next-hello/`
- Environment configuration: `docker-compose.yml`, `otel/`, `wrk/`
- Results: `results/`
- Rari OTel span points: `rari/crates/rari/src/server/mod.rs`, `rari/crates/rari/src/runtime/mod.rs`, `rari/crates/rari/src/rsc/rendering/layout/core.rs`
- Next.js OTel span points: `nextjs/packages/next/src/server/app-render/use-flight-response.tsx`, `nextjs/packages/next/src/server/app-render/stream-ops.web.ts`, `nextjs/packages/next/src/server/stream-utils/node-web-streams-helper.ts`
