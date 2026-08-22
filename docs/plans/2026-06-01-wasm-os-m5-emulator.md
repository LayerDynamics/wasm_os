# Linux guest integration — Emulator as a Privileged Process ("Linux in a tab")

> **Marquee moment:** launch **"Linux"** from the desktop and watch a **real Linux
> kernel boot to a shell** inside a WASM_OS window — while every other WASM_OS
> process keeps running, stays isolated, and the emulator is **killable from
> `top`/the System Monitor**. This is L5, the final layer of the spec: a
> foreign-architecture emulator running *as one privileged process among many*,
> not a separate app and not the whole system.

**Status:** PLAN (authored 2026-06-01). Builds on kernel, process, shell, desktop, and IPC (all merged to `main`;
process control and IPC = `docs/M4-STATUS.md`). Source of truth: `docs/specs/SPEC-1-wasm-os.md`.

---

## Implementation decision

The implementation uses TinyEMU, an MIT-licensed RISC-V emulator, in a dedicated
worker. The bootloader, Linux kernel, and BusyBox/Buildroot root filesystem are
documented in `assets/linux/README.md`; the emulator build and license are in
`third_party/tinyemu/README.md`.

---

## What Linux guest integration is (and is NOT)

Linux guest integration is an **integration task**, not a kernel-construction task. We are not
writing a CPU emulator — that is infeasible and misses the point. We integrate a
**third-party WASM CPU emulator (TinyEMU)** as a first-class WASM_OS **process**: it
gets a PID, shows up in `proc_list`/`top`, draws into a compositor window, receives
brokered input, is **special-cased by the scheduler** (a dedicated worker run to a
budget, FR-28), and is **killable** — all **without breaking the FR-6 isolation
guarantee** for the other (real `wasm32-wasi`) processes.

**Spec traces:** **FR-27** (x86/RISC-V emulator as a single privileged process
booting real Linux into a framebuffer), **FR-28** (special-cased scheduling —
dedicated worker, run-to-budget, isolation preserved), **FR-29** (COULD — bridge a
host VFS directory into the guest), plus **OQ-2** (the brokered networking
capability `net_request`, deferred since desktop compositor, **resolved here**), **FR-23** (canvas
framebuffer surface), and **FR-36** (all new ABI through the Binder).

**Confirmed scope decisions (planning Q&A): defer nothing.**
1. **Core = TinyEMU (RISC-V)**, integrated as a privileged process.
2. **Images: bundle AND net-broker.** A small kernel+initrd is **bundled** as a
   static asset for a deterministic, offline, CI-friendly boot; **and** the
   capability-gated **`net_request`** broker is built (resolving OQ-2) so images can
   also be **fetched/run from within** WASM_OS at runtime.
3. **FR-29 shared folder: included** — a host `/home` subtree bridged into guest
   Linux via TinyEMU's virtio-9p, backed by the WASM_OS VFS.
4. **Dev practice:** per-task commit (+ its tests) → one branch → PR → drive CI green
   → you merge. Identical to WASI process runtime–process control and IPC. **Tier A only** (SAB), consistent with WASI process runtime–process control and IPC.

---

## The one structural rule for the Linux guest task: **spike first, assert on serial**

Unlike WASI process runtime–process control and IPC, the "spine" is **not our kernel** — it is *"does the third-party core
even work in our headless environment, and how do we assert on it?"* So:

- **Task 1 is a time-boxed TinyEMU boot check** that empirically answers whether the
  RISC-V guest boots to a shell **in headless Playwright**, and **how to assert it**.
  The rest of the tasks are authored/refined **from the spike's findings**, not from
  guesses about a third-party lib.
