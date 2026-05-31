# syntax=docker/dockerfile:1.7

# Stage 1: Build Rari binary
FROM rust:1.85-bookworm AS rari-builder

WORKDIR /src

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    libclang-dev \
 && rm -rf /var/lib/apt/lists/*

COPY rari/Cargo.toml rari/Cargo.lock rari/rust-toolchain.toml ./
COPY rari/crates/rari/Cargo.toml crates/rari/
COPY rari/tools/snapshot/Cargo.toml tools/snapshot/
COPY rari/tools/prepare-binaries/Cargo.toml tools/prepare-binaries/
COPY rari/tools/release/Cargo.toml tools/release/

RUN mkdir -p crates/rari/src tools/snapshot/src && \
    touch crates/rari/src/lib.rs tools/snapshot/src/main.rs

RUN --mount=type=cache,target=/usr/local/cargo/git/db \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/.rusty_v8 \
    --mount=type=cache,sharing=locked,target=/src/target \
    cargo fetch

COPY rari/crates/rari/src crates/rari/src
COPY rari/tools/snapshot/src tools/snapshot/src

RUN mkdir -p crates/rari/snapshots && \
    touch crates/rari/snapshots/RARI_SNAPSHOT.bin && \
    printf 'pub static RESIDUAL_LAZY_ESM_SOURCES: &[(&str, &str)] = &[];\npub static RESIDUAL_LAZY_JS_SOURCES: &[(&str, &str)] = &[];\n' > crates/rari/snapshots/residual_lazy_sources.rs

RUN --mount=type=cache,target=/usr/local/cargo/git/db \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/.rusty_v8 \
    --mount=type=cache,sharing=locked,target=/src/target \
    cargo build --release --package rari-snapshot && \
    cargo run --release --bin build-snapshot -- crates/rari/snapshots && \
    cargo build --release --package rari && \
    cp target/release/rari /usr/local/bin/rari


# Stage 2: Build test app
FROM node:22-bookworm-slim AS app-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    libfontconfig1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=rari-builder /usr/local/bin/rari /usr/local/bin/rari

WORKDIR /app

COPY app/rari-hello/package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install

RUN --mount=type=cache,target=/root/.npm \
    npm install rari@0.14.1 vite --save-dev && \
    if [ -d node_modules/rari-linux-x64 ]; then cp /usr/local/bin/rari node_modules/rari-linux-x64/bin/rari; fi

COPY app/rari-hello/ .

RUN npx vite build && rm -rf node_modules src


# Stage 3: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libfontconfig1 \
    libssl3 \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home appuser

COPY --from=rari-builder /usr/local/bin/rari /usr/local/bin/rari
COPY --from=app-builder /app/dist /app/dist

WORKDIR /app

RUN mkdir -p dist/server && \
    printf '{"cacheControl":{"routes":{"/stream":"no-cache, no-store"}}}' > dist/server/config.json

ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
ENV OTEL_SERVICE_NAME=rari-app

EXPOSE 3000

USER appuser

CMD ["rari", "-m", "production", "-H", "0.0.0.0", "-p", "3000"]
