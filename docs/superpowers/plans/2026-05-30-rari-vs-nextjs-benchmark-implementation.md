# Rari vs Next.js Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверить заявления Rari о 18x ускорении относительно Next.js через OTel-инструментовку исходников и wrk-бенчмаркинг.

**Architecture:** Docker Compose стек из 5 сервисов: rari-app (Rust+V8+OTel), next-app (Node.js+OTel), otel-collector, jaeger, wrk. RSC тестовое дерево: Page→Header→Main→CardList→Card[x10] async components.

**Tech Stack:** Rust (Rari + tracing/tracing-subscriber + opentelemetry crate), TypeScript (Next.js + @opentelemetry/api), Docker/multi-stage, wrk, Jaeger/Tempo

---

### Важное замечание: OTel уже встроен в оба фреймворка

При изучении исходников выяснилось:

**Rari:**
- `init_logging()` в `crates/rari/src/bin/rari.rs` уже поднимает OTLP экспортёр через `tracing-opentelemetry`
- Все спаны уже расставлены: `http.request`, `route.match`, `rsc.render`, `v8.execute_script`, `rsc.serialize_json`, `rsc.serialize`
- `deno_telemetry` extension для JS-стороны тоже встроен
- Зависимости в `Cargo.toml` уже есть: `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp`, `tracing-opentelemetry`

**Next.js:**
- `packages/next/src/server/lib/trace/tracer.ts` — полноценная обёртка над `@opentelemetry/api`
- `packages/next/src/server/lib/trace/constants.ts` — все основные span-константы: `AppRenderSpan.rscPayload`, `AppRenderSpan.componentTree`, `BaseServerSpan.handleRequest/serialize/routeMatch` и др.
- Спаны уже воткнуты в `app-render.tsx`, `create-component-tree.tsx`, `base-server.ts`, `render-result.ts`
- Allowlist отфильтровывает неважные спаны — по умолчанию `componentTree`, `rscPayload`, `handleRequest`, `routeMatch`, `serialize` и др. активны
- Экспорт OTLP настраивается через `instrumentation.ts` в проекте (Next.js не имеет встроенного экспортёра, это ответственность пользователя)
- npm-пакет next не включает все спаны в compiled dist — поэтому Docker build собирает Next.js из source fork через pnpm

**Что всё ещё нужно сделать:**
- Rari: проверить, что per-component спаны (`rsc.card`, `rsc.header`) создаются или доработать если нет
- Next.js: создать `instrumentation.ts` с OTLP экспортёром (стандартный Next.js механизм)
- Согласовать имена спанов между фреймворками для прямого сравнения

---

### Task 0: Project Scaffolding

**Files:**
- Create: `D:\rari\.gitignore`
- Create: `D:\rari\docker-compose.yml`
- Modify: `D:\rari\AGENTS.md`

- [ ] **Step 1: Create .gitignore**

```gitignore
node_modules/
target/
dist/
.next/
results/*.json
*.log
*.pen
.superpowers/
```

- [ ] **Step 2: Create AGENTS.md with project context**

Write summary of project purpose: benchmark Rari vs Next.js with OTel. Note key directories: `rari/` (fork), `nextjs/` (fork), `app/` (test projects).

---

### Task 1: Create RSC Test Application (shared components)

**Files:**
- Create: `D:\rari\app\rari-hello\package.json`
- Create: `D:\rari\app\rari-hello\vite.config.ts`
- Create: `D:\rari\app\rari-hello\index.html`
- Create: `D:\rari\app\rari-hello\src\app\layout.tsx`
- Create: `D:\rari\app\rari-hello\src\app\page.tsx`
- Create: `D:\rari\app\rari-hello\src\components\header.tsx`
- Create: `D:\rari\app\rari-hello\src\components\card-list.tsx`
- Create: `D:\rari\app\rari-hello\src\components\card.tsx`

- [ ] **Step 1: Create Rari test project structure**

