# Rari vs Next.js: OpenTelemetry Benchmark & Article

## Goal
Verify Rari's 18x performance claims against Next.js using OpenTelemetry instrumentation of both frameworks' source code and wrk load testing. Write an in-depth engineering article.

## Target Audience
Hardcore engineers interested in runtime architecture (Rust vs Node.js), internal RSC implementation, and micro-benchmarking.

## Article Structure
1. **Introduction** — Rari claims 18x faster than Next.js. Marketing or reality?
2. **Architecture Under the Microscope**
   - 2.1 Rari: Rust HTTP server → V8 isolate → RSC render → serialize
   - 2.2 Next.js: Node.js event loop → RSC render → serialize
   - 2.3 Fundamental difference: native code vs JIT, zero-copy vs Buffer allocations
3. **Methodology**
   - 3.1 Test environment: Docker Compose stack
   - 3.2 RSC tree: Page → Header → Main → CardList → Card[N] (async RSC)
   - 3.3 OpenTelemetry: span point map in both runtimes
   - 3.4 wrk: -t12 -c100 -d30s, warmup 10s + 3 runs, median
4. **Instrumentation: OTel in Runtimes**
   - 4.1 Rari: `opentelemetry` crate in Rust — injection points
   - 4.2 Next.js: `@opentelemetry/api` in Node.js — injection points
   - 4.3 Jaeger: span timeline visualization
5. **wrk Results**
   - 5.1 Throughput (req/s)
   - 5.2 Latency (avg, p50, p95, p99)
   - 5.3 CPU profiling (flamegraph under load)
6. **Analysis: Where Rari Is Actually Faster**
   - 6.1 Span timeline breakdown
   - 6.2 V8 isolate vs Node.js warmup
   - 6.3 Serialization: zero-copy in Rust vs Buffer.toString() in Node.js
   - 6.4 Factors not contributing to performance
7. **Conclusions** — verdict for production use

## Technical Decisions

### Test Environment
- Docker Compose stack:
  - `rari-app` — Rari built from source with OTel (multi-stage Dockerfile)
  - `next-app` — Next.js built from source with OTel (multi-stage Dockerfile)
  - `otel-collector` — OpenTelemetry Collector
  - `jaeger` — trace visualization
  - `wrk` — wrk container for test execution

### RSC Test Tree
```
Page (async RSC)
└── Header
└── Main
    └── CardList
        └── Card[N] (N=10, each async RSC)
```
Each Card contains: title + description. All components are Server Components without `"use client"`. Async via `await` on a promise.

### OTel Span Points

| Stage | Rari (Rust) | Next.js (Node.js) |
|-------|-------------|-------------------|
| Connection accept | `http.accept` — tokio::spawn | `http.accept` — http.createServer |
| Request parsing | `http.parse` — hyper request | `http.parse` — IncomingMessage |
| Routing | `route.dispatch` — match path | `route.dispatch` — Next.js router |
| Init isolate/vm | `v8.isolate.init` | `v8.warmup` — module resolve |
| Render Page | `rsc.page` | `rsc.page` |
| Render Header | `rsc.header` | `rsc.header` |
| Render CardList | `rsc.card_list` | `rsc.card_list` |
| Render Card[N] | `rsc.card` (N child spans) | `rsc.card` (N child spans) |
| Await async data | `rsc.card.async` | `rsc.card.async` |
| Serialization | `rsc.serialize` — Rust to bytes | `rsc.serialize` — JSON.stringify |
| Response send | `http.write` — hyper::Response | `http.write` — ServerResponse |

### wrk Parameters
- `-t12 -c100 -d30s` (multi-threaded)
- Warmup 10s + 3 runs of 30s
- Median across 3 runs
- Results: req/s, avg latency, p50, p95, p99

### Rari Instrumentation (Rust)
- `opentelemetry` crate
- V8 isolate warmup: investigate whether to maintain a pool of isolates or create per request
- Priority: zero-copy serialization via `bytes` crate

### Next.js Instrumentation (Node.js)
- `@opentelemetry/api` package
- Patch Next.js router for stage measurements
- Compare with turbopack

## Success Criteria
1. Reproducible latency/throughput figures for both frameworks
2. Span timelines showing time distribution across stages
3. Article ~10 minutes reading, focused on engineering analysis
4. Clear understanding of what makes Rari faster (or not) at each stage
