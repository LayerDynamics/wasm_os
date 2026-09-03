# WASM_OS

[![CI](https://github.com/LayerDynamics/wasm_os/actions/workflows/ci.yml/badge.svg)](https://github.com/LayerDynamics/wasm_os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

WASM_OS is an operating-system experiment that runs inside a browser tab. A
Rust microkernel schedules `wasm32-wasi` programs, routes their blocking syscalls
over a `SharedArrayBuffer` ring, and exposes a Unix-like userland. A TypeScript
host connects the kernel to browser workers, storage, a terminal, and a windowed
desktop.

The desktop includes a shell, core utilities, a file manager, Paint, an editor,
a Lisp REPL, a system monitor, and a Welcome window.
The taskbar can also start a RISC-V Linux guest in TinyEMU. The guest appears as
one privileged process alongside the regular WASI processes.

This is a research and learning project, not a secure general-purpose operating
system. It requires a cross-origin-isolated page, targets modern browsers, and
is not to be used for anything that matters. Browser storage persists files for the origin, but the running machine exists only while the page is open.

## How it works

```text
Browser tab — cross-origin isolated (SharedArrayBuffer + Atomics)

┌─ main thread ───────────────────────────────────────────────────────────────┐
│ compositor: windows, taskbar, focus, brokered input                         │
└─────────────────────────────────────────────────────────────────────────────┘
                 │ ▲
                 ▼ │ postMessage: surfaces, input, process lifecycle
┌─ kernel worker ──────────────────────────────────────────────────────────────┐
│ Rust → WASM component                                                        │
│ process table, capabilities, scheduler, syscall routing, VFS, IPC            │
│ one syscall ring per process; Atomics.waitAsync keeps the worker responsive   │
└─────────────────────────────────────────────────────────────────────────────┘
                 │ ▲
                 ▼ │ SharedArrayBuffer syscall ring
┌─ process workers ────────────────────────────────────────────────────────────┐
│ wasm32-wasi guests                                                           │
│ hand-written WASI shim marshals guest memory and blocks on ring responses    │
└─────────────────────────────────────────────────────────────────────────────┘
                 │
                 └── dedicated emulator worker: TinyEMU RISC-V Linux
```

The kernel is compiled as a `wasm32-unknown-unknown` component. It owns the
process table, capability checks, scheduler, VFS, WASI syscall router, pipes,
message channels, shared-memory regions, signals, and process metrics.

The host runtime in [`packages/host`](packages/host) provides feature detection,
the shared-memory ring, kernel and process workers, the compositor, the xterm
binding, and the OPFS/IndexedDB blockstores. A synchronous write-back cache
bridges the kernel's synchronous store imports to the browser's asynchronous
storage APIs.

The Binder takes the WIT contracts under `wit/` and owns both sides of the ABI.
It runs `jco` for the kernel component, then checks the guest syscall crate against
`wit/kernel/kernel.wit` at the signature level: names, parameter counts, parameter
types, and return types must agree. `npm run binder:check` runs both checks.

Processes start with no optional capabilities. The kernel delegates capabilities
such as `Gpu`, `Input`, `Shm`, `Signal`, and `Net` only when the parent has the
corresponding authority. A trapping guest becomes a zombie; the kernel and its
other processes continue running.

## Quick start

`SharedArrayBuffer` requires a cross-origin-isolated context. The bundled server
sets the required COOP/COEP headers. The supported local path is:

```bash
# Install the Rust targets, cargo-component, wasm tools, Zig, Node packages,
# and Playwright where the bootstrap script supports them.
./tools/bootstrap.sh

# Build the kernel and its generated bindings.
npm run build

# Build the Rust, Zig, and hand-written WAT wasm32-wasi guests.
npm run build:guests

# Bundle the host workers and browser entrypoint.
npm run bundle

# Serve the app with the required isolation headers.
node tools/serve.mjs
```

Open `http://localhost:8080`. The page opens with the Welcome guide as the only
visible window. It explains the desktop, terminal, apps, filesystem, and
keyboard controls; the terminal is already running and stays available from
the taskbar. Linux starts from the launcher and uses the RISC-V configuration
in [`assets/linux/wasmos-riscv64.cfg`](assets/linux/wasmos-riscv64.cfg).

## Verification

Run the complete local gate with:

```bash
npm run verify
```

The command builds the kernel, builds the guest programs, regenerates the ABI,
runs the binder conformance check, lints Rust, type-checks both TypeScript
clients, builds the React client, runs the complete Rust and Vitest suites, and
runs the fast Playwright suite in Chromium. The browser suite starts both the
plain host entrypoint and the packaged React entrypoint, then executes guests
from the VFS paths installed during boot.

Individual checks are available when iterating:

| Command | Coverage |
| --- | --- |
| `npm run build` | Kernel component and generated host bindings |
| `npm run build:guests` | Rust, Zig, and WAT `wasm32-wasi` guest binaries |
| `npm run binder:kernel-check` | Guest syscall stubs against `wit/` |
| `npm run lint` | Rust clippy for the workspace and kernel WASM target |
| `npm run typecheck` | TypeScript host type-check |
| `npm run test:rust` | Every Cargo workspace package, including kernel, graphics SDK, wasm-object, and file-manager tests |
| `npm run test:host` | Vitest for feature detection, blockstores, rings, and polyglot output |
| `npm run typecheck:web` | Type-check the packaged React client in `apps/web` |
| `npm run build:web` | Build the packaged React client and its hashed browser assets |
| `npm run test:e2e` | Fast Playwright tests in real Chromium |
| `npm run test:e2e:slow` | Linux boot and emulator tests |

## Repository layout

```text
crates/
  kernel/          # scheduler, VFS, syscall router, pipes, IPC, signals, metrics
  wasmos-sys/      # guest-side process, IPC, signal, and window ABI
  wasmgfx/         # software RGBA framebuffer and 8×8 font
  wasmobj/         # self-executing wasm-object document container
  sh/              # shell with PATH lookup, pipelines, redirection, and builtins
  coreutils/       # 21 standalone utilities, including ls, cat, grep, ps, top, and kill
  apps/            # file manager, Paint, Editor, System Monitor, Lisp, Welcome, nano
  hello, crash, catfile, spinner, gfxspike, chandemo, shmdemo, sigdemo
                   # process, fault, graphics, IPC, and signal fixtures
packages/host/     # workers, shared-memory ring, compositor, terminal, blockstores
packages/abi/      # tracked JS/TypeScript bindings + ignored core wasm payloads
wit/               # control, blockstore, and world ABI definitions
third_party/       # TinyEMU RISC-V emulator and build recipe
assets/linux/      # RISC-V bootloader, kernel, rootfs, and VM configuration
tools/             # Binder, bootstrap, development server, and production server
docs/              # design specifications, status reports, and implementation plans
e2e/               # Playwright tests against the assembled browser system
```

Pinned tool versions are recorded in [`rust-toolchain.toml`](rust-toolchain.toml)
and [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md). CI runs the build and test pipeline
on Linux x86_64.

## Scope and limitations

- Only a cross-origin-isolated Chromium or Firefox page can boot the current
  runtime; non-isolated contexts are rejected before worker startup.
- The project has no threat model for mutually hostile third-party guests.
- Files persist in the origin's OPFS and IndexedDB, but a running process and the
  emulator are recreated when the page reloads.
- The Linux integration currently supports one TinyEMU instance and a brokered
  `fetch` capability rather than a complete WASI sockets layer.

## License

WASM_OS is MIT licensed. TinyEMU is also MIT licensed; its license and build
recipe are in [`third_party/tinyemu/`](third_party/tinyemu). The Linux guest
payloads have their own upstream licenses, documented in
[`assets/linux/README.md`](assets/linux/README.md).
