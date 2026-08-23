# WASM_OS — WASI process runtime (First WASI Process) — Implementation Plan

> **Status:** Implemented. This is the historical implementation record for the WASI process runtime.
> **Historical scope guard:** At the time this plan covered only the first WASI process path and stopped before shell, desktop, IPC, signals, and Linux integration. Those later tasks are implemented now; the status reports describe the live paths. The current guest set also includes Zig and WAT programs.

**Goal:** Run one real Rust `wasm32-wasip1` binary as a scheduled process. The guest executes in its own Web Worker, makes **blocking WASI Preview 1 syscalls over a SharedArrayBuffer ring** that are routed to kernel handlers, writes to a captured stdout, and exits 0. A second concurrent process proves isolation, and a deliberately-trapping guest proves crash containment (FR-34, pulled forward) — the SPEC-1 **WASI process runtime** task.

**Traces:** FR-4 (route WASI p1 syscalls to kernel handlers), FR-5 (`spawn`/`wait`), FR-9 (run unmodified Rust `wasm32-wasi` modules), FR-6 (process memory isolation), FR-34 (crash containment, brought forward), Tier-A SAB transport (§3.1, §3.4).

> **As-built note (2026-05-31):** WASI process runtime is implemented and verified — see `docs/M1-STATUS.md`. The Binder's textual JS/TypeScript output under `packages/abi/generated` is tracked and checked by `npm run binder:check`; the split-out core wasm payloads remain build artifacts. The old `npm run drift` instructions below are replaced by `npm run binder:check`.

---

## Architecture (decided 2026-05-31 — see `docs/specs` §3.1 and the plan questions)

The kernel/VFS bootstrap kernel runs synchronously on the main thread. WASI process runtime **moves the kernel into a dedicated kernel worker (kworker)** and introduces worker-per-process guests talking to it over a SAB syscall ring.

```text
 main thread (host)                       async control proxy (postMessage)
   boot() · detectFeatures() · index.ts  ───────────────┐
                                                         ▼
 ┌──────────────────────── kernel worker (kworker) ───────────────────────┐
 │  jco kernel component  (KernelCore: proc table + fd tables + sched +    │
 │  capabilities + VFS)  ·  OPFS/IDB blockstores + CachedStore live HERE   │
 │  servicing loop: Atomics.waitAsync over each process's ring →           │
 │     control.service_syscall(pid, req_bytes) → resp_bytes → notify       │
 │  spawns nested process workers; tracks exit codes; answers wait(pid)    │
 └───▲───────────────────────────▲────────────────────────────────────────┘
     │ SAB ring (per process)     │ SAB ring (per process)
 ┌───┴──────────────┐        ┌────┴─────────────┐
 │ process worker 1 │        │ process worker 2 │   ...
 │  guest hello.wasm│        │  guest hello.wasm│
 │  wasi_snapshot_  │        │  (separate WASM  │
 │  preview1 shim → │        │   Memory, NOT    │
 │  ring (Atomics.  │        │   shared)        │
 │  wait BLOCKS)    │        │                  │
 └──────────────────┘        └──────────────────┘
```

**Load-bearing separations (do not violate):**

1. **The guest uses stock WASI.** `hello.wasm` is a plain Rust `wasm32-wasip1` binary importing `wasi_snapshot_preview1` from std. It needs **zero** generated `wasmos:kernel` stubs. The Binder / `wasmos:abi` generated bindings are used only for the **kworker ↔ kernel-component** boundary (which already exists), never on the stock-WASI guest path. The shell and graphics guests use the separately checked hand-written `wasmos:kernel` transport where they need OS extensions.
2. **Memory marshalling happens in the JS shim, not in Rust.** The process worker's WASI shim reads/writes the *guest's* linear memory (gather iovecs for `fd_write`, scatter bytes for `fd_read`). The ring carries already-resolved values. The Rust kernel router only ever sees `(fd, bytes, len, …)` — **never** a guest pointer. This is what makes the kernel host-testable and keeps isolation clean.
3. **The kworker never blocks.** Process workers WANT to block (`Atomics.wait` on the response slot — that is Tier-A synchronous syscall semantics). The kworker must stay responsive to N rings + the control proxy, so it multiplexes with **`Atomics.waitAsync`** (Chrome + Firefox evergreen). A `postMessage`-wakeup fallback is documented but NOT implemented in WASI process runtime (single code path).
4. **Host-orchestrated spawn, owned by the kworker.** The Rust kernel cannot create Workers. The kworker (which both hosts kernel state AND can spawn nested workers) orchestrates spawn end-to-end: `control.spawn(...)` allocates the PID + fd table + capset in the kernel and returns it; the kworker then creates the process worker and hands it the guest bytes + a fresh ring SAB.

