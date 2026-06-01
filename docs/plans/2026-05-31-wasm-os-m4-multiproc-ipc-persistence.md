# M4 — Multi-process, IPC, Persistence ("it's really an OS")

**Plan date:** 2026-05-31
**Source of truth:** `docs/specs/SPEC-1-wasm-os.md` (Phase 4 / Milestone M4)
**Predecessors:** M0 (kernel+VFS), M1 (first process), M2 (userland+terminal), **M3 (compositor & desktop — merged, CI-green on `main`)**
**Branch / delivery:** `feat/m4-multiproc-ipc` · per-task commits → PR → CI green → merge (same flow as M1–M3)

---

## What M4 is

The milestone that makes WASM_OS *feel like an operating system*: **many processes
scheduled concurrently, talking to each other through real IPC, observable live,
controllable with signals, and a session that survives a reload.** Concretely —
≥32 concurrent processes within the main-thread budget; **message channels** and
**shared-memory regions** between processes; **SIGTERM/SIGKILL** signals; a live
**`ps`/`top`** view (a graphical System Monitor **and** CLI tools); **runtime
priority**; and **session snapshot/restore** that re-opens your desktop on reload.

**Spec traces:** **FR-3** (schedule ≥32 concurrent, deterministic policy + time
accounting), **FR-7** (signals/kill → zombie + resource release), **FR-8**
(priority settable at spawn + adjustable at runtime), **FR-33** (`ps`/`top` of
live processes, memory, scheduler state), **FR-35** (session snapshot/restore),
plus the IPC half of **FR-6**/§3.2 (message channels + explicit shared-memory as
the only cross-process memory path) and **FR-36** (all new ABI through the Binder).

**Decisions confirmed (planning Q&A): defer nothing.**
1. **IPC = channels + shared memory.** `chan_open/chan_send/chan_recv` (named
   bidirectional message channels) **and** `shm_create/shm_map/shm_read/shm_write`
   (an explicit shared `SharedArrayBuffer` region, gated by the `Shm` capability).
2. **Full signals.** Guest-callable `kill(pid, sig)` (Signal-capability-gated):
   **SIGKILL** forced reap + **SIGTERM** delivered for graceful shutdown.
3. **Both `ps`/`top` forms.** A graphical **System Monitor** canvas app **and**
   `ps`/`top` coreutils for the shell.
4. **FR-35 session snapshot/restore** and **FR-8 runtime priority** are both in.
5. **Tier A only** (SAB), consistent with M1–M3.

---

## Architecture deltas introduced by M4

- **Process metrics + `proc_list` syscall.** `ProcInfo` gains `priority`,
  `cpu_ticks` (scheduler time accounting), `mem_bytes`, and `parent`. The kernel
  accounts a scheduler tick **per serviced syscall** (`service_syscall` →
  `sched.account(pid, 1)`) — a deterministic kernel-activity metric. The process
  worker reports its `WebAssembly.Memory` byte length to the kworker after
  instantiation (and on `memory.grow`), stored per-process. A new guest syscall
  `proc_list()` returns the table so userland (`ps`/`top`, the System Monitor) can
  render it without host privileges.
- **Message channels** (`crates/kernel/src/chan.rs`): a named, **bidirectional**
  message queue pair. `chan_open(name)` rendezvous: the first opener creates the
  channel; the second connects. `chan_send(fd, bytes)` frames a message into the
  peer's inbox; `chan_recv(fd)` dequeues one message, **parking** (reusing M2
  park/resume, `WaitReason::ChanRecv(id)`) when empty. Built on the pipe pattern
  but message-framed + bidirectional + name-brokered.
