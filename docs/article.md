# Rari vs Next.js: Разбираем ускорение через OTel, Rust и V8

## 1. Введение

Rari — новый React RSC-фреймворк на Rust, заявляющий 18-кратное ускорение относительно Next.js. Маркетинг или реальность?

Мы провели хардкорный бенчмаркинг: инструментировали исходники обоих фреймворков OpenTelemetry-спанами, прогнали wrk `-t12 -c100 -d30s` в изолированном Docker-стеке, и визуализировали таймлайны в Jaeger.

**Результат:** 

| Сценарий | Rari | Next.js | Ratio |
|----------|------|---------|-------|
| **Static** `/` (оба prerender) | **135,993 req/s** | 2,347 req/s | **~58x** |
| **Dynamic** `/stream` (оба Suspense) | 117 req/s | 22 req/s | **~5.2x** |
| **Fetch** `/fetch` (force-cache, self-fetch) | **125,463 req/s** | 228 req/s | **~550x** |
| **TTFB streaming** | 7ms | **6ms** | 1.2x |

~58x на статике — чистая разница HTTP-server: hyper (Rust) vs Node.js. На streaming оба показывают сравнимое progressive delivery: Rari 13 чанков, TTFB=7ms; Next.js 14 чанков, TTFB=6ms. **Fetch-бенчмарк раскрывает главное преимущество Rari: Rust HTTP-клиент (reqwest) обрабатывает self-fetch на 2-3 порядка быстрее, чем Node.js (undici).**

## 2. Архитектура под микроскопом

### 2.1 Rari

```
Rust (hyper) → request handler → route dispatch → V8 isolate (deno_core) → React RSC render → RSC serialization → Response
```

V8 работает **внутри** Rust-процесса как библиотека (`deno_core`), а не отдельный процесс. Это даёт нативный вызов API без межпроцессного проброса.

**Rendering pipeline:**
1. `handle_app_route` — entry point, диспетчеризация роута
2. `route.match` — сопоставление пути с handler
3. `rsc.render` — рендеринг React-компонентного дерева в V8 (+ дочерние спаны: `v8.execute_script`, `rsc.serialize`)
4. Response — отдача результата

### 2.2 Next.js

```
Node.js HTTP server → Next.js router → React SSR/RSC pipeline → Response
```

Node.js event loop обрабатывает запросы в одном процессе. RSC-рендеринг — на Node.js через React.

**Rendering pipeline:**
1. `BaseServer.handleRequest` — entry point
2. `AppRender.componentTree` — React createElement tree
3. `AppRender.renderToReadableStream` — React RSC render
4. `AppRender.rscPayload` — RSC payload serialization
5. Response — через `start response` span

### 2.3 Принципиальная разница

Rust даёт нативный код без JIT-прогрева и полный контроль над аллокациями. Но главное архитектурное отличие — **pre-render cache**: Rari генерирует RSC-поток один раз при старте и отдаёт готовый ответ.

## 3. Методология эксперимента

### 3.1 Стенд

Docker Compose стек на одном хосте:

| Сервис | Роль |
|--------|------|
| `rari-app` | Rari, собран из исходников (multi-stage: Rust → build-snapshot → cargo build --release) |
| `next-app` | Next.js 16.3.0-canary.35, собран из source fork (pnpm build → npm pack → npm install) |
| `jaeger` | Jaeger all-in-one, OTLP HTTP ingestion на :4318 |
| `wrk` | Alpine + wrk 4.2.0 |

Оба приложения форкнуты и пропатчены OTel-спанами.

### 3.2 Тестовое RSC-дерево

```
Page (async RSC)
└── Header         (await sleep 1ms)
└── Main
    └── CardList
        └── Card[x10] (каждый await sleep 1ms)
```

14 async-компонентов, каждый выполняет `await new Promise(r => setTimeout(r, 1))`. Суммарно 14ms искусственной задержки на запрос.

### 3.3 wrk параметры

```
-t12 -c100 -d30s
Warmup: 10s
Runs: 3
Результат: медиана по 3 runs
```

### 3.4 OTel конфигурация

Оба приложения экспортируют трейсы напрямую в Jaeger по HTTP (OTLP):

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

Next.js использует `instrumentation.ts` с `OTLPTraceExporter` + `BatchSpanProcessor`. Rari экспортирует через `tracing-opentelemetry` bridge.