**Tech stack (additions to kernel/VFS bootstrap):** Rust guest crates (`wasm32-wasip1`, plain `cargo build`); Web Workers (module workers); `SharedArrayBuffer` + `Atomics` (incl. `Atomics.waitAsync`); Node `worker_threads` + `SharedArrayBuffer` for ring unit tests under Vitest. No new third-party deps.

**kernel/VFS bootstrap reuse:** `KernelCore`, `ProcTable`, `CapabilitySet`, `Scheduler`, `Vfs`, `OpfsBlockstore`, `IdbBlockstore`, `CachedStore` are reused as-is or extended. The VFS stays **flat-key** (kernel/VFS bootstrap quirk); `fd_readdir` is synthesized from `Vfs::list` and explicitly marked provisional pending shell and userland hierarchical dirs.

---

## WASI process runtime exit criteria (definition of done for this whole plan)

1. A Rust `hello.wasm` (`wasm32-wasip1`, unmodified, built by plain `cargo build`) is `spawn`ed, runs in its own worker, writes `hello from wasm_os …` to **captured stdout via `fd_write` routed through the SAB ring to the kernel**, and **exits with code 0** (observed via `wait(pid)`).
2. **Isolation (FR-6):** two `hello` processes run concurrently, each in its own worker with its own non-shared `WebAssembly.Memory`; each produces independent correct output; the kernel shows two distinct PIDs with separate fd tables; **no `Shm` capability is granted to either** (no inter-process memory path exists).
3. **Crash containment (FR-34, brought forward):** a deliberately-trapping `crash.wasm` is spawned concurrently with a `hello` process; the trap is contained — `crash` becomes a `zombie` with a non-zero/trap exit, while the kernel **and** the peer `hello` process keep running and complete normally; the kworker survives.
4. **FS syscalls reach the VFS:** a guest opens a path written by the host (`path_open`), `fd_read`s its bytes back correctly, `fd_seek`s, and `fd_close`s — proving the syscall router speaks FS, not just stdout.
5. `npm run verify` (binder drift gate + `cargo test` + Vitest + Playwright) is green, including the **regression guard** that kernel/VFS bootstrap's tri-backend persistence-across-reload still passes through the new async control proxy.

---

## Task 1: Extend the WIT contract — spawn / wait / service-syscall (contract-first)

**Files:** Modify `wit/control.wit`; regenerate `packages/abi/generated/*`.

**Step 1 — add to `interface control` in `wit/control.wit`** (keep existing verbs):

```wit
  // --- Process lifecycle (WASI process runtime, FR-5) ---
  record spawn-spec {
    name: string,
    /// Capability grants for the child, encoded as a flat list the host builds.
    /// WASI process runtime grants: fs-root-rw + the cwd subtree. (No shm/net/signal at WASI process runtime.)
    grant-fs-subtree: string,    // e.g. "/home" ; "" => none
    grant-spawn: bool,
  }

  /// Allocate a process: PID + per-process fd table (0/1/2 preopened) + capset.
  /// Does NOT execute anything — the host (kworker) creates the worker and runs
  /// the guest, then drives syscalls in via service-syscall.
  spawn: func(spec: spawn-spec) -> u32;

  /// Route one WASI Preview 1 syscall for `pid`. `request` is the binary wire
  /// format (see crates/kernel/src/syscall.rs). Returns the binary response.
  /// All guest-memory marshalling has ALREADY been done host-side; this sees
  /// only resolved values. proc_exit is encoded here and transitions the proc.
  service-syscall: func(pid: u32, request: list<u8>) -> list<u8>;

  /// Has the process exited? Returns the exit code if it is a zombie.
  exit-code: func(pid: u32) -> option<s32>;
```

> Keep `service-syscall` as opaque `list<u8>` on purpose: it avoids pulling the `wasmos:kernel` guest-stub world into WASI process runtime and lets the wire format evolve in Rust without WIT churn.

**Step 2 — regenerate + verify drift gate.**

```bash
npm run build && npm run binder:check
```

→ Expected: `binder gen` refreshes `packages/abi/generated`; `npm run binder:check` exits 0 (tracked == rebuilt). Confirm the generated `kernel.d.ts` now lists `spawn`, `serviceSyscall`, `exitCode`.

**Step 3 — commit.**

```bash
git add wit/control.wit packages/abi/generated && git commit -m "feat(wit): control spawn/wait/service-syscall for WASI process runtime (contract-first)"
```

---