- **Shared memory** (`crates/kernel/src/shm.rs` + host SAB store): an explicit
  shared region — the **only** cross-process memory path (FR-6). `shm_create(size)`
  → `shm_id` (the kworker allocates a `SharedArrayBuffer`, the kernel records the
  owner + size); `shm_map(shm_id)` maps it into another process **iff** it holds a
  `Shm{shm_id}` capability (granted by the creator via spawn delegation or a grant
  call); `shm_read/shm_write(shm_id, off, guest_ptr, len)` copy between the shared
  SAB and the caller's linear memory (cap-checked). *(Design note: a wasm guest
  cannot map an external SAB into its own linear memory, so access is syscall-
  mediated rather than a literal `(ptr,len)` mapping — this preserves default-deny
  isolation while delivering real shared memory; documented as an as-built point.)*
- **Signals** (`WaitReason`-free, queue-based): `kill(pid, sig)` requires the
  `Signal` capability. **SIGKILL** → the kernel zombifies + the kworker terminates
  the worker (M3 `kill` path) + releases pipes/surfaces/channels/shm. **SIGTERM** →
  enqueues a pending signal; the target polls `sig_pending()` and exits cleanly
  (the shell/apps check it in their loop). The kernel + kworker close all the
  dying process's IPC + surface resources on exit (extends the M2/M3 cleanup).
- **Runtime priority** (FR-8): `set_priority(pid, prio)` (control + guest, the
  latter for self or with a capability) re-buckets the process in the scheduler;
  spawn already carries an initial priority.
- **Session manifest** (`/home/.session.json`): the compositor records open
  process-apps + window geometry; on boot a SessionManager re-spawns them and
  restores layout (the VFS already persists file contents — FR-30).

**Message topology (unchanged hub):** guest ⇄ process-worker (ring) ⇄ kworker ⇄
main/compositor. Channels + signals + `proc_list` flow over the ring; shm SABs and
memory-size reports flow process-worker ⇄ kworker like the M3 framebuffer SABs.

---

## M4 exit criteria (definition of done — from spec §4.1 / §5)

1. **≥32 concurrent processes** sustained within the main-thread budget (NFR: main
   thread < 50% busy at 32) — a spawn-32 harness; all reach `running`; the desktop
   stays responsive.
2. **Two processes exchange messages via a channel** (`chan_open`/`send`/`recv`),
   end to end.
3. **Two processes share memory** via an explicit `shm` region (one writes, the
   other reads the same bytes) — and a process without the `Shm` cap cannot map it.
4. **Signals work**: SIGTERM lets a process exit gracefully; SIGKILL force-reaps;
   a process without the `Signal` cap cannot signal another (default-deny).
5. **Live `ps`/`top`**: the graphical System Monitor **and** the CLI `top` show the
   live process table with state, priority, CPU-activity, and memory, updating in
   real time; click/command **kill** works.
6. **Runtime priority** (FR-8): a process's priority can be set at spawn and changed
   live, reflected in the scheduler + the monitor.
7. **Session survives reload** (FR-35): with apps open, reload re-opens them
   (session manifest) and `/home` content persists.
8. `npm run verify` is **green**, including the **M0–M3 regression suite** under
   the new kernel.

---

## Out of scope for M4 (deferred)

- **Tier B** (cooperative/Asyncify/JSPI) — Tier A only (R-1).
- **Networking broker** (OQ-2 / `net_request`) — no M4 deliverable needs it; M5/later.
- **Full running-process-memory snapshot** — FR-35 is a *session/layout* restore
  (re-spawn apps + restore window geometry + the persisted VFS), not a freeze-dry
  of live wasm linear memory (infeasible in-tab); documented.
- **The L4 emulator** (M5).
- **WASI p2 components** (FR-13) — the `wasmos_kernel` p1 surface remains the path.

---

## Phase A — Scheduling, metrics, and concurrency (the observability + FR-3 base)

### Task 1 — Process metrics + `proc_list` syscall + runtime priority

**Files:** `crates/kernel/src/types.rs` (`ProcInfo` + `mem_bytes`/`parent`; `set_priority`),
`sched.rs` (re-bucket on priority change), `kcore.rs` + `lib.rs` (account per
syscall; `set_priority`; `set_proc_mem`), `syscall.rs` (`Op::ProcList` `0x30`,
`Op::SetPriority` `0x31`; handlers), `wit/control.wit` (extend `proc-info`;
`set-proc-mem`, `set-priority`), `crates/wasmos-sys` (`proc_list`, `set_priority`);
`packages/host/src/worker/process-worker.ts` (report memory) + `kernel-worker.ts`
(`setProcMem` on report) + `boot.ts`.

