# WASI in WASM_OS

> How a stock `wasm32-wasip1` program becomes a scheduled, isolated process —
> the hand-written shim, the binary syscall ring, the kernel router, and how a
> *blocking* syscall actually blocks in a browser.
>
> Companion docs: [WASM](wasm.md) (the module forms) and [WIT](wit.md) (the typed
> kernel ABI). The syscall surface beyond WASI is the `wasmos_kernel` extension —
> see [wit.md](wit.md).

A guest in WASM_OS is a normal Rust/Zig program that imports standard
`wasi_snapshot_preview1`. It calls `fd_write`, `path_open`, `fd_read`, and
`proc_exit` exactly as it would under another Preview 1 runtime. WASM_OS runs those
imports through `WasiRuntime`, the per-process runtime in
[`packages/host/src/worker/wasi-runtime.ts`](../../packages/host/src/worker/wasi-runtime.ts):
it compiles the guest, supplies the import namespaces, validates the memory and
`_start` contract, and enters the guest. The import calls then cross the shim and
kernel layers:

```text
guest .wasm (wasm32-wasip1)        process worker (TS)            kworker (TS) → kernel component (Rust)
  fd_write(fd, iovs, …)  ──import──▶ WasiRuntime → wasi-shim.ts     control.service-syscall(pid, bytes)
                                     reads iovs out of guest mem    syscall.rs: decode → VFS/pipe/proc
                                     → binary msg over SAB ring ───▶ → reply bytes (or PARK)
                                     ◀── scatters result into mem ◀──  errno + fields
```

The dividing line is strict: **the shim is the only place guest linear memory is
touched; the kernel only ever sees resolved values, never a guest pointer.**

The same path accepts hand-authored WAT. The shipped
[`guests/wat/watinfo.wat`](../../guests/wat/watinfo.wat) utility opens
the live `/proc/uptime` file, reads it, and writes the result to stdout.
`wat2wasm` produces `packages/host/guests/watinfo.wasm` during
`npm run build:guests`; boot installs that artifact as
`/usr/bin/watinfo` and `/bin/watinfo`. WAT does not get special
runtime treatment and it does not use Binder-generated guest bindings: its imports
are the same WASI Preview 1 functions the Rust and Zig guests use.

---

## 1. The runtime and shim: `wasi_snapshot_preview1`

[`packages/host/src/worker/wasi-runtime.ts`](../../packages/host/src/worker/wasi-runtime.ts)
is the runtime entry point. It owns one guest instance, its lifecycle, and the
process memory contract. The worker reports the guest memory size after
instantiation and rejects a guest that does not export private linear memory named
`memory` or a `_start` function. The public host package exports the same runtime
from [`packages/host/src/wasi.ts`](../../packages/host/src/wasi.ts), so other host
launchers do not need to reconstruct the import wiring.

The runtime delegates import calls to the hand-written shim:

[`packages/host/src/worker/wasi-shim.ts`](../../packages/host/src/worker/wasi-shim.ts)
builds the `wasi_snapshot_preview1` import object that `WasiRuntime` hands to
`WebAssembly.instantiate`. Each
WASI function:

1. reads its pointer/length arguments out of the guest's `WebAssembly.Memory` (e.g.
   `readIovs(ptr, len)` walks the `(buf, len)` iovec array),
2. marshals the **resolved** values (bytes, fd numbers, paths) through the SAB
   syscall ring to the kernel,
3. scatters the result back into guest memory and returns the WASI `errno`.

This is "the ONLY place guest linear memory is touched" — its module docstring says
so, and it is what keeps the kernel host-testable and isolation clean.

The runtime has named handlers for the Preview 1 surface used by the shipped guests:

```text
args_get  args_sizes_get  environ_get  environ_sizes_get
clock_res_get  clock_time_get  random_get  poll_oneoff  sched_yield  proc_exit
fd_advise  fd_allocate  fd_close  fd_datasync  fd_fdstat_get
fd_fdstat_set_flags  fd_fdstat_set_rights  fd_filestat_get
fd_filestat_set_size  fd_filestat_set_times  fd_pread  fd_pwrite
fd_read  fd_readdir  fd_renumber  fd_seek  fd_sync  fd_tell  fd_write
fd_prestat_get  fd_prestat_dir_name
path_open  path_create_directory  path_filestat_get  path_filestat_set_times
path_link  path_readlink  path_remove_directory  path_rename path_symlink
path_unlink_file  proc_raise
sock_accept  sock_recv  sock_send  sock_shutdown
```

