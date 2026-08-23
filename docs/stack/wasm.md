# WebAssembly in WASM_OS

> How WASM_OS uses WebAssembly itself — the two distinct WASM "dialects" it
> compiles to, why they differ, and where the boundaries fall.
>
> Companion docs: [WASI](wasi.md) (the syscall surface guests use) and
> [WIT](wit.md) (the typed ABI that defines the kernel boundary).

WASM_OS treats the WebAssembly virtual machine as the "hardware." There is no
native code in the run path: the kernel, the userland, and the apps are all WASM,
and the browser tab is the machine they run on. But "WASM" appears in **two
different forms** here, built by two different toolchains, instantiated two
different ways — and the distinction is the heart of the architecture.

| | **The kernel** | **The guests** (userland + apps) |
|---|----------------|----------------------------------|
| WASM form | a **Component** (Component Model) | stock **core modules** |
| Target | `wasm32-unknown-unknown` | `wasm32-wasip1` |
| Toolchain | `cargo-component` → `jco transpile` | `cargo build` (Rust) / `zig build-exe` (Zig) |
| ABI | typed [WIT](wit.md) (`wasmos:abi`) | standard WASI P1 + the `wasmos_kernel` import |
| Instantiated by | jco-generated JS in the **kworker** | `WebAssembly.instantiate` in a **process worker** |
| Memory | component-internal | its own non-shared `WebAssembly.Memory` |

---

## 1. The kernel is a WASM Component

The kernel ([`crates/kernel`](../../crates/kernel)) is Rust compiled to a
**WebAssembly Component** for `wasm32-unknown-unknown` via `cargo-component`. It is
a *pure* component: it imports only the host-backed storage interfaces and exports
the control surface. That contract is declared in WIT
([`wit/world.wit`](../../wit/world.wit)):

```wit
world kernel {
  import home-store;   // /home  — host backs with OPFS
  import mnt-store;    // /mnt   — host backs with IndexedDB
  import sys-store;    // /etc, /var, … — host backs with OPFS
  export control;      // boot, mount, fs-*, spawn, service-syscall, …
}
```

The kernel has **no ambient authority**: it cannot touch the network, the DOM, or
even storage directly — it can only call the three `*-store` imports the host
supplies, and the host can only drive it through the exported `control` interface.
The build wires this up:

```bash
npm run build:kernel   # cargo component build --release -p kernel \
                       #   --target wasm32-unknown-unknown
npm run build          # build:kernel, then `binder gen` (jco transpile)
```

Because a browser cannot yet load a Component directly, the [Binder](wit.md)
transpiles it: `jco transpile` (in *instantiation* mode, so the host can inject the
store imports at runtime) lowers the component into a plain ES module + a core
`.wasm`, written to `packages/abi/generated`. The textual JS/TypeScript bindings are
committed; the split-out core wasm is a build artifact. The kworker imports that
module and calls `control.*`. See [wit.md](wit.md) for the full Binder flow and the
`control` interface.

> The kernel crate is built `crate-type = ["cdylib", "rlib"]`
> ([`crates/kernel/Cargo.toml`](../../crates/kernel/Cargo.toml)): the `cdylib` is
> what `cargo-component` turns into the component; the `rlib` lets `cargo test`
> build a **native** host harness for `vfs`/`types`/`syscall` — the kernel logic is
> unit-tested as ordinary Rust, off-WASM.

---

## 2. The guests are stock core `wasm32-wasip1` modules

Everything in userland — the shell ([`crates/sh`](../../crates/sh)), the coreutils,
the canvas apps ([`crates/apps`](../../crates/apps)), the demos — is a **plain core
WebAssembly module** targeting `wasm32-wasip1`. These are *not* components. They are
ordinary Rust (and Zig) programs that import standard
[`wasi_snapshot_preview1`](wasi.md), built with the stock toolchain:

```bash
npm run build:guests   # cargo build -p sh -p coreutils -p filemanager … \
                       #   --target wasm32-wasip1 --release
                       # + zig build-exe for the polyglot guests (echo.zig, mandelbrot.zig)
                       # + wat2wasm for the hand-authored WAT utility (watinfo)
                       # → copied into packages/host/guests/
```

The Zig `echo`/`mandelbrot` guests
([`guests/zig`](../../guests/zig)) and the hand-authored
WAT module ([`guests/wat/watinfo.wat`](../../guests/wat/watinfo.wat))
are the same kind of core module as the Rust guests. `echo.zig` is a stock-WASI
coreutil; `mandelbrot.zig` uses the hand-authored `wasmos_kernel` surface to
render, pan, zoom, and generate fresh seeded views. `watinfo` opens
`/proc/uptime` through WASI and is installed as
`/usr/bin/watinfo` during boot. There is **no Component Model and no
generated binding on this guest path**: each module is compiled to a core
`.wasm` file and instantiated by the same process runtime.