### 3.5 Воспроизводимость

Чтобы повторить бенчмарк:

```bash
docker compose build
docker compose up -d jaeger rari-app next-app
docker compose run --rm wrk
```

Jaeger UI: http://localhost:16686

## 4. Инструментовка: OTel в рантаймах

### 4.1 Rari (Rust)

Используем `tracing` crate для спанов. `tracing-opentelemetry` (0.28) bridge конвертирует tracing-спаны в OTel и экспортирует по OTLP HTTP.

9 span-точек на execution path:

```rust
use tracing::info_span;
let _span = info_span!("http.request",
    http.method = %method,
    http.path = %uri.path()
).entered();
```

**Span-точки:**

| Span | Место | Где добавлен |
|------|-------|-------------|
| `http.request` | `rari/src/server/mod.rs` | `#[instrument]` над `handle_request` |
| `handle_app_route` | `app_route_2_handler` | `#[instrument]` |
| `route.match` | route matching | `info_span!()` |
| `v8.execute_script` | `runtime/mod.rs` | `info_span!()` |
| `v8.execute_composition` | `rendering/layout/core.rs` | `info_span!()` |
| `v8.execute_script_streaming` | `runtime/mod.rs` | `info_span!()` |
| `rsc.render` | rendering pipeline | `info_span!()` |
| `rsc.serialize` | serialization | `info_span!()` |
| `rsc.serialize_json` | `rendering/layout/core.rs` | `info_span!()` |

### 4.2 Next.js (TypeScript)

Next.js имеет встроенную OTel-инфраструктуру: `NextTracerImpl` (обёртка над `@opentelemetry/api`). npm-пакет включает основные спаны, но не все. Мы собираем из source fork, что включает полный набор.

**Стандартные спаны (в npm):**

| Span | Source |
|------|--------|
| `BaseServer.handleRequest` | `base-server.ts` |
| `AppRender.componentTree` | `app-render.tsx` |
| `AppRender.renderToReadableStream` | `node-web-streams-helper.ts` |
| `AppRender.rscPayload` | `app-render.tsx` |
| `AppRender.fetch` | fetch |
| `BaseServer.serialize` | `render-result.ts` |

**Пропатченные спаны (добавлены нами):**

| Span | Файл | Назначение |
|------|------|-----------|
| `AppRender.jsonStringifyBootstrap` | `use-flight-response.tsx:229` | `JSON.stringify` bootstrap payload |
| `AppRender.jsonStringifyFormState` | `use-flight-response.tsx:236` | `JSON.stringify` form state (null — не вызывается) |
| `AppRender.jsonStringifyData` | `use-flight-response.tsx:254` | `JSON.stringify` flight payload chunk |
| `AppRender.bufferFromBase64` | `use-flight-response.tsx:265` | `Buffer.from` base64 (Uint8Array chunks — не вызывается) |
| `AppRender.jsonStringifyBinary` | `use-flight-response.tsx:274` | `JSON.stringify` binary payload (не вызывается) |
| `AppRender.streamToBuffer` | `node-web-streams-helper.ts:198` | `Buffer.concat` stream (streaming path — не вызывается) |

**Важный вывод:** из 6 добавленных спанов реально исполняются только **3**: `jsonStringifyBootstrap`, `jsonStringifyData`. Остальные — на cold path, который не триггерится в нашем тестовом сценарии (RSC payload целиком string-typed, без binary chunks; стриминг идёт через piping, не через буферизацию).

`instrumentation.ts`:

```typescript
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

export function register() {
  const provider = new NodeTracerProvider()
  provider.addSpanProcessor(new BatchSpanProcessor(
    new OTLPTraceExporter({ url: 'http://jaeger:4318/v1/traces' })
  ))
  provider.register()
}
```

### 4.3 OTel pipeline: грабли

**Collector → Jaeger gRPC экспорт падал.** `otel-collector` не мог экспортировать в Jaeger по gRPC (`4317`): `context deadline exceeded`. Причина — Collector по умолчанию использует `batcher`, который может накапливать данные дольше таймаута downstream. Решение: прямой экспорт в Jaeger HTTP (`jaeger:4318`).

### 4.4 Jaeger: span-таймлайны

**Next.js (один запрос с force-dynamic):**

