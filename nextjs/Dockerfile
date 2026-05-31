# Stage 1: Build Next.js from source fork (includes built-in OTel spans)
FROM node:22-bookworm-slim AS next-builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /workspace
COPY nextjs/ .

# Install workspace deps and build next package (TS→dist/)
RUN pnpm install --no-frozen-lockfile && \
    pnpm --filter=next... build && \
    cd packages/next && \
    npm pack

# Stage 2: Build test app with locally-built next
FROM node:22-alpine AS app-builder
WORKDIR /app

COPY app/next-hello/package.json .
COPY app/next-hello/next.config.js .
COPY app/next-hello/instrumentation.ts .
COPY app/next-hello/app ./app

# Install from npm first, then replace next with local build from source fork
COPY --from=next-builder /workspace/packages/next/next-*.tgz /tmp/next.tgz
COPY app/next-hello/public ./public
RUN --mount=type=cache,target=/root/.npm \
    npm install && \
    npm install /tmp/next.tgz && \
    rm /tmp/next.tgz

RUN --mount=type=cache,target=/root/.npm \
    npx next build

# Stage 3: Runtime
FROM node:22-alpine
WORKDIR /app
COPY --from=app-builder /app/.next/standalone/ .
COPY --from=app-builder /app/.next/static ./.next/static
COPY --from=app-builder /app/public ./public
COPY --from=app-builder /app/node_modules ./node_modules
ENV NODE_ENV=production
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
ENV OTEL_SERVICE_NAME=next-app
ENV NEXT_OTEL_VERBOSE=1
EXPOSE 3000
CMD ["node", "server.js"]
