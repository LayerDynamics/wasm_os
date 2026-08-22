# process control and IPC Status — Multi-process, IPC & Persistence

**Status:** ✅ Complete — all eight exit criteria met (verified 2026-06-01 via `npm run verify`, exit 0).

WASM_OS is now a **multi-process OS you can observe and control**. It sustains
**≥32 concurrent processes** within the main-thread budget; processes talk to each
other through real **IPC** — named **message channels** (`chan_open`/`send`/`recv`)
and an explicit **shared-memory** region (the only cross-process memory path,
FR-6); they are controllable with **signals** — catchable **SIGTERM** (graceful)
and uncatchable **SIGKILL** (forceful reap), gated by the **Signal** capability;
they are observable **live** through a graphical **System Monitor** and the
`ps`/`top` **coreutils** (state, priority, CPU-activity, memory); their **priority**
is settable at spawn and adjustable at runtime (`renice`, FR-8); and the **desktop
session survives a reload** — open apps + window geometry are re-opened from a
manifest, on top of the already-persistent VFS (FR-35).

## Exit criteria

| # | Criterion | Verified by | Result |
|---|-----------|-------------|--------|
| 1 | **≥32 concurrent processes** sustained within the main-thread budget; the desktop stays responsive (FR-3) | `e2e/concurrency.spec.ts` (32 spinners + a responsive `echo`) | ✅ PASS |
| 2 | **Two processes exchange a message over a channel** end to end (`chan_open`/`send`/`recv`, FR-6) | `e2e/channel.spec.ts` | ✅ PASS |
| 3 | **Two processes share an explicit memory region** (one writes, the other reads); access is default-deny (FR-6) | `e2e/shm.spec.ts` + kernel `shm` units (owner/grant/isolation) | ✅ PASS |
| 4 | **Signals**: SIGTERM exits gracefully, SIGKILL force-reaps, signalling another without the Signal cap is denied (FR-7/FR-34) | `e2e/signals.spec.ts` (builtin TERM, `-9` reap, `/bin/kill` coreutil) | ✅ PASS |
| 5 | **Live `ps`/`top`** — graphical **System Monitor** + CLI show the live table; click/command **kill** works (FR-33) | `e2e/sysmon.spec.ts`, `e2e/ps.spec.ts` | ✅ PASS |
| 6 | **Runtime priority** set live and reflected in the scheduler + `proc_list` (FR-8) | `e2e/renice.spec.ts`, kernel `proc_list`/`set_priority` units | ✅ PASS |
| 7 | **Session survives reload** — open apps re-open at saved geometry; `/home` persists (FR-35) | `e2e/session.spec.ts` | ✅ PASS |
| 8 | `npm run verify` green **including** the kernel/VFS bootstrap–desktop compositor regression suite under the new kernel | local `npm run verify` (exit 0) | ✅ PASS |

## Verify gate breakdown (latest local run — 2026-06-01)

```text
build         : kernel component (wasm32-unknown-unknown) + jco bindings regenerated
build:guests  : 30 Rust wasm32-wasip1 guests (adds chandemo/shmdemo/sigdemo/spinner +
                kill/renice/ps/top coreutils + the sysmon app) + 2 Zig wasm32-wasi guests
binder        : kernel-check — wasmos-sys conforms to kernel.wit, 18 verbs: spawn, pipe,
                wait, proc-list, set-priority, chan-open/send/recv, shm-create/map/read/
                write/grant, kill, sig-wait, win-surface/present/read-input (FR-36)
lint          : clippy clean (-D warnings) on the whole workspace + kernel wasm target
typecheck     : tsc -p packages/host/tsconfig.json --noEmit — clean
cargo test    : 92 passed; 0 failed  (kernel 89 — incl. proc_list metrics + priority cap,
                channel open/send/recv/park/EOF, shm create/grant/isolation/free, signal
                cap-gating + SIGTERM sig_wait wake + SIGKILL reap, chan.rs 4 + shm.rs 4;
                wasmgfx 3)
vitest        : 14 passed (4 files) — features, polyglot-echo, IdbBlockstore, ring
playwright    : 52 passed — kernel/VFS bootstrap–desktop compositor regression + process control and IPC: concurrency(32), channel, shm, signals(3),
                renice, ps/top, sysmon, session restore
```

## Architecture deltas introduced by process control and IPC

- **Process metrics + `proc_list` syscall** (`0x30`): `ProcInfo` gains `priority`,
  `cpu_ticks`, `mem_bytes`, `parent`. The kernel accounts **one scheduler tick per
  serviced syscall** (`service_syscall` → `sched.account`) as a deterministic
  kernel-activity metric; the process worker reports its `WebAssembly.Memory` byte
  length to the kworker after instantiation.
