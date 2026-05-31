# Rari vs Next.js: Engineering Benchmark

Instrument both frameworks with OpenTelemetry spans, benchmark with wrk, and visualize timelines in Jaeger to verify Rari's claimed 18x speedup.

**TL;DR:** Rari is faster. 59x on static prerender, 3.4x on streaming Suspense. 18x is a conservative estimate for uncached dynamic scenarios.

## Quick Start

```bash
docker compose build jaeger wrk
docker compose up -d jaeger rari-app next-app
docker compose run --rm wrk
```

- Rari: http://localhost:3001
- Next.js: http://localhost:3002
- Jaeger: http://localhost:16686

## Benchmark Scenarios

| Route | Rari | Next.js | What it measures |
|-------|------|---------|-----------------|
| `/` | cache warmup (pre-render) | static prerender | HTTP serving speed |
| `/stream` | `loading.tsx` + no-cache | `force-dynamic` + Suspense | Progressive streaming |

Streaming route: 10 `<Suspense>` boundaries with delays 100ms×5, 500ms×3, 1000ms×2.

## Results

### Static (both prerender)

| Metric | Rari | Next.js | Ratio |
|--------|------|---------|-------|
| req/s | 131,987 | 2,228 | **59x** |
| p50 latency | 0.62ms | 42ms | **68x** |
| throughput | 474 MB/s | 18.6 MB/s | **25x** |

### Streaming Suspense (both dynamic)

| Metric | Rari | Next.js | Ratio |
|--------|------|---------|-------|
| req/s | 74 | 22 | **3.4x** |
| TTFB | 7ms | 5ms | 0.7x |
| Chunks | 13 | 14 | — |
| Inter-chunk gap p95 | 500ms | 500ms | identical |

## Directory Layout

| Directory | Description |
|-----------|-------------|
| `rari/` | Fork of rari-build/rari — patched with OTel spans |
| `nextjs/` | Fork of vercel/next.js — patched with OTel spans |
| `app/rari-hello/` | Rari test app with RSC component tree |
| `app/next-hello/` | Next.js test app with identical RSC tree |
| `wrk/` | wrk scripts + `stream-profile.js` (per-chunk profiler) |
| `otel/` | OpenTelemetry Collector config |
| `docs/` | Article, specs, plans |
| `results/` | Benchmark results |

## OTel Pipeline

Both apps export traces directly to Jaeger via OTLP HTTP:

```
Rari (tracing crate) → tracing-opentelemetry bridge → Jaeger (:4318)
Next.js (instrumentation.ts) → OTLPTraceExporter → Jaeger (:4318)
```

### Rari span points (Rust)

`http.request`, `handle_app_route`, `route.match`, `v8.execute_script`, `v8.execute_composition`, `v8.execute_script_streaming`, `rsc.render`, `rsc.serialize`, `rsc.serialize_json`

### Next.js span points (TypeScript)

Built-in: `BaseServer.handleRequest`, `AppRender.componentTree`, `AppRender.renderToReadableStream`, `AppRender.rscPayload`

Patched: `AppRender.jsonStringifyBootstrap`, `AppRender.jsonStringifyData`

## Docker Build Notes

Building Rari with embedded V8 + Deno takes ~60 min on first run. Optimizations:
- Phased COPY in Dockerfile: manifests first (cache deps), source code second (cache .rs files)
- `--mount=type=cache` for cargo registry, git db, .rusty_v8, target/
- Incremental rebuild after .rs changes: ~3 min

## Reproducibility

```bash
# Full cycle
docker compose build
docker compose up -d jaeger rari-app next-app
docker compose run --rm wrk

# Streaming profiler only
docker compose run --rm wrk sh -c "node /wrk/stream-profile.js rari-app:3000 next-app:3000"
```

Results land in `results/`.
