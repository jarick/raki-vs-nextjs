# Streaming RSC Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clustered Suspense streaming `/stream` route to both test apps, build a per-chunk timing profiler, and integrate into the wrk benchmark.

**Architecture:** D3 approach — same Docker Compose services, new `/stream` route alongside existing `/`. Both apps serve both routes. Streaming profiler (Node.js) collects per-chunk metrics. wrk measures throughput degradation.

**Tech Stack:** Next.js 16.3 (source fork), Rari (Rust, V8), Node.js 22, wrk 4.2, Docker Compose

---

### Task 1: Next.js `/stream` page

**Files:**
- Create: `app/next-hello/app/stream/page.tsx`

- [ ] **Step 1: Create `app/next-hello/app/stream/page.tsx`**

```tsx
import { Suspense } from 'react'
import { Header } from '../header'

export const dynamic = 'force-dynamic'

const delays = {
  fast: [100, 100, 100, 100, 100],
  medium: [500, 500, 500],
  slow: [1000, 1000],
}

async function Card({ delay, title }: { delay: number; title: string }) {
  await new Promise((r) => setTimeout(r, delay))
  return (
    <div style={{ padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
      <h3>{title}</h3>
      <p>Loaded after {delay}ms</p>
    </div>
  )
}

function Skeleton() {
  return (
    <div
      style={{
        padding: 16,
        border: '1px solid #eee',
        borderRadius: 8,
        background: '#f5f5f5',
      }}
    >
      <div
        style={{ height: 24, width: '60%', background: '#ddd', borderRadius: 4 }}
      />
      <div
        style={{
          height: 16,
          width: '40%',
          background: '#eee',
          borderRadius: 4,
          marginTop: 8,
        }}
      />
    </div>
  )
}

function SkeletonCards({
  count,
  label,
  items,
}: {
  count: number
  label: string
  items: { delay: number; title: string }[]
}) {
  return (
    <>
      <h2>{label}</h2>
      {items.map((item, i) => (
        <Suspense key={i} fallback={<Skeleton />}>
          <Card delay={item.delay} title={item.title} />
        </Suspense>
      ))}
    </>
  )
}

export default async function StreamPage() {
  return (
    <main>
      <Header />
      <SkeletonCards
        count={delays.fast.length}
        label="Fast Items"
        items={delays.fast.map((d, i) => ({
          delay: d,
          title: `Fast Item ${i + 1}`,
        }))}
      />
      <SkeletonCards
        count={delays.medium.length}
        label="Medium Items"
        items={delays.medium.map((d, i) => ({
          delay: d,
          title: `Medium Item ${i + 1}`,
        }))}
      />
      <SkeletonCards
        count={delays.slow.length}
        label="Slow Items"
        items={delays.slow.map((d, i) => ({
          delay: d,
          title: `Slow Item ${i + 1}`,
        }))}
      />
    </main>
  )
}
```

- [ ] **Step 2: Verify `GET /stream` works in isolation**

Run: `npx next dev --port 3333 app/next-hello/` then `curl -sS --max-time 10 http://localhost:3333/stream | head -5`

Expected: HTML output with `<main><h1>Rari vs Next.js Benchmark</h1><h2>Fast Items</h2>` followed by skeleton divs.

---

### Task 2: Rari `/stream` page

**Files:**
- Create: `app/rari-hello/src/app/stream/page.tsx`
- Create: `app/rari-hello/src/app/stream/loading.tsx`

- [ ] **Step 1: Create `app/rari-hello/src/app/stream/page.tsx`**

```tsx
import { Suspense } from 'react'
import { Header } from '../../components/header'

export const dynamic = 'force-dynamic'

const delays = {
  fast: [100, 100, 100, 100, 100],
  medium: [500, 500, 500],
  slow: [1000, 1000],
}

async function Card({ delay, title }: { delay: number; title: string }) {
  await new Promise((r) => setTimeout(r, delay))
  return (
    <div style={{ padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
      <h3>{title}</h3>
      <p>Loaded after {delay}ms</p>
    </div>
  )
}

function Skeleton() {
  return (
    <div
      style={{
        padding: 16,
        border: '1px solid #eee',
        borderRadius: 8,
        background: '#f5f5f5',
      }}
    >
      <div
        style={{ height: 24, width: '60%', background: '#ddd', borderRadius: 4 }}
      />
      <div
        style={{
          height: 16,
          width: '40%',
          background: '#eee',
          borderRadius: 4,
          marginTop: 8,
        }}
      />
    </div>
  )
}

function SkeletonCards({
  label,
  items,
}: {
  label: string
  items: { delay: number; title: string }[]
}) {
  return (
    <>
      <h2>{label}</h2>
      {items.map((item, i) => (
        <Suspense key={i} fallback={<Skeleton />}>
          <Card delay={item.delay} title={item.title} />
        </Suspense>
      ))}
    </>
  )
}

export default async function StreamPage() {
  return (
    <main>
      <Header />
      <SkeletonCards
        label="Fast Items"
        items={delays.fast.map((d, i) => ({
          delay: d,
          title: `Fast Item ${i + 1}`,
        }))}
      />
      <SkeletonCards
        label="Medium Items"
        items={delays.medium.map((d, i) => ({
          delay: d,
          title: `Medium Item ${i + 1}`,
        }))}
      />
      <SkeletonCards
        label="Slow Items"
        items={delays.slow.map((d, i) => ({
          delay: d,
          title: `Slow Item ${i + 1}`,
        }))}
      />
    </main>
  )
}
```

