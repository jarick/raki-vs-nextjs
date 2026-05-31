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