The file and process calls are split between the shim and the kernel router. The
shim owns guest-memory marshalling; the kernel owns descriptor state, pipes,
capabilities, VFS contents, timestamps, links, and park/resume behavior.
`fd_advise` and `fd_datasync` are valid operations with browser-appropriate
semantics: the former validates the descriptor and the latter reaches the
synchronous store boundary. `fd_allocate` grows a bounded sparse file when the
requested range is outside its current size.

The timing, entropy, and yield calls are handled entirely host-side because they
are about worker-local facilities rather than kernel state:

- `poll_oneoff` blocks the worker for a relative duration via `Atomics.wait` on a
  private cell that is never notified (a real timed sleep).
- `clock_time_get` reads `performance.now()` / `performance.timeOrigin`.
- `random_get` uses the worker's CSPRNG, and `sched_yield` completes immediately
  because the guest worker has no second guest coroutine to yield to.

`random_get` uses the browser's CSPRNG directly. `/dev/random` and `/dev/urandom`
are separate kernel device paths and receive their seed through
`control.seed-entropy`.

The four socket imports are explicit. WASM_OS does not expose WASI Preview 1 socket
descriptors; each returns `NOSYS` so a guest can detect the boundary and use the
WASM_OS network broker when it has the corresponding `Net` capability.

---

## 2. The kernel router: binary wire format

The kworker drains one request off a process's ring and calls the typed component
export `control.service-syscall(pid, request)`. Inside the kernel,
[`crates/kernel/src/syscall.rs`](../../crates/kernel/src/syscall.rs) decodes it.

