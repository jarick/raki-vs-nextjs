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