```json
{
  "name": "rari-hello",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "rari dev",
    "build": "rari build",
    "start": "rari start"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "rari": "latest",
    "typescript": "^5.7.0"
  }
}
```

Set `"rari": "workspace:*"` if using the local forked binary.

- [ ] **Step 2: Create vite.config.ts**

```typescript
import { defineConfig } from 'rari/vite'
export default defineConfig({})
```

- [ ] **Step 3: Create index.html**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body><div id="root"></div></body>
</html>
```

- [ ] **Step 4: Create root layout.tsx**

```tsx
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await new Promise(r => setTimeout(r, 1))
  return (
    <html>
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 5: Create page.tsx**

```tsx
import { Header } from '../components/header'
import { CardList } from '../components/card-list'

export default async function HomePage() {
  await new Promise(r => setTimeout(r, 1))
  return (
    <main>
      <Header />
      <CardList count={10} />
    </main>
  )
}
```

- [ ] **Step 6: Create header.tsx**

```tsx
export async function Header() {
  await new Promise(r => setTimeout(r, 1))
  return <h1>Rari vs Next.js Benchmark</h1>
}
```

- [ ] **Step 7: Create card-list.tsx**

```tsx
import { Card } from './card'

export async function CardList({ count }: { count: number }) {
  await new Promise(r => setTimeout(r, 1))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} title={`Item ${i + 1}`} description={`Description for item ${i + 1}`} />
      ))}
    </div>
  )
}
```

- [ ] **Step 8: Create card.tsx**

Each `await new Promise(r => setTimeout(r, 1))` simulates a 1ms async data fetch (mimicking real RSC data fetching):

```tsx
export async function Card({ title, description }: { title: string; description: string }) {
  await new Promise(r => setTimeout(r, 1))
  return (
    <div style={{ padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}
```

- [ ] **Step 9: Create identical Next.js project at `D:\rari\app\next-hello\`**

Same component files at `app/` (Next.js App Router uses `app/` directly, no `src/app/`):
- `D:\rari\app\next-hello\package.json` with `"next": "latest"` or `"next": "workspace:*"` for local fork
- `D:\rari\app\next-hello\next.config.js` with `output: 'standalone'`
- `D:\rari\app\next-hello\app\layout.tsx` — same code as Rari layout
- `D:\rari\app\next-hello\app\page.tsx` — same code as Rari page
- `D:\rari\app\next-hello\app\header.tsx` — same (no `components/` dir, flat or colocated)
- `D:\rari\app\next-hello\app\card-list.tsx` — same
- `D:\rari\app\next-hello\app\card.tsx` — same

Package.json:

```json
{
  "name": "next-hello",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "next": "latest"
  }
}
```

next.config.js:

```javascript
/** @type {import('next').NextConfig} */
module.exports = {
  output: 'standalone',
}
```

---

### Task 2: Verify and refine Rari OTel instrumentation

Rari уже имеет всю OTel-инфраструктуру. Нужно только проверить per-component spans и создать Dockerfile.

**Files:**
- Read: `D:\rari\rari\crates\rari\src\rsc\rendering\core\renderer.rs` — проверить существующие спаны
- Read: `D:\rari\rari\crates\rari\src\rsc\rendering\layout\core.rs` — проверить `v8.execute_composition` и `rsc.serialize_json`
- Read: `D:\rari\rari\crates\rari\src\bin\rari.rs` — убедиться что `init_logging()` конфигурится через `OTEL_EXPORTER_OTLP_ENDPOINT`
- Create: `D:\rari\rari\Dockerfile` — multi-stage сборка с Rust и runtime

- [ ] **Step 1: Verify existing spans match benchmark needs**

Проверить, что существующие спаны покрывают spec:

| Spec-спан | Rari-спан | Статус |
|-----------|-----------|--------|
| `http.accept` | — | tokio, не инструментирован явно (не нужен) |
| `http.parse` | — | hyper, не инструментирован явно (не нужен) |
| `route.dispatch` | `route.match` | ✅ существует |
| `v8.isolate.init` | `v8.execute_script` / `v8.execute_function` | ✅ существует |
| `rsc.page` | `rsc.render` с `component.type=page` | ✅ существует |
| `rsc.header` | `rsc.render` с `component.type=header` | ⚠️ проверить, передаётся ли component.id |
| `rsc.card_list` | `rsc.render` с `component.type=card_list` | ⚠️ проверить |
| `rsc.card` | `rsc.render` с `component.type=card` | ⚠️ проверить |
| `rsc.card.async` | `rsc.render` + `v8.execute_function` | ⚠️ проверить coverage |
| `rsc.serialize` | `rsc.serialize` + `rsc.serialize_json` | ✅ существует |
| `http.write` | — | hyper Response, не нужен отдельно |

- [ ] **Step 2: If per-component spans are insufficient, add them**

Если `renderer.rs::internal_render_to_rsc()` не создаёт отдельные спаны для каждого компонента (только один общий `rsc.render`), добавить `tracing::span!()` или `tracer.start()` вокруг рендера каждого компонента. Использовать макросы `tracing` для минимального оверхеда:

```rust
// В renderer.rs, перед рендером каждого компонента:
let component_span = tracing::info_span!("rsc.render", component.type = %component_type);
let _guard = component_span.enter();
```

Rari уже использует `tracing` + `tracing-opentelemetry` bridge, так что `tracing::info_span!()` автоматически создаст OTel-спан.

- [ ] **Step 3: Create Rari Dockerfile**

```dockerfile
# Build stage
FROM rust:1.85-bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y cmake pkg-config libssl-dev protobuf-compiler