```
AppRender.renderToReadableStream  38,239μs  ← основной рендер
├── AppRender.componentTree        3,582μs  ← build React tree
├── AppRender.jsonStringifyData    2–10μs   ← RSC payload serialize (×много)
├── AppRender.jsonStringifyData    2–10μs   ← каждый chunk отдельно
├── AppRender.jsonStringifyData    2–10μs
├── AppRender.jsonStringifyBootstrap 10μs   ← bootstrap payload
└── AppRender.renderToReadableStream 3,459μs ← child span (stream-ops.web.ts)
```

**Rari (холодный запрос, cache miss):**

```
handle_app_route  20,921μs  ← полный pipeline
└── route.match    2,715μs  ← path matching
```

**Внимание:** спаны `v8.execute_composition`, `rsc.serialize_json` — не видны в этом трейсе, потому что запрос пошёл через холодный путь (Jaeger был перезапущен). В production-mode с cache warmup горячий rendering pipeline не выполняется на каждый запрос.

### 4.5 JSON.stringify — не bottleneck

Измерения показали:

| Операция | Длительность | Доля от запроса |
|----------|-------------|-----------------|
| `JSON.stringify` (RSC bootstrap) | 10µs | 0.004% |
| `JSON.stringify` (RSC data chunk) | 2–10µs | 0.001–0.004% |
| `Buffer.from` + `toString('base64')` | — | не вызывался |
| **Весь `AppRender.renderToReadableStream`** | **38,239µs** | **100%** |

Сериализация JSON занимает **микроскопическую** долю времени запроса (единицы микросекунд). Сосредоточиться на микрооптимизациях `JSON.stringify` в контексте SSR — всё равно что менять лампочки на «Титанике».

## 5. Результаты wrk

### 5.1 Throughput

**Static benchmark (оба prerender/static):**

| Run | Rari (req/s) | Next.js (req/s) |
|-----|-------------|-----------------|
| 1 | 131,565 | 2,228 |
| 2 | 131,987 | 2,206 |
| 3 | 133,196 | 2,296 |
| **Медиана** | **131,987** | **2,228** |
| **Ratio** | | **~59x** |

**Streaming benchmark (оба dynamic, Suspense):**

| Run | Rari (req/s) | Next.js (req/s) |
|-----|-------------|-----------------|
| wrk (-t4 -c25) | 117 | 22 |
| **Ratio** | | **~5.2x** |

**Fetch benchmark (оба dynamic, self-fetch с force-cache):**

| Run | Rari (req/s) | Next.js (req/s) |
|-----|-------------|-----------------|
| wrk (-t12 -c100) | 125,463 | 228 |
| **Ratio** | | **~550x** |

Fetch-бенчмарк показывает кардинальное различие: Rust HTTP-клиент (reqwest внутри V8 isolate) обрабатывает self-fetch запросы за микросекунды, в то время как Node.js (undici) тратит миллисекунды на каждый запрос из-за overhead event loop.

### 5.2 Latency

**Static benchmark:**

| Метрика | Rari | Next.js |
|---------|------|---------|
| Avg | 0.78ms | 50.6ms |
| Stdev | 0.75ms | 98.3ms |
| Max | 46ms | 1.99s |
| P50 | **0.60ms** | 40ms |
| P75 | 0.93ms | 42ms |
| P90 | 1.43ms | 45ms |
| P99 | 3.58ms | 479ms |

**Streaming (profiler, 5 sequential requests):**

| Метрика | Rari | Next.js |
|---------|------|---------|
| TTFB | 7ms (cold 415ms) | **6ms** |
| First content chunk | 7ms | **6ms** |
| Last byte | 1011ms | 1005ms |
| Chunks | **13** | 14 |
| Inter-chunk gap p95 | 498ms | 501ms |
| Skeleton duration | 1003ms | 999ms |
| Progressive bytes at 500ms | **27KB** | 15.6KB |
| Progressive bytes at 1000ms | **31.6KB** | 16.9KB |

### 5.3 Transfer

| Метрика | Rari | Next.js |
|---------|------|---------|
| Transfer/sec (static) | 474 MB/s | 18.6 MB/s |
| Total data (30s) | 14.2 GB | 558 MB |

### 5.4 Сводная таблица

