# WIT & the ABI in WASM_OS

> How the WebAssembly Interface Type (WIT) language defines the contracts in
> WASM_OS — the typed kernel↔host boundary that `cargo-component` + `jco` build
> against, and the separate logical ABI that the drift gate enforces by hand.
>
> Companion docs: [WASM](wasm.md) (component vs core modules) and [WASI](wasi.md)
> (the syscall surface the extension augments).

WIT is the IDL of the Component Model: it declares packages, `interface`s (records,
variants, enums, funcs), and `world`s (what a component imports/exports). In
WASM_OS, WIT plays **two distinct roles**, in two separate trees:

| | `wasmos:abi` | `wasmos:kernel` |
|---|--------------|-----------------|
| Files | [`wit/`](../../wit) (`world.wit`, `control.wit`, `blockstore.wit`) | [`crates/wasmos-sys/wit/kernel.wit`](../../crates/wasmos-sys/wit/kernel.wit) |
| Describes | the kernel **component's** real contract | the **syscall extension** (beyond WASI) |
| Consumed by | `cargo-component` (build) + `jco transpile` (binder gen) | nobody — it is **documentation** |
| Enforced by | the build itself + `binder check` (drift) | `binder kernel-check` (regex drift gate) |
| Transport | Component Model imports/exports | binary messages over the SAB ring |

This split is deliberate, and the second file says so in its own header: the
extension WIT "lives outside the kernel component's `wit/` tree (which is a single
`wasmos:abi` package) on purpose — it is not consumed by `cargo-component`/`jco`."

---

## 1. `wasmos:abi` — the real component contract

This is the WIT `cargo-component` compiles the kernel against and `jco` transpiles.
Three files form one package:

- [`wit/world.wit`](../../wit/world.wit) — the `kernel` world: imports
  `home-store` / `mnt-store` / `sys-store`, exports `control`.
- [`wit/blockstore.wit`](../../wit/blockstore.wit) — the three storage interfaces
  the **host** implements and the kernel imports. All three are the same flat
  key→bytes shape:

  ```wit
  interface home-store {
    get: func(key: string) -> option<list<u8>>;
    put: func(key: string, value: list<u8>) -> bool;
    list-keys: func(prefix: string) -> list<string>;
    delete: func(key: string) -> bool;
  }
  ```

  The host binds these to OPFS (`/home`, system dirs) and IndexedDB (`/mnt`) via a
  synchronous write-back cache that bridges the kernel's *synchronous* imports to
  async browser storage ([`packages/host/src/blockstore`](../../packages/host/src/blockstore)).

- [`wit/control.wit`](../../wit/control.wit) — the surface the **host** drives. It
  declares the data types (`proc-info`, `feature-report`, `spawn-spec`,
  `syscall-outcome`, the `fs-error` variant, the `backend` enum) and the functions:
  `boot`, `mount`, `fs-write/read/list/delete/mkdirp`, `seed-entropy`, `spawn`,
  `spawn-emulator`, `service-syscall`, `deliver-stdin`, `deliver-input`,
  `deliver-net`, `bind-terminal`, `set-priority`, `exit-code`, `take-capture`,
  `list-procs`, …

The types here are load-bearing, not decorative. The clearest example is how a
**blocking syscall** is modelled in the return type ([WASI park/resume](wasi.md)):

```wit
record syscall-outcome {
  reply:       option<list<u8>>,  // none => PARKED; some => response bytes
  wakeups:     list<u32>,         // parked pids now runnable
  term-output: list<u8>,          // bytes to stream to the terminal
  spawn:       option<spawn-request>,
  reap:        list<u32>,
  net:         option<net-request>,
  term-mode:   option<u8>,
}
```

The `option<list<u8>>` *is* the park signal; the `list<u32> wakeups` *is* the
resume mechanism. The semantics live in the type.

---

## 2. The Binder — WIT → bindings, and drift gates

[`tools/binder/binder.mjs`](../../tools/binder/binder.mjs) has three commands
(wired into `package.json`):

- **`binder gen`** (part of `npm run build`) — runs `jco transpile` on the built
  kernel component in **instantiation mode** (so the host can inject the
  `home-store`/`mnt-store`/`sys-store` imports at runtime) and writes the JS + core
  `.wasm` bindings to `packages/abi/generated`. That directory is a **build
  artifact, gitignored** — the WIT is the source of truth, the bindings are derived.

- **`binder check`** — re-transpiles into a temp dir and diffs against the committed
  bindings; if they differ, the WIT/kernel drifted from the generated bindings and
  the build fails with "run `npm run build && npm run binder gen` and commit."

