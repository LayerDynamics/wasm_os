# WASM_OS

> A layered operating system that runs entirely inside a browser tab — a WASM
> microkernel that schedules WASI processes, a Unix-style userland and terminal, a
> windowed desktop compositor, and (eventually) an emulator capable of booting a
> real Linux. *A whole OS in wasm/wat/wasi — into a web OS. Yup.*

WASM_OS treats the WebAssembly virtual machine as the "hardware" and builds the
operating system that belongs on top of it. Every `wasm32-wasi` module is a
first-class **process**: it is scheduled by a real kernel, makes **blocking WASI
syscalls** over a `SharedArrayBuffer` ring, talks to other processes through real
**IPC**, draws into **windows** managed by a compositor, and is isolated by a
**capability** model — all with no install and no app server. It is served as
static assets behind COOP/COEP headers; the browser tab is the machine.

This is not a webtop of iframes and it is not a foreign-CPU emulator. The kernel
itself is Rust compiled to a WASM component; the userland binaries are stock
`wasm32-wasi` programs (Rust **and** Zig today); the host is TypeScript wiring the
browser's primitives (Workers, SAB/Atomics, OPFS/IndexedDB, Canvas) into kernel
services. See [`docs/specs/SPEC-1-wasm-os.md`](docs/specs/SPEC-1-wasm-os.md) for
the full design.

---

## The five layers

The four "kinds of web OS" the project set out to build are not competing designs
— they are **five layers of one system**, each a demoable milestone.

| Layer | What it is | Milestone | Status |
|-------|-----------|-----------|--------|
| **L0 — Microkernel** | WASM microkernel: scheduler, tri-backend VFS, capability-mediated syscalls | [M0](docs/M0-STATUS.md) | ✅ Complete |
| **L1 — WASI process ABI** | Any language targeting `wasm32-wasi` runs as a scheduled, isolated process making blocking syscalls over the SAB ring | [M1](docs/M1-STATUS.md) | ✅ Complete |
| **L2 — Userland & terminal** | Rust shell + 13 coreutils + xterm terminal; kernel pipes, redirection, exit codes; polyglot proof (Zig `echo`) | [M2](docs/M2-STATUS.md) | ✅ Complete |
| **L3 — Compositor & desktop** | Host compositor: real windows (move/resize/focus/min/max/z-order), taskbar, process-owned canvas surfaces, brokered input; file manager + Paint + Editor + Mandelbrot apps | [M3](docs/M3-STATUS.md) | ✅ Complete |
| **L4 — Multi-process, IPC, persistence** | ≥32 concurrent processes, message channels + shared memory, signals, live `ps`/`top`, runtime priority, session restore | [M4](docs/M4-STATUS.md) | ✅ Complete |
| **L5 — Emulator** | An x86/RISC-V emulator running *as a single privileged process* (boot a real Linux) | M5 | ⏳ Future |

Each `docs/MX-STATUS.md` records that milestone's exit criteria, the verified
`npm run verify` gate breakdown (rust / host / e2e), and every as-built deviation
with its cause. Those are the authoritative, dated source of truth — this README
links to them rather than duplicating numbers that go stale.

---

## How it works (architecture)

```text
   Browser tab (COOP/COEP → cross-origin isolated, Tier A: SAB + Atomics)
   ┌─────────────────────────────────────────────────────────────────────┐
   │ main thread                                                           │
   │   compositor (windows, taskbar, focus, input)  ── async postMessage ──┼─┐
   └───────────────────────────────────────────────────────────────────────┘ │
                                                                               │
   ┌───────────────────────── kernel worker ("kworker") ───────────────────────┘
   │   jco-transpiled kernel component (Rust → WASM)                       │
   │   owns every process's SAB syscall ring; services them with          │
   │   Atomics.waitAsync (never blocks); VFS over OPFS/IndexedDB           │
   └───────────────────────────────────────────────────────────────────────┘
                    │ one SAB ring per process (Atomics.wait / waitAsync)
   ┌────────────────┴──────────────────────────────────────────────────────┐
   │ process worker(s)   guest .wasm (wasm32-wasi)  ── blocking syscalls ──▶ │
   │   hand-written WASI shim marshals guest memory (iovecs); the kernel     │
   │   syscall router only ever sees resolved values, never a guest pointer  │
   └─────────────────────────────────────────────────────────────────────────┘
```

- **Kernel** ([`crates/kernel`](crates/kernel)) — Rust compiled to a WASM
  **component** for `wasm32-unknown-unknown` (pure component: imports only the two
  host-backed stores, exports `control`). It is the scheduler
  ([`sched.rs`](crates/kernel/src/sched.rs)), the process table + capabilities
  ([`types.rs`](crates/kernel/src/types.rs)), the VFS
  ([`vfs.rs`](crates/kernel/src/vfs.rs)), the WASI syscall router
  ([`syscall.rs`](crates/kernel/src/syscall.rs)), kernel pipes
  ([`pipe.rs`](crates/kernel/src/pipe.rs)), and the M4 IPC primitives —
  message channels ([`chan.rs`](crates/kernel/src/chan.rs)) and shared memory
  ([`shm.rs`](crates/kernel/src/shm.rs)).