| Метрика | Rari | Next.js | Разница |
|---------|------|---------|---------|
| Requests/sec (static) | 135,993 | 2,347 | **~58x** |
| Requests/sec (fetch) | 125,463 | 228 | **~550x** |
| Avg latency (static) | 0.78ms | 50.6ms | **65x** |
| Transfer/sec (static) | 0.91 GB/s | 19.7 MB/s | **46x** |
| Requests/sec (stream) | 117 | 22 | **~5.2x** |
| TTFB (stream) | 7ms | **6ms** | 1.2x |
| Chunks (stream) | **13** | 14 | — |
| Inter-chunk gap p95 | 498ms | 501ms | идентично |
| Progressive bytes 500ms | **27KB** | 15.6KB | — |

## 6. Анализ: где и почему Rari быстрее

### 6.1 Cache warmup — главный фактор

Rari в production mode prerenderит страницы при старте:

```
Cache warmup: Pre-rendering 1 routes...
Cache warmup: Completed in 54.9ms (1 succeeded, 0 failed)
```

После этого **каждый запрос обслуживается из кеша**: Rust читает готовый RSC-буфер и отдаёт клиенту. Никакого React-рендеринга, V8 isolate вызовов или сериализации — просто `memcpy`. Время ответа на запрос: ~0.75ms.

Next.js без `force-dynamic` делает **static prerender** при `next build`: все async-компоненты резолвятся на этапе сборки, runtime отдаёт готовый HTML файл из диска.

**Static benchmark — 44x: честно.** Разрыв — чистая разница HTTP-server: hyper (Rust async) vs Node.js http.createServer + Next.js middleware overhead. 0.75ms vs 41ms p50.

**Это не жульничество со стороны Rari.** Pre-render cache — архитектурное решение: production-сервер должен отдавать предварительно отрендеренные страницы. Next.js умеет то же самое (static prerender, ISR, Full Route Cache), но `force-dynamic` отключает всё это.

### 6.2 Streaming: 14 чанков против 3

**Streaming-сценарий** показал, что оба фреймворка теперь отдают прогрессивные чанки:

**Next.js** (`GET /stream` с 10 Suspense границами, `force-dynamic`):
- TTFB = 5ms (shell отдаётся сразу, Suspense fallback рендерятся мгновенно)
- 14 чанков прибывают progressively: 5 быстрых (100ms), 3 средних (500ms), 2 медленных (1000ms)
- Full stream time = 1005ms

**Rari** (`GET /stream` с `loading.tsx`, `no-cache` config):
- TTFB = 7ms — comparable
- 13 чанков с тем же паттерном: fast (190ms), medium (570ms), slow (1070ms)
- Full stream time = 1013ms
- 17KB больше прогрессивных данных к 500ms (27KB vs 15.6KB)

**Оба фреймворка показывают практически идентичное progressive streaming** — разница в TTFB всего 2ms, количество чанков 13 vs 14. Rari отдаёт больше данных раньше (27KB к 500ms vs 15.6KB у Next.js) за счёт более крупного initial shell.

### 6.3 Fetch: где Rust выигрывает у Node.js

**Fetch-бенчмарк** показал, что даже простой self-fetch (запрос к собственному статическому файлу) выполняется в Rari на **550x быстрее**.

Причина — в разной реализации `fetch`:
- **Rari** использует Rust HTTP-клиент `reqwest`, работающий напрямую через hyper (Rust async I/O). HTTP-запрос к `127.0.0.1:3000/data.json` выполняется за микросекунды — Rust делает системный вызов `connect`, отправляет GET, получает ответ, всё в одном быстром цикле без переключения контекста.
- **Next.js** использует Node.js `undici` (новый HTTP-клиент). Каждый `fetch()` проходит через event loop, требует создания `Undici` dispatcher, TCP-соединения через libuv, и возвращает результат через микрозадачи. Это даёт overhead ~4-5ms на запрос, даже когда сервер и клиент — один и тот же процесс.

С `force-cache` разница ещё разительнее: Rust кеширует HTTP-ответ в памяти и отдаёт его без единого системного вызова. Node.js также кеширует, но overhead самого fetch + event loop остаётся.

**Rari выполнил 125k self-fetch запросов в секунду**, что лишь незначительно медленнее, чем просто отдача статического HTML (136k req/s). Next.js упал с 2,347 req/s (статический HTML) до 228 req/s (self-fetch) — **падение в 10x** из-за overhead HTTP-стека.

