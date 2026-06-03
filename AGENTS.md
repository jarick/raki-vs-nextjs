# Rari vs Next.js Benchmark

Goal: verify Rari's 18x performance claims against Next.js through OTel instrumentation of both frameworks' source code and wrk benchmarking.

## Project Structure
- `rari/` — fork of rari-build/rari with OTel patches
- `nextjs/` — fork of vercel/next.js with OTel patches
- `app/rari-hello/` — Rari test project
- `app/next-hello/` — Next.js test project
- `otel/` — OpenTelemetry Collector config
- `wrk/` — container with wrk scripts
- `results/` — benchmark results
- `docs/` — specs and plans

## How to Run
```bash
docker compose build
docker compose up -d otel-collector jaeger
docker compose up -d rari-app next-app
docker compose run --rm wrk
```
