# WASI in WASM_OS

> How a stock `wasm32-wasip1` program becomes a scheduled, isolated process —
> the hand-written shim, the binary syscall ring, the kernel router, and how a
> *blocking* syscall actually blocks in a browser.
>
> Companion docs: [WASM](wasm.md) (the module forms) and [WIT](wit.md) (the typed
> kernel ABI). The syscall surface beyond WASI is the `wasmos_kernel` extension —
> see [wit.md](wit.md).

A guest in WASM_OS is a normal Rust/Zig program that imports standard
`wasi_snapshot_preview1` — nothing project-specific. It calls `fd_write`,
`path_open`, `fd_read`, `proc_exit` exactly as it would under `wasmtime`. WASM_OS
makes those calls real by supplying its **own implementation of WASI**, split across
three layers:

```text
guest .wasm (wasm32-wasip1)        process worker (TS)            kworker (TS) → kernel component (Rust)
  fd_write(fd, iovs, …)  ──import──▶ wasi-shim.ts                  control.service-syscall(pid, bytes)
                                     reads iovs out of guest mem    syscall.rs: decode → VFS/pipe/proc
                                     → binary msg over SAB ring ───▶ → reply bytes (or PARK)
                                     ◀── scatters result into mem ◀──  errno + fields
```

The dividing line is strict: **the shim is the only place guest linear memory is
touched; the kernel only ever sees resolved values, never a guest pointer.**

---

## 1. The shim: `wasi_snapshot_preview1`, hand-written

[`packages/host/src/worker/wasi-shim.ts`](../../packages/host/src/worker/wasi-shim.ts)
builds the import object the process worker hands to `WebAssembly.instantiate`. Each
WASI function:

1. reads its pointer/length arguments out of the guest's `WebAssembly.Memory` (e.g.
   `readIovs(ptr, len)` walks the `(buf, len)` iovec array),
2. marshals the **resolved** values (bytes, fd numbers, paths) through the SAB
   syscall ring to the kernel,
3. scatters the result back into guest memory and returns the WASI `errno`.

This is "the ONLY place guest linear memory is touched" — its module docstring says
so, and it is what keeps the kernel host-testable and isolation clean.

The implemented WASI Preview 1 surface (the real handler set in `wasi-shim.ts`):

```text
fd_write  fd_read  fd_seek  fd_close  fd_readdir  fd_fdstat_get  fd_fdstat_set_flags
fd_filestat_get  fd_prestat_get  fd_prestat_dir_name
path_open  path_create_directory  path_remove_directory  path_unlink_file
path_rename  path_filestat_get
args_get  args_sizes_get  environ_get  environ_sizes_get
clock_time_get  random_get  poll_oneoff  sched_yield  proc_exit
```

Two of these are handled **entirely host-side**, without the kernel, because they are
about worker-local timing, not kernel state:

- `poll_oneoff` blocks the worker for a relative duration via `Atomics.wait` on a
  private cell that is never notified (a real timed sleep).
- `clock_time_get` reads `performance.now()` / `performance.timeOrigin`.

`random_get` is seeded with real host CSPRNG entropy that the host hands the kernel
once at boot (`control.seed-entropy` — the kernel is otherwise deterministic and has
no RNG of its own).

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
| [`packages/host/src/worker/process-worker.ts`](../../packages/host/src/worker/process-worker.ts) | per-process worker; instantiates the guest with the shim |
| [`packages/host/src/ring/`](../../packages/host/src/ring) | the SAB syscall ring (client/protocol/layout) |
| [`crates/kernel/src/syscall.rs`](../../crates/kernel/src/syscall.rs) | the kernel WASI router + binary wire format + park/resume |
| [`crates/kernel/src/vfs.rs`](../../crates/kernel/src/vfs.rs) | tri-backend VFS the router calls |
| [`crates/wasmos-sys/src/lib.rs`](../../crates/wasmos-sys/src/lib.rs) | guest stubs for the `wasmos_kernel` extension + `chdir_to_pwd` |
| [`wit/control.wit`](../../wit/control.wit) | `service-syscall` + `syscall-outcome` (park/wakeups) — see [wit.md](wit.md) |

See also: [`docs/specs/SPEC-1-wasm-os.md`](../specs/SPEC-1-wasm-os.md) §3 for the
syscall path in the overall design.