- [ ] **Step 2: Create `app/rari-hello/src/app/stream/loading.tsx`**

```tsx
function Skeleton() {
  return (
    <div
      style={{
        padding: 16,
        border: '1px solid #eee',
        borderRadius: 8,
        background: '#f5f5f5',
      }}
    >
      <div
        style={{ height: 24, width: '60%', background: '#ddd', borderRadius: 4 }}
      />
      <div
        style={{
          height: 16,
          width: '40%',
          background: '#eee',
          borderRadius: 4,
          marginTop: 8,
        }}
      />
    </div>
  )
}

export default function Loading() {
  return (
    <main>
      <h1>Loading...</h1>
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} />
      ))}
    </main>
  )
}
```

This `loading.tsx` triggers `render_route_with_streaming()` in Rari's `layout/core.rs`. Without it, Rari renders the entire page synchronously — no streaming.

- [ ] **Step 3: Verify Rari builds with new files**

Run: `docker compose build rari-app`

Expected: build succeeds. No new cargo dependencies needed (only JSX/TSX source files).

---

### Task 3: Streaming Profiler

**Files:**
- Create: `wrk/stream-profile.js`

- [ ] **Step 1: Create `wrk/stream-profile.js`**

```javascript
const http = require('http')

const TARGETS = process.argv.slice(2)
if (TARGETS.length === 0) {
  console.error('Usage: node stream-profile.js <target> [target...]')
  console.error('Example: node stream-profile.js rari-app:3000 next-app:3000')
  process.exit(1)
}

const RUNS = 5
const TIMEOUT_MS = 15000

async function profileTarget(target) {
  const results = []

  for (let run = 1; run <= RUNS; run++) {
    const chunks = []
    const start = Date.now()
    let error = null

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.get(
          `http://${target}/stream`,
          { timeout: TIMEOUT_MS },
          (res) => {
            const chunks = []
            let totalBytes = 0
            let index = 0

            res.on('data', (chunk) => {
              const now = Date.now() - start
              chunks.push({
                index,
                ms: now,
                bytes: chunk.length,
                cumulativeBytes: totalBytes,
              })
              totalBytes += chunk.length
              index++
            })

            res.on('end', () => {
              const ttfb = chunks.length > 0 ? chunks[0].ms : 0
              const lastByte =
                chunks.length > 0 ? chunks[chunks.length - 1].ms : 0

              // Compute inter-chunk gaps
              const gaps = []
              for (let i = 1; i < chunks.length; i++) {
                gaps.push(chunks[i].ms - chunks[i - 1].ms)
              }

              // Sort gaps for percentiles
              const sorted = [...gaps].sort((a, b) => a - b)
              const gapMean =
                gaps.length > 0
                  ? gaps.reduce((a, b) => a + b, 0) / gaps.length
                  : 0
              const gapP50 =
                sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0
              const gapP95 =
                sorted.length > 0
                  ? sorted[Math.floor(sorted.length * 0.95)]
                  : 0
              const gapMax = sorted.length > 0 ? sorted[sorted.length - 1] : 0

              // Skeleton size estimate (first chunk is typically skeleton)
              const skeletonBytes =
                chunks.length > 0 ? chunks[0].bytes : 0
              const skeletonThreshold = skeletonBytes + 512

              // First contentful chunk (first chunk larger than skeleton)
              const firstContent = chunks.find(
                (c) => c.bytes > skeletonThreshold
              )

              // Progressive bytes at checkpoints
              const checkpoints = [500, 1000, 2000, 5000]
              const progressiveBytes = {}
              for (const cp of checkpoints) {
                const cpChunks = chunks.filter((c) => c.ms <= cp)
                progressiveBytes[`${cp}ms`] = cpChunks.reduce(
                  (a, c) => a + c.bytes,
                  0
                )
              }

              resolve({
                ttfb_ms: ttfb,
                firstContentChunk_ms: firstContent ? firstContent.ms : null,
                lastByte_ms: lastByte,
                chunks: chunks.length,
                interChunkGap_ms: {
                  mean: Math.round(gapMean * 100) / 100,
                  p50: gapP50,
                  p95: gapP95,
                  max: gapMax,
                },
                skeletonDuration_ms: lastByte - ttfb,
                progressiveBytes,
                error: null,
              })
            })
          }
        )

        req.on('error', (e) => {
          reject(new Error(`Request failed: ${e.message}`))
        })

        req.on('timeout', () => {
          req.destroy()
          reject(new Error('Timeout'))
        })
      })

      results.push(result)
      process.stderr.write(
        `  Run ${run}/${RUNS}: ttfb=${result.ttfb_ms}ms lastByte=${result.lastByte_ms}ms chunks=${result.chunks}\n`
      )
    } catch (e) {
      process.stderr.write(`  Run ${run}/${RUNS}: ERROR ${e.message}\n`)
      results.push({
        ttfb_ms: null,
        firstContentChunk_ms: null,
        lastByte_ms: null,
        chunks: null,
        interChunkGap_ms: null,
        skeletonDuration_ms: null,
        progressiveBytes: null,
        error: e.message,
      })
    }
  }

  // Aggregate: filter successful runs, compute medians
  const valid = results.filter((r) => !r.error && r.ttfb_ms !== null)

  if (valid.length === 0) {
    return {
      target,
      runs: RUNS,
      successful: 0,
      error: 'All runs failed',
    }
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }

  return {
    target,
    runs: RUNS,
    successful: valid.length,
    profile: {
      ttfb_ms: median(valid.map((r) => r.ttfb_ms)),
      firstContentChunk_ms: median(
        valid.map((r) => r.firstContentChunk_ms).filter(Boolean)
      ),
      lastByte_ms: median(valid.map((r) => r.lastByte_ms)),
      chunks: median(valid.map((r) => r.chunks)),
      interChunkGap_ms: {
        mean: Math.round(
          median(valid.map((r) => r.interChunkGap_ms.mean)) * 100
        ) / 100,
        p50: median(valid.map((r) => r.interChunkGap_ms.p50)),
        p95: median(valid.map((r) => r.interChunkGap_ms.p95)),
        max: median(valid.map((r) => r.interChunkGap_ms.max)),
      },
      skeletonDuration_ms: median(valid.map((r) => r.skeletonDuration_ms)),
      progressiveBytes: {
        '500ms': Math.round(
          median(valid.map((r) => r.progressiveBytes['500ms']))
        ),
        '1000ms': Math.round(
          median(valid.map((r) => r.progressiveBytes['1000ms']))
        ),
      },
    },
  }
}