## Task 2: Kernel — per-process fd table + Descriptor model (TDD)

**Files:** Modify `crates/kernel/src/types.rs` (+ inline tests).

**Step 1 — add the descriptor + fd-table model.** A `Descriptor` is what an fd points at; fds 0/1/2 are stdin/stdout/stderr; ≥3 are VFS files. stdout/stderr writes accumulate in a per-process capture buffer (read by the host to surface output).

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DescKind {
    Stdin,
    Stdout,                 // captured
    Stderr,                 // captured
    File { path: String },  // backed by the VFS
}

#[derive(Clone, Debug)]
pub struct Descriptor {
    pub kind: DescKind,
    pub offset: u64,        // read/write cursor for File
    pub rights: Rights,
}
```

Extend `Process` with `fds: BTreeMap<u32, Descriptor>`, `next_fd: u32` (starts at 3), `stdout: Vec<u8>`, `stderr: Vec<u8>`, and `exit_code: Option<i32>`. Initialize fds 0/1/2 in `ProcTable::spawn`. Add methods: `open_fd(pid, Descriptor) -> u32`, `fd(pid, fd) -> Option<&Descriptor>`, `fd_mut`, `close_fd(pid, fd) -> bool`, `push_stdout(pid, &[u8])`, `take_capture(pid) -> (Vec<u8>, Vec<u8>)`, `set_exit(pid, code)`, `exit_code(pid)`.

**Step 2 — failing tests FIRST** (watch them fail, then implement to green):

- `spawn_preopens_std_fds` — a fresh process has fds 0,1,2 with kinds Stdin/Stdout/Stderr.
- `open_fd_allocates_increasing_fds_from_3`.
- `fd_tables_are_per_process_and_do_not_alias` — open a File fd in pid A; pid B's table is unaffected; closing A's fd does not touch B (this is the kernel-side half of the isolation proof, exit-criterion 2).
- `stdout_capture_accumulates_and_drains`.
- `set_and_read_exit_code`.

**Step 3 — run, commit.**

```bash
cargo test -p kernel 2>&1 | tail -20
git add crates/kernel/src/types.rs && git commit -m "feat(kernel): per-process fd table + Descriptor + stdout capture (TDD)"
```

---

## Task 3: Kernel — WASI Preview 1 syscall router (TDD, the core of WASI process runtime)

**Files:** Create `crates/kernel/src/syscall.rs`; declare `pub mod syscall;` in `lib.rs`.

**Step 1 — define the wire format.** Hand-rolled, little-endian, length-prefixed. One opcode byte then opcode-specific fields. Keep an explicit `#[repr(u8)] enum Op` and `errno` constants (subset of WASI p1: `SUCCESS=0`, `BADF=8`, `INVAL=28`, `NOENT=44`, `NOTDIR=54`, `EXIST=20` …). Request/response are `Vec<u8>`. Because the JS shim resolves guest memory, the wire payloads are concrete:

| Op | Request fields | Response fields |
|----|----------------|-----------------|
| `FD_WRITE` | `fd:u32, data:bytes` | `errno:u16, nwritten:u32` |
| `FD_READ` | `fd:u32, len:u32` | `errno:u16, data:bytes` |
| `FD_SEEK` | `fd:u32, offset:i64, whence:u8` | `errno:u16, new_offset:u64` |
| `FD_CLOSE` | `fd:u32` | `errno:u16` |
| `PATH_OPEN` | `dirfd:u32, path:string, oflags:u16, fs_rights:u64` | `errno:u16, fd:u32` |
| `FD_READDIR` | `fd:u32, cookie:u64, buf_len:u32` | `errno:u16, entries:bytes` (WASI dirent layout) |
| `FD_PRESTAT_GET` | `fd:u32` | `errno:u16` (WASI process runtime: `SUCCESS` for fd 3 = the `/` preopen; `BADF` for fd ≥ 4 to end the libc preopen scan — see note) |
| `FD_PRESTAT_DIR_NAME` | `fd:u32, len:u32` | `errno:u16, name:bytes` |
| `FD_FDSTAT_GET` | `fd:u32` | `errno:u16, filetype:u8, flags:u16, rights:u64` |
| `ENVIRON_SIZES_GET` / `ARGS_SIZES_GET` | — | `errno:u16, count:u32, buf_size:u32` |
| `ENVIRON_GET` / `ARGS_GET` | — | `errno:u16, blob:bytes` (NUL-joined) |
| `RANDOM_GET` | `len:u32` | `errno:u16, bytes:bytes` |
| `CLOCK_TIME_GET` | `clock_id:u32, precision:u64` | `errno:u16, time_ns:u64` |
| `PROC_EXIT` | `code:u32` | `errno:u16` (0; side effect: proc → zombie, exit set) |