COPY rari/ .
RUN cargo build --release --package rari

# Copy test app
FROM node:22-alpine AS app-builder
WORKDIR /app
COPY app/rari-hello/ .
RUN npm ci && npm run build

# Runtime stage
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/rari /usr/local/bin/rari
COPY --from=app-builder /app/dist /app/dist
WORKDIR /app
EXPOSE 3000
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
ENV OTEL_SERVICE_NAME=rari
CMD ["rari", "start", "--host", "0.0.0.0", "--port", "3000"]
```

> Rari `init_logging()` по умолчанию шлёт на `http://otel-collector:4318` (HTTP, не gRPC) — это важно! Порт 4318, а не 4317.

---

### Task 3: Configure Next.js OTel export (instrumentation.ts)

Next.js уже имеет встроенную OTel-инфраструктуру:
- `tracer.ts` — `NextTracerImpl` обёртка над `@opentelemetry/api`
- `constants.ts` — спаны: `BaseServerSpan.routeMatch/serialize`, `AppRenderSpan.componentTree/rscPayload`, `AppRenderSpan.renderToReadableStream` и др. — все в allowlist
- Спаны уже воткнуты в `base-server.ts`, `app-render.tsx`, `render-result.ts`, `create-component-tree.tsx`

**Важно:** npm-пакет next не включает все эти спаны в compiled dist. Чтобы получить их, собираем Next.js из source fork (`nextjs/`) в Docker. Тогда все встроенные спаны работают без патчей.

**Files:**
- Create: `D:\rari\app\next-hello\instrumentation.ts` — настройка OTLP экспортёра
- Create: `D:\rari\app\next-hello\package.json` — добавить OTel SDK пакеты
- Create: `D:\rari\nextjs\Dockerfile` — multi-stage с pnpm build next из source

- [ ] **Step 1: Create `instrumentation.ts` в тестовом проекте**