async function main() {
  const allResults = []
  for (const target of TARGETS) {
    process.stderr.write(`\nProfiling ${target}...\n`)
    const result = await profileTarget(target)
    allResults.push(result)

    console.log(`\n--- ${target} ---`)
    if (result.error) {
      console.log(`  ERROR: ${result.error}`)
      continue
    }
    console.log(`  Runs: ${result.successful}/${result.runs}`)
    console.log(`  TTFB: ${result.profile.ttfb_ms}ms`)
    console.log(`  First content chunk: ${result.profile.firstContentChunk_ms}ms`)
    console.log(`  Last byte: ${result.profile.lastByte_ms}ms`)
    console.log(`  Chunks: ${result.profile.chunks}`)
    console.log(`  Inter-chunk gap (mean/p50/p95/max): ${
      result.profile.interChunkGap_ms.mean
    }/${result.profile.interChunkGap_ms.p50}/${
      result.profile.interChunkGap_ms.p95
    }/${result.profile.interChunkGap_ms.max}ms`)
    console.log(`  Skeleton duration: ${result.profile.skeletonDuration_ms}ms`)
    console.log(`  Progressive bytes: 500ms=${result.profile.progressiveBytes['500ms']}B 1000ms=${result.profile.progressiveBytes['1000ms']}B`)
  }

  // Write JSON results
  const fs = require('fs')
  const outputPath = '/results/streaming-results.json'
  fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2))
  process.stderr.write(`\nResults saved to ${outputPath}\n`)
}

