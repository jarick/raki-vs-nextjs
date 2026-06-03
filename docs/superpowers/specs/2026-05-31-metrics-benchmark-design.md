# Metrics for Rari vs Next.js article

## 1. Goal

Add 8 metrics (P0-P3) to the project's benchmark infrastructure to strengthen the article's analysis. Each metric is evaluated by complexity and value.

## 2. Priorities

| Priority | Metric | Rationale |
|----------|--------|-----------|
| P0 | P95/P99 latency | Free (wrk flag), dramatically improves quality |
| P0 | Payload equivalence | Critical for comparison validity |
| P1 | TTFB / time to last byte | Key architectural difference (streaming vs buffering) |
| P1 | Saturation curve | Best visualization of degradation |
| P2 | Cache hit ratio | Evidence for the 260x mechanism |
| P2 | CPU per request | Fairness of comparison |
| P3 | Memory RSS | Hosting cost |
| P3 | Span coverage | Trust in OTel instrumentation |

## 3. Implementation

### 3.1 P0: P95/P99 latency

**Where**: `wrk/run-benchmark.sh`
**What**: Add `--latency` flag to wrk calls
**Difficulty**: 5 minutes, +2 lines
**Result**: wrk outputs p50/p75/p90/p99 distribution

### 3.2 P0: Payload equivalence

**Where**: `wrk/verify-payload.js` (new file)
**What**: 
1. curl both servers, save response body
2. Node.js script using React 19 Flight Client (`createFromFetch`) parses both RSC streams
3. Compare: RSC chunk count, component names, props structure
4. Output: "Component tree identical: Page → Layout → Header, Main → CardList → Card[10]"
**Difficulty**: ~80 lines JS, half a day

### 3.3 P1: TTFB / time to last byte

**Where**: `wrk/run-benchmark.sh`
**What**: Add `curl --no-buffer` with `-w "%{time_starttransfer}:%{time_total}"` before/after wrk
**Difficulty**: +10 lines bash, half a day
**Result**: Rari TTFB ~0.3ms (from cache), Next.js TTFB ~210ms (full response buffering)

### 3.4 P1: Saturation curve

**Where**: `wrk/saturation.sh` (new file)
**What**: wrk loop over concurrency: 1, 10, 25, 50, 100, 200, 500
Each level: warmup 10s, run 30s. Parse req/s and latency into CSV.
Run separately: `sh saturation.sh`
**Difficulty**: ~60 lines bash, 1-2 days (7 levels × 40s × 2 apps × 3 repeats)
**Result**: CSV for "Throughput vs Concurrency" chart

### 3.5 P2: Cache hit ratio

**Where**: 
- `rari/crates/rari/src/server/handlers/app_handler.rs` — new `/_cache-stats` route
- `wrk/run-benchmark.sh` — curl this endpoint after the test
**What**: Rari already has `cache_hits`/`cache_misses` counters in `ResponseCache` (AtomicU64). Need to:
1. Add handler for `GET /_cache-stats` → JSON `{hits, misses, evictions, hit_ratio}`
2. Call after benchmark: `curl http://rari-app:3000/_cache-stats`
**Difficulty**: +20 lines Rust, 5 lines bash, half a day

### 3.6 P2: CPU per request

**Where**: `wrk/capture-stats.sh` (new file)
**What**: Parallel process: `docker stats --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"` every 5 seconds
**Difficulty**: ~30 lines bash, half a day
**Result**: CPU·ms/req for each framework

### 3.7 P3: Memory RSS

**Where**: Part of `capture-stats.sh` + separate `docker exec` commands
**What**: 
- `docker stats` provides RSS live
- For Next.js: `process.memoryUsage()` via docker exec
- For Rari: `/proc/self/status` or `malloc_stats`
**Difficulty**: Part of P2, additional ~half a day

### 3.8 P3: Span coverage

**Context**: Manual `opentelemetry::global::tracer().start()` calls in Rari are replaced with `tracing` macros. The `tracing-opentelemetry` bridge is already configured — tracing spans are automatically exported as OTel.

Next.js already uses the built-in `NextTracerImpl` — no changes needed.

**Where**: `rari/crates/rari/src/`
**What**:
1. Replace all `opentelemetry::global::tracer("rari").start("span.name")` with `tracing::info_span!("span.name")` + `.entered()`
2. `http.request` (app_handler.rs:803): `let _span = info_span!("http.request", http.method = %method, http.path = %uri.path()).entered();` — guard auto-ends on all return paths
3. `rsc.render`: move span from `internal_render_to_rsc` (dead code) to `render_route_with_streaming`
4. streaming path: add `info_span!("rsc.streaming")` around `render_partial_from_composition()`
5. Remove unused raw OTel boilerplate (direct imports of `opentelemetry::global::tracer`)
**Difficulty**: ~30 lines Rust, half a day

## 4. File Changes

| File | Type | Lines +/- |
|------|------|-----------|
| `wrk/run-benchmark.sh` | edit | +15 |
| `wrk/saturation.sh` | new | ~60 |
| `wrk/verify-payload.js` | new | ~80 |
| `wrk/capture-stats.sh` | new | ~30 |
| `rari/.../app_handler.rs` | edit | -5 |
| `rari/.../layout/core.rs` | edit | +10 |
| `rari/.../streaming/renderer.rs` | edit | +5 |
| `rari/.../renderer.rs` | edit | +0 |
| `rari/.../serializer/mod.rs` | edit | +0 |
| `rari/.../runtime/mod.rs` | edit | +0 |

## 5. Article Results

After implementation, the article will include:

1. **Latency table**: avg / p50 / p90 / p99 / max for both frameworks
2. **Payload equivalence**: confirmation of identical RSC trees
3. **TTFB difference**: Rari <1ms (streaming) vs Next.js ≈210ms (buffered)
4. **Saturation curve**: req/s vs concurrency chart with saturation point
5. **Cache hit ratio**: evidence of 100% hit rate in Rari
6. **CPU·ms/req**: fair efficiency comparison
7. **Memory RSS**: runtime cost
8. **Span coverage**: full Jaeger trace with fixes

## 6. Boundaries

**Out of scope:**
- OTel overhead measurement (P5 — complexity not justified)
- Cold start latency (P4 — nice-to-have)
- Allocation profile (heaptrack) — too complex
- CPU flamegraph — requires `perf` on Rust, not container-friendly
- 18x comparison across different RSC trees