> **Preopen note:** WASI libc scans `fd_prestat_get(3), (4)…` until `BADF` to discover preopened dirs. WASI process runtime preopens **one** directory at fd 3 mapped to `/` (so `path_open` resolves absolute-ish paths) and returns `BADF` for fd ≥ 4. `fd_prestat_dir_name(3)` returns `"/"`. This is the minimum that lets `path_open` work; document it.

**Step 2 — implement `pub fn service(core: &mut KernelCore, pid: u32, req: &[u8]) -> Vec<u8>`** (or a `SyscallRouter` method on `KernelCore`). It decodes, dispatches, enforces the process's capability set on FS ops (a `path_open` outside the granted subtree → `NOENT`/`EACCES`, audited), reads/writes the VFS for File fds, appends to capture buffers for stdout/stderr, and records exit on `PROC_EXIT`.

**Step 3 — failing tests FIRST** (host target, in-memory `MemStore` VFS, synthetic pids):

- `fd_write_to_stdout_is_captured` and `…stderr`.
- `proc_exit_records_code_and_zombifies`.
- `path_open_then_fd_read_returns_vfs_bytes` (write a file via `core.write`, open+read it through the router).
- `fd_seek_moves_cursor_and_partial_reads_work`.
- `fd_close_then_use_is_badf`.
- `path_open_outside_capability_subtree_is_denied` (default-deny FS — ties FR-31 to the syscall surface).
- `args_environ_sizes_then_get_roundtrip` (empty argv/env at WASI process runtime → count 0, success).
- `fd_prestat_scan_terminates` (fd 3 ok, fd 4 BADF).
- `random_get_fills_len_bytes`; `clock_time_get_is_monotonic_nonzero` (kernel uses a host-provided/now stub — at WASI process runtime return a fixed deterministic value to keep tests reproducible; note as provisional).
- `fd_readdir_synthesizes_entries_from_flat_list` (provisional, flat-key).

**Step 4 — run, commit.**

```bash
cargo test -p kernel 2>&1 | tail -30
git add crates/kernel/src/syscall.rs crates/kernel/src/lib.rs && git commit -m "feat(kernel): WASI p1 syscall router (fd_write/read/seek/close/path_open/proc_exit/…) (TDD)"
```

---

## Task 4: Kernel — wire spawn/service/exit into KernelCore + component adapter (TDD)

**Files:** Modify `crates/kernel/src/kcore.rs`, `crates/kernel/src/lib.rs`; regenerate bindings.

**Step 1 — `KernelCore` surface (host-testable):**

```rust
pub fn spawn(&mut self, name: &str, grant_fs: Option<(&str, Rights)>, grant_spawn: bool) -> u32;
pub fn service_syscall(&mut self, pid: u32, req: &[u8]) -> Vec<u8>;   // delegates to syscall::service
pub fn exit_code(&self, pid: u32) -> Option<i32>;
```

`spawn` builds the `CapabilitySet` from the grants (default-deny otherwise — **never** grant `Shm`), registers the process `New → Ready`, enqueues it on the scheduler, and returns the pid. (The init process from kernel/VFS bootstrap boot stays.)

**Step 2 — failing `kcore` tests FIRST:**

- `spawn_then_service_fd_write_then_exit` — full lifecycle on the core: spawn, route an `FD_WRITE`, route a `PROC_EXIT(0)`, assert capture == written bytes and `exit_code == Some(0)`.
- `two_spawns_have_isolated_fd_tables_and_no_shm_cap` — exit-criterion-2 at the kernel layer: assert neither pid `check_cap(Shm)`.
- `spawn_grants_only_requested_caps` (default-deny preserved).

**Step 3 — component adapter in `lib.rs`** (inside the `#[cfg(target_arch="wasm32")] mod component`): implement the three new `Guest` methods (`spawn`, `service_syscall`, `exit_code`) mapping the WIT `spawn-spec` → `KernelCore::spawn` args, passing `request`/returning `response` bytes verbatim, mapping `Option<i32>` → `option<s32>`.

**Step 4 — build, regen, drift, run wasm + host tests:**

```bash
npm run build && npm run binder:check
cargo test -p kernel 2>&1 | tail -20
git add crates/kernel/src packages/abi/generated && git commit -m "feat(kernel): spawn/service_syscall/exit_code wired through KernelCore + component (TDD)"
```

---

## Task 5: SAB syscall ring — shared layout + guest/host endpoints (TDD in Node)

