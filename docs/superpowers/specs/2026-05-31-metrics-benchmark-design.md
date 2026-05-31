# Метрики для статьи Rari vs Next.js

## 1. Цель

Добавить 8 метрик (P0-P3) в бенчмарк-инфраструктуру проекта для усиления аргументации в статье. Каждая метрика оценивается по сложности и полезности.

## 2. Приоритеты

| Priority | Метрика | Обоснование |
|----------|---------|-------------|
| P0 | P95/P99 latency | Бесплатно (флаг wrk), резко повышает качество |
| P0 | Payload equivalence | Критично для валидности сравнения |
| P1 | TTFB / time to last byte | Ключевое архитектурное различие (streaming vs buffering) |
| P1 | Saturation curve | Лучшая визуализация деградации |
| P2 | Cache hit ratio | Доказательство механизма 260x |
| P2 | CPU per request | Честность сравнения |
| P3 | Memory RSS | Стоимость хостинга |
| P3 | Span coverage | Доверие к OTel-инструментовке |

## 3. Имплементация

### 3.1 P0: P95/P99 latency

**Где**: `wrk/run-benchmark.sh`
**Что**: Добавить флаг `--latency` к wrk вызовам
**Сложность**: 5 минут, +2 строки
**Результат**: wrk выдаёт распределение p50/p75/p90/p99

### 3.2 P0: Payload equivalence

**Где**: `wrk/verify-payload.js` (новый файл)
**Что**: 
1. curl обоих серверов, сохранение тела ответа
2. Node.js-скрипт через React 19 Flight Client (`createFromFetch`) парсит оба RSC-потока
3. Сравнение: количество RSC-чанков, имена компонентов, структура props
4. Вывод: "Component tree идентичен: Page → Layout → Header, Main → CardList → Card[10]"
**Сложность**: ~80 строк JS, полдня

### 3.3 P1: TTFB / time to last byte

**Где**: `wrk/run-benchmark.sh`
**Что**: Добавить `curl --no-buffer` с `-w "%{time_starttransfer}:%{time_total}"` до/после wrk
**Сложность**: +10 строк bash, полдня
**Результат**: Rari TTFB ~0.3ms (из кеша), Next.js TTFB ~210ms (буферизация всего ответа)

### 3.4 P1: Saturation curve

**Где**: `wrk/saturation.sh` (новый файл)
**Что**: Цикл wrk по concurrency: 1, 10, 25, 50, 100, 200, 500
Каждый уровень: warmup 10s, run 30s. Парсинг req/s и latency в CSV.
Запускается отдельно: `sh saturation.sh`
**Сложность**: ~60 строк bash, 1-2 дня (7 уровней × 40s × 2 приложения × 3 повтора)
**Результат**: CSV для графика "Throughput vs Concurrency"

### 3.5 P2: Cache hit ratio

**Где**: 
- `rari/crates/rari/src/server/handlers/app_handler.rs` — новый route `/_cache-stats`
- `wrk/run-benchmark.sh` — curl этого эндпоинта после теста
**Что**: Rari уже имеет счётчики `cache_hits`/`cache_misses` в `ResponseCache` (AtomicU64). Нужно:
1. Добавить handler для `GET /_cache-stats` → JSON `{hits, misses, evictions, hit_ratio}`
2. Вызвать после benchmark: `curl http://rari-app:3000/_cache-stats`
**Сложность**: +20 строк Rust, 5 строк bash, полдня

### 3.6 P2: CPU per request

**Где**: `wrk/capture-stats.sh` (новый файл)
**Что**: Параллельный процесс `docker stats --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"` каждые 5 секунд
**Сложность**: ~30 строк bash, полдня
**Результат**: CPU·ms/req для каждого фреймворка

### 3.7 P3: Memory RSS

**Где**: Часть `capture-stats.sh` + отдельные команды `docker exec`
**Что**: 
- `docker stats` даёт RSS live
- Для Next.js: `process.memoryUsage()` через docker exec
- Для Rari: `/proc/self/status` или `malloc_stats`
**Сложность**: часть P2, дополнительно ~полдня

### 3.8 P3: Span coverage

**Контекст**: Ручные `opentelemetry::global::tracer().start()` в Rari заменяются на `tracing`-макросы. `tracing-opentelemetry` bridge уже настроен — tracing-спаны автоматически экспортируются как OTel.

Next.js уже использует встроенный `NextTracerImpl` — изменений не требует.

**Где**: `rari/crates/rari/src/`
**Что**:
1. Заменить все `opentelemetry::global::tracer("rari").start("span.name")` на `tracing::info_span!("span.name")` с `.entered()`
2. `http.request` (app_handler.rs:803): `let _span = info_span!("http.request", http.method = %method, http.path = %uri.path()).entered();` — guard auto-ends на всех return-путях
3. `rsc.render`: переместить span из `internal_render_to_rsc` (dead code) в `render_route_with_streaming`
4. streaming path: добавить `info_span!("rsc.streaming")` вокруг `render_partial_from_composition()`
5. Удалить неиспользуемый raw OTel boilerplate (прямые импорты `opentelemetry::global::tracer`)
**Сложность**: ~30 строк Rust, полдня

## 4. Изменения в файлах

| Файл | Тип | Строк +/- |
|------|-----|-----------|
| `wrk/run-benchmark.sh` | edit | +15 |
| `wrk/saturation.sh` | new | ~60 |
| `wrk/verify-payload.js` | new | ~80 |
| `wrk/capture-stats.sh` | new | ~30 |
| `rari/.../app_handler.rs` | edit | -5 |
| `rari/.../layout/core.rs` | edit | +10 |
| `rari/.../streaming/renderer.rs` | edit | +5 |
| `rari/.../renderer.rs` | edit | +0 |
| `rari/.../serializer/mod.rs` | edit | +0 |
| `rari/.../runtime/mod.rs` | edit | +0 |

## 5. Результаты для статьи

После имплементации статья получит:

1. **Таблица латентности**: avg / p50 / p90 / p99 / max для обоих фреймворков
2. **Payload equivalence**: подтверждение одинакового RSC-дерева
3. **TTFB разница**: Rari <1ms (streaming) vs Next.js ≈210ms (buffered)
4. **Saturation curve**: график req/s vs concurrency с точкой насыщения
5. **Cache hit ratio**: доказательство 100% hit rate в Rari
6. **CPU·ms/req**: честная efficiency
7. **Memory RSS**: стоимость runtime
8. **Span coverage**: полный Jaeger trace с фиксами

## 6. Границы

**НЕ входит в scope:**
- OTel overhead замер (P5 — не оправдывает сложность)
- Cold start latency (P4 — nice-to-have)
- Аллокационный профиль (heaptrack) — слишком сложно
- CPU flamegraph — потребует `perf` на Rust, не влезает в контейнер
- Сравнение 18x с разными RSC-деревьями