- **Message channels** (`crates/kernel/src/chan.rs`, opcodes `0x32`–`0x34`):
  named rendezvous; opaque `chan_id` handles (not WASI fds). `chan_recv` parks on
  `WaitReason::ChanRecv`; a peer's exit closes its endpoint and gives a parked
  receiver EOF. Buffered messages survive a closed sender until drained.
- **Shared memory** (`crates/kernel/src/shm.rs`, opcodes `0x35`–`0x39`): a
  kernel-arbitrated byte region accessed via `shm_read`/`shm_write` (copy in/out) —
  a wasm guest cannot map an external buffer into its own linear memory. Default-deny:
  the creator owns + is granted access and may `grant` other pids; the owner's exit
  frees its regions.
- **Signals** (opcodes `0x3A` `kill`, `0x3B` `sig_wait`): SIGTERM queues a pending
  signal and wakes a `sig_wait`-parked target (a **zero-CPU** delivery path,
  `WaitReason::SigWait` — no busy-poll); SIGKILL forges the target's own `proc_exit`
  (releasing pipes/surfaces/channels/shm + waking waiters) and asks the host to
  terminate its worker via a new `SyscallOutcome.reap` list.
- **Signal capability + delegation**: the shell is granted `Signal` at boot; `kill`
  and `renice` exist as both **shell builtin / coreutil**, with the shell delegating
  `Signal` to the spawned `/bin/kill` and `/bin/renice` exactly as it delegates
  `Gpu`/`Input` (`want_signal` byte on `k_spawn`, honoured only if the parent holds it).
- **CLI + graphical observability**: `ps`/`top` coreutils over `proc_list`, and a
  **System Monitor** canvas app (`crates/apps/sysmon`) that renders the live table
  and acts on the selected process (`k`/`t`/`r`) via a launcher-delegated `Signal`.
- **Session manifest** (`packages/host/src/compositor/session.ts`): the compositor
  records open app windows + geometry to `/home/.session.json`; on boot the
  `SessionManager` re-spawns them and restores layout (the VFS already persists file
  content). New compositor hooks `onWindowOpened`/`onWindowsChanged`; `Win` gains
  `geometry()`/`setGeometry()`.

## As-built deviations & decisions

- **Shared memory is grant-arbitrated, not `Shm`-capability-gated at the syscall.**
  A guest cannot map an external `SharedArrayBuffer` into linear memory, so shm is a
  kernel-held buffer reached through copy-in/out syscalls; isolation is enforced by
  the explicit per-region **grant set** (creator → `grant(pid)`), default-deny —
  delivering FR-6's "explicit, opt-in shared memory" without a literal mapping.
- **shm lifetime is owner-managed.** A region is freed when its **owner** exits, so a
  consumer must finish before the owner does. The `shmdemo` fixture expresses this the
  natural way: the writer `wait()`s on the reader before exiting.
- **SIGTERM is cooperative via a blocking `sig_wait` primitive** (POSIX `sigwait`-like),
  not by interrupting an arbitrary blocking syscall with EINTR — this gives zero-CPU
  delivery without threading signal checks through every read path. SIGKILL remains
  uncatchable + immediate.
- **`kill`/`renice` ship as BOTH a shell builtin and a `/bin/*` coreutil** (the user
  asked for both). The builtin runs in-process on the shell's `Signal`; the coreutil
  works by full path via delegated `Signal`. The E2E exercises the coreutil explicitly
  so it is not shadowed-and-untested by the builtin.
- **FR-35 is a session/layout restore, not a freeze-dry of live wasm memory** (the
  latter is infeasible in-tab): reload re-spawns the apps and restores window geometry
  on top of the persistent `/home`. Documented in the plan's out-of-scope.
- **`init` (pid 1) is protected** — the System Monitor refuses to signal it.

## CI

`.github/workflows/ci.yml` builds the Rust + Zig guests (`build:guests`) before the
host tests, so the new guest crates (`chandemo`, `shmdemo`, `sigdemo`, `sysmon`,
the `kill`/`renice`/`ps`/`top` coreutils) are covered with no workflow change — they
are workspace members picked up by clippy and `build:guests`, and their wasms are
copied into `packages/host/guests/` for the e2e server. `test:rust` runs the expanded
kernel suite (channels, shm, signals).

## Deferred to Linux guest integration and later work (per spec)

Networking broker (OQ-2 / `net_request`), Tier B (cooperative/Asyncify/JSPI), full
running-process-memory snapshot, WASI p2 components (FR-13), and the Linux guest integration.