- **`binder kernel-check`** (`npm run binder:kernel-check`, part of `npm run
  verify`) — the FR-36 drift gate for the *extension* ABI. Because `wasmos:kernel`
  is **not** a Component-Model package, it cannot be jco-transpiled. Instead the
  binder regex-scans [`crates/wasmos-sys/wit/kernel.wit`](../../crates/wasmos-sys/wit/kernel.wit)
  for every `name: func` and asserts [`crates/wasmos-sys/src/lib.rs`](../../crates/wasmos-sys/src/lib.rs)
  exposes a matching guest stub. Add a verb to `kernel.wit` without a stub and the
  build fails. This keeps the documented extension ABI honest even though no tool
  generates code from it.

---

## 3. `wasmos:kernel` — the documented syscall extension

WASI Preview 1 is not enough to run a Unix-like userland: there is no `spawn`, no
`pipe`, no `wait`, no windows, no IPC. WASM_OS adds those as the **`wasmos_kernel`
extension**, transported as binary messages over the same SAB ring (opcodes `0x20+`
in [`syscall.rs`](../../crates/kernel/src/syscall.rs); guest stubs in
[`wasmos-sys`](../../crates/wasmos-sys/src/lib.rs); the matching `wasmos_kernel.syscall`
import provided by the host shim).

[`crates/wasmos-sys/wit/kernel.wit`](../../crates/wasmos-sys/wit/kernel.wit) is the
**documented source of truth** for that extension. It is hand-written WIT used as a
spec (and checked by `kernel-check`), declaring two interfaces:

- `process` — `spawn`, `pipe`, `wait` (pipelines); `proc-list`, `set-priority`
  (`ps`/`top`/renice); `chan-open`/`send`/`recv` (message channels);
  `shm-create`/`map`/`read`/`write`/`grant` (shared memory); `kill`/`sig-wait`
  (signals); `net-request` (brokered fetch); `tty-set-raw` (raw/cooked terminal for
  `nano`).
- `compositor` — `win-surface`, `win-present`, `win-read-input` (canvas apps).

```wit
// the pipeline primitives the shell uses (wasmos:kernel `process`):
spawn: func(path: string, argv: list<string>,
            stdio: tuple<stdio, stdio, stdio>, cwd: string) -> result<u32, u16>;
pipe:  func() -> result<tuple<u32, u32, u32>, u16>;  // (read-fd, write-fd, pipe-id)
wait:  func(pid: u32) -> result<s32, u16>;           // child exit code
```

These WIT records mirror the binary wire layout the router decodes — they document
intent and gate drift, while the actual transport is the ring, not Component-Model
calls.

---

## 4. Why two WIT packages?

- `wasmos:abi` is a **real** Component-Model contract because the kernel↔host
  boundary genuinely is a component boundary — `cargo-component` enforces it at
  compile time and `jco` generates the glue. Changing it without regenerating
  bindings fails `binder check`.
- `wasmos:kernel` is **documentation-grade** WIT: the guest↔kernel syscall channel
  is a hand-rolled binary ring (so any `wasm32-wasi` toolchain can speak it without
  component tooling — see [wasm.md](wasm.md)), but we still want a typed, readable
  spec of that surface and a gate against silent drift. Writing it in WIT keeps the
  whole ABI described in one language; `binder kernel-check` substitutes for the
  codegen that a real component would get.

---

## File map

| Path | Role |
|------|------|
| [`wit/world.wit`](../../wit/world.wit) | the `kernel` world (imports stores, exports control) |
| [`wit/control.wit`](../../wit/control.wit) | the host-driven control surface + all shared types |
| [`wit/blockstore.wit`](../../wit/blockstore.wit) | the three host-implemented storage interfaces |
| [`crates/wasmos-sys/wit/kernel.wit`](../../crates/wasmos-sys/wit/kernel.wit) | documented `wasmos_kernel` extension ABI (process + compositor) |
| [`tools/binder/binder.mjs`](../../tools/binder/binder.mjs) | `gen` (jco transpile) · `check` (binding drift) · `kernel-check` (stub drift) |
| [`packages/abi/generated`](../../packages/abi) | jco output — build artifact, gitignored |
| [`crates/wasmos-sys/src/lib.rs`](../../crates/wasmos-sys/src/lib.rs) | guest stubs `kernel-check` verifies against `kernel.wit` |

See also: [WASM](wasm.md) for how the component is built and transpiled, [WASI](wasi.md)
for the syscall path the `control` surface drives, and
[`docs/specs/SPEC-1-wasm-os.md`](../specs/SPEC-1-wasm-os.md) (FR-36) for the ABI
single-source-of-truth requirement.