**Files:** Create `packages/host/src/ring/layout.ts`, `packages/host/src/ring/guest.ts`, `packages/host/src/ring/host.ts`, `packages/host/test/ring.test.ts`.

**Step 1 — `layout.ts`: the SAB memory map + control words.** Use **two monotonic doorbell counters** (NOT a single shared 3-state word — that is race-prone with two waiters and a reset step). Each side waits on the *other's* counter expecting its last-seen value, so a too-fast peer makes `wait` return `not-equal` immediately (no lost wakeup), and there is no reset-vs-arm ambiguity.

```text
header = Int32Array, 4 lanes:
  [0] REQ_SEQ    request doorbell  (server waits on this; client bumps)
  [1] RESP_SEQ   response doorbell (client waits on this; server bumps)
  [2] OPLEN      request byte length
  [3] RESPLEN    response byte length
then REQUEST region (e.g. 64 KiB) ; then RESPONSE region (64 KiB)
```

Helpers: `createRing(reqCap, respCap): SharedArrayBuffer`, typed views (`Int32Array` header, `Uint8Array` regions), constants. Both counters start at 0.

**Step 2 — `guest.ts` `RingClient.call(requestBytes): Uint8Array`** (process worker; SYNCHRONOUS, blocks):

```text
write request bytes; OPLEN = n
respSeen = Atomics.load(RESP_SEQ)
Atomics.add(REQ_SEQ, 1); Atomics.notify(REQ_SEQ)
Atomics.wait(RESP_SEQ, respSeen)      // returns immediately if already bumped → no lost wakeup
read RESPLEN bytes from RESPONSE region; return
```

**Step 3 — `host.ts` `RingServer.arm(sab, onRequest)`** (kworker; NON-blocking, multiplexed via `waitAsync`):

```text
loop:
  reqSeen = Atomics.load(REQ_SEQ)
  await Atomics.waitAsync(header, REQ_SEQ_INDEX, reqSeen).value   // resolves when client bumps
  read OPLEN bytes; resp = onRequest(reqBytes)                    // calls control.serviceSyscall(pid, …)
  write resp + RESPLEN
  Atomics.add(RESP_SEQ, 1); Atomics.notify(RESP_SEQ)
```

No reset step, no shared-word ambiguity, race-free. Provide a `postMessage`-wakeup fallback **as a comment only** (for targets lacking `waitAsync`; not wired in WASI process runtime).

**Step 4 — failing test FIRST `ring.test.ts`** using Node `worker_threads` (real SAB, real Atomics): a small worker thread runs a `RingClient.call` loop; the main test thread runs a `RingServer` that echoes/transforms; assert a request round-trips correct bytes and that the client genuinely blocked until served. (This is a true cross-thread ring test, not a mock.)

**Step 5 — run, commit.**

```bash
npm run test:host 2>&1 | tail -20
git add packages/host/src/ring packages/host/test/ring.test.ts && git commit -m "feat(host): SAB syscall ring (blocking guest client + waitAsync host server) (TDD)"
```

---

## Task 6: Process worker + hand-written WASI Preview 1 shim

**Files:** Create `packages/host/src/worker/process-worker.ts`, `packages/host/src/worker/wasi-shim.ts`.

**Step 1 — `wasi-shim.ts`: build the `wasi_snapshot_preview1` import object** given the guest `WebAssembly.Memory` accessor and a `RingClient`. Each function does guest-memory marshalling then delegates to the ring:

- `fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr)`: gather iovecs **from guest memory**, concat → `ring.call(encode(FD_WRITE, fd, data))` → decode `nwritten` → write to `nwritten_ptr` → return errno.
- `fd_read(fd, iovs_ptr, iovs_len, nread_ptr)`: `ring.call(FD_READ, fd, totalLen)` → **scatter** returned bytes into guest iovecs → write nread → errno.
- `fd_seek`, `fd_close`, `path_open` (read path string from guest mem; write returned fd), `fd_readdir`, `fd_prestat_get`, `fd_prestat_dir_name`, `fd_fdstat_get`, `args_sizes_get`/`args_get`, `environ_sizes_get`/`environ_get`, `random_get`, `clock_time_get`.
- `proc_exit(code)`: `ring.call(PROC_EXIT, code)` then **throw a sentinel `ProcExit` exception** to unwind the guest (do not return).

**Step 2 — `process-worker.ts`** (module worker entry): on the init message `{wasmBytes, pid, ringSab, memory?}`: create the ring client; `WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: shim })`; **use the guest's own exported `memory`** (non-shared — assert `!(memory.buffer instanceof SharedArrayBuffer)` to guarantee isolation); call the exported `_start()`. Catch the `ProcExit` sentinel → normal exit; catch a WASM `RuntimeError`/trap → crash exit. In all cases `postMessage({pid, exit: {kind:'exit'|'trap', code}})` and `close()` the worker.

