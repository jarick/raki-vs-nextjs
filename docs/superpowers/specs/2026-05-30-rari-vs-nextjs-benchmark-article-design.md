# Rari vs Next.js: Бенчмаркинг и статья на Хабр

## Цель
Проверить заявления Rari о 18x ускорении относительно Next.js с помощью OpenTelemetry инструментовки исходников обоих фреймворков и нагрузочного тестирования wrk. Написать хардкорную инженерную статью на Хабр.

## Целевая аудитория
Хардкорные инженеры, интересующиеся архитектурой рантаймов (Rust vs Node.js), внутренним устройством RSC, микро-бенчмаркингом.

## Структура статьи
1. **Введение** — Rari заявляет 18x быстрее Next.js. Маркетинг или реальность?
2. **Архитектура под микроскопом**
   - 2.1 Rari: Rust HTTP server → V8 isolate → RSC render → serialize
   - 2.2 Next.js: Node.js event loop → RSC render → serialize
   - 2.3 Принципиальная разница: нативный код vs JIT, zero-copy vs Buffer аллокации
3. **Методология эксперимента**
   - 3.1 Тестовый стенд: Docker (Docker Compose стек)
   - 3.2 RSC дерево: Page → Header → Main → CardList → Card[N] (async RSC)
   - 3.3 OpenTelemetry: карта span-точек в обоих рантаймах
   - 3.4 wrk: -t12 -c100 -d30s, warmup 10s + 3 runs, медиана
4. **Инструментовка: OTel в рантаймах**
   - 4.1 Rari: `opentelemetry` crate в Rust — точки внедрения
   - 4.2 Next.js: `@opentelemetry/api` в Node.js — точки внедрения
   - 4.3 Jaeger: визуализация span-таймлайнов
5. **Результаты wrk**
   - 5.1 Throughput (req/s)
   - 5.2 Latency (avg, p50, p95, p99)
   - 5.3 CPU profiling (flamegraph под нагрузкой)
6. **Анализ: где Rari реально быстрее?**
   - 6.1 Разбор span-таймлайнов
   - 6.2 V8 isolate vs Node.js warmup
   - 6.3 Serialization: zero-copy в Rust vs Buffer.toString() в Node.js
   - 6.4 Что НЕ даёт прироста
7. **Выводы** — вердикт для продакшна

## Технические решения

### Тестовый стенд
- Docker Compose стек:
  - `rari-app` — собранный из исходников Rari с OTel (multi-stage Dockerfile)
  - `next-app` — собранный из исходников Next.js с OTel (multi-stage Dockerfile)
  - `otel-collector` — OpenTelemetry Collector
  - `jaeger` — визуализация трейсов
  - `wrk` — контейнер с wrk для запуска тестов

### RSC тестовое дерево
```
Page (async RSC)
└── Header
└── Main
    └── CardList
        └── Card[N] (N=10, каждый async RSC)
```
Каждый Card содержит: заголовок + описание. Все компоненты — Server Components без `"use client"`. Асинхронность через `await` на промис.

### OTel span-точки

| Этап | Rari (Rust) | Next.js (Node.js) |
|------|-------------|-------------------|
| Приём соединения | `http.accept` — tokio::spawn | `http.accept` — http.createServer |
| Парсинг запроса | `http.parse` — hyper request | `http.parse` — IncomingMessage |
| Роутинг | `route.dispatch` — match path | `route.dispatch` — Next.js router |
| Init isolate/vm | `v8.isolate.init` | `v8.warmup` — модуль резолв |
| Рендер Page | `rsc.page` | `rsc.page` |
| Рендер Header | `rsc.header` | `rsc.header` |
| Рендер CardList | `rsc.card_list` | `rsc.card_list` |
| Рендер Card[N] | `rsc.card` (N child spans) | `rsc.card` (N child spans) |
| Await async data | `rsc.card.async` | `rsc.card.async` |
| Сериализация | `rsc.serialize` — Rust to bytes | `rsc.serialize` — JSON.stringify |
| Отправка | `http.write` — hyper::Response | `http.write` — ServerResponse |

### wrk параметры
- `-t12 -c100 -d30s` (многопоточный)
- Warmup 10s + 3 runs по 30s
- Берётся медиана по 3 runs
- Результаты: req/s, avg latency, p50, p95, p99

### Инструментовка Rari (Rust)
- Крейт `opentelemetry`
- Прогрев V8 isolate: Исследовать, нужно ли держать пул изолятов или создавать на каждый запрос
- Приоритет: zero-copy сериализация через `bytes` crate

### Инструментовка Next.js (Node.js)
- Пакет `@opentelemetry/api`
- Патч роутера Next.js для замеров этапов
- Сравнить с турбопаками

## Критерии успеха
1. Получены воспроизводимые цифры latency/throughput для обоих фреймворков
2. Получены span-таймлайны, показывающие распределение времени по этапам
3. Статья объёмом ~10 минут чтения, без воды, сфокусированная на инженерном анализе
4. Понятно, за счёт чего именно Rari быстрее (или не быстрее) в каждом этапе