```typescript
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

export function register() {
  const provider = new NodeTracerProvider()
  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`
      : 'http://otel-collector:4318/v1/traces',
  })
  provider.addSpanProcessor(new BatchSpanProcessor(exporter))
  provider.register()
}
```

- [ ] **Step 2: Добавить OTel SDK в package.json**

```json
{
  "dependencies": {
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
    "@opentelemetry/sdk-trace-node": "^1.29.0",
    "@opentelemetry/sdk-trace-base": "^1.29.0"
  }
}
```

- [ ] **Step 3: Create Next.js Dockerfile (build from source fork)**

```dockerfile
# Stage 1: Build Next.js from source fork
FROM node:22-alpine AS next-builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /workspace
COPY nextjs/ .
RUN pnpm install --no-frozen-lockfile && \
    pnpm --filter=next build && \
    cd packages/next && npm pack

# Stage 2: Build test app with locally-built next
FROM node:22-alpine AS app-builder
WORKDIR /app
COPY app/next-hello/package.json .
COPY app/next-hello/next.config.js .
COPY app/next-hello/instrumentation.ts .
COPY app/next-hello/app ./app
COPY --from=next-builder /workspace/packages/next/next-*.tgz /tmp/next.tgz
RUN npm install && npm install /tmp/next.tgz && rm /tmp/next.tgz
RUN npx next build

# Stage 3: Runtime
FROM node:22-alpine
WORKDIR /app
COPY --from=app-builder /app/.next/standalone/ .
COPY --from=app-builder /app/.next/static ./.next/static
COPY --from=app-builder /app/node_modules ./node_modules
ENV NODE_ENV=production
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
ENV OTEL_SERVICE_NAME=next-app
ENV NEXT_OTEL_VERBOSE=1
EXPOSE 3000
CMD ["node", "server.js"]
```

> Сборка из source fork гарантирует все встроенные спаны без патчей.

---

### Task 4: Docker Infrastructure / Benchmark Stack

Оба приложения шлют трейсы по HTTP OTLP на `otel-collector:4318`. Collector форвардит в Jaeger по gRPC (4317).

**Files:**
- Modify: `D:\rari\docker-compose.yml`
- Create: `D:\rari\otel\otel-collector-config.yml`
- Create: `D:\rari\wrk\Dockerfile`
- Create: `D:\rari\wrk\run-benchmark.sh`

- [ ] **Step 1: Create otel-collector-config.yml**

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024

exporters:
  debug:
    verbosity: detailed
  otlp:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp, debug]
```

- [ ] **Step 2: Create docker-compose.yml**

```yaml
version: '3.9'

services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    volumes:
      - ./otel/otel-collector-config.yml:/etc/otel/config.yml
    command: ["--config", "/etc/otel/config.yml"]
    ports:
      - "4317:4317"
      - "4318:4318"

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"  # UI
      - "14250:14250"  # gRPC
    environment:
      - COLLECTOR_OTLP_ENABLED=true

  rari-app:
    build:
      context: .
      dockerfile: rari/Dockerfile
    ports:
      - "3001:3000"
    depends_on:
      - otel-collector
      - jaeger

  next-app:
    build:
      context: .
      dockerfile: nextjs/Dockerfile
    ports:
      - "3002:3000"
    depends_on:
      - otel-collector
      - jaeger

  wrk:
    build:
      context: ./wrk
    depends_on:
      - rari-app
      - next-app
    command: ["./run-benchmark.sh"]
```

- [ ] **Step 3: Create wrk/Dockerfile**

```dockerfile
FROM alpine:latest
RUN apk add --no-cache wrk jq
COPY run-benchmark.sh .
RUN chmod +x run-benchmark.sh
```

- [ ] **Step 4: Create wrk/run-benchmark.sh**