> The guest memory is the guest module's own definition — **never** a `SharedArrayBuffer`. The ONLY SAB a process worker touches is its own syscall ring. There is no path to a peer's memory (no `Shm` cap, no shared guest memory). That is the structural isolation guarantee.

**Step 3 — no standalone unit test here** (this is exercised by the E2E in Task 11 — it requires a real browser worker + real guest). Commit.

```bash
git add packages/host/src/worker/process-worker.ts packages/host/src/worker/wasi-shim.ts && git commit -m "feat(host): process worker + hand-written WASI p1 shim (ring-marshalled)"
```

---

## Task 7: Kernel worker (kworker) — host the kernel, service rings, orchestrate spawn

**Files:** Create `packages/host/src/worker/kernel-worker.ts`; move blockstore wiring here.

**Step 1 — kworker boot:** on `{features}` from the main thread: create OPFS/IDB blockstores + `CachedStore` **inside the kworker** (OPFS/IDB both work in workers); `import` the generated `kernel.js`; `instantiate(getCoreModule, {home-store, mnt-store})`; `control.boot(features)`; `postMessage({type:'ready', bootMillis, features})`.

**Step 2 — control proxy handler:** answer main-thread requests (`fsWrite/fsRead/fsList/fsDelete/listProcs/mount/spawn/wait/flush`) by calling the kernel component and posting results back with a correlation id. (Async proxy — the main thread `await`s these.)

**Step 3 — spawn orchestration (`spawn` request):** call `control.spawn(spec)` → pid; allocate a ring SAB; create a **nested** process worker (`new Worker(new URL('./process-worker.ts', import.meta.url), {type:'module'})`); `arm` a `RingServer` on the ring whose `onRequest` calls `control.serviceSyscall(pid, reqBytes)`; post `{wasmBytes, pid, ringSab}` to the process worker; on the process worker's `{exit}` message, record it (the router already set the kernel exit on `PROC_EXIT`; the trap case calls a small `control.serviceSyscall(pid, PROC_EXIT(trapCode))` or a dedicated zombify path), resolve any pending `wait(pid)`, and tear down the worker.

**Step 4 — `wait(pid)`:** resolve when the process worker reports exit (or immediately if `control.exitCode(pid)` is already `Some`). Return `{exitCode}`.

**Step 5 — commit.**

```bash
git add packages/host/src/worker/kernel-worker.ts && git commit -m "feat(host): kernel worker — hosts kernel, multiplexes syscall rings, orchestrates spawn"
```

---

## Task 8: Refactor boot.ts → async control proxy over the kworker

**Files:** Modify `packages/host/src/boot.ts`, `packages/host/src/index.ts`; adjust `packages/host/test/features.test.ts` only if needed.

**Step 1 — `boot()` now:** `detectFeatures()` on the main thread → create the kworker (`new Worker(new URL('./worker/kernel-worker.ts', import.meta.url), {type:'module'})`) → post `{features}` → await `ready` → return a `BootResult` whose `control` is an **async proxy** (each method posts to the kworker and awaits the correlated reply) plus `spawn(path|bytes)`, `wait(pid)`, and `flush()`. The blockstores are no longer created on the main thread (they moved into the kworker).

**Step 2 — update `KernelControl` type** to async signatures (`fsRead(path): Promise<Uint8Array>`, etc.) and add `spawn`, `wait`. Update `index.ts` to `await` and to dispatch `wasmos:ready` with the same `{bootMillis, features}` detail shape the E2E expects.

**Step 3 — run host tests** (features test must still pass; ring test unaffected). Commit.

```bash
npm run test:host 2>&1 | tail -20
git add packages/host/src/boot.ts packages/host/src/index.ts packages/host/test && git commit -m "refactor(host): boot returns async control proxy over the kworker"
```

---

## Task 9: Guest crates — hello (Rust) + crash (Rust)

**Files:** Create `crates/hello/Cargo.toml`, `crates/hello/src/main.rs`, `crates/crash/Cargo.toml`, `crates/crash/src/main.rs`; add both to the workspace `members`; add a `build:guests` npm script.

**Step 1 — `crates/hello/src/main.rs`:**

```rust
fn main() {
    println!("hello from wasm_os");
}
```

**Step 2 — `crates/crash/src/main.rs`** (deliberate trap):

