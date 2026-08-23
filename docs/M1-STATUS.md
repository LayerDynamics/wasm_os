# WASI process runtime Status — First WASI Process

**Status:** ✅ Complete — the current repository gate passed on 2026-08-22 via `npm run verify`.

A real Rust `wasm32-wasip1` binary runs as a scheduled process in its own Web
Worker, makes **blocking WASI Preview 1 syscalls over a SharedArrayBuffer ring**
that are routed to kernel handlers, writes to a captured stdout, and exits 0.
Two concurrent processes prove isolation, a trapping guest proves crash
containment, and a guest reads a host-written file through `path_open`/`fd_read`.

## Exit criteria

| # | Criterion | Verified by | Result |
|---|-----------|-------------|--------|
| 1 | Rust `hello.wasm` spawns in its own worker, `fd_write`→captured stdout **via the SAB ring**, exits 0 | `e2e/process.spec.ts` test 1; `kcore::spawn_then_service_fd_write_then_exit` | ✅ PASS (exit 0, stdout `hello from wasm_os`) |
| 2 | Two concurrent processes isolated — distinct PIDs, non-shared memory, no `Shm` cap (FR-6) | `e2e/process.spec.ts` test 2; `kcore::two_spawns_have_isolated_fd_tables_and_no_shm_cap`; `types::fd_tables_are_per_process_and_do_not_alias` | ✅ PASS (`sharedMemory=false` both; independent output) |
| 3 | Trapping guest contained to a zombie; kernel + peer survive (FR-34) | `e2e/process.spec.ts` test 3 | ✅ PASS (crash→zombie, peer exits 0, kernel still serves syscalls) |
| 4 | `path_open`/`fd_read`/`fd_seek`/`fd_close` reach the VFS | `e2e/process.spec.ts` test 4 (catfile); `syscall::path_open_then_fd_read_returns_vfs_bytes` + 11 router tests | ✅ PASS (guest read `payload-from-host` from `/mnt/in.txt`) |
| 5 | `npm run verify` green incl. kernel/VFS bootstrap tri-backend persistence regression through the async proxy | local `npm run verify` (exit 0); `e2e/boot.spec.ts` | ✅ PASS |

## Verify gate breakdown (latest local run — 2026-08-22)

```text
build        : kernel component (wasm32-unknown-unknown) + jco bindings regenerated
typecheck    : tsc -p packages/host/tsconfig.json --noEmit — clean
cargo test   : workspace passed, including 110 kernel tests and the wasmobj tests
vitest       : 32 passed (8 files)
playwright   : 89 passed in the fast browser suite, including boot/persistence,
               WASI process execution, filesystem paths, desktop, and input
clippy       : clean (-D warnings) on wasm32-unknown-unknown + host targets
```

## Architecture as built

- **Kworker-hosted kernel:** the jco kernel component + the OPFS/IndexedDB
  blockstores + `CachedStore` moved off the main thread into a dedicated
  **kernel worker** (`packages/host/src/worker/kernel-worker.ts`). It owns every
  process's SAB syscall ring, services them with `Atomics.waitAsync` (never
  blocking), and orchestrates spawn end-to-end (allocate PID/fd-table/caps via
  `control.spawn`, then create the nested process worker). The main thread talks
  to the kernel only through an **async postMessage proxy**.
- **SAB syscall ring** (`packages/host/src/ring/`): two monotonic doorbell
  counters (REQ_SEQ/RESP_SEQ) — race-free, no lost wakeups. The process worker
  blocks on `Atomics.wait` (true Tier-A syscall semantics); the kworker
  multiplexes N rings with `Atomics.waitAsync`.
- **Guest path is Binder-free:** `hello`/`crash`/`catfile` are stock Rust
  `wasm32-wasip1` binaries importing only `wasi_snapshot_preview1`. The WASI shim
  (`worker/wasi-shim.ts`) is hand-written; it does all guest-memory marshalling
  (iovec gather/scatter), so the Rust syscall router (`crates/kernel/src/syscall.rs`)
  only ever sees resolved values, never a guest pointer.
- **proc_exit / traps:** `proc_exit` unwinds the guest via a `ProcExit` sentinel
  exception; a WASM trap (`std::process::abort()` → `unreachable`) is caught in
  the process worker and reported as a contained crash (FR-34).

## Notable execution-time decisions (deviations from the plan, with cause)

1. **Generated bindings are tracked Binder output.** `npm run build` regenerates
   the component bindings and `npm run binder:check` compares them with the staged
   result before checking the guest syscall signatures. The core wasm payloads
   remain build artifacts; the textual JS and TypeScript bindings are reviewable.
2. **`@types/node@22`** added (dev, types-only) for the `worker_threads`-based
   ring test; scoped via `/// <reference types="node" />` so browser `src` stays
   node-free. **`ES2024.SharedMemory`** added to the host tsconfig `lib` for
   `Atomics.waitAsync`.
3. **Preopen at fd 3 = `/` (a `Dir` descriptor), `next_fd` starts at 4** (plan
   said `next_fd=3`) — keeps `fd_prestat_get` self-consistent (fd 3 success, fd≥4
   `BADF` to terminate the libc preopen scan) and lets `path_open` resolve paths.
4. **`fd_readdir` now reads the hierarchical VFS** — the directory tree and explicit
   directory markers are implemented by the shell and userland layer.
5. **`clock_time_get` and `random_get` are host-side WASI handlers.** The clock
   reads the worker's real time source and random bytes come from the browser
   CSPRNG; kernel `/dev/random` and `/dev/urandom` receive their seed through
   the explicit boot entropy call.
6. **Ring multiplexing uses `Atomics.waitAsync`** in the kernel worker and
   `Atomics.wait` in each process worker. The runtime is Tier A only: a
   non-isolated page is rejected before boot rather than silently taking a
   partial `postMessage` path.
7. **Worker bundling:** esbuild emits `dist/index.js` + `dist/worker/{kernel,process}-worker.js`
   (structure-preserving); workers are constructed from those built URLs. Guests
   are served from `/packages/host/guests/`.

## Current boundaries

- Shell, xterm, pipelines, coreutils, the compositor, process control, IPC,
  signals, and the checked `wasmos:kernel` transport are live later layers;
  their current paths are recorded in the shell/userland, desktop, process-control,
  and Linux integration status files.
- The kworker still uses the `CachedStore` bridge because the generated component
  store imports are synchronous while OPFS/IndexedDB are asynchronous.
- Tier B (Asyncify/JSPI or a `postMessage` syscall transport) and WASI Preview 2
  components remain design targets, not active execution paths.
