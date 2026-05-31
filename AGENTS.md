# Rari vs Next.js Benchmark

Цель: проверить заявления Rari о 18x ускорении относительно Next.js через OTel-инструментовку исходников и wrk-бенчмаркинг.

## Структура проекта
- `rari/` — fork rari-build/rari с OTel патчами
- `nextjs/` — fork vercel/next.js с OTel патчами
- `app/rari-hello/` — Rari тестовый проект
- `app/next-hello/` — Next.js тестовый проект
- `otel/` — конфиг OpenTelemetry Collector
- `wrk/` — контейнер с wrk скриптами
- `results/` — результаты бенчмарков
- `docs/` — spec и plan

## Как запустить
```bash
docker compose build
docker compose up -d otel-collector jaeger
docker compose up -d rari-app next-app
docker compose run --rm wrk
```