main().catch(console.error)
```

- [ ] **Step 2: Verify script runs against a local target**

Run: `node wrk/stream-profile.js localhost:3000` (if Next.js dev server is running on 3000)

Expected: 5 sequential profile runs, human-readable summary printed, `streaming-results.json` saved.

---

### Task 4: wrk benchmark integration

**Files:**
- Modify: `wrk/run-benchmark.sh`

- [ ] **Step 1: Add streaming throughput test and profiler after existing flat benchmark**

Find the section after the flat wrk runs:

```bash
  # Runs
  for i in $(seq 1 $RUNS); do
    echo "Run $i of $RUNS..."
    wrk -t"$THREADS" -c"$CONNECTIONS" -d"${RUN_SECONDS}s" --latency \
      "http://$TARGET/" > "$RESULTS_DIR/${NAME}_run${i}.txt" 2>&1
  done
```

Replace with:

```bash
  # Runs — flat
  for i in $(seq 1 $RUNS); do
    echo "Run $i of $RUNS (flat)..."
    wrk -t"$THREADS" -c"$CONNECTIONS" -d"${RUN_SECONDS}s" --latency \
      "http://$TARGET/" > "$RESULTS_DIR/${NAME}_run${i}.txt" 2>&1
  done

  # Runs — streaming
  echo "Streaming throughput (4 threads, 25 connections)..."
  wrk -t4 -c25 -d15s --latency \
    "http://$TARGET/stream" > "$RESULTS_DIR/${NAME}_stream.txt" 2>&1

  # Streaming profile
  echo "Streaming profile (per-chunk timing)..."
  node /wrk/stream-profile.js "$TARGET"
```

- [ ] **Step 2: Add streaming results to aggregated output**

After the existing aggregation loop (`for TARGET in $TARGETS`), add:

```bash
  for TARGET in $TARGETS; do
    NAME=$(echo "$TARGET" | cut -d: -f1)
    echo ""
    echo "--- $NAME streaming ---"
    if [ -f "$RESULTS_DIR/${NAME}_stream.txt" ]; then
      grep -E "(Requests/sec|Latency|Transfer/sec)" "$RESULTS_DIR/${NAME}_stream.txt"
    fi
  done
```

Also add streaming results JSON reading:

```bash
if [ -f "/results/streaming-results.json" ]; then
  echo ""
  echo "--- Streaming Profile Results ---"
  node -e "
    const d = require('/results/streaming-results.json');
    for (const r of d) {
      console.log(r.target + ':');
      if (r.error) { console.log('  ERROR: ' + r.error); continue; }
      console.log('  TTFB: ' + r.profile.ttfb_ms + 'ms');
      console.log('  Last byte: ' + r.profile.lastByte_ms + 'ms');
      console.log('  Chunks: ' + r.profile.chunks);
      console.log('  Gap p95: ' + r.profile.interChunkGap_ms.p95 + 'ms');
    }
  "
fi
```

- [ ] **Step 3: Create `wrk/saturation-stream.sh` (optional, for concurrency ramp on streaming)**

If the existing `wrk/saturation.sh` exists, create a streaming variant. Otherwise skip.

---

### Task 5: Rebuild, deploy, and verify

- [ ] **Step 1: Rebuild and restart both apps**

```bash
docker compose build rari-app next-app
docker compose up -d rari-app next-app
```

Wait 10s for startup + cache warmup.

- [ ] **Step 2: Verify both routes work**

```bash
# Flat baseline (unchanged)
curl -sS --max-time 10 http://localhost:3001/ | head -3
curl -sS --max-time 10 http://localhost:3002/ | head -3

# Streaming (progressive chunks)
curl -sS --max-time 15 http://localhost:3001/stream | head -3
curl -sS --max-time 15 http://localhost:3002/stream | head -3
```

Expected: all return HTTP 200 with HTML. `/stream` routes show skeleton content immediately (first bytes arrive before full render completes).

- [ ] **Step 3: Run full benchmark**

```bash
docker compose run --rm wrk
```

Expected: flat baseline results similar to previous runs, plus new streaming throughput + profile metrics.

- [ ] **Step 4: Verify streaming profile output**

Check `results/streaming-results.json` exists with non-null metrics for both targets.

---

### Risk: Rari `<Suspense>` doesn't trigger streaming

If after Task 5 the Rari `/stream` route returns a complete page at once (no progressive chunks), Rari's V8 isn't streaming Suspense boundaries. Mitigation per spec:

- Revert to Rari's manual streaming pattern using `op_send_raw_chunk_to_rust`
- Create a custom composition script at `app/rari-hello/src/app/stream/composition.tsx` that sends chunks progressively
- This changes Rari's execution path significantly but produces comparable chunk-timing data

This step is ONLY needed if streaming doesn't work out of the box.
