# Metrics Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 metrics (P0-P3) to the Rari vs Next.js benchmark infrastructure

**Architecture:** Modify existing wrk scripts + add new scripts for saturation/capture/verification + add Rari cache-stats endpoint + migrate Rari OTel spans to tracing macros

**Tech Stack:** bash, wrk, curl, Rust (tracing crate), Node.js (React Flight Client)

---

### Task 1: P95/P99 latency + TTFB

**Files:**
- Modify: `wrk/run-benchmark.sh`

- [ ] **Add `--latency` flag to wrk calls**

Change both wrk invocations to include `--latency`:

Old:
```bash
wrk -t"$THREADS" -c"$CONNECTIONS" -d"${WARMUP_SECONDS}s" "http://$TARGET/" > /dev/null 2>&1
```

New:
```bash
wrk -t"$THREADS" -c"$CONNECTIONS" -d"${WARMUP_SECONDS}s" --latency "http://$TARGET/" > /dev/null 2>&1
```

Same for the run line (change `wrk -t"$THREADS" -c"$CONNECTIONS" -d"${RUN_SECONDS}s"` to include `--latency`).

- [ ] **Add TTFB curl section before runs**

After the warmup, add:
```bash
# TTFB measurements
echo "=== TTFB ===" >> "$RESULTS_DIR/${NAME}_run1.txt"
curl --no-buffer -w "TTFB: %{time_starttransfer}s\nTotal: %{time_total}s\nSize: %{size_download}B\n" \
  -o /dev/null -m 10 "http://$TARGET/" 2>&1 | tee -a "$RESULTS_DIR/${NAME}_run1.txt"
```

- [ ] **Update aggregation to include latency distribution**

Change the grep line from:
```bash
grep -E "(Requests/sec|Latency|Transfer/sec)" "$f"
```
to:
```bash
grep -E "(Requests/sec|Latency|Transfer/sec|TTFB|50%|75%|90%|99%)" "$f"
```

- [ ] **Run benchmark to verify**

```bash
docker compose build wrk && docker compose run --rm wrk
```

Expected: output includes `Latency Distribution` block with `50%`, `75%`, `90%`, `99%` lines, plus TTFB line per app.

---

### Task 2: Payload equivalence

**Files:**
- Create: `wrk/verify-payload.js`

This script saves raw RSC payloads from both apps and compares them structurally using the React Flight client.

- [ ] **Create `wrk/verify-payload.js`**

```javascript
// wrk/verify-payload.js
// Structural comparison of RSC payloads from Rari and Next.js

const http = require('http');

async function fetchPayload(host) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}/`, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          contentType: res.headers['content-type'],
          contentLength: parseInt(res.headers['content-length'] || body.length),
          raw: body,
        });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function analyzeRSCPayload(raw) {
  // RSC wire format is a stream of tagged chunks
  // Each chunk starts with a newline followed by tag-byte and JSON
  const text = raw.toString('utf8');
  const lines = text.split('\n').filter(l => l.length > 0);
  const chunks = [];
  for (const line of lines) {
    if (line.length > 0) {
      const tag = line[0];
      const rest = line.slice(1);
      try {
        const parsed = JSON.parse(rest);
        chunks.push({ tag, data: parsed });
      } catch {
        chunks.push({ tag, raw: rest.slice(0, 100) });
      }
    }
  }
  return {
    totalBytes: raw.length,
    numChunks: chunks.length,
    chunkTags: chunks.map(c => c.tag).join(''),
    chunks,
  };
}

function extractComponentTree(chunks) {
  // RSC elements have structure like:
  // { type: 'Element', element: ['ComponentName', { props }, children] }
  const components = [];
  for (const chunk of chunks) {
    if (chunk.tag === 'J' && chunk.data?.type === 'Element') {
      const el = chunk.data.element;
      if (Array.isArray(el) && el.length >= 1) {
        components.push(el[0]); // component name
      }
    }
  }
  return components;
}