```rust
fn main() {
    // Force a WASM trap (unreachable) — used to prove crash containment (FR-34).
    panic!("intentional crash for containment test");
}
```

> These are plain `wasm32-wasip1` **binaries**, built with `cargo build -p hello --target wasm32-wasip1 --release` (NOT `cargo component` — they are core modules importing stock `wasi_snapshot_preview1`). Add `build:guests` to copy `target/wasm32-wasip1/release/{hello,crash}.wasm` to a served path (e.g. `packages/host/guests/`), and add that dir to `.gitignore` (built artifacts) or commit them if the E2E needs them without a build step — prefer building in the Playwright `webServer` command.

**Step 3 — wire into the workspace + verify they build and import only WASI:**

```bash
cargo build -p hello -p crash --target wasm32-wasip1 --release
wasm-tools print target/wasm32-wasip1/release/hello.wasm | grep -E '\(import "wasi_snapshot_preview1"' | head
```

→ Expected: imports are all `wasi_snapshot_preview1` (no `wasmos_*`) — proves the guest path is Binder-free.

**Step 4 — commit.**

```bash
git add crates/hello crates/crash Cargo.toml package.json .gitignore && git commit -m "feat(guests): Rust hello + crash wasm32-wasip1 binaries"
```

---

## Task 10: Update kernel/VFS bootstrap E2E to the async control proxy (regression guard)

**Files:** Modify `e2e/boot.spec.ts`, `e2e/opfs.spec.ts` as needed.

**Step 1 — convert the synchronous `control.fsWrite(...)` / `fsRead(...)` calls in the persistence test to `await`** the async proxy. Keep the assertions identical: `/home` (OPFS) + `/mnt` (IDB) survive reload, `/scratch` (tmpfs) is volatile, `homeList` contains the persisted path. Keep boot-time + tier-A assertions.

**Step 2 — run and confirm kernel/VFS bootstrap behavior is preserved through the new architecture.**

```bash
npm run test:e2e 2>&1 | tail -30
git add e2e/boot.spec.ts e2e/opfs.spec.ts && git commit -m "test(e2e): port kernel/VFS bootstrap persistence E2E to async control proxy (regression guard)"
```

---

## Task 11: WASI process runtime E2E — spawn, stdout, exit, isolation, crash containment, FS syscall

**Files:** Create `e2e/process.spec.ts`; ensure the Playwright `webServer` builds guests + kernel + bundle.

**Step 1 — extend `playwright.config.ts` `webServer.command`** to also build the guests: `cargo build -p hello -p crash --target wasm32-wasip1 --release && <copy to packages/host/guests> && npm run build && npm run bundle && node tools/serve.mjs`.

> **Bundling the workers — make the entry points explicit.** esbuild does NOT reliably code-split workers from the `new Worker(new URL('./x.ts', import.meta.url))` pattern (that is a Vite behavior). Define **three explicit esbuild entry points**, each emitting its own ESM bundle, and reference the worker files by their built URLs:
>
> ```jsonc
> // root package.json "bundle" script — three entries, one esbuild invocation:
> "bundle": "esbuild packages/host/src/index.ts packages/host/src/worker/kernel-worker.ts packages/host/src/worker/process-worker.ts --bundle --format=esm --outdir=dist --loader:.wasm=file --asset-names=[name] --public-path=/dist"
> ```
>
> Then in source, construct workers from the BUILT paths under `/dist` (e.g. `new Worker('/dist/kernel-worker.js', {type:'module'})`) rather than `new URL('./kernel-worker.ts', import.meta.url)`, so the served artifacts match. Verify all three `dist/*.js` bundles exist before running the E2E.

**Step 2 — `e2e/process.spec.ts`** (real Chromium, real workers, real SAB — NO mocks). Drive everything through `window.__wasmos`:

- **Test A — hello runs and exits 0:** `await __wasmos.spawn('/guests/hello.wasm')` → pid; `const {exitCode} = await __wasmos.wait(pid)`; assert `exitCode === 0`; read captured stdout (via a `control.readStdout(pid)` proxy method or surfaced in the exit message) and assert it contains `hello from wasm_os`.
- **Test B — isolation (FR-6):** spawn two hellos concurrently; both exit 0 with independent correct output; `await control.listProcs()` shows two distinct PIDs; assert (via an audit/cap-introspection proxy or by construction documented in the test) **neither holds `Shm`**; assert each process worker used a non-shared `WebAssembly.Memory` (the worker asserts this internally and reports it; the E2E checks the report).
- **Test C — crash containment (FR-34):** spawn `crash.wasm` concurrently with a `hello`; `await wait(crashPid)` reports a trap/non-zero exit and `listProcs` shows it `zombie`; the `hello` peer still exits 0; a follow-up `await control.fsWrite('/scratch.txt', …)` + `fsRead` succeeds → **the kernel/kworker survived**.
- **Test D — FS syscall reaches VFS:** host `await control.fsWrite('/mnt/in.txt', 'payload')`; spawn a guest variant (or reuse hello compiled to read `/mnt/in.txt` and echo it) — *or* assert at the router level if a read-guest is out of WASI process runtime scope. **Decision:** keep D as a guest that `path_open`+`fd_read`s `/mnt/in.txt` and writes the bytes to stdout; assert captured stdout == `payload`. (Add `crates/catfile` if needed — a 3rd tiny Rust guest that reads `argv[0]`-less fixed path `/mnt/in.txt`.)