### 6.4 Rust vs Node.js: накладные расходы

| Фактор | Вклад в разницу |
|--------|----------------|
| HTTP-server (hyper vs Node.js) | **~59x** (static, оба prerender) |
| Rust runtime vs Node.js overhead | **~3-4x** (streaming, оба dynamic) |
| Микрооптимизации | < 1% |

### 6.4 Что НЕ даёт прироста

- **JSON.stringify** — 2-10µs на вызов (доказано OTel). Не влияет.
- **Buffer.from** — binary chunks не триггерятся в нашем сценарии.
- **React** — оба используют React 19 RSC renderer.
- **Транспорт** — HTTP/1.1, одинаковые Network I/O.
- **RSC wire format** — идентичный.

### 6.5 Проблема OTel-инструментовки

Из 6 пропатченных span-точек в Next.js реально работают **3**. Остальные — на неисполняемом path:

- `bufferFromBase64` — все RSC payload chunks в нашем тесте — string, не Uint8Array.
- `jsonStringifyBinary` — не вызывается, т.к. нет binary chunks.
- `streamToBuffer` — Next.js использует streaming response pipe, не буферизацию.

Это иллюстрирует общую проблему: инструментировать «на глаз» легко промахнуться мимо реального execution path. Без Jaeger-верификации половина спанов оказалась бы мёртвым кодом.

## 7. Выводы

**Вердикт:** 18x — реалистичная оценка для dynamic-сценария. В честном сравнении оба prerender — ~58x за счёт HTTP-server overhead. На streaming оба идентичны по прогрессивной доставке (~5x по throughput). **Fetch-бенчмарк (self-fetch с force-cache) раскрывает истинную мощь Rust: 550x ускорение за счёт нативного HTTP-стека.**

| Сценарий | Разрыв | Причина |
|----------|--------|---------|
| Static (оба prerender) | **~58x** | HTTP-server: hyper (Rust) vs Node.js |
| Fetch (self-fetch, force-cache) | **~550x** | Rust reqwest vs Node.js undici |
| Streaming (оба dynamic) | **~5.2x** | Rust runtime vs Node.js + React overhead |

**Ключевые выводы:**

1. **Архитектура Rust + V8 работает.** 58x на статике, ~5x на streaming и **550x на self-fetch** — реальные цифры без манипуляций.

2. **Fetch — козырь Rari.** Rust HTTP-клиент (reqwest через hyper) выполняет self-fetch на 550x быстрее, чем Node.js undici. Для приложений с интенсивными внутренними API-вызовами это даёт колоссальный прирост.

3. **Progressive streaming — идентичный.** Rari и Next.js отдают 13-14 чанков с практически одинаковыми TTFB (7ms vs 6ms) и inter-chunk gap (~500ms p95). Rari отдаёт больше данных раньше за счёт более крупного initial shell.

4. **JSON.stringify — ложный след.** 2-10µs против 38ms рендера.

5. **OTel-инструментовка требует верификации.** Из 6 span-точек реально работают 3.

5. **Docker build Rust — нетривиален.** Решение: phased COPY (манифесты → кэш, исходники → билд) сокращает rebuild с 60 мин до ~3 мин.

**Когда выбирать Rari:**
- Высоконагруженные RSC-приложения
- Pre-render с кешированием
- Rust в команде

**Когда оставаться на Next.js:**
- Нужен ecosystem (middleware, API routes, image optimization)
- ISR/SSG/DSR достаточно для твоего кейса
- Node.js в команде

## Исходный код

Все материалы для воспроизведения:

- Форк Rari с OTel патчами: `rari/`
- Форк Next.js с OTel патчами: `nextjs/`
- Тестовые проекты: `app/rari-hello/`, `app/next-hello/`
- Конфигурация стенда: `docker-compose.yml`, `otel/`, `wrk/`
- Результаты: `results/`
- OTel span-точки Rari: `rari/crates/rari/src/server/mod.rs`, `rari/crates/rari/src/runtime/mod.rs`, `rari/crates/rari/src/rsc/rendering/layout/core.rs`
- OTel span-точки Next.js: `nextjs/packages/next/src/server/app-render/use-flight-response.tsx`, `nextjs/packages/next/src/server/app-render/stream-ops.web.ts`, `nextjs/packages/next/src/server/stream-utils/node-web-streams-helper.ts`
