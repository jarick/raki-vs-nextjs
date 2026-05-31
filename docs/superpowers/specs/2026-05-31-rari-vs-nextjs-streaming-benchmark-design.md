# Streaming RSC Benchmark: Rari vs Next.js

## Goal
Compare Rari and Next.js on dynamic streaming RSC with Suspense boundaries — measuring TTFB, progressive delivery, inter-chunk timing, and throughput degradation vs flat (non-streaming) baseline.

## Context
Existing benchmark (`docs/article.md`) compares Rari warmed cache (production mode) vs Next.js `force-dynamic`. The ~295x gap is dominated by cache vs no-cache, not by raw streaming pipeline performance. This spec defines a streaming-specific benchmark where both frameworks exercise real RSC streaming with Suspense boundaries, no route cache.

## Test Structure

### Route
- `GET /` — existing flat benchmark (unchanged, baseline)
- `GET /stream` — new clustered Suspense benchmark

### RSC Tree (`/stream`)
```
Page (async, no cache, force-dynamic)
├── <Header />                    — await 1ms, NO Suspense (fast, blocks shell)
├── <h2>Fast Items</h2>           — static text
├── <Suspense fallback={<Skeleton/>}>
│   └── <Card delay=100 />        — x5
├── <Suspense fallback={<Skeleton/>}>
│   └── <Card delay=100 />        — x5
├── <h2>Medium Items</h2>
├── <Suspense fallback={<Skeleton/>}>
│   └── <Card delay=500 />        — x3
├── <h2>Slow Items</h2>
├── <Suspense fallback={<Skeleton/>}>
│   └── <Card delay=1000 />       — x2
```

Each Card:
```tsx
export async function Card({ delay, title }: { delay: number; title: string }) {
  await new Promise(r => setTimeout(r, delay))
  return <div style={{padding:16,border:'1px solid #ccc',borderRadius:8}}>
    <h2>{title}</h2>
    <p>Loaded after {delay}ms delay</p>
  </div>
}
```

### Fallback (Skeleton)
```tsx
function Skeleton() {
  return <div style={{padding:16,border:'1px solid #eee',borderRadius:8,background:'#f5f5f5'}}>
    <div style={{height:24,width:'60%',background:'#ddd',borderRadius:4}} />
    <div style={{height:16,width:'40%',background:'#eee',borderRadius:4}} />
  </div>
}
```

## Implementation

### Next.js (`app/next-hello/`)
- Create `app/stream/page.tsx` with the tree above
- No additional config needed (React Suspense works natively)
- Existing `dynamic = 'force-dynamic'` in page

### Rari (`app/rari-hello/`)
- Create `app/rari-hello/src/app/stream/page.tsx` — same tree, but Rari JSX syntax
- **Must create** `app/rari-hello/src/app/stream/loading.tsx` — this triggers `render_route_with_streaming()` in `layout/core.rs`. Without it, Rari renders synchronously (no streaming).
- `loading.tsx` exports the `<Skeleton />` component as default
- Route `GET /stream` is auto-registered by Rari's filesystem router via `stream/page.tsx`

### Docker Compose (D3 approach)
- No new services. Both apps serve `GET /` and `GET /stream` from the same instance.
- Same Dockerfiles. Only source files change.

## Streaming Profiler

### `wrk/stream-profile.js` (Node.js)

**Input:** CLI args — target hosts, optional signal timeout
**Output:** JSON + human-readable summary

**Algorithm:**
```javascript
for each target in [rari-app:3000, next-app:3000]:
  for run = 1 to 5:
    const start = Date.now()
    let response
    try:
      response = await fetch(`http://${target}/stream`, { signal: AbortSignal.timeout(15000) })
    catch:
      record error, skip run, continue
    assert response.ok, else skip run
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0, index = 0
    while (true):
      try:
        const { done, value } = await reader.read()
      catch:
        record partial data before error
        break
      if (done) break
      chunks.push({ index, ms: Date.now() - start, bytes: value.length, cumulativeBytes: totalBytes })
      totalBytes += value.length; index++
    // compute metrics
    push to results[target]