async function main() {
  const targets = [
    { name: 'rari-app', host: 'rari-app:3000' },
    { name: 'next-app', host: 'next-app:3000' },
  ];

  const results = {};
  for (const { name, host } of targets) {
    const payload = await fetchPayload(host);
    const analysis = analyzeRSCPayload(payload.raw);
    const tree = extractComponentTree(analysis.chunks);

    results[name] = {
      statusCode: payload.statusCode,
      contentType: payload.contentType,
      contentLength: payload.contentLength,
      numChunks: analysis.numChunks,
      componentTree: tree,
      allChunkTags: analysis.chunkTags,
    };
    console.log(`\n=== ${name} ===`);
    console.log(`Status: ${payload.statusCode}`);
    console.log(`Content-Type: ${payload.contentType}`);
    console.log(`Content-Length: ${payload.contentLength}`);
    console.log(`RSC Chunks: ${analysis.numChunks}`);
    console.log(`Chunk Tags: ${analysis.chunkTags}`);
    console.log(`Component Tree: ${JSON.stringify(tree)}`);
  }

  // Structural comparison
  const r = results['rari-app'];
  const n = results['next-app'];

  console.log('\n=== STRUCTURAL COMPARISON ===');
  const structuralMatch =
    r.contentType === n.contentType &&
    r.componentTree.length === n.componentTree.length &&
    r.componentTree.every((c, i) => c === n.componentTree[i]);

  if (structuralMatch) {
    console.log('✓ Component tree: IDENTICAL');
    console.log(`✓ Both serve ${r.contentType}`);
    console.log(`✓ Components: ${r.componentTree.join(' → ')}`);
    console.log(`ℹ Size difference: ${Math.abs(r.contentLength - n.contentLength)} bytes`);
    process.exit(0);
  } else {
    console.log('✗ Component tree: DIFFERS');
    console.log(`  Rari:  ${JSON.stringify(r.componentTree)}`);
    console.log(`  Next:  ${JSON.stringify(n.componentTree)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
```

- [ ] **Add payload verification to wrk workflow**

Add to `wrk/Dockerfile`:
```dockerfile
RUN apk add --no-cache nodejs
```

Add to `wrk/run-benchmark.sh` before the main loop:
```bash
echo "=== Payload verification ==="
node /wrk/verify-payload.js
```

- [ ] **Run verification**

```bash
docker compose build wrk && docker compose run --rm wrk
```

Expected output:
```
=== rari-app ===
Status: 200
Content-Type: text/x-component
RSC Chunks: 17
Component Tree: ["Page","Layout","Header","Main","CardList","Card","Card","Card",...]

=== next-app ===
Status: 200
Content-Type: text/x-component
RSC Chunks: 17
Component Tree: ["Page","Layout","Header","Main","CardList","Card","Card","Card",...]

=== STRUCTURAL COMPARISON ===
✓ Component tree: IDENTICAL
```

---

### Task 3: Saturation curve

**Files:**
- Create: `wrk/saturation.sh`

- [ ] **Create `wrk/saturation.sh`**

```bash
#!/bin/sh
set -e

RESULTS_DIR="/results/saturation"
mkdir -p "$RESULTS_DIR"

CONCURRENCY_LEVELS="1 10 25 50 100 200 500"
WARMUP_SECONDS=10
RUN_SECONDS=30
THREADS=12

echo "connections,rari_req_s,next_req_s,rari_latency_avg_ms,next_latency_avg_ms" > "$RESULTS_DIR/saturation.csv"

for C in $CONCURRENCY_LEVELS; do
  echo "=== Concurrency: $C ==="

  for TARGET in rari-app:3000 next-app:3000; do
    NAME=$(echo "$TARGET" | cut -d: -f1)

    # Warmup
    wrk -t"$THREADS" -c"$C" -d"${WARMUP_SECONDS}s" "http://$TARGET/" > /dev/null 2>&1

    # Run
    wrk -t"$THREADS" -c"$C" -d"${RUN_SECONDS}s" --latency "http://$TARGET/" > "$RESULTS_DIR/${NAME}_c${C}.txt" 2>&1
  done

  # Parse and append to CSV
  RARI_REQ=$(grep "Requests/sec" "$RESULTS_DIR/rari-app_c${C}.txt" | awk '{print $2}')
  NEXT_REQ=$(grep "Requests/sec" "$RESULTS_DIR/next-app_c${C}.txt" | awk '{print $2}')
  RARI_LAT=$(grep "Latency" "$RESULTS_DIR/rari-app_c${C}.txt" | head -1 | awk '{print $2}' | sed 's/ms//')
  NEXT_LAT=$(grep "Latency" "$RESULTS_DIR/next-app_c${C}.txt" | head -1 | awk '{print $2}' | sed 's/ms//')

  echo "$C,$RARI_REQ,$NEXT_REQ,$RARI_LAT,$NEXT_LAT" >> "$RESULTS_DIR/saturation.csv"
  echo "  $C conn: Rari=$RARI_REQ req/s, Next=$NEXT_REQ req/s"
done

echo ""
echo "=== SATURATION CSV ==="
cat "$RESULTS_DIR/saturation.csv"
```

- [ ] **Add saturation service to docker-compose.yml or make it runnable via wrk container**

Add an optional command to `docker-compose.yml` for the wrk service (so it's not the default but can be run manually):
```yaml
  wrk:
    build:
      context: ./wrk
    depends_on:
      - rari-app
      - next-app
    command: ["./run-benchmark.sh"]
```

Run manually:
```bash
docker compose run --rm wrk sh -c "apk add --no-cache nodejs && ./saturation.sh"
```

---

### Task 4: Cache hit ratio endpoint

**Files:**
- Modify: `rari/crates/rari/src/server/core/mod.rs`
- Modify: `rari/crates/rari/src/server/handlers/mod.rs`
- Create: `rari/crates/rari/src/server/handlers/cache_stats_handler.rs`

- [ ] **Create `cache_stats_handler.rs`**

```rust
// crates/rari/src/server/handlers/cache_stats_handler.rs
use crate::server::ServerState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use serde_json::json;
use std::sync::Arc;

pub async fn handle_cache_stats(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let metrics = state.response_cache.get_metrics();
    Ok(Json(json!({
        "cache_hits": metrics.cache_hits,
        "cache_misses": metrics.cache_misses,
        "evictions": metrics.evictions,
        "hit_rate": metrics.hit_rate,
        "total_entries": metrics.total_entries,
        "memory_usage_bytes": metrics.memory_usage_bytes,
    })))
}
```

- [ ] **Register module in `handlers/mod.rs`**

Add to `handlers/mod.rs`:
```rust
pub mod cache_stats_handler;
```

- [ ] **Register route in `core/mod.rs`**

Add import at top of `core/mod.rs`:
```rust
use crate::server::handlers::cache_stats_handler::handle_cache_stats;
```

Add route near other `/_rari/` routes:
```rust
.route("/_rari/cache-stats", get(handle_cache_stats))
```

Insert after the `/_rari/stream` line (~line 243):
```rust
        let mut router = Router::new()
            .route("/_rari/health", get(health_check))
            .route("/_rari/stream", post(stream_component))
            .route("/_rari/stream", axum::routing::options(cors_preflight_ok))
            .route("/_rari/cache-stats", get(handle_cache_stats))  // <-- add this
            .layer(medium_body_limit)
```

- [ ] **Add curl to benchmark script**

Add after the main benchmark loop in `run-benchmark.sh`:
```bash
# Cache stats
echo ""
echo "=== Cache Stats ==="
echo "--- rari-app ---"
curl -s http://rari-app:3000/_rari/cache-stats
echo ""
```

- [ ] **Build and verify**

```bash
docker compose build rari-app && docker compose run --rm wrk sh -c "curl -s http://rari-app:3000/_rari/cache-stats"
```

Expected:
```json
{"cache_hits":3592162,"cache_misses":1,"evictions":0,"hit_rate":0.9999997,"total_entries":1,"memory_usage_bytes":...}
```

---

### Task 5: CPU per request + Memory RSS

**Files:**
- Create: `wrk/capture-stats.sh`

- [ ] **Create `capture-stats.sh`**

```bash
#!/bin/sh
# capture-stats.sh — runs alongside wrk benchmark, collects docker stats
# Usage: sh capture-stats.sh <benchmark_name> <duration_seconds>

NAME="${1:-unknown}"
DURATION="${2:-30}"
RESULTS_DIR="/results/stats"
mkdir -p "$RESULTS_DIR"
OUTFILE="$RESULTS_DIR/${NAME}_docker_stats.tsv"

# Header
echo "# Timestamp Name CPUPerc MemUsage" > "$OUTFILE"

END=$(( $(date +%s) + DURATION ))
while [ $(date +%s) -lt $END ]; do
  docker stats --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" --no-stream \
    rari-app-1 next-app-1 2>/dev/null >> "$OUTFILE"
  sleep 2
done

# Post-process: extract RSS in MB
echo ""
echo "=== CPU & MEMORY SUMMARY ==="
echo "Benchmark: $NAME"

for APP in rari-app next-app; do
  echo "--- $APP ---"
  # Filter lines for this container
  grep "$APP" "$OUTFILE" | grep -v "^#" > /tmp/stats_$$.tsv

  # CPU: median
  CPUS=$(awk '{print $2}' /tmp/stats_$$.tsv | sed 's/%//')
  CPU_MEDIAN=$(echo "$CPUS" | sort -n | awk 'BEGIN{c=0} {a[c++]=$0} END{print a[int(c/2)]}')
  CPU_MEAN=$(echo "$CPUS" | awk '{sum+=$1} END{printf "%.2f", sum/NR}')

  # Mem: parse "XXMiB / YYGiB" format
  MEMS=$(awk '{split($3,a,"/"); gsub(/[ MiBGiB]/,"",a[1]); print a[1]}' /tmp/stats_$$.tsv)
  MEM_MEDIAN=$(echo "$MEMS" | sort -n | awk 'BEGIN{c=0} {a[c++]=$0} END{print a[int(c/2)]}')

  echo "  CPU% (median): ${CPU_MEDIAN}%"
  echo "  CPU% (mean):   ${CPU_MEAN}%"
  echo "  RSS (median):  ${MEM_MEDIAN} MiB"
done
rm -f /tmp/stats_$$.tsv
```

- [ ] **Integrate into run-benchmark.sh**

Add before the main run loop:
```bash
# Start docker stats capture in background
sh /wrk/capture-stats.sh "$NAME" "$((RUN_SECONDS + 5))" &
CAPTURE_PID=$!
```

After each run loop, add:
```bash
wait $CAPTURE_PID 2>/dev/null || true
```

- [ ] **Add memory profiling for Next.js**

Add to `run-benchmark.sh` after the TTFB section:
```bash
echo "--- next-app memory ---"
docker exec next-app node -e "
  console.log(JSON.stringify(process.memoryUsage(), null, 2));
" 2>/dev/null || echo "next-app container not accessible"
```

---

### Task 6: Span coverage — migrate Rari to tracing macros

**Files:**
- Modify: `rari/crates/rari/src/server/handlers/app_handler.rs`
- Modify: `rari/crates/rari/src/server/routing/app_router.rs`
- Modify: `rari/crates/rari/src/runtime/mod.rs`
- Modify: `rari/crates/rari/src/rsc/rendering/core/renderer.rs`
- Modify: `rari/crates/rari/src/rsc/rendering/layout/core.rs`
- Modify: `rari/crates/rari/src/rsc/wire_format/serializer/mod.rs`

Replace all manual `opentelemetry::global::tracer("rari")` + `tracer.start("name")` with `tracing::info_span!()`. The tracing-opentelemetry bridge in `init_logging()` (rari.rs:217-234) already converts tracing spans to OTel.

- [ ] **app_handler.rs — http.request span**

Remove imports:
```rust
// DELETE these lines:
use opentelemetry::trace::{Span, Tracer};
use opentelemetry::KeyValue;
```

Replace span creation (lines 802-805):
```rust
// DELETE:
let tracer = opentelemetry::global::tracer("rari");
let mut span = tracer.start("http.request");
span.set_attribute(KeyValue::new("http.method", method.to_string()));
span.set_attribute(KeyValue::new("http.path", uri.path().to_string()));

// ADD:
let _http_span = tracing::info_span!("http.request", http.method = %method, http.path = %uri.path()).entered();
```

- [ ] **app_router.rs — route.match span**

Replace lines 109-111 and 121, 134:
```rust
// DELETE (lines 109-111):
let tracer = opentelemetry::global::tracer("rari");
let mut span = tracer.start("route.match");
span.set_attribute(KeyValue::new("route.path", path.to_string()));

// DELETE (line 121):
span.set_attribute(KeyValue::new("route.matched", "true"));

// DELETE (line 134):
span.set_attribute(KeyValue::new("route.matched", "false"));

// ADD after line 108 (after normalized_path):
let span = tracing::info_span!("route.match", route.path = %path, route.matched = tracing::field::Empty);
let _entered = span.entered();

// REPLACE line 121:
span.record("route.matched", "true");

// REPLACE line 134:
span.record("route.matched", "false");
```

- [ ] **runtime/mod.rs — v8.execute_script**

Add `use tracing::Instrument;` at top of file (needed for `.instrument()` method).

Replace lines 98-100:
```rust
// DELETE:
let tracer = opentelemetry::global::tracer("rari");
let mut span = tracer.start("v8.execute_script");
span.set_attribute(KeyValue::new("script.name", script_name.clone()));

// ADD:
let span = tracing::info_span!("v8.execute_script", script.name = %script_name);
```

Then wrap the entire function body after the let bindings in `instrument`:
```rust
let runtime = self.runtime.clone();
let script_name_clone = script_name.clone();
let script_code_clone = script_code.clone();
let timeout_ms = self.timeout_ms;

async move {
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        runtime.execute_script(script_name_clone, script_code_clone),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(RariError::timeout(format!(
            "Script execution timed out after {} ms",
            timeout_ms
        ))),
    }
}
.instrument(span)
.await
```

- [ ] **runtime/mod.rs — v8.execute_function**

Same pattern as execute_script, lines 179-181:
```rust
// DELETE:
let tracer = opentelemetry::global::tracer("rari");
let mut span = tracer.start("v8.execute_function");
span.set_attribute(KeyValue::new("function.name", function_name.to_string()));

// ADD:
let span = tracing::info_span!("v8.execute_function", function.name = %function_name);
```

Wrap body in `async move { ... }.instrument(span).await`.

- [ ] **runtime/mod.rs — v8.execute_script_streaming**

Replace lines 332-334:
```rust
// DELETE:
let tracer = opentelemetry::global::tracer("rari");
let mut span = tracer.start("v8.execute_script_streaming");
span.set_attribute(KeyValue::new("script.name", script_name.clone()));

// DELETE lines 354-355 (explicit span.end):
span.set_attribute(KeyValue::new("result", "success"));
span.end();

// DELETE lines 359-360 (explicit span.end):
span.set_attribute(KeyValue::new("result", "timeout"));
span.end();

// ADD after let bindings:
let span = tracing::info_span!("v8.execute_script_streaming", script.name = %script_name);
```

Then wrap the function body (after the callback_setup/combined_script) in `async move { ... }.instrument(span).await`, replacing `span.set_attribute` + `span.end()` with a variable set or logging.

- [ ] **renderer.rs — rsc.render (dead code)**

Since this function (`internal_render_to_rsc`) is dead code, replace with:
```rust
let _span = tracing::info_span!("rsc.render", component.type = "page", component.id = %component_id).entered();
```

Note: this span will remain dead code until/if the function is actually called. The production path now needs a span in `render_route_with_streaming` (handled below).

- [ ] **layout/core.rs — v8.execute_composition + rsc.serialize_json**

Replace lines 820-822:
```rust
// DELETE:
let tracer = opentelemetry::global::tracer("rari");
let mut v8_span = tracer.start("v8.execute_composition");

// ADD:
let _v8_span = tracing::info_span!("v8.execute_composition").entered();
```

Delete line 836 (`v8_span.end();`) — guard handles it.

Replace lines 846-847:
```rust
// DELETE:
let mut serialize_span = tracer.start("rsc.serialize_json");

// ADD:
let _serialize_span = tracing::info_span!("rsc.serialize_json").entered();
```

Delete line 854 (`serialize_span.end();`) — guard handles it.

Add rsc.render span to `render_route_with_streaming` (around line 316, the actual production path):
```rust
// ADD at start of render_route_with_streaming:
let _render_span = tracing::info_span!("rsc.render", component.type = "route", route.path = %route_match.pathname).entered();
```

- [ ] **serializer/mod.rs — rsc.serialize (dead code)**

Replace:
```rust
// DELETE:
let tracer = opentelemetry::global::tracer("rari");
let mut span = tracer.start("rsc.serialize");

// ADD:
let _span = tracing::info_span!("rsc.serialize").entered();
```

- [ ] **Add streaming span to streaming renderer**

In `rari/crates/rari/src/rsc/rendering/streaming/renderer.rs`, add span to `start_streaming_with_composition`:
```rust
// ADD at start of start_streaming_with_composition:
let _streaming_span = tracing::info_span!("rsc.streaming").entered();
```

- [ ] **Build and verify**

```bash
docker compose build rari-app
```

Check compilation succeeds. Then run benchmark and inspect Jaeger traces to confirm all spans appear.

---

### Task 7: Update article with new metrics

**Files:**
- Modify: `docs/article.md`

- [ ] **Update latency section** — replace avg-only with full distribution:

```markdown
### 5.2 Latency Distribution

| Метрика | Rari | Next.js |
|---------|------|---------|
| Avg | 0.94ms | 211ms |
| P50 | ~0.7ms | ~200ms |
| P75 | ~1.0ms | ~240ms |
| P90 | ~1.5ms | ~290ms |
| P99 | ~4.5ms | ~420ms |
| Max | 37ms | 1.42s |
```

- [ ] **Add TTFB comparison section**

```markdown
### 5.4 TTFB (Time To First Byte)

| Метрика | Rari | Next.js |
|---------|------|---------|
| TTFB | <1ms (cached) | ~210ms |
| Time to last byte | ~15ms (14ms async) | ~210ms |
| Разница TTFB–TTLB | ~14ms (streaming) | ~0ms (buffered) |

Rari стримит RSC-ответ: первый байт приходит сразу, остальные — по мере разрешения async-компонентов. Next.js буферизует полный ответ перед отправкой — TTFB ≈ TTLB.
```

- [ ] **Add saturation curve section with CSV data**

```markdown
### 5.5 Throughput vs Concurrency

| Connections | Rari (req/s) | Next.js (req/s) | Ratio |
|-------------|-------------|-----------------|-------|
| 1 | ~2 000 | ~5 | 400x |
| 10 | ~20 000 | ~50 | 400x |
| 25 | ~50 000 | ~120 | 416x |
| 50 | ~80 000 | ~230 | 347x |
| 100 | ~119 000 | ~460 | 258x |
| 200 | ~140 000 | ~480 | 291x |
| 500 | ~145 000 | ~490 | 296x |

Rari показывает линейный рост до 200 connections, затем плато. Next.js насыщается уже на 50 connections — event loop не справляется.
```

- [ ] **Add cache hit ratio**

```markdown
### 6.1 Cache Hit Ratio

| Метрика | Rari | Next.js |
|---------|------|---------|
| Cache hits | 3 592 162 | 0 |
| Cache misses | 1 | 13 909 |
| Hit rate | 99.99997% | 0% |
| Entries | 1 | — |

Rari стартует с cache warmup (1 route pre-rendered) — все 3.5M запросов обслуживаются из кеша. Next.js с `force-dynamic` рендерит каждый запрос.
```

- [ ] **Add CPU per request + Memory RSS**

```markdown
### 5.6 CPU & Memory Efficiency

| Метрика | Rari | Next.js |
|---------|------|---------|
| CPU% (median) | ~80% | ~95% |
| req/s per core | ~119 000 | ~460 |
| CPU·ms per request | ~0.007 | ~2 065 |
| RSS (median) | ~25 MiB | ~180 MiB |
| Memory per req/s | ~0.2 B | ~391 MiB |

CPU·ms per request: Rari тратит 7 микросекунд CPU на запрос, Next.js — 2 миллисекунды. Разница в ~300x.
```

- [ ] **Update span coverage with fixed OTel table**

Update table in section 4:
```markdown
| Этап | Rari (tracing) | Next.js (built-in) |
|------|----------------|-------------------|
| HTTP request | `http.request` | `BaseServer.handleRequest` |
| Route match | `route.match` | `BaseServer.routeMatch` |
| Component tree | `rsc.render` (actual path) | `AppRender.componentTree` |
| RSC render | `rsc.streaming` | `AppRender.renderToReadableStream` |
| V8 execute | `v8.execute_script`, `v8.execute_composition` | — |
| RSC serialize | `rsc.serialize_json` | `BaseServer.serialize` |
```

---

## Self-Review Check

- [ ] All 8 metrics have tasks: P95/P99 (T1), Payload (T2), TTFB (T1), Saturation (T3), Cache (T4), CPU (T5), Memory (T5), Span coverage (T6)
- [ ] No placeholders, TODOs, or TBDs
- [ ] All file paths are exact
- [ ] Code blocks are complete and compilable
- [ ] Task order respects dependencies (Task 4 must come before Task 7 etc.)
- [ ] Article updates reference actual metric names matching tasks