```bash
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

for TARGET in $TARGETS; do
  NAME=$(echo "$TARGET" | cut -d: -f1)
  echo "=== Benchmarking $TARGET ==="

  # Warmup
  echo "Warmup ${WARMUP_SECONDS}s..."
  wrk -t"$THREADS" -c"$CONNECTIONS" -d"${WARMUP_SECONDS}s" "http://$TARGET/" > /dev/null 2>&1

  # Runs
  for i in $(seq 1 $RUNS); do
    echo "Run $i of $RUNS..."
    wrk -t"$THREADS" -c"$CONNECTIONS" -d"${RUN_SECONDS}s" \
      "http://$TARGET/" > "$RESULTS_DIR/${NAME}_run${i}.txt" 2>&1
  done
done

# Aggregate results
echo "=== Results ==="
for TARGET in $TARGETS; do
  NAME=$(echo "$TARGET" | cut -d: -f1)
  echo "--- $NAME ---"
  # Extract median throughput and latency from runs
  for f in "$RESULTS_DIR/${NAME}"_run*.txt; do
    echo "File: $f"
    grep -E "(Requests/sec|Latency|Transfer/sec)" "$f"
  done
done
```

---

### Task 5: Build and Run Benchmarks

- [ ] **Step 1: Build all Docker images**

```bash
cd D:\rari
docker compose build
```

- [ ] **Step 2: Start the stack**

```bash
docker compose up -d otel-collector jaeger rari-app next-app
# Wait for health checks
docker compose run --rm wrk
```

- [ ] **Step 3: Open Jaeger UI**

Open `http://localhost:16686` to explore traces. Filter by service `rari` and `next.js`. Compare span timelines side by side.

- [ ] **Step 4: Collect wrk results**

```bash
docker compose cp wrk:/results ./results/
```

- [ ] **Step 5: Parse and compute median**

Create a quick script or do manually: for each framework, take 3 runs, extract req/s, avg latency, p95, p99, compute median.

---

### Task 6: Trace Analysis

- [ ] **Step 1: Export traces from Jaeger**

Use Jaeger API to get trace data for both services. Focus on:
- Root span duration distribution
- Child span breakdown (% time in HTTP, routing, V8/Node, RSC, serialize)
- Latency waterfall comparison

- [ ] **Step 2: Identify bottlenecks**

For each framework, compute:
- `http.*` total time
- `route.*` total time
- `v8.*` / `rsc.*` total time (this is the RSC render time)
- `rsc.serialize` total time
- `http.write` total time

Compare these across frameworks. This is the core of the article's analysis section.

---

### Task 7: Write Article

**File:** `D:\rari\article\rari-vs-nextjs-benchmark.md`

- [ ] **Step 1: Write introduction** — Rari claims 18x, the question, the approach

- [ ] **Step 2: Architecture section** — Rust+V8 vs Node.js in 1-2 paragraphs with a small diagram reference

- [ ] **Step 3: Methodology section** — Docker stack, RSC tree, OTel points, wrk params

- [ ] **Step 4: Instrumentation section** — OTel span map table (from spec), key code snippets

- [ ] **Step 5: Results section** — Table: req/s, avg/p50/p95/p99 latency for each. Include span time breakdown table

- [ ] **Step 6: Analysis section** — Point-by-point where Rari is faster and why

- [ ] **Step 7: Conclusion** — Verdict for production use

---

### Self-Review Checklist

1. **Spec coverage:** Every section from the spec has a corresponding task:
   - [x] RSC test tree → Task 1
   - [x] Rari instrumentation → Task 2
   - [x] Next.js instrumentation → Task 3
   - [x] Docker/infra → Task 4
   - [x] wrk benchmarks → Task 5 (via docker-compose + run-benchmark.sh)
   - [x] Trace analysis → Task 6
   - [x] Article → Task 7
   - [x] Architecture section → Task 7 Step 2
   - [x] Span table → Task 7 Step 4
   - [x] Span time analysis → Task 6 / Task 7 Step 6

2. **Placeholder scan:** All code blocks contain actual code (not "TBD" or "TODO"). No placeholder patterns found.

3. **Type consistency:** All file paths, span names, and component names are consistent across tasks. `rsc.card` spans in Task 2 match component names in Task 1. `rsc.serialize` span in Task 2 matches `serialization` constant in Task 3.