**Steps:**
1. Extend `ProcInfo`/`proc-info` with `priority`, `cpu_ticks`, `mem_bytes`,
   `parent`; regenerate bindings.
2. In `service_syscall`, account 1 scheduler tick to the pid (deterministic
   activity metric). `set_priority(pid, p)` updates the table + re-enqueues at the
   new level. Spawn carries the initial priority (already present).
3. The process worker posts `{type:"mem", pid, bytes}` after instantiation (and on
   detected `memory.grow`); the kworker calls `control.setProcMem(pid, bytes)`.
4. Guest `proc_list()` syscall returns the serialized table (pid/name/state/
   priority/cpu/mem/parent); `set_priority(pid, p)` for live renice.

**Tests:** kernel units (account increments per syscall; `set_priority` re-buckets;
`list` carries the new fields). `e2e` smoke: spawn a process, `proc_list` via a
tiny harness shows it with nonzero cpu after a syscall + a memory size.

### Task 2 — 32 concurrent processes (FR-3 exit)

**Files:** `crates/spinner` (a stress guest: bounded compute + periodic syscalls,
exits on SIGTERM); `package.json` build:guests; `e2e/concurrency.spec.ts`.

**Steps:** a `spinner` guest loops doing a little work and a periodic syscall so the
scheduler accounts it; exits on SIGTERM (Task 5) or after N iterations. Spawn 32 via
`control.spawn` and assert all reach `running` and the main thread stays responsive
(boot stays interactive; a follow-up shell command still runs).

**Tests:** `e2e/concurrency.spec.ts` — spawn 32 spinners; `proc_list`/`listProcs`
shows ≥ 32 running; the terminal still echoes a command (main-thread budget intact).

---

## Phase B — IPC (the marquee)

### Task 3 — Message channels (`chan_open` / `chan_send` / `chan_recv`)

**Files:** `crates/kernel/src/chan.rs` (new: `ChannelTable`, rendezvous by name,
per-endpoint inbox, framed messages); `syscall.rs` (`Op::ChanOpen 0x32`,
`ChanSend 0x33`, `ChanRecv 0x34`; `WaitReason::ChanRecv(id)`; park/resume + EOF on
peer close); `types.rs` (`DescKind::Chan{id, end}`); `kcore.rs`/`lib.rs`;
`crates/wasmos-sys` (`chan_open`/`chan_send`/`chan_recv`); `wit/kernel.wit` +
`binder kernel-check`.

**Steps:** `chan_open(name)` → fd; first opener creates, second connects (rendezvous
table). `chan_send(fd, bytes)` enqueues a framed message to the peer's inbox + wakes
a parked receiver. `chan_recv(fd)` returns one message or parks (`ChanRecv`); peer
close → EOF. `proc_exit` closes channel ends (sibling of pipe cleanup).

**Tests:** kernel units (open rendezvous; send→recv delivery + wake; recv parks then
delivers; peer-close EOF; cap none needed beyond holding the fd). `e2e/channel.spec.ts`:
spawn two processes that `chan_open("demo")`, one sends, the other receives + echoes
the payload to a verifiable sink (file or terminal).

### Task 4 — Shared memory (`shm_create` / `shm_map` / `shm_read` / `shm_write`)

**Files:** `crates/kernel/src/shm.rs` (new: `ShmTable` — id → {owner, size, mappers});
`types.rs` (`Capability::Shm{id}` already reserved — make it id-scoped); `syscall.rs`
(`Op::ShmCreate 0x35`, `ShmMap 0x36`, `ShmRead 0x37`, `ShmWrite 0x38`; cap checks);
`k_spawn` shm-cap delegation; host: `kernel-worker.ts` allocates the shared SAB +
routes it to mapping process workers; `process-worker.ts`/`wasi-shim.ts`
(`shm_read`/`shm_write` copy guest-mem ⇄ shared SAB, like the M3 framebuffer);
`crates/wasmos-sys`; `wit/kernel.wit` + kernel-check.