- **Assert on serial-console TEXT, never framebuffer pixels.** Boot the guest with
  capture TinyEMU's `hvc0` console output, and assert on captured
  serial text (boot banner, a command's output). Pixel assertions are flaky and are
  explicitly out of scope for *verification*.
- **Serial boot (early, easy assert) precedes graphical framebuffer (polish).** We
  prove "Linux boots to a shell" over serial **before** wiring TinyEMU's console into a
  `win_surface` SAB. Likewise input uses the worker's TinyEMU console hook.

---

## Architecture deltas introduced by Linux guest integration

- **A new process *kind*: `Native`/privileged (non-ring).** Today every process is a
  `wasm32-wasi` guest driven by the SAB syscall ring. The emulator is a process that
  **makes no WASI syscalls** — it runs its own CPU loop in a dedicated worker. The
  kernel gains a process kind that has a PID + capability set + `proc_list` entry +
  is killable, but is **not** pumped by `service_syscall`. `reap` (process control and IPC) already tells
  the host to terminate a worker, so the kill path is reused.
- **Dedicated emulator worker** (`packages/host/src/worker/emulator-worker.ts`):
  hosts TinyEMU, owns the boot loop, exposes
  serial output + screen + keyboard to the host. Launched by a new control verb
  `spawnEmulator` (distinct from the wasm `spawn`).
- **Run-to-budget scheduling (FR-28).** The emulator runs continuously in its own
  worker thread (true parallelism → it cannot stall the main thread or other process
  workers). The scheduler **accounts** it (a time/quantum budget surfaced in `top`)
  rather than fine-preempting it; `cpu_ticks` semantics are extended (a syscall-less
  process can't earn syscall ticks — we wire **wall-budget accounting** for it rather
  than reporting 0).
- **Framebuffer present reuses desktop compositor.** TinyEMU's console adapter renders into a compositor
  **canvas surface** (`win_surface`/`win_present` path) — the VGA/console framebuffer
  is presented in a real window. Input reuses the desktop compositor broker (focused window →
  `deliverInput` → emulator worker → TinyEMU console).
- **`net_request` brokered networking (OQ-2).** New capability-gated syscall: a
  process calls `net_request(cap, request)` → the host performs a `fetch` (and later
  WS) on its behalf → response returned. Gated by the existing `Capability::Net`
  (already in the enum, currently unused). A `fetch` coreutil + a guest stub + the
  Binder verb. The emulator uses it to load images at runtime.
- **virtio-9p shared folder (FR-29).** TinyEMU's 9p filesystem is backed by a JS adapter
  that reads/writes a `/home` subtree through the WASM_OS VFS — files cross the
  host↔guest boundary (`mount -t 9p` in the guest).
- **Guest-disk persistence (FR-35 tie-in).** The guest's disk/state image is
  persisted to OPFS so a booted Linux session can survive a reload; "Linux" joins the
  taskbar launcher + the process control and IPC session manifest.

**Message topology (unchanged hub):** main/compositor ⇄ kworker ⇄ workers. The
emulator worker is a *peer* worker that talks to the compositor for its surface +
input and to the kworker for lifecycle (spawn/kill/proc_list/net/9p), but **not**
over the per-syscall ring.

---

## Linux guest integration exit criteria (definition of done — spec §4.1 Phase 5 / §5)

**Phase A criteria are the spec's Linux guest integration MUSTs and are independently shippable.**

1. **Launch "Linux" → it boots a real kernel to a shell** in a WASM_OS window;
   verified by **serial-console text** (boot banner + an interactive command's
   output), not pixels. (FR-27)
2. **Other WASM_OS processes keep running and remain isolated** while Linux runs —
   a concurrent `wasm32-wasi` process stays alive and the emulator cannot touch its
   memory (FR-6 preserved). (FR-28)
3. **The emulator is killable from `top`/System Monitor** — killing it reaps the
   worker; peers survive. (exit criteria)
4. **The guest shell is interactive** — brokered keyboard input reaches the guest and
   its output comes back (serial-asserted).
5. **The framebuffer renders in a window** (graphical present, FR-23) — a canvas
   window shows the VGA console.
6. **`net_request` works** (OQ-2): a capability-holding process fetches a URL via the
   host broker; default-deny without `Net`; **an image is loaded/booted from within**
   WASM_OS over the broker.
7. **FR-29 shared folder**: a file written in host `/home` is read inside guest Linux,
   and a file created in the guest is read back via the host VFS.
8. **Guest session persists across reload** (FR-35 tie-in) and "Linux" is launchable
   from the taskbar.
9. `npm run verify` is **green**, including the **kernel, process, shell, desktop, and IPC regression suite**; the heavy
   boot test runs in a **separate slow lane** so it can't flake the fast suite.

---

## Out of scope for Linux guest integration (deferred)

- **Writing an emulator core** — we integrate TinyEMU; no from-scratch CPU.
- **Pixel-level framebuffer assertions** — verification is serial-text based;
  graphical present is exercised by "a canvas window appears + updates," not pixel
  diffs.
- **Tier B** (Asyncify/JSPI) — Tier A only (R-1).
- **WASI p2 components** (FR-13) — the p1 + `wasmos_kernel` surface remains the path.
- **Full WASI-sockets shim** — `net_request` is the brokered-fetch capability
  (Assumption 9); a sockets shim stays a later target.
- **Multiple concurrent emulator instances** — one privileged emulator process is the
  Linux guest integration target (the design does not preclude more later).

---

## Phase A — Boots to a shell (the Linux guest integration MUSTs; independently shippable)

### T1 — TinyEMU boot check: RISC-V Linux → shell, serial-asserted in Playwright
**The empirical foundation. Author T2+ from what this resolves.**
- Use the vendored TinyEMU core under `third_party/tinyemu/`. The RISC-V bootloader,
  kernel, and root filesystem live under `assets/linux/` and are served by the dev
  server.
- A minimal harness page (or reuse the host) instantiates TinyEMU in a **dedicated
  worker**, boots from `wasmos-riscv64.cfg`, and pipes its `hvc0` console output
  to a buffer readable from the page.
- **Test (the deliverable):** a headless Playwright spec boots the image and asserts
  the captured **serial text** contains the shell/login banner within a generous
  timeout. Records the boot markers and image details in the Linux guest status
  report.
- **Resolve before T2:** worker-vs-main, TinyEMU console hooks, and the
  OffscreenCanvas/SAB framebuffer path.

### T2 — Emulator as a **privileged process** (kernel lifecycle + isolation)
- Kernel: a process **kind** (`Native`/privileged) — PID, capability set, `proc_list`
  entry, **not** pumped by the WASI ring; reuse process control and IPC `reap` for kill. Decide + wire
  `cpu_ticks`/budget semantics for a syscall-less process (wall-budget accounting,
  not 0).
- Host: `emulator-worker.ts` registered with the kworker; a `spawnEmulator` control
  verb (caps: `Gpu`, `Input`, `Net`, privileged-sched). The worker from T1 becomes
  this process's body.
- **Tests:** kernel unit — a `Native` process appears in `proc_list`, is killable,
  and its presence doesn't perturb ring processes. E2E — spawn the emulator process;
  it shows in `listProcs`; a concurrent `wasm32-wasi` process stays alive (isolation).

### T3 — Interactive guest shell via **brokered keyboard input**
- Route the focused emulator window's input (desktop compositor `deliverInput`) into the worker →
  TinyEMU's guest console input path.
- **E2E (serial-asserted):** boot → type a command (e.g. `echo WASMOS-<marker>` /
  `uname -a`) into the guest → assert the marker/uname appears in **serial output**.

### T4 — **Framebuffer window** (graphical present, FR-23)
- Wire TinyEMU's console output into a compositor **canvas surface**
  (`win_surface`/`win_present`), so the guest console renders in a window.
- **E2E:** launching "Linux" opens a **canvas window** that becomes non-blank
  (updates) within a timeout — presence/update, **not** pixel-exact.

### T5 — **Run-to-budget scheduling + isolation + killable from `top`** (FR-28; closes Phase A)
- Scheduler: special-case the emulator (run-to-budget; surface its budget/activity in
  `proc_list`/`top`). Confirm peers keep running while Linux runs.
- **E2E (the exit-criteria scenario):** Linux booted + a concurrent WASM_OS process
  both alive in `top`; **kill the emulator from the System Monitor** → it dies, the
  peer + desktop survive. ← **Phase A = Linux guest integration MUST met; tag a shippable point.**

---

## Phase B — Brokered networking + "run the image from within it" (OQ-2)

### T6 — `net_request` capability + host **fetch broker** + `fetch` coreutil
- New syscall `net_request` (new opcode), gated by `Capability::Net` (default-deny);
  host broker in the kworker performs `fetch` (async) and returns the response over
  the ring; guest stub; Binder verb (FR-36); a `fetch`/`wget` coreutil (shell
  delegates `Net` like `Signal`).
- **Tests:** kernel unit (cap gating → NOTCAPABLE without `Net`); E2E — a process
  fetches a locally-served asset via the broker and writes it to the VFS; default-deny
  proven.

### T7 — Boot an image **fetched at runtime** over the broker
- The emulator can load a Linux image obtained via `net_request` (URL → fetch → boot),
  in addition to the bundled one — the literal "run the image from within it."
- **E2E (slow lane):** resolve a locally-served RISC-V VM configuration via the
  broker and boot it to a serial shell.

---

## Phase C — Shared folder (FR-29; riskiest — sequenced last)

### T8 — virtio-9p **shared folder** bridged to the WASM_OS VFS
- Back TinyEMU's 9p filesystem with a JS adapter over `control.fsRead/fsWrite/fsList` for
  a `/home` subtree; guest `mount -t 9p ...` exposes host files.
- **E2E (serial-asserted):** host writes `/home/shared/hello.txt` → guest `cat`s it
  over 9p (serial shows the contents); guest writes a file → host `fsRead` sees it.

---

## Phase D — Persistence, desktop integration, and the finale

### T9 — Guest-disk **persistence** (OPFS) + "Linux" in taskbar/session (FR-35 tie-in)
- Persist the guest disk/state to OPFS so a booted session survives reload; add
  "Linux" to the taskbar launcher and the process control and IPC session manifest (re-open on reload).
- **E2E:** create a file in the guest → reload → it's still there (or the disk image
  persisted), and "Linux" re-opens from the session.