The wire format (from the router's own header doc):

> Little-endian, length-prefixed. **Request** = `op:u8` then opcode-specific fields.
> **Response** = `errno:u16` then opcode-specific fields (always written in full,
> zero-filled on error, so the shim can decode uniformly). A `bytes` field is
> `len:u32` followed by the raw bytes; a `string` is a UTF-8 `bytes`.

The WASI opcodes (`Op` enum, request byte 0):

| Op | byte | Op | byte |
|----|------|----|------|
| `FdWrite` | `0x01` | `PathCreateDirectory` | `0x11` |
| `FdRead` | `0x02` | `PathUnlinkFile` | `0x12` |
| `FdSeek` | `0x03` | `PathRemoveDirectory` | `0x13` |
| `FdClose` | `0x04` | `PathRename` | `0x14` |
| `PathOpen` | `0x05` | `PathFilestatGet` | `0x15` |
| `FdReaddir` | `0x06` | `FdFilestatGet` | `0x16` |
| `FdPrestatGet` | `0x07` | `FdFdstatSetFlags` | `0x17` |
| `FdPrestatDirName` | `0x08` | `FdReady` | `0x18` |
| `FdFdstatGet` | `0x09` | `ProcExit` | `0x10` |
| `EnvironSizesGet` | `0x0A` | | |
| `EnvironGet` | `0x0B` | | |
| `ArgsSizesGet` | `0x0C` | | |
| `ArgsGet` | `0x0D` | | |
| `FdPread` | `0x19` | `FdPwrite` | `0x1A` |
| `FdFilestatSetSize` | `0x1B` | `FdFilestatSetTimes` | `0x1C` |
| `FdSync` | `0x1D` | `PathLink` | `0x1E` |
| `PathReadlink` | `0x1F` | `PathSymlink` | `0x27` |
| `FdTell` | `0x28` | `PathFilestatSetTimes` | `0x29` |
| `FdFdstatSetRights` | `0x2A` | `FdRenumber` | `0x2B` |
| `ProcRaise` | `0x2C` | | |

Opcodes `0x20+` are the **`wasmos_kernel` extension** (spawn/pipe/wait, surfaces,
channels, shm, signals, net, tty) — beyond WASI; see [wit.md](wit.md). The router
hits the VFS ([`vfs.rs`](../../crates/kernel/src/vfs.rs)), the pipe table
([`pipe.rs`](../../crates/kernel/src/pipe.rs)), and the process table
([`types.rs`](../../crates/kernel/src/types.rs)), all capability-checked.

---

## 3. How a *blocking* syscall blocks (park / resume)

This is the part that makes "real blocking WASI syscalls in a browser" work.

A guest calls `fd_read` and expects to block until bytes arrive. In the worker, the
ring `call()` blocks the **guest's** worker thread with `Atomics.wait` on the ring.
On the kernel side, a read with no data yet does **not** spin — it **parks**:
`service-syscall` returns `reply = None` (the `parked` outcome). The kworker keeps
the request bytes and does *not* complete the ring, so the guest stays blocked.

Later, an event makes the fd readable — a pipe write, a delivered keystroke
(`control.deliver-stdin`), a child exit. That syscall's outcome carries a `wakeups`
list of pids whose parked syscalls are now runnable; the kworker **re-drives** each
parked request (iterative, de-duplicated) with its stashed bytes, and this time it
completes, unblocking the guest.

Crucially, **the kernel itself never blocks**: the kworker services rings with
`Atomics.waitAsync`, so a parked guest costs nothing and the scheduler keeps running.
The relevant fields on `syscall-outcome` (see [`wit/control.wit`](../../wit/control.wit)
and [wit.md](wit.md)):

- `reply: option<list<u8>>` — `none` = parked, `some` = the response bytes.
- `wakeups: list<u32>` — parked pids to re-drive now.
- `term-output` / `spawn` / `reap` / `net` / `term-mode` — side effects the host
  must perform (stream terminal output, instantiate a spawned child, kill a process,
  broker a fetch, switch terminal line discipline).

---

## 4. The filesystem a guest sees: preopen + `$PWD`

WASI programs reach files relative to a **preopened directory** (`fd 3`). In WASM_OS
the **kernel** preopens that fd as the VFS root: every process's fd table is created
with `PREOPEN_FD = 3` bound to `Dir { path: "/" }`
([`crates/kernel/src/types.rs`](../../crates/kernel/src/types.rs)). When the guest's
libc scans its preopens, `fd_prestat_dir_name` returns that name — the kernel
produces the `/` bytes and the shim merely relays them into guest memory. Because the
preopen is rooted at `/` (not at the process's cwd), a guest can reach the whole VFS —
`/etc`, `/bin`, `/home` — not just its working directory.

The working directory is carried out-of-band in **`$PWD`** (inherited from the
parent at spawn). wasi-libc defaults its own cwd to `/`, so a guest that opens a
*relative* path calls `wasmos_sys::chdir_to_pwd()` first
([`crates/wasmos-sys/src/lib.rs`](../../crates/wasmos-sys/src/lib.rs)) to align
libc's cwd with `$PWD`. This is why a bare `ls` or a relative `cat rel.txt` resolves
against the shell's current directory while absolute paths outside it still work
(verified by the "non-root cwd" E2E in
[`e2e/coreutils.spec.ts`](../../e2e/coreutils.spec.ts)).

The VFS is tri-backend (`tmpfs` / OPFS / IndexedDB), mounted per prefix
(`/home` → OPFS, `/mnt` → IndexedDB, system dirs → OPFS), exposed to the kernel as
the three `*-store` imports in [`wit/blockstore.wit`](../../wit/blockstore.wit).

---

## 5. Tiers: SAB (A) vs cooperative (B)

The blocking model above is **Tier A**, which needs a cross-origin-isolated context
(COOP/COEP headers) so `SharedArrayBuffer` + `Atomics.wait` are available — the dev
server and the deployed app set those headers. The feature report
(`feature-report.tier` in [`wit/control.wit`](../../wit/control.wit), detected by
[`packages/host/src/features.ts`](../../packages/host/src/features.ts)) records `"A"`
when SAB is present. Without isolation there is no `Atomics.wait`, so blocking
syscalls cannot use the ring the same way — that is a distinct, reduced-guarantee
tier (`"B"`), not a free downgrade. The boot screen surfaces the unsupported case
rather than silently misbehaving.

---

## File map

| Path | Role |
|------|------|
| [`packages/host/src/worker/wasi-shim.ts`](../../packages/host/src/worker/wasi-shim.ts) | the hand-written `wasi_snapshot_preview1` (only place guest memory is read) |
| [`packages/host/src/worker/wasi-runtime.ts`](../../packages/host/src/worker/wasi-runtime.ts) | per-process WASI runtime; compiles, instantiates, validates, and starts one guest |
| [`packages/host/src/wasi.ts`](../../packages/host/src/wasi.ts) | public host-package export for launching and inspecting the runtime |
| [`packages/host/src/worker/process-worker.ts`](../../packages/host/src/worker/process-worker.ts) | per-process worker; owns the runtime and reports process lifecycle events |
| [`packages/host/src/ring/`](../../packages/host/src/ring) | the SAB syscall ring (client/protocol/layout) |
| [`crates/kernel/src/syscall.rs`](../../crates/kernel/src/syscall.rs) | the kernel WASI router + binary wire format + park/resume |
| [`crates/kernel/src/vfs.rs`](../../crates/kernel/src/vfs.rs) | tri-backend VFS the router calls |
| [`crates/wasmos-sys/src/lib.rs`](../../crates/wasmos-sys/src/lib.rs) | guest stubs for the `wasmos_kernel` extension + `chdir_to_pwd` |
| [`wit/control.wit`](../../wit/control.wit) | `service-syscall` + `syscall-outcome` (park/wakeups) — see [wit.md](wit.md) |

See also: [`docs/specs/SPEC-1-wasm-os.md`](../specs/SPEC-1-wasm-os.md) §3 for the
syscall path in the overall design.