```

**Metrics computed:**
| Metric | Definition |
|--------|-----------|
| `ttfb` | ms from fetch start to first chunk |
| `firstContentChunk` | ms when first chunk larger than `Skeleton` size arrives (threshold: median Skeleton size in bytes + 1 standard deviation) |
| `chunks` | total chunk count |
| `interChunkGaps` | array of gaps (mean, p50, p95, max) |
| `lastByte` | ms to complete response |
| `skeletonDuration` | time when last chunk arrived — ttfb (≈ streaming window) |
| `progressiveBytes[p]` | bytes received by ms points [500, 1000, 2000, 5000] |
| `chunkCountByTime[window]` | chunks received in each 100ms window |

### Integration with wrk

```bash
# Existing flat benchmark (unchanged)
wrk -t12 -c100 -d30s http://$target/

# Streaming throughput (lighter load — Suspense creates async backpressure)
wrk -t4 -c25 -d15s http://$target/stream

# Streaming profile (per-chunk timing)
node /wrk/stream-profile.js $target
```

The wrk streaming run uses lighter load (`-t4 -c25`) because:
- Suspense-backed requests involve async orchestration (promise resolution, boundary updates)
- Heavy concurrency on streaming can cause timeouts or backpressure distortion
- The primary streaming metric is per-chunk timing, not max throughput

## Risks

### Rari `<Suspense>` JSX Support (UNVERIFIED)
Rari's streaming infrastructure exists (StreamingRenderer, mpsc, `op_send_raw_chunk_to_rust`), but it's unknown whether `<Suspense fallback={...}>` in JSX actually triggers React's streaming path inside V8.

**What we know:**
- Rari's `render_route_with_streaming()` checks for `loading.tsx` and switches to streaming mode
- Rari has a `/streaming-contract` demo endpoint with manual chunk sending
- React 19's `renderToReadableStream` (used inside Rari's V8) supports Suspense natively

**What we don't know:**
- Whether `react-dom/server` inside V8 emits Suspense boundary updates automatically when encountering `<Suspense>` in JSX
- Whether Rari's composition layer forwards those updates through `mpsc` to the HTTP response

**Mitigation:**
1. First step: deploy Rari with `stream/page.tsx` + `loading.tsx`, do `curl`, observe if streaming chunks arrive progressively
2. If `<Suspense>` doesn't work in JSX, fall back to Rari's manual streaming pattern (composition script + `op_send_raw_chunk_to_rust`)
3. If manual pattern is needed, the Rari test becomes a custom JS composition module simulating the same Suspense delays — slightly different path from Next.js but comparable at the chunk-timing level

## Metrics and Output

### `results/streaming-results.json`
```json
{
  "rari-app": {
    "throughput": { "req_s": 0, "latency_avg_ms": 0 },
    "profile": {
      "ttfb_ms": { "p50": 0, "p95": 0 },
      "firstContentChunk_ms": { "p50": 0 },
      "lastByte_ms": { "p50": 0 },
      "interChunkGap_ms": { "mean": 0, "p50": 0, "p95": 0, "max": 0 },
      "skeletonDuration_ms": { "p50": 0 },
      "chunks": { "p50": 0 },
      "progressiveBytes": { "500ms": 0, "1000ms": 0 }
    }
  },
  "next-app": {  },
  "comparison": {
    "ttfb_ratio": 0,
    "lastByte_ratio": 0
  }
}
```

### Comparison with Flat Baseline
Metrics from `/` (existing) vs `/stream` (new):
- **TTFB degradation** — how much slower is TTFB with Suspense vs flat?
- **Throughput degradation** — req/s drop when streaming is enabled
- **Chunk efficiency** — do both frameworks emit similar number of chunks for same tree?

## Verification
1. Both apps serve `GET /` unchanged (baseline unaffected)
2. Both apps serve `GET /stream` — returning HTML with progressive chunks
3. `curl http://app/stream | head` shows skeleton HTML immediately, content arrives later
4. wrk doesn't timeout on streaming route
5. stream-profile.js produces valid JSON with non-null metrics
6. 5 sequential profile runs show consistent metrics (low variance)

## Success Criteria
- Streaming metrics for both Rari and Next.js are collected and comparable
- Flat vs streaming throughput degradation is quantified
- Article section can be written with real numbers, not speculation