**Steps:** `shm_create(size)` → `shm_id`; the kworker allocates a `SharedArrayBuffer`
shared to the creator's worker; the kernel grants the creator `Shm{shm_id}` and
records owner/size. `shm_map(shm_id)` succeeds **iff** the caller holds `Shm{shm_id}`
(delegated at spawn or granted) → the kworker routes the SAB to that worker.
`shm_write(shm_id, off, ptr, len)` / `shm_read(...)` copy between the caller's linear
memory and the shared SAB (cap + bounds checked). Pixels-never-cross-the-ring
discipline: shm bytes move worker↔SAB, not through the kernel ring.

**Tests:** kernel units (create grants owner the cap; map without cap → NOTCAPABLE;
bounds checks). `e2e/shm.spec.ts`: a writer process `shm_create`s + writes a known
pattern; a reader (delegated the cap) `shm_map`s + reads it back identical; a third
process without the cap fails to map.

---

## Phase C — Signals + priority

### Task 5 — Full signals (SIGTERM + SIGKILL, `Signal` capability)

**Files:** `syscall.rs` (`Op::Kill 0x39`, `SigPending 0x3A`; signal queue per
process; `Signal` cap check), `types.rs` (`pending_signals: VecDeque<u8>`),
`kcore.rs`/`lib.rs` (`signal(pid, sig)` → wakeups/host-kill request), `kernel-worker.ts`
(SIGKILL → `killProcess`), `crates/wasmos-sys` (`kill`, `sig_pending`, `SIG_TERM`/`SIG_KILL`);
shell `kill` builtin + a `kill` coreutil; `crates/sh` + `crates/coreutils`.

**Steps:** `kill(pid, sig)` requires `Signal`. **SIGKILL** → kernel marks the target
for forced reap; the outcome tells the kworker to `killProcess(pid)` (terminate
worker + release resources). **SIGTERM** → push `sig` onto the target's pending
queue + wake it if parked; the target's `sig_pending()` returns + drains pending
signals so it can exit cleanly. The shell, spinner, and apps poll `sig_pending` in
their loops and exit on SIGTERM.

**Tests:** kernel units (no `Signal` cap → NOTCAPABLE; SIGTERM queues + wakes;
SIGKILL requests host kill; pending drains once). `e2e/signals.spec.ts`: a process
handed SIGTERM exits gracefully (observable cleanup); SIGKILL force-closes one that
ignores SIGTERM; an unprivileged process cannot kill a peer.

### Task 6 — Runtime priority (FR-8)

**Files:** folds into Task 1's `set_priority` (control + guest); a shell `renice`
builtin/coreutil; the System Monitor exposes it (Task 8).

**Steps:** `set_priority(pid, prio)` adjusts a live process; the scheduler re-buckets;
`proc_list` reflects it. Spawn priority is already supported.

**Tests:** kernel unit (live re-bucket changes pick order); `e2e` via the monitor /
`renice` asserting `proc_list` shows the new priority.

---

## Phase D — Observability (FR-33, both forms)

### Task 7 — `ps` / `top` coreutils

**Files:** `crates/coreutils/src/bin/ps.rs`, `top.rs` (use `proc_list`); `/bin` + BIN.

**Steps:** `ps` prints a one-shot table (pid/state/pri/cpu/mem/name). `top`
re-renders every interval (clears + reprints) until input; both read `proc_list`.

**Tests:** `e2e/ps-top.spec.ts` (through the terminal): `ps` lists the shell + a
spawned process with their metrics; `top` updates.

### Task 8 — Graphical System Monitor app

**Files:** `crates/apps/sysmon` (Rust canvas app, wasmgfx): live process table,
CPU-activity + memory bars, row select, **kill** (SIGTERM/SIGKILL) + **renice**
buttons; launcher entry; `/bin` + BIN.

