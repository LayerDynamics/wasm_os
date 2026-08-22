# WASI process runtime Status — First WASI Process

**Status:** ✅ Complete — all exit criteria met (verified 2026-05-31 via `npm run verify`, exit 0).

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

## Verify gate breakdown (latest local run)

```text
build        : kernel component (wasm32-unknown-unknown) + jco bindings regenerated
typecheck    : tsc -p packages/host/tsconfig.json --noEmit — clean
cargo test   : 42 passed; 0 failed
               (vfs ×6, types+fd-table ×12, scheduler ×5, kcore ×7, syscall ×12)
vitest       : 7 passed (3 files) — features ×2, IdbBlockstore ×3, SAB ring ×2
playwright   : 9 passed — boot<1.5s+tierA+init-proc, tri-backend persist, fsDelete,
               OpfsBlockstore real-OPFS, IdbBlockstore real-IDB (kernel/VFS bootstrap regression);
               hello spawn/stdout/exit0, two-proc isolation, crash containment,
               catfile path_open+fd_read (WASI process runtime)
clippy       : clean (-D warnings) on wasm32-unknown-unknown + host targets
```

## Architecture as built

- **Kworker-hosted kernel:** the jco kernel component + the OPFS/IndexedDB
  blockstores + `CachedStore` moved off the main thread into a dedicated
  **kernel worker** (`packages/host/src/worker/kernel-worker.ts`). It owns every
  process's SAB syscall ring, services them with `Atomics.waitAsync` (never
  blocking), and orchestrates spawn end-to-end (allocate PID/fd-table/caps via
  `control.spawn`, then create the nested process worker). The main thread talks
  to the kernel only through an **async postMessage proxy** (`boot.ts`).
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
4. **`fd_readdir` synthesized from the flat-key VFS listing** — provisional until
   shell and userland introduces a real hierarchical directory tree.
5. **`clock_time_get` returns a deterministic constant**; **`random_get`** uses a
   deterministic LCG. Real capability-gated clock/entropy brokers (§3.6) are
   deferred; deterministic stubs keep tests reproducible.
6. **Ring multiplexing uses `Atomics.waitAsync`** (Chrome + Firefox evergreen);
   the `postMessage`-wakeup fallback is documented but not implemented (single
   code path).
7. **Worker bundling:** esbuild emits `dist/index.js` + `dist/worker/{kernel,process}-worker.js`
   (structure-preserving); workers are constructed from those built URLs. Guests
   are served from `/packages/host/guests/`.

## Deferred to shell and userland and later work (genuinely out of WASI process runtime scope; tracked)

- Shell + xterm.js, `$PATH`, pipelines/redirection, polyglot C/Zig coreutils
  (FR-14), the `wasmos:kernel` guest syscall world + `wit-bindgen` guest stubs.
- Hierarchical VFS dirs + real `fd_readdir`; OPFS sync access handles to retire
  the `CachedStore` bridge inside the kworker.
- `Atomics.waitAsync` `postMessage`-wakeup fallback; Tier B (Asyncify/JSPI).
- Real clock/entropy device brokers; control `kill`/signals (FR-7); live `ps`/`top` UI (FR-33).