### T10 — Full Linux guest integration E2E + **slow-lane CI** + kernel/Binder tests + `M5-STATUS` + verify + PR
- A separate **slow CI lane** for the boot/serial tests (generous timeouts, asset
  hosting) so the multi-second Linux boot can't flake the ~9s fast suite; the fast
  lane keeps kernel, process, shell, desktop, and IPC + the light Linux guest integration checks.
- `docs/M5-STATUS.md` (exit-criteria table, verify-gate breakdown, as-built
  decisions, licensing note); update the README Linux guest row.
- `npm run verify` green (fast lane) + the slow lane green; branch → PR → drive CI →
  you merge.

---

## Risks & mitigations (Linux guest integration-specific)

| Risk | Mitigation |
|------|------------|
| **TinyEMU headless boot / asserting is hard** | T1 checks the worker and console path first; assert on **serial text**, not pixels. |
| **CI weight + flakiness** (multi-MB image, multi-second boot) | Keep the RISC-V image local; use a **separate slow lane** and generous timeouts. |
| **Guest payload licensing** | Keep TinyEMU's MIT license and the Linux payload licenses documented separately. |
| **"defer nothing" → half-finished mega-PR** | **Phase A is independently green/shippable** (the spec MUSTs); B/C/D are explicit cut-points; 9p (riskiest) is last. |
| **Run-to-budget starves peers or main thread** | Emulator in its **own worker** (true parallelism); budget accounting; killable. Isolation proven by the Phase-A concurrent-peer E2E. |
| **Emulator can't be reaped (non-ring worker)** | process control and IPC `reap` already just tells the host to terminate a worker; T2 verifies it on the native kind. |

---

## Verification (every task)

Per task: `cargo test -p kernel` (+ any touched crate), the task's E2E, `npm run
lint` (clippy), `npm run typecheck`, and `binder kernel-check` when ABI changes.
Finale: full `npm run verify` (fast lane) + the slow boot lane, both green, before
the PR. CI conclusion confirmed via `gh run view --json conclusion` (not the watch
exit code).
