# syntax=docker/dockerfile:1
#
# WASM_OS — fully-from-source container for Railway (no git-LFS dependency).
#
# Four build stages run in parallel, then a slim runtime serves the result:
#   emu     emscripten -> the MIT TinyEMU riscv64 WASM core
#   image   download + splitimg -> the riscv64 Linux guest image
#   build   Rust + Node + Zig -> kernel/bindings, guest wasm, esbuild workers, React SPA
#   runtime node-slim -> the production COOP/COEP static server (tools/prod-server.mjs)
#
# Everything the host fetches at runtime is built here, so the deploy needs no LFS
# materialization and is reproducible from source.

# ---------------------------------------------------------------------------
# emu — build the MIT TinyEMU riscv64 core to WASM from source (emscripten).
# ---------------------------------------------------------------------------
FROM emscripten/emsdk:5.0.7 AS emu
RUN apt-get update && apt-get install -y --no-install-recommends curl perl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Only the recipe + our worker glue are needed; the MIT source is downloaded + pinned.
COPY third_party/tinyemu/build-from-source.sh third_party/tinyemu/lib.js /src/third_party/tinyemu/
RUN bash /src/third_party/tinyemu/build-from-source.sh
# -> /src/third_party/tinyemu/riscvemu64-wasm.{wasm,js}

# ---------------------------------------------------------------------------
# image — assemble the riscv64 guest image (bbl + kernel + split rootfs).
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS image
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev tar ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /out
COPY assets/linux/build-image.sh /out/build-image.sh
RUN bash /out/build-image.sh
# -> /out/{bbl64.bin, kernel-riscv64.bin, riscv64-rootfs/}

# ---------------------------------------------------------------------------
# build — kernel component + bindings, guest wasm, esbuild workers, React SPA.
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS build
ENV DEBIAN_FRONTEND=noninteractive
# Node.js 24 (matches CI) + build deps.
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates git wabt \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# WASM targets + the component toolchain (kernel -> wasm32-unknown-unknown; guests -> wasip1).
RUN rustup target add wasm32-unknown-unknown wasm32-wasip1
RUN cargo install cargo-component wasm-tools --locked
# Zig 0.14.1 (FR-14 polyglot guest), pinned + checksum-verified (matches CI).
RUN curl -fsSL "https://ziglang.org/download/0.14.1/zig-x86_64-linux-0.14.1.tar.xz" -o /tmp/zig.tar.xz \
    && echo "24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c  /tmp/zig.tar.xz" | sha256sum -c - \
    && tar -xf /tmp/zig.tar.xz -C /opt && rm /tmp/zig.tar.xz
ENV PATH="/opt/zig-x86_64-linux-0.14.1:${PATH}"
WORKDIR /app
# The toolchain layers above are cached across source changes. Copy the full repo
# (npm workspaces need every workspace's package.json, so we can't cheaply pre-copy
# just the manifests), install node deps, then build everything from source.
COPY . .
RUN npm ci
# Build everything from source. (No BuildKit cache mounts: Railway's managed builder
# rejects `RUN --mount=type=cache`, failing BUILD_IMAGE before any step runs. The
# toolchain layers above still cache across source-only changes.)
RUN npm run build \
    && npm run build:guests \
    && npm run bundle \
    && npm run build:web

# ---------------------------------------------------------------------------
# runtime — slim image that serves the built OS with COOP/COEP on $PORT.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The production server uses only Node builtins — no runtime dependencies.
COPY tools/prod-server.mjs tools/prod-server.mjs
COPY package.json ./
# Built artifacts the host fetches at runtime + the React SPA.
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/abi/generated ./packages/abi/generated
COPY --from=build /app/packages/host/guests ./packages/host/guests
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Source configs/docs/wit the runtime serves verbatim.
COPY wit ./wit
COPY assets/linux/wasmos-riscv64.cfg assets/linux/image-manifest.json assets/linux/README.md ./assets/linux/
COPY third_party/tinyemu/lib.js third_party/tinyemu/README.md ./third_party/tinyemu/
# The MIT emulator core (emu stage) + the riscv64 guest image (image stage).
COPY --from=emu /src/third_party/tinyemu/riscvemu64-wasm.wasm /src/third_party/tinyemu/riscvemu64-wasm.js ./third_party/tinyemu/
COPY --from=image /out/bbl64.bin /out/kernel-riscv64.bin ./assets/linux/
COPY --from=image /out/riscv64-rootfs ./assets/linux/riscv64-rootfs
# Drop root: the server only reads world-readable static files and binds $PORT
# (>1024, so no privileged-port need). The `node` user ships with the base image.
USER node
# Railway injects PORT; the server binds 0.0.0.0:$PORT.
CMD ["node", "tools/prod-server.mjs"]