- **Host** ([`packages/host`](packages/host)) — TypeScript. Tier detection
  ([`features.ts`](packages/host/src/features.ts)), the SAB syscall ring
  ([`ring/`](packages/host/src/ring)), the kernel/process workers
  ([`worker/`](packages/host/src/worker)), the compositor
  ([`compositor/`](packages/host/src/compositor)), the xterm terminal binding
  ([`term/`](packages/host/src/term)), and the OPFS/IndexedDB blockstores with a
  synchronous write-back cache ([`blockstore/`](packages/host/src/blockstore))
  that bridges the kernel's synchronous imports to async browser storage.
- **The Binder** ([`tools/binder`](tools/binder)) — [`wit/`](wit) is the single
  source of truth for the ABI; `binder gen` runs `jco transpile` into
  `packages/abi/generated` (a build artifact, not committed), and the
  `binder kernel-check` gate enforces that the guest syscall stubs in
  [`crates/wasmos-sys`](crates/wasmos-sys) conform to the WIT (FR-36).
- **Isolation by default** — processes start default-deny; capabilities (`Gpu`,
  `Input`, `Shm`, `Signal`, …) are granted explicitly and delegated on spawn only
  if the parent holds them. A trapping guest is contained to a zombie; the kernel
  and its peers survive.

---

## Quick start

> Requires a **cross-origin-isolated** context (COOP/COEP headers) for
> `SharedArrayBuffer` — the bundled dev server sets these for you. Evergreen
> Chromium or Firefox.

```bash
# 1. Install the toolchain (rust targets, cargo-component, wasm-tools, zig, node deps, playwright)
./tools/bootstrap.sh

# 2. Build the kernel + regenerate ABI bindings, build the guest binaries, bundle the host
npm run build          # kernel component + jco bindings
npm run build:guests   # Rust + Zig wasm32-wasi guests → packages/host/guests/
npm run bundle         # esbuild host → dist/index.js + workers

# 3. Serve with the required COOP/COEP isolation headers, then open the page
node tools/serve.mjs   # http://localhost:8080  (serves packages/host/index.html → /dist)
```

The page boots to a desktop: a taskbar with a launcher and live clock, the
terminal in a window, and the file manager / Paint / Editor / Mandelbrot apps
launchable from the taskbar.

---

## Development

The full gate is one command (build → guests → binder check → lint → typecheck →
rust tests → host tests → e2e):

```bash
npm run verify
```

Individual gates:

| Command | What it runs |
|---------|-------------|
| `npm run build` | Build kernel WASM component + regenerate jco bindings from `wit/` |
| `npm run build:guests` | Build all Rust + Zig `wasm32-wasi` guests into `packages/host/guests/` |
| `npm run binder:kernel-check` | Enforce guest syscall stubs conform to `wit/` (FR-36) |
| `npm run lint` | `cargo clippy` on the workspace + the kernel's `wasm32` target (`-D warnings`) |
| `npm run typecheck` | `tsc --noEmit` on the host |
| `npm run test:rust` | Kernel + `wasmgfx` unit tests |
| `npm run test:host` | Vitest (features, blockstores, ring, polyglot byte-diff) |
| `npm run test:e2e` | Playwright — real Chromium, real OPFS/IndexedDB, real workers |

The `e2e/` suite exercises the system end-to-end in a real browser (boot timing &
isolation, tri-backend persistence, process spawn/isolation/crash-containment,
shell pipelines & redirection, coreutils, the desktop & apps, and the M4 IPC /
concurrency / metrics paths) — no mocked layers.

---

## Repository layout

```text
crates/
  kernel/          # the microkernel (scheduler, VFS, syscall router, pipes, IPC, shm)
  wasmos-sys/      # guest-side syscall stubs for the wasmos_kernel ABI (spawn/pipe/wait/win_*/chan/shm)
  wasmgfx/         # guest graphics SDK: software RGBA framebuffer + 8×8 font
  sh/              # the Rust shell ($PATH, pipelines, redirection, builtins)
  coreutils/       # the 13 FR-18 coreutils (ls, cat, cp, mv, rm, wc, head, tail, …)
  hello, crash, catfile, spinner, chandemo, shmdemo   # demo / fault-injection / IPC-demo guests
  apps/            # graphical process apps: filemanager, paint, editor
guests/zig/        # polyglot guests built by a non-Cargo toolchain (echo.zig, mandelbrot.zig)
packages/
  host/            # TypeScript host: workers, SAB ring, compositor, terminal, blockstores
  abi/             # generated jco bindings (build artifact, gitignored)
wit/               # the ABI single source of truth (control.wit, blockstore.wit, world.wit)
tools/             # binder (wit → bindings), serve.mjs (COOP/COEP dev server), bootstrap.sh
docs/              # SPEC-1, per-milestone status reports (M0–M3), and implementation plans
e2e/               # Playwright end-to-end specs (real browser, real storage, real workers)
```

---

## Toolchain

Pinned versions are in [`rust-toolchain.toml`](rust-toolchain.toml) and recorded
in [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md). In brief: Rust 1.95.0 (targets
`wasm32-wasip1` + `wasm32-unknown-unknown`), `cargo-component`, `jco`, `wasm-tools`,
Zig (for the polyglot guests), Node 24, and Playwright/Chromium. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the full pipeline on
Linux x86_64 on every push.

## License

MIT.