### Instantiation, isolation, and crash containment

Each guest runs in its **own process worker**
([`packages/host/src/worker/process-worker.ts`](../../packages/host/src/worker/process-worker.ts)),
which:

1. receives the guest `.wasm` bytes + a `SharedArrayBuffer` syscall ring,
2. instantiates the module with a hand-written WASI shim
   ([`wasi-shim.ts`](../../packages/host/src/worker/wasi-shim.ts)) as its imports,
3. runs `_start`.

The structural isolation guarantee lives here: **the guest's linear memory is its
own non-shared `WebAssembly.Memory`. The only `SharedArrayBuffer` the worker touches
is its own syscall ring** — there is no path to a peer's memory. The kernel never
receives a guest pointer either (the shim resolves all pointers before anything
crosses the ring — see [wasi.md](wasi.md)).

A guest that traps (a Rust `panic!`, `unreachable`, an OOB access) is caught in the
worker and reported as a contained crash: the process becomes a zombie, and the
kernel and every peer process survive (FR-34). `proc_exit` unwinds the same way via
a `ProcExit` sentinel.

---

## 3. A document can also be a module — `wasmobj`

WASM_OS takes "everything is a module" one step further with
[`crates/wasmobj`](../../crates/wasmobj) (see
[SPEC-2](../specs/SPEC-2-wasmobj.md)): a *document* is stored **as a hand-emitted,
valid `wasm32-wasip1` module** whose data segment holds the content and whose
`_start` prints that content to stdout. It is the same core-module shape as any
guest — so a saved document is itself a runnable process. This is the most literal
expression of the project's thesis, and a good worked example of emitting valid
WASM by hand (no compiler): see
[`crates/wasmobj/src/mint.rs`](../../crates/wasmobj/src/mint.rs).

---

## 4. Why two WASM forms?

- **The kernel is a Component** because the kernel↔host boundary is the one place we
  want a *typed, tool-checked contract*. WIT + `jco` give us that: the host imports
  are typed, the `control` surface is typed, and drift is caught by the build
  ([wit.md](wit.md)). The kernel is also the trust boundary, so a pure,
  ambient-authority-free component is exactly right.
- **The guests are core modules** because we want *any* `wasm32-wasi` toolchain to
  produce a runnable process with zero project-specific tooling. A guest author
  writes a normal Rust/Zig program against standard WASI; WASM_OS schedules it. No
  WIT, no bindgen, no component packaging.

The seam between them is the **SAB syscall ring**: guests speak WASI (and the
`wasmos_kernel` extension) as binary messages over the ring; the kworker drains
those and calls the typed component `control.service-syscall`. WASM on both sides,
two dialects, one ring between them.

---

## File map

| Path | Role |
|------|------|
| [`crates/kernel`](../../crates/kernel) | the kernel — built as a WASM **component** |
| [`crates/kernel/Cargo.toml`](../../crates/kernel/Cargo.toml) | `cdylib` (component) + `rlib` (host tests); `[package.metadata.component]` |
| [`wit/`](../../wit) | the component's WIT contract (`wasmos:abi`) — see [wit.md](wit.md) |
| [`crates/sh`](../../crates/sh), [`crates/coreutils`](../../crates/coreutils), [`crates/apps`](../../crates/apps) | guests — stock `wasm32-wasip1` **core modules** |
| [`guests/zig`](../../guests/zig) | polyglot guests (Zig) — same module shape |
| [`guests/wat/watinfo.wat`](../../guests/wat/watinfo.wat) | hand-authored WAT utility; compiled to `watinfo.wasm` |
| [`crates/wasmobj`](../../crates/wasmobj) | documents emitted *as* `.wasm` modules ([SPEC-2](../specs/SPEC-2-wasmobj.md)) |
| [`packages/host/src/worker/process-worker.ts`](../../packages/host/src/worker/process-worker.ts) | instantiates a guest module per process (isolation unit) |
| [`tools/binder`](../../tools/binder) | `cargo component` + `jco transpile` driver ([wit.md](wit.md)) |

See also: [`docs/specs/SPEC-1-wasm-os.md`](../specs/SPEC-1-wasm-os.md) for the full
system design, and [`docs/TOOLCHAIN.md`](../TOOLCHAIN.md) for pinned versions.