**Step 3 — run, commit.**

```bash
npm run test:e2e 2>&1 | tail -40
git add e2e/process.spec.ts playwright.config.ts crates/catfile 2>/dev/null; git commit -m "test(e2e): WASI process runtime — spawn/stdout/exit, isolation, crash containment, FS syscall (real browser)"
```

---

## Task 12: ps view, CI, and M1-STATUS

**Files:** Modify `.github/workflows/ci.yml` (build guests step), create `docs/M1-STATUS.md`.

**Step 1 — CI:** add `rustup target add wasm32-wasip1` (already pinned) and a `cargo build -p hello -p crash --target wasm32-wasip1 --release` step before E2E. Confirm the existing Linux-determinism + drift jobs still pass with the new generated bindings.

**Step 2 — `docs/M1-STATUS.md`:** record each WASI process runtime exit criterion, the test that proves it, and the actual result from a real `npm run verify` run (fill from the log — no placeholders). Note the as-built deviations (e.g. `Atomics.waitAsync` chosen; `fd_readdir` synthesized from the hierarchical VFS; preopen at fd 3 = `/`; clock and random handlers use the host's real time and browser CSPRNG).

**Step 3 — full verify + commit.**

```bash
npm run verify 2>&1 | tee /tmp/m1-verify.log | tail -40
git add .github/workflows/ci.yml docs/M1-STATUS.md && git commit -m "ci: build guests + WASI process runtime status (all exit criteria verified)"
```

---

## Done criteria (verify before declaring complete)

```bash
npm run verify
```

All five WASI process runtime exit criteria (top of plan) must hold:

1. ✅ Rust `hello.wasm` spawns in its own worker, `fd_write`→captured stdout via the SAB ring, **exits 0** (`e2e/process.spec.ts` Test A).
2. ✅ Two concurrent processes isolated — distinct PIDs, separate fd tables, non-shared memory, **no `Shm` cap** (Test B + `kcore`/`types` unit tests).
3. ✅ Trapping guest contained to a zombie; kernel + peer survive (Test C + FR-34).
4. ✅ `path_open`/`fd_read`/`fd_seek`/`fd_close` reach the VFS (Test D + `syscall` unit tests).
5. ✅ Binder drift gate green; kernel/VFS bootstrap tri-backend persistence still passes through the async proxy.

**STOP here.** This historical task ended before shell and userland. Those paths
are implemented in the shell/userland task and documented in `docs/M2-STATUS.md`.

---

## TODO / deferred (discovered-adjacent — do NOT do in this plan)

- **shell and userland:** shell + xterm.js binding, `$PATH` resolution, pipelines/redirection (kernel pipes), coreutils from Rust **and C/Zig** (FR-14 polyglot proof), the `wasmos:kernel` guest syscall world + `wit-bindgen` Rust/C guest stubs.
- **Hierarchical VFS dirs** + real `fd_readdir` (WASI process runtime synthesizes entries from the flat-key store; the kernel/VFS bootstrap flat-key TODO persists).
- **OPFS sync access handles** for `/home` to retire the `CachedStore` bridge in the kworker (WASI process runtime reuses `CachedStore`; sync handles are a worker-only optimization).
- **`Atomics.waitAsync` fallback:** the documented `postMessage`-wakeup path for any target browser lacking `waitAsync` (not implemented in WASI process runtime).
- **Real clock/entropy brokers:** the current WASI shim uses the worker clock and
  browser CSPRNG; the kernel's seeded `/dev/random` and `/dev/urandom` paths are
  separate device behavior.
- **Tier B (Asyncify/JSPI):** WASI process runtime is Tier-A only; the cooperative no-SAB path is a separate effort (R-1).
- **Control `kill`/signals** (FR-7) and live `ps`/`top` UI (FR-33) — process control and IPC.