**Steps:** polls `proc_list` (a periodic self-`sig_pending`/timer loop driven by
input ticks or a short `chan`/poll), renders the table with bars, routes clicks to
`kill`/`set_priority`. The marquee "it's really an OS" window.

**Tests:** `e2e/sysmon.spec.ts`: open the monitor; it lists running processes;
spawn one → it appears; click kill → it disappears + the process is reaped.

---

## Phase E — Session persistence (FR-35)

### Task 9 — Session snapshot / restore

**Files:** `packages/host/src/compositor/session.ts` (SessionManager): manifest
`/home/.session.json` of open process-apps + window geometry; `compositor.ts`/`index.ts`
hooks (record on open/move/resize/close; restore on boot).

**Steps:** on every window open/close/move/resize for a process-app, write the
manifest (name + caps + geometry). On boot, after the desktop is up, read the
manifest and re-spawn each app, restoring window position/size. The terminal/shell
is always present; `/home` content persists already (FR-30).

**Tests:** `e2e/session.spec.ts`: open Paint + the file manager, move them, set a
wallpaper, `flush`, reload → both windows re-open at their saved geometry and the
wallpaper persists.

---

## Phase F — Close-out

### Task 10 — Full M4 E2E + kernel/Binder tests; CI + `M4-STATUS` + verify + PR

**Files:** `e2e/m4-marquee.spec.ts`; `crates/kernel` tests; `.github/workflows/ci.yml`
(build new guests: spinner/ps/top/sysmon — all Rust, covered by `build:guests`);
`package.json`; `docs/M4-STATUS.md`.

**Steps:** the headline E2E — boot → spawn many processes → two exchange via a
channel → two share an `shm` region → open the System Monitor showing them live →
SIGTERM/SIGKILL from the monitor → reload restores the session. Kernel unit coverage
for channels/shm/signals/priority/metrics. M0–M3 specs stay green. Extend
`build:guests`; `binder:kernel-check` covers the new world; write `M4-STATUS.md`
with **real** `npm run verify` numbers + as-built deviations; run `verify` green;
open the PR and drive CI green.

**Tests:** `npm run verify` exit 0 (build · build:guests · binder:kernel-check ·
lint · typecheck · test:rust · test:host · test:e2e); CI green on the PR.

---

## Risks specific to M4

- **Shared memory vs the wasm linear-memory model.** A guest can't map an external
  SAB into its own address space. *Resolved by design:* syscall-mediated
  `shm_read/shm_write` copy guest-mem ⇄ a host-held shared SAB (cap-checked) — real
  shared memory between processes while preserving default-deny isolation (FR-6).
  Documented as an as-built deviation from the spec's literal `(ptr,len)` mapping.
- **"CPU time" in a worker model.** True per-process CPU isn't measurable in-tab; the
  scheduler accounts a tick **per serviced syscall** (a deterministic kernel-activity
  metric) and memory is the reported `WebAssembly.Memory` size. `top` labels them
  honestly ("syscalls"/"activity", "mem"), not a faked CPU%.
- **32 concurrent workers.** Browsers handle dozens of workers, but the kworker must
  multiplex 32 rings via `Atomics.waitAsync` without starving. *Mitigation:* the
  existing non-blocking serve loop scales; the concurrency E2E asserts main-thread
  responsiveness, not just spawn success.
- **Resource cleanup on exit grows.** A dying process now releases pipes (M2),
  surfaces (M3), **channels, shm mappings, and pending signals** (M4). *Mitigation:*
  one `proc_exit` cleanup path, each subsystem unit-tested for release-on-exit.
- **Scope.** Largest milestone yet (IPC ×2 + signals + 2 monitors + session).
  *Mitigation:* spine-first (metrics → channels → shm), each subsystem independently
  demoable; ship after any phase as a coherent increment.

---

## Open question touching M4

- **OQ-2 (networking).** Still not required by any M4 deliverable; recommend keeping
  the brokered `net_request` deferred to M5/later. Flag for the owner at approval.
