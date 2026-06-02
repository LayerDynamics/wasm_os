# Deploying WASM_OS (Railway)

WASM_OS ships as a **cross-origin-isolated static app** (the React web client in
`apps/web` plus the host runtime's build artifacts). It is containerized with a
multi-stage `Dockerfile` that builds **everything from source** — so the deploy has
**no git-LFS dependency** and is reproducible.

## What the container does

`Dockerfile` has four stages (the first three run in parallel):

| Stage | Base | Produces |
|-------|------|----------|
| `emu` | `emscripten/emsdk:5.0.7` | the MIT TinyEMU riscv64 WASM core (`build-from-source.sh`) |
| `image` | `debian:bookworm-slim` | the riscv64 Linux guest image (`assets/linux/build-image.sh` — download + `splitimg`) |
| `build` | `rust:1-bookworm` + Node 24 + Zig | kernel component + jco bindings, guest `.wasm`, esbuild workers, the React SPA |
| `runtime` | `node:24-bookworm-slim` | the production server + all built artifacts (~360 MB) |

The runtime runs `tools/prod-server.mjs`, which serves the SPA + the repo-root build
artifacts (`/dist/`, `/packages/`, `/third_party/`, `/assets/`, `/wit/`) with the
**COOP `same-origin` + COEP `require-corp`** headers that `SharedArrayBuffer` (the SAB
syscall ring) requires, on Railway's injected `$PORT`. `/healthz` is the liveness probe.

## Deploy to Railway

`railway.toml` already selects the Dockerfile builder, the start command, the
healthcheck, and the restart policy — no dashboard config needed.

```sh
# One-time: install + authenticate the CLI
npm i -g @railway/cli      # or: brew install railway
railway login

# From the repo root: create/link a project, then deploy
railway init --name wasm-os          # or: railway link --project <existing>
railway up --ci -m "deploy WASM_OS"  # builds the Dockerfile, streams logs

# Expose it publicly
railway domain
```

Railway auto-detects the root `Dockerfile`; `$PORT` is injected automatically.

## Build it locally (same as Railway)

```sh
docker build -t wasmos .
docker run --rm -p 8080:8080 -e PORT=8080 wasmos
# open http://localhost:8080  (cross-origin isolated; the OS + riscv64 emulator boot)
```

## Notes

- **Cross-origin isolation is mandatory.** Without COOP/COEP the kernel's
  `SharedArrayBuffer` ring fails and the OS won't boot. The server sets them on every
  response (module workers need COEP+CORP on the worker script too).
- **No LFS at build time.** The emulator core + guest image are rebuilt from pinned
  upstream sources in the `emu`/`image` stages, so a missing LFS object can't break the
  deploy. The committed (LFS) copies are excluded via `.dockerignore`.
- **Vite asset dir.** The SPA bundle is emitted under `/spa-assets/` (not `/assets/`,
  which is the riscv64 guest-image prefix) — see `apps/web/vite.config.ts`.
