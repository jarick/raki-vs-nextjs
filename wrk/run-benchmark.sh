#!/bin/sh
set -e

TARGETS="rari-app:3000 next-app:3000"
RESULTS_DIR="/results"
WARMUP_SECONDS=10
RUN_SECONDS=30
THREADS=12
CONNECTIONS=100
RUNS=3

mkdir -p "$RESULTS_DIR"

echo "=== Payload verification ==="
node /wrk/verify-payload.js

# Start docker stats capture in background
sh /wrk/capture-stats.sh "benchmark" "$((RUN_SECONDS + 5))" &
CAPTURE_PID=$!

for TARGET in $TARGETS; do
  NAME=$(echo "$TARGET" | cut -d: -f1)
  echo "=== Benchmarking $TARGET ==="

  # Warmup
  echo "Warmup ${WARMUP_SECONDS}s..."
  wrk -t"$THREADS" -c"$CONNECTIONS" -d"${WARMUP_SECONDS}s" --latency "http://$TARGET/" > /dev/null 2>&1

  # TTFB measurements
  echo "=== TTFB ===" >> "$RESULTS_DIR/${NAME}_run1.txt"
  curl --no-buffer -w "TTFB: %{time_starttransfer}s\nTotal: %{time_total}s\nSize: %{size_download}B\n" \
    -o /dev/null -m 10 "http://$TARGET/" 2>&1 | tee -a "$RESULTS_DIR/${NAME}_run1.txt"

  echo "--- next-app memory ---"
  docker exec next-app node -e "
    console.log(JSON.stringify(process.memoryUsage(), null, 2));
  " 2>/dev/null || echo "next-app container not accessible"

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
  node /wrk/stream-profile.js "$TARGET" || echo "stream-profile.js failed for $TARGET, continuing..."

  # Runs — fetch
  echo "Fetch throughput..."
  wrk -t"$THREADS" -c"$CONNECTIONS" -d"${RUN_SECONDS}s" --latency \
    "http://$TARGET/fetch" > "$RESULTS_DIR/${NAME}_fetch.txt" 2>&1

  # Fetch profile
  echo "Fetch profile (server-side fetch duration)..."
  node /wrk/fetch-profile.js "$TARGET" || echo "fetch-profile.js failed for $TARGET, continuing..."
done

wait $CAPTURE_PID 2>/dev/null || true

# Aggregate results
echo ""
echo "========================================"
echo "=== AGGREGATED RESULTS ==="
echo "========================================"
for TARGET in $TARGETS; do
  NAME=$(echo "$TARGET" | cut -d: -f1)
  echo ""
  echo "--- $NAME ---"
  for f in "$RESULTS_DIR/${NAME}"_run*.txt; do
    echo "File: $f"
    grep -E "(Requests/sec|Latency|Transfer/sec|TTFB|50%|75%|90%|99%)" "$f"
  done
done

echo ""
echo "--- Streaming Throughput ---"
for TARGET in $TARGETS; do
  NAME=$(echo "$TARGET" | cut -d: -f1)
  if [ -f "$RESULTS_DIR/${NAME}_stream.txt" ]; then
    echo "--- $NAME ---"
    grep -E "(Requests/sec|Latency|Transfer/sec)" "$RESULTS_DIR/${NAME}_stream.txt"
  fi
done

if [ -f "/results/streaming-results.json" ]; then
  echo ""
  echo "--- Streaming Profile Results ---"
  node -e "
    try {
      const d = require('/results/streaming-results.json');
      for (const r of d) {
        console.log(r.target + ':');
        if (r.error) { console.log('  ERROR: ' + r.error); continue; }
        console.log('  TTFB: ' + r.profile.ttfb_ms + 'ms');
        console.log('  First content: ' + r.profile.firstContentChunk_ms + 'ms');
        console.log('  Last byte: ' + r.profile.lastByte_ms + 'ms');
        console.log('  Chunks: ' + r.profile.chunks);
        console.log('  Gap p95: ' + r.profile.interChunkGap_ms.p95 + 'ms');
      }
    } catch(e) {
      console.error('Failed to parse streaming-results.json:', e.message);
    }
  "
fi

echo ""
echo "--- Fetch Throughput ---"
for TARGET in $TARGETS; do
  NAME=$(echo "$TARGET" | cut -d: -f1)
  if [ -f "$RESULTS_DIR/${NAME}_fetch.txt" ]; then
    echo "--- $NAME ---"
    grep -E "(Requests/sec|Latency|Transfer/sec)" "$RESULTS_DIR/${NAME}_fetch.txt"
  fi
done

if [ -f "/results/fetch-results.json" ]; then
  echo ""
  echo "--- Fetch Profile Results (server-side fetch duration) ---"
  node -e "
    try {
      const d = require('/results/fetch-results.json');
      for (const r of d) {
        console.log(r.target + ':');
        if (r.error) { console.log('  ERROR: ' + r.error); continue; }
        const f = r.fetchDuration_ms;
        console.log('  Runs: ' + r.successful + '/' + r.runs);
        console.log('  Fetch duration: min=' + f.min + 'ms median=' + f.median + 'ms mean=' + f.mean + 'ms max=' + f.max + 'ms p95=' + f.p95 + 'ms p99=' + f.p99 + 'ms');
      }
    } catch(e) {
      console.error('Failed to parse fetch-results.json:', e.message);
    }
  "
fi
