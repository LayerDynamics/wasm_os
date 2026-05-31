# SPEC-1: WASM_OS

> A layered operating system that runs entirely inside a browser tab — a WASM microkernel that schedules WASI processes, a Unix-style userland and terminal, a windowed desktop compositor, and an emulator capable of booting a real Linux, all composed as layers of one system.

**Date:** 2026-05-30
**Author:** Ryan O'Boyle (<layerdynamics@proton.me>) + Claude
**Status:** Draft
**Version:** 1.0

---

## 0. Reading Guide

This spec describes an intentionally ambitious system. To keep "do all of it" from collapsing into "do nothing well," the document is organized around one load-bearing idea:

> **The four "kinds of web OS" the project set out to build are not four competing designs. They are five layers of one system, each a demoable milestone.**

| The project asked for… | …is delivered as |
|---|---|
| A whole OS in WASM/WASI (microkernel) | **Layer 0** — the WASM microkernel (kernel space) |
| Polyglot (wasm/wat/wasi/wa*m) | **Layer 1** — the WASI process ABI: any language targeting `wasm32-wasi` is a runnable process |
| A WASI userland + terminal | **Layer 2** — shell, coreutils, terminal |
| A webtop / desktop environment | **Layer 3** — the windowing compositor and desktop |
| Run a real Linux (emulator) | **Layer 4** — an x86/RISC-V emulator running *as a single privileged process* |

Where this spec records a decision the author confirmed during discovery, it states so. Where it proposes a value the author has not yet fixed (NFR numbers, timeline, exact WASI version, networking model), the value is marked **[PROPOSED]** and the underlying decision is tracked in §8 Open Questions with an owner. This is deliberate (see §1.5).

---

## 1. Background

### 1.1 Problem Statement

There is no operating system that is *natively* designed for the WebAssembly machine model. Today, getting OS-like behavior in a browser means one of two unsatisfying things:

1. **Single-app WASM** — a program (a game, a Figma, a Photoshop port) compiled to WASM that owns the whole tab. There is no notion of multiple processes, a shared filesystem, scheduling, or inter-process communication. The "OS" is just the browser, and the browser is not designed to be one.
2. **Emulating a foreign machine** — booting x86 Linux in a JS/WASM CPU emulator (v86, container2wasm). This works, but it is *emulation of a different architecture*; it pays a large performance tax, treats WASM as a dumb instruction substrate, and ignores everything WASM/WASI offer natively (typed sandboxing, capability-oriented imports, fast near-native module execution).

WASM_OS asks the question directly: **if the WebAssembly virtual machine is the "hardware," what is the operating system that belongs on top of it?** It builds that OS — a microkernel that treats each `wasm32-wasi` module as a first-class process, with a real scheduler, a virtual filesystem, capability-mediated syscalls, IPC, a userland, a desktop, and (as one app among many) the ability to host a foreign-architecture emulator for the cases where you genuinely need legacy Linux.

### 1.2 Current State

| What exists today | Why it's insufficient for this goal |
|---|---|
| **Browser runtime (V8/SpiderMonkey/JSC) + `WebAssembly` API** | Executes one or many modules but provides no process model, scheduler, FS, or IPC. It is the CPU, not the OS. |
| **WASI runtimes (Wasmtime, Wasmer, WasmEdge, wasm3)** | Server/native-side; not browser-native and not multi-process operating environments with a UI. |
| **`@bjorn3/browser_wasi_shim`, WASI polyfills** | Give *one* module a WASI environment in the browser. No scheduler, no multi-process kernel, no shared FS across processes. |
| **Webtops (daedalOS, Puter, Webtop)** | Desktop UX in the browser, but "apps" are web apps/iframes; there is no WASM-native kernel or WASI process model underneath. |
| **Emulators (v86, container2wasm, WebVM)** | Boot real Linux in-browser via CPU emulation. Different architecture, heavy, and not a WASM-native OS — exactly the thing this project relegates to *one optional layer*. |

No existing system unifies a WASM-native microkernel + WASI processes + userland + desktop + optional emulation. That is the gap.

### 1.3 Target Users

The project intentionally serves four overlapping audiences (all four were chosen during discovery):

1. **Learners / the author (showcase & systems-programming education).** People who want to understand schedulers, syscalls, capabilities, and IPC by building/reading a real one that runs in a tab with zero install.
2. **App authors targeting a sandboxed runtime (real platform for untrusted code).** Developers who want to ship a `.wasm` app that runs safely inside someone else's browser with brokered, capability-limited access to FS/network/devices.
3. **Developers wanting a zero-install sandbox/playground.** Run real WASI CLI binaries, coreutils, compilers, and pipelines in-browser for demos, CI, teaching, and reproducible environments.
4. **Researchers exploring novel OS abstractions.** People interested in what scheduling, isolation, and IPC *mean* when the hardware is a deterministic, capability-oriented VM.

### 1.4 Motivation

- **The substrate finally exists.** WASM is fast and ubiquitous; WASI Preview 1 is stable and widely targeted; the Component Model + WASI Preview 2 bring a real capability model; SharedArrayBuffer + Atomics + OPFS + (emerging) JSPI make genuine multi-process behavior in a tab feasible for the first time.
- **Nobody has built the *native* answer.** Every prior approach either ignores the process model or emulates a foreign machine. There is room for a definitively WASM-native OS.
- **One artifact serves all four goals.** A correct microkernel is simultaneously a teaching tool, a product platform, a dev sandbox, and a research vehicle — so the effort compounds.

### 1.5 Assumptions

> Author-confirmed decisions are unmarked. **[PROPOSED]** values are Claude's defaults pending an owner decision in §8.

1. **Confirmed — Layered architecture.** All four requested archetypes are delivered as the five layers in §0, not as separate products.
2. **Confirmed — Polyglot via WASI.** The process ABI is WASI; any language compiling to `wasm32-wasi` (Rust, C, Zig, AssemblyScript, hand-written WAT) yields a runnable process. *Caveat (see §2.3): the polyglot guarantee is not uniform across all five languages at the same fidelity — Rust/C/Zig are first-class; AssemblyScript and hand-written WAT require more manual ABI work.*
3. **Confirmed — Core language.** Polyglot, with **Rust → WASM as the primary kernel/runtime language** (the `crates/` tree) and **TypeScript as the host** (the `packages/` tree). WAT, AssemblyScript, and C/Zig are first-class *process* languages and may supply individual kernel-adjacent modules.
4. **Confirmed — Execution model.** Worker-per-process with **SharedArrayBuffer + Atomics** as the primary tier; a **constrained cooperative single-thread tier** as fallback (see §3.1, §2.3 — this fallback is *not* transparent).
5. **Confirmed — Persistence.** Layered VFS: in-memory tmpfs at `/`, **OPFS** for `/home`, **IndexedDB** fallback for `/mnt` and for browsers without OPFS.
6. **Confirmed — GUI.** Hybrid compositor: DOM-framed windows whose content surface is either a DOM node *or* a `<canvas>`/WebGL framebuffer.
7. **Confirmed — Timeline.** Sequenced by dependency, not calendar; owners/dates are TBD (§5, §8).
8. **[PROPOSED] — WASI baseline.** **WASI Preview 1** is the process-ABI baseline (maximizes language breadth today); **WASI Preview 2 / the Component Model** is the capability + security layer and the forward target (see §8 OQ-1).
9. **[PROPOSED] — Networking.** No raw sockets initially; network access is a brokered host capability (`fetch`/WebSocket/WebTransport) exposed to processes through a capability-gated syscall, with a WASI-sockets shim as a later target (§8 OQ-2).
10. **[PROPOSED] — Target browsers.** Evergreen Chromium and Firefox with cross-origin isolation enabled; Safari supported on the cooperative tier where SAB/OPFS constraints apply (§8 OQ-3).
11. **Confirmed — Distribution channel.** The OS is served as static assets (it is "just a web page") behind COOP/COEP headers; no server is required to *run* it. A server is optional and only for app registry/remote sync features.

---

## 2. Requirements

### 2.1 Functional Requirements

Requirements are grouped by layer and traced to architecture (§3) and milestones (§5). Each is a testable statement.

#### Layer 0 — Microkernel

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | The system MUST boot a WASM microkernel in a browser tab that reaches a "ready" state with no WASI process running, exposing a kernel API to the host. |
| FR-2 | MUST | The kernel MUST maintain a process table assigning each process a unique PID, a state (`new`/`ready`/`running`/`blocked`/`zombie`), and an owning capability set. |
| FR-3 | MUST | The kernel MUST schedule ≥ 32 concurrent processes using a documented, deterministic-by-default policy (proposed: priority round-robin with per-process time accounting). |
| FR-4 | MUST | The kernel MUST route WASI Preview 1 syscalls from a process to kernel handlers (FS, clock, random, args/env, exit, poll) and return ABI-correct results. |
| FR-5 | MUST | The kernel MUST provide `spawn(image, args, env, caps)` and `wait(pid)` primitives usable from the shell and from processes that hold the capability. |
| FR-6 | MUST | The kernel MUST isolate process linear memory such that one process cannot read or write another process's memory except through an explicit shared-memory IPC capability. |
| FR-7 | SHOULD | The kernel SHOULD support signals/kill (`SIGKILL`, `SIGTERM` equivalents) that transition a process to `zombie` and release its resources. |
| FR-8 | COULD | The kernel COULD support process priorities settable at spawn and adjustable at runtime. |

#### Layer 1 — WASI Process ABI (polyglot)

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-9 | MUST | The system MUST run unmodified `wasm32-wasi` (Preview 1) modules produced by the Rust toolchain as processes. |
| FR-10 | MUST | The system MUST run `wasm32-wasi` modules produced by the C/Zig (wasi-sdk) toolchains. |
| FR-11 | SHOULD | The system SHOULD run AssemblyScript-produced modules that conform to the documented WASI subset. |
| FR-12 | SHOULD | The system SHOULD run hand-authored `.wat` modules that import the documented kernel syscall interface. |
| FR-13 | SHOULD | The system SHOULD load and instantiate **WASI Preview 2 components**, mapping their imported interfaces to kernel-provided capabilities. |
| FR-14 | MUST | The build tooling MUST produce, from at least one Rust source and one C/Zig source, a `.wasm` artifact that runs as a process with identical observable behavior. |

#### Layer 2 — Userland & Terminal

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-15 | MUST | The system MUST provide an interactive terminal (xterm-class) bound to a shell process. |
| FR-16 | MUST | The shell MUST execute built-in and on-disk WASI binaries, resolve `$PATH`, and report exit codes. |
| FR-17 | MUST | The shell MUST support pipelines (`a \| b \| c`) and I/O redirection (`>`, `>>`, `<`) implemented via kernel pipe/file descriptors. |
| FR-18 | MUST | The system MUST ship a coreutils set sufficient for a credible Unix session: at minimum `ls, cat, echo, cp, mv, rm, mkdir, pwd, grep, head, tail, wc, env`. |
| FR-19 | SHOULD | The shell SHOULD support job control basics (background `&`, `jobs`, foreground) backed by kernel process states. |
| FR-20 | COULD | The system COULD ship a package mechanism to install additional `.wasm` binaries into the VFS. |

#### Layer 3 — Compositor & Desktop (webtop)

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-21 | MUST | The system MUST present a desktop with a taskbar/launcher, a clock, and the ability to open multiple windows. |
| FR-22 | MUST | The compositor MUST manage window lifecycle (open/close/focus/move/resize/minimize/maximize) and z-order. |
| FR-23 | MUST | A window's content surface MUST be either a DOM node (web-native app) or a `<canvas>`/WebGL framebuffer the compositor presents (graphical/emulator app). |
| FR-24 | MUST | The system MUST ship a graphical file manager that browses the VFS and can launch files with associated apps. |
| FR-25 | SHOULD | The compositor SHOULD broker input (keyboard/mouse/touch) to the focused window's owning process via the capability system. |
| FR-26 | COULD | The desktop COULD support per-user theming/wallpaper persisted to `/home`. |

#### Layer 4 — Emulator-as-process

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-27 | SHOULD | The system SHOULD run an x86 (or RISC-V) emulator compiled to WASM **as a single, privileged process** that boots a real Linux/BusyBox userland into a window's framebuffer. |
| FR-28 | SHOULD | The emulator process MUST receive special-cased scheduling (a dedicated worker, run-to-budget rather than fine-grained preemption) without violating the isolation guarantees of FR-6 for other processes. |
| FR-29 | COULD | The emulator COULD bridge a directory of the host VFS into the guest Linux (shared folder) via a brokered device. |

#### Cross-cutting

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-30 | MUST | The VFS MUST persist `/home` across reloads (OPFS, IndexedDB fallback) and present a single POSIX-like tree spanning tmpfs/OPFS/IndexedDB mounts. |
| FR-31 | MUST | Every host-side capability (FS path subtree, network, clock, devices) MUST be grantable/revocable per process; a process with no grant for a resource MUST be unable to access it. |
| FR-32 | MUST | The system MUST run with no application server: served as static assets behind COOP/COEP, fully functional offline after first load. |
| FR-33 | SHOULD | The system SHOULD expose a `ps`/`top`-style view of live processes, memory, and scheduler state. |
| FR-34 | SHOULD | A process crash or trap MUST be contained: it terminates only that process, surfaces an error, and leaves the kernel and other processes running. |
| FR-35 | COULD | The system COULD support session snapshot/restore (serialize running state + VFS). |
| FR-36 | MUST | All ABI bindings (guest stubs per language, kernel host trait, TS host bindings) MUST be generated by the centralized Binder from the single `wit/` source of truth; `binder check` MUST fail CI if committed generated output drifts from the `wit/` definitions. |

### 2.2 Non-Functional Requirements

> All numeric targets are **[PROPOSED]** unless an owner fixes them (§8 OQ-4). They are written as measurable statements so they are testable once confirmed.

#### Performance

| Metric | Target [PROPOSED] | Measurement |
|--------|--------|-------------|
| Cold boot to kernel-ready | < 1500 ms on mid-tier laptop, broadband | `performance.now()` from script start to kernel `ready` event |
| Boot to interactive terminal (M2) | < 3000 ms cold, < 1000 ms warm (cached) | First shell prompt paint, instrumented |
| Process spawn latency (warm module) | p95 < 25 ms | Time from `spawn()` to process `running`, 1000-sample histogram |
| Syscall overhead (FS read, SAB tier) | p95 < 0.5 ms added vs. raw host op | Microbenchmark harness in `tools/` |
| Concurrent processes before scheduler thrash | ≥ 32 sustained at < 50% main-thread budget | Load harness spawning N spinners |
| Compositor frame rate (≤ 8 windows) | ≥ 55 fps steady, no input-to-paint > 100 ms | `requestAnimationFrame` timing + input trace |

#### Reliability

| Metric | Target [PROPOSED] |
|--------|--------|
| Process-crash containment (FR-34) | 100% — no single process trap may crash the kernel; verified by fault-injection suite |
| VFS durability | Zero acknowledged-write loss for `/home` across reload/crash; verified by write-then-reload test |
| Recovery after kernel panic | Auto-reboot to ready < 2 s, VFS intact |
| Mean session length before unrecoverable error | ≥ 1 hour under the soak test |

#### Security & Compliance

- **Isolation model:** every process runs in a WASM sandbox; the only host access is through capability-gated syscalls brokered by the kernel. Default-deny.
- **Capability model:** capabilities are unforgeable references granted at spawn and stored in the process's capability set; revocation is immediate. WASI Preview 2 / Component Model interface typing is the long-term enforcement substrate (§3.7).
- **Cross-origin isolation:** the app is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to enable SharedArrayBuffer. *This constrains what untrusted content can be embedded* (CORP/CORS on all subresources) — captured as a constraint (§2.3) and risk (R-4).
- **Data classification:** user-created files in `/home` are treated as private to the origin; no telemetry leaves the device by default. No PII/PHI/financial handling is in scope for V1.
- **Compliance:** none required for V1 (no accounts, no server, no PII). Revisit only if the optional registry/remote-sync server is built (§8 OQ-5).
- **Audit logging:** the kernel SHOULD maintain an in-memory, inspectable audit log of capability grants and denials for the running session (supports FR-33 and the research goal).

#### Scalability

- **Process scale:** V1 target ≥ 32 concurrent processes; design the process table and scheduler to not hard-cap below 256.
- **FS scale:** handle a `/home` of ≥ 500 MB and individual files ≥ 64 MB without UI stall (streamed/chunked I/O).
- **Growth approach:** scale by worker pool sizing and by moving hot kernel paths into WASM; the architecture must not require a server to scale users (each user runs their own OS in their own tab).

### 2.3 Constraints

1. **Browser sandbox is the floor.** No real hardware, no raw threads beyond Web Workers, no synchronous network, no arbitrary native FS. Everything is mediated by browser APIs.
2. **SharedArrayBuffer requires cross-origin isolation.** The primary execution tier (FR-3/§3.1) is only available when COOP/COEP are set and honored. This is a hard hosting constraint (must control response headers) and limits embedding untrusted cross-origin DOM/iframes.
3. **The cooperative fallback is NOT transparent.** Without SAB, blocking WASI syscalls cannot use `Atomics.wait`. The fallback tier must make syscalls asynchronous via Asyncify (build-time transform of the guest) or JSPI/stack-switching (where available). **This imposes requirements on guest modules** (they must be Asyncify-instrumented or JSPI-compatible) and therefore is a distinct *compatibility tier with reduced guarantees*, not a free downgrade. (Risk R-1.)
4. **Polyglot fidelity is uneven (today).** Rust → WASI p1/p2 is first-class; C/Zig via wasi-sdk are solid p1; AssemblyScript's WASI surface is thin; hand-written WAT must hand-roll the syscall imports. The "any language" claim is true at the ABI level but graded in practice (Risk R-2).
4b. **No persistent server in the run path.** V1 must run from static hosting; any server feature is strictly optional and additive.
5. **OPFS synchronous access is worker-only and browser-varied.** Synchronous OPFS access handles exist only in Workers and Safari support/semantics differ; the VFS must degrade to IndexedDB.
6. **Single-language mandate rejected by design.** The project is explicitly polyglot; tooling must support a multi-toolchain build (`tools/`).

### 2.4 Explicit Non-Goals (V1)

| ID | Priority | The system WILL NOT (in V1) |
|----|----------|------------------------------|
| FR-NG-1 | WONT | Provide raw TCP/UDP sockets to processes (networking is brokered host capability only). |
| FR-NG-2 | WONT | Support multi-user accounts, authentication, or a login system. |
| FR-NG-3 | WONT | Guarantee binary compatibility with native Linux ELF binaries outside the Layer-4 emulator. |
| FR-NG-4 | WONT | Provide a hosted app store/marketplace with payments (a local package mechanism is the ceiling — FR-20). |
| FR-NG-5 | WONT | Target non-evergreen or mobile-first browsers as first-class in V1. |
| FR-NG-6 | WONT | Implement real-time / hard-deadline scheduling guarantees. |

---

## 3. Architecture

### 3.1 System Overview

WASM_OS is a layered system inside a single browser tab. The **host** (TypeScript, main thread) owns the DOM, the compositor, device brokers, and worker lifecycle. The **kernel** (Rust → WASM) owns the process table, scheduler, VFS, syscall routing, IPC, and the capability system. **Processes** are `wasm32-wasi` modules running in Web Workers.

```text
 BROWSER TAB  (served static, COOP/COEP enabled)
┌──────────────────────────────────────────────────────────────────────┐
│ MAIN THREAD (TypeScript host)                                          │
│  ┌─────────────┐  ┌──────────────────────┐  ┌──────────────────────┐  │
│  │ Compositor  │  │ Device Brokers        │  │ Boot / Loader        │  │
│  │ (L3 desktop)│  │ net(fetch/WS) · input │  │ fetch .wasm · COOP   │  │
│  │ DOM+canvas  │  │ clock · entropy · gpu │  │ check · panic/reboot │  │
│  └──────┬──────┘  └───────────┬──────────┘  └──────────┬───────────┘  │
│         │  capability-gated host calls (postMessage / SAB ring)        │
│  ┌──────┴───────────────────────────────────────────────┴─────────┐   │
│  │ KERNEL  (Rust → WASM)        [runs on main thread or kworker]    │   │
│  │  process table · SCHEDULER · capability store · IPC · syscall   │   │
│  │  router ──► VFS (tmpfs / OPFS / IndexedDB)                       │   │
│  └───▲────────────▲───────────────▲──────────────────▲─────────────┘   │
│      │ SAB + Atomics syscall channel (primary tier)   │                 │
│  ┌───┴───┐    ┌───┴───┐    ┌───┴────┐         ┌───────┴────────────┐    │
│  │Worker │    │Worker │    │Worker  │  ...    │ Worker (privileged) │    │
│  │ proc  │    │ proc  │    │ shell  │         │ EMULATOR (L4)       │    │
│  │.wasm  │    │.wasm  │    │ (L2)   │         │ x86/RV → boots Linux│    │
│  └───────┘    └───────┘    └────────┘         └─────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
  Persistence: OPFS (/home) · IndexedDB (/mnt + fallback) · tmpfs (/)
```

**Two execution tiers (Constraint 3):**

```text
Tier A — PRIMARY (cross-origin isolated):
   worker-per-process · SAB+Atomics syscall ring · Atomics.wait blocks the
   guest synchronously · true parallelism across workers.

Tier B — COMPAT (no SAB, e.g. Safari/non-isolated):
   guest must be Asyncify-instrumented OR use JSPI · syscalls are async ·
   cooperative scheduling on fewer/one worker · reduced concurrency,
   higher latency, narrower guest compatibility. NOT transparent.
```

### 3.2 Component Design

#### Component: Boot / Loader (host)

- **Responsibility:** Bring the OS from a cold page load to a kernel-ready state; detect capabilities (SAB/COOP-COEP, OPFS, JSPI) and select execution tier.
- **Technology:** TypeScript, main thread; `WebAssembly.instantiateStreaming`.
- **Interfaces:** `boot()`, emits `ready`/`panic`; exposes tier + feature report.
- **Dependencies:** static asset hosting with COOP/COEP; the kernel `.wasm`.

#### Component: Microkernel (kernel space)

- **Responsibility:** Own the process table, scheduler, syscall router, IPC, capability store, and VFS coordination.
- **Technology:** Rust → `wasm32-unknown-unknown` (kernel) / `wasm32-wasi` for kernel-adjacent modules; `crates/`.
- **Interfaces:** kernel ABI to host (spawn/kill/list/grant/revoke); WASI syscall surface to processes.
- **Dependencies:** SAB ring or postMessage transport; VFS backends.

#### Component: Scheduler

- **Responsibility:** Decide which ready process runs next and account for time used; special-case the privileged emulator process (FR-28).
- **Technology:** Rust, inside the kernel.
- **Interfaces:** `enqueue(pid)`, `next()`, `on_block(pid)`, `on_yield(pid)`, `set_priority(pid, p)`.
- **Dependencies:** process table, clock broker.

#### Component: Capability Store

- **Responsibility:** Hold each process's unforgeable capability set; enforce default-deny on every brokered resource; support grant/revoke.
- **Technology:** Rust; maps to WASI p2 component interface typing as it matures.
- **Interfaces:** `grant(pid, cap)`, `revoke(pid, cap)`, `check(pid, cap) -> bool`.
- **Dependencies:** process table, audit log.

#### Component: Virtual Filesystem (VFS)

- **Responsibility:** Present one POSIX-like tree over multiple backends; enforce path capabilities; stream large files.
- **Technology:** Rust core + TS backend adapters (OPFS, IndexedDB).
- **Interfaces:** WASI FS calls (`fd_read/write/seek`, `path_open`, `fd_readdir`, …); mount/unmount.
- **Dependencies:** OPFS, IndexedDB, tmpfs (linear memory / SAB).

#### Component: IPC

- **Responsibility:** Pipes, message channels, and explicit shared-memory regions between processes (the only inter-process memory path, FR-6).
- **Technology:** Rust; SAB-backed ring buffers (Tier A) or message ports (Tier B).
- **Interfaces:** `pipe()`, `chan_open()`, `shm_map(cap)`.
- **Dependencies:** capability store, scheduler (wake on data).

#### Component: Compositor & Desktop (L3)

- **Responsibility:** Window lifecycle, z-order, input brokering, taskbar/launcher, file manager.
- **Technology:** TypeScript, DOM + `<canvas>`/WebGL, main thread.
- **Interfaces:** `openWindow(proc, surfaceType)`, input events → process via capability; framebuffer present.
- **Dependencies:** kernel (process list), input broker.

#### Component: Userland (L2)

- **Responsibility:** Shell, coreutils, terminal binding.
- **Technology:** Rust/C/Zig → WASI binaries (polyglot showcase); xterm.js terminal in host.
- **Interfaces:** stdin/stdout/stderr fds; `$PATH` resolution; pipelines.
- **Dependencies:** kernel spawn/wait, VFS, IPC pipes.

#### Component: Device Brokers (host)

- **Responsibility:** Mediate clock, entropy, network (`fetch`/WS/WebTransport), input, and GPU/canvas access as capabilities.
- **Technology:** TypeScript, main thread.
- **Interfaces:** capability-gated request/response; no direct guest access.
- **Dependencies:** capability store (every call checked).

#### Component: Emulator Process (L4)

- **Responsibility:** Boot a foreign-arch Linux/BusyBox into a framebuffer window, as one privileged process.
- **Technology:** an x86/RISC-V emulator compiled to WASM (e.g. a v86-class core), packaged as a process image.
- **Interfaces:** framebuffer surface (canvas), optional shared-folder device (FR-29).
- **Dependencies:** dedicated worker, special scheduling budget, compositor surface.

#### Component: Build & Tooling (incl. the Binder)

- **Responsibility:** Multi-toolchain build producing process `.wasm` artifacts and the kernel; **the centralized Binder** that generates all ABI bindings from the `wit/` source of truth (§3.4.1); benchmarks; image packaging.
- **Technology:** `tools/` — `binder` (wrapping `wit-bindgen` + `jco` + custom AssemblyScript/WAT emitters), wasm-pack/cargo, wasi-sdk (C/Zig), AssemblyScript compiler, `wasm-tools`/`wat2wasm`, component tooling.
- **Interfaces:** `binder gen`, `binder check`, `build kernel`, `build app <lang>`, `pack image`, `bench`.
- **Dependencies:** the `wit/` interface definitions; the respective language toolchains.

### 3.3 Data Model

Core kernel entities (in-memory unless noted):

```text
Process
  pid: u32                  state: enum{new,ready,running,blocked,zombie}
  image: ModuleRef          priority: u8
  caps: CapabilitySet       fds: Map<fd, Descriptor>
  memory: WasmInstanceMem    worker: WorkerRef (Tier A)
  parent: pid?              exit_code: i32?

Capability  (unforgeable)
  kind: enum{FsPath, Net, Clock, Entropy, Input, Gpu, Spawn, Shm, Signal}
  scope: e.g. FsPath{ subtree: "/home/user", rights: rwx }
  revocable: bool

Descriptor (file/pipe/chan)  fd → {kind, backendRef, offset, rights}

VNode (VFS)
  path, kind: enum{file,dir,symlink,device}
  mount: enum{tmpfs, opfs, idb}
  size, mtime, rights         backendHandle

Message/Pipe   buffer: SAB ring (Tier A) | MessagePort (Tier B)
ShmRegion      sab: SharedArrayBuffer, granted_to: Set<pid>, rights
AuditEntry     ts, pid, cap, action: enum{grant,revoke,allow,deny}
```

**Persistence mapping:** `Process`, `Capability`, `Descriptor`, scheduler state → in-memory (lost on reload unless FR-35 snapshot). `VNode` content → tmpfs (memory), OPFS (`/home`), or IndexedDB (`/mnt`, fallback). `AuditEntry` → in-memory, session-scoped.

**Consistency:** strong within a single backend op; the VFS guarantees acknowledged writes to `/home` are durable (Reliability NFR). Cross-backend operations (e.g. move tmpfs→OPFS) are copy-then-unlink, not atomic across backends — documented limitation.

### 3.4 API & Interface Design

**Kernel ⇄ Host control API** (TypeScript-facing):

```text
kernel.spawn({ image, args, env, caps }) -> Promise<Pid>
kernel.kill(pid, signal) -> Result
kernel.wait(pid) -> Promise<{ exitCode }>
kernel.list() -> ProcessInfo[]            // backs ps/top (FR-33)
kernel.grant(pid, capability) -> Result
kernel.revoke(pid, capability) -> Result
kernel.mount(path, backend) -> Result
kernel.on('ready'|'panic'|'proc:exit'|'cap:deny', handler)
```

**Process ⇄ Kernel syscall surface** = **WASI Preview 1** baseline imports (`wasi_snapshot_preview1`): `fd_read, fd_write, fd_seek, fd_close, path_open, fd_readdir, clock_time_get, random_get, args_get, environ_get, poll_oneoff, proc_exit`, plus a **kernel-extension namespace** `wasmos_kernel` for OS-specific calls not in WASI p1:

```text
wasmos_kernel.spawn(image_ptr, len, argv, caps_ptr) -> pid
wasmos_kernel.chan_open(name_ptr, len) -> fd
wasmos_kernel.shm_map(cap_id) -> (ptr, len)
wasmos_kernel.win_surface(kind) -> surface_id   // request a compositor surface
wasmos_kernel.net_request(cap_id, req_ptr) -> handle   // brokered fetch/WS
```

**Forward target (WASI p2 / Component Model):** the same capabilities expressed as typed imported interfaces (`wasi:filesystem`, `wasi:sockets`, `wasi:cli`, plus a custom `wasmos:kernel` world), so capability enforcement is carried by the component type system (FR-13, §3.7).

**Transports:** Tier A — SAB ring buffer with an Atomics-signaled request/response protocol (binary, length-prefixed). Tier B — `postMessage` with structured clone, async.

#### 3.4.1 Binding Generation — the Centralized Binder

A polyglot OS has many binding boundaries — guest processes in 5 languages (Rust, C, Zig, AssemblyScript, WAT), the Rust→WASM kernel, the TS host, and two transports (SAB ring / postMessage). Hand-writing the glue is an `N languages × M interfaces × 2 transports` explosion that *will* drift out of sync (change a syscall, forget to update the Zig stubs, guest silently misaligns the ABI). WASM_OS therefore treats binding glue as **generated from a single source of truth**, never hand-authored per boundary.

**Single source of truth — `wit/`.** Every boundary is declared once in **WIT** (WebAssembly Interface Types, the Component-Model IDL). Upstream `wasi:*` WIT packages are reused, not redefined. WASM_OS defines three worlds:

| World | Boundary | Consumers |
|-------|----------|-----------|
| `wasmos:kernel` | guest process ⇄ kernel syscall surface (`wasmos_kernel` extension + curated `wasi:*` subset) | every process language + the kernel (export side) |
| `wasmos:control` | host ⇄ kernel control API (`spawn/kill/wait/list/grant/revoke/mount`) | TS host + kernel |
| `wasmos:brokers` | kernel ⇄ host device brokers (net/clock/entropy/input/gpu) | TS host + kernel |

The `wit/` tree is authoritative. No component talks to another via hand-written marshalling.

**Generator — `tools/binder` (one command: `binder gen`).** Wraps existing codegen and supplies the gaps for targets that lack upstream support:

| Target | Tooling | Generated output |
|--------|---------|------------------|
| Rust guest stubs | `wit-bindgen` (Rust) | `crates/wasmos-sys` — typed syscalls for Rust processes |
| C / Zig guest stubs | `wit-bindgen` (C) | headers + stub lib consumed by wasi-sdk builds |
| Kernel host side | `wit-bindgen` (Rust, export) | the `WasmosKernel` trait the kernel **implements** |
| TS host bindings | `jco` + type emit | `packages/abi` — typed control/broker calls + lift/lower |
| AssemblyScript | custom thin emitter (no upstream target) | generated AS binding module |
| WAT | custom emitter + validator | canonical import-signature `.wat` block + a conformance check for hand-written `.wat` |

**Preview 1 ↔ Preview 2 bridge (partially resolves OQ-1).** Interfaces are authored in WIT (p2's language), but p1 remains the runtime breadth baseline. For p1-target guests, the binder links the standard `wasi_snapshot_preview1` adapter and emits p1 import shims for the `wasmos_kernel` extension **from the same WIT** — so the p1 and p2 surfaces are two renderings of one definition, never a fork.

**Transport-neutral ABI — the centralized payoff.** Generated stubs never reference SAB or `postMessage`. They target an abstract `Transport` (lower args → bytes → signal → lift result); the canonical lift/lower is generated **once**, and the two transport implementations (SAB ring = Tier A, `postMessage` = Tier B) plug in beneath it. This collapses `N×M×2` to "generated once per language, two transports written by hand, total."

**Drift gate — `binder check` (CI).** The WIT worlds carry a version tag. `binder check` regenerates into a temp dir and diffs against the committed generated output, failing the build on any mismatch. Generated artifacts are committed (for reviewability) but treated as derived — edited only by regenerating. This makes ABI drift a hard CI failure rather than a silent runtime corruption.

```text
                 wit/  (wasmos:kernel · wasmos:control · wasmos:brokers + wasi:*)
                   │  single source of truth
                   ▼
         tools/binder gen  (wit-bindgen · jco · custom AS/WAT emitters)
   ┌──────────┬──────────┬───────────┬───────────┬──────────┬──────────┐
   ▼          ▼          ▼           ▼           ▼          ▼
 crates/    C/Zig      AS module   WAT import   crates/    packages/
 wasmos-sys headers    bindings    block+check  kernel     abi (TS host)
 (Rust gst) (gst)      (gst)       (gst)        (impl trait)(control+brokers)
   └────────────── all lower/lift through one abstract Transport ──────────────┘
                         │                              │
                    SAB ring (Tier A)            postMessage (Tier B)
                   ────────────── binder check (CI drift gate) ──────────────
```

This component is owned by **Build & Tooling** (§3.2) and is a hard dependency of M1 (the first process needs generated guest + kernel bindings to exist).

### 3.5 Data Flow

**Workflow A — Shell runs a piped WASI pipeline `cat log | grep err` (traces FR-15..18, FR-9, FR-4):**

```text
1. Terminal keystrokes → host → shell process stdin (fd 0).
2. Shell parses pipeline; calls wasmos_kernel.spawn(cat), spawn(grep);
   kernel creates 2 processes + a pipe (IPC) wiring cat.stdout → grep.stdin.
3. Kernel grants each a FsPath cap for the cwd subtree only.
4. cat issues WASI fd_read on "log" → syscall router → VFS (OPFS) → bytes.
5. cat fd_write → pipe ring buffer; scheduler wakes grep (blocked on read).
6. grep fd_write matches → host renders to terminal (shell.stdout).
7. Both proc_exit; kernel reaps, returns exit codes to shell; prompt returns.
```

**Workflow B — Boot to desktop and open the file manager (traces FR-1, FR-21..24):**

```text
1. Loader checks COOP/COEP+SAB → Tier A; instantiates kernel → 'ready'.
2. Host starts compositor; spawns the desktop/session process.
3. User clicks Files → compositor calls kernel.spawn(filemanager, caps={FsPath:/, Input, Gpu}).
4. File manager requests win_surface(DOM) → compositor opens a window.
5. It lists / via WASI fd_readdir across mounts; double-click .wasm → spawn as app.
```

**Workflow C — Boot Linux in the emulator (traces FR-27, FR-28):**

```text
1. User launches "Linux"; kernel.spawn(emulator, caps={Gpu, Input, privileged-sched}).
2. Scheduler assigns a dedicated worker + run-to-budget policy (no fine preempt).
3. Emulator requests win_surface(canvas-framebuffer); compositor presents it.
4. Emulator fetches a kernel+initrd image (brokered net cap) and boots BusyBox.
5. Guest console renders into the framebuffer; other processes keep running,
   isolation (FR-6) preserved — the emulator cannot touch their memory.
```

### 3.6 Integration Points

- **Browser platform APIs:** `WebAssembly`, Web Workers, SharedArrayBuffer/Atomics, OPFS (`navigator.storage.getDirectory`), IndexedDB, Canvas/WebGL, `fetch`/WebSocket/WebTransport, (optional) JSPI.
- **Language toolchains** (build-time): Rust/cargo + wasm-pack, wasi-sdk (C/Zig), AssemblyScript, `wasm-tools`/`wabt`, WASI component tooling.
- **Terminal:** xterm.js (host) bound to shell fds.
- **Emulator core:** a third-party WASM CPU emulator + Linux kernel/initrd images (external assets fetched at runtime).
- **Optional server (not in run path):** app registry / remote-sync endpoint for FR-20/FR-35 — additive, behind a flag.

### 3.7 Security Architecture

- **Sandbox-in-sandbox:** each process is a WASM instance (browser-enforced memory safety) running in a Worker; the OS adds a capability layer on top so even sandboxed code gets *default-deny* access to FS/net/devices.
- **Capabilities are the only authority.** A process can touch a resource iff it holds a matching, unrevoked capability. Brokers (`net`, `gpu`, `input`, VFS) call `capStore.check(pid, cap)` on **every** request; denials are audited.
- **Granting is explicit and minimal.** `spawn` grants only the caps the parent passes and is itself authorized to delegate. The shell grants a child the cwd subtree, not all of `/`.
- **WASI p2 / Component Model as enforcement substrate (forward).** Expressing host access as typed imported interfaces means a process *cannot even name* a capability it wasn't given — enforcement moves from runtime checks toward the type system.
- **Cross-origin isolation tradeoff.** COOP/COEP (needed for SAB) means all embedded subresources need CORP/CORS; untrusted third-party DOM/iframe embedding is restricted. The emulator and net broker fetch only CORP-compliant or proxied assets. (Risk R-4.)
- **Secrets:** none server-side in V1 (no server in run path). Any optional registry uses standard token auth, out of V1 scope.
- **Threat model summary** in Appendix D.

### 3.8 Resilience Design

- **Fault containment (FR-34):** a process trap is caught at the worker/instance boundary; the kernel marks it `zombie`, frees fds/caps/worker, emits an error event; kernel and peers continue.
- **Kernel panic:** the loader supervises; on panic it reboots the kernel to ready (< 2 s) with the VFS intact (VFS state lives in OPFS/IndexedDB, not kernel memory).
- **Backpressure:** IPC ring buffers are bounded; a full buffer blocks the writer (Tier A via Atomics, Tier B via async await) rather than growing unbounded.
- **VFS durability:** writes to `/home` are flushed/committed before acknowledgment; an interrupted multi-step op is recoverable to a consistent state per-backend.
- **Emulator isolation:** the privileged emulator gets CPU budget but no capability to other processes' memory; a runaway emulator is killable like any process.
- **Caching:** kernel and core binaries are cache-first (service worker) for warm boot and offline (FR-32).

### 3.9 Observability

- **Process/scheduler introspection:** `kernel.list()` powers a `ps`/`top` view (FR-33): per-process state, CPU time, memory pages, held capabilities.
- **Capability audit log:** in-memory, inspectable, records grant/revoke/allow/deny with pid+cap+timestamp (supports research goal and security review).
- **Kernel tracing:** a ring-buffered event log (spawn, exit, syscall classes, panics) viewable in a dev panel; toggleable verbosity.
- **Performance counters:** boot time, spawn latency histogram, syscall overhead, frame rate — surfaced in a dev HUD and emitted to the bench harness in `tools/`.
- **No external telemetry by default** (privacy; FR-32).

### 3.10 Infrastructure & Deployment

- **Hosting:** static assets (HTML/JS/WASM) on any host that can set **COOP/COEP** headers (e.g. a CDN/static host or a tiny header-setting edge). Railway/Netlify/Cloudflare-class static hosting is sufficient.
- **Build:** multi-toolchain pipeline in `tools/` producing the kernel `.wasm`, the userland binaries (multiple languages), and packed app images; a single `build all` orchestrator.
- **Environments:** `dev` (local server with COOP/COEP + HMR), `preview` (per-branch static deploy), `prod` (CDN static).
- **Deployment strategy:** atomic static deploys with cache-busting hashes; service worker controls warm-cache rollover; rollback = redeploy previous immutable build.
- **CI:** build all toolchains, run unit + integration + the WASI conformance subset + fault-injection + bench-regression gate on every PR.

---

## 4. Implementation Plan

### 4.1 Build Phases

Phases map 1:1 to layers and to milestones (§5). **V1 = end of Phase 2 (the interactive terminal).** The remaining requested marquee moments are delivered in Phases 3–5.

#### Phase 0 — Kernel & VFS skeleton (M0)

- **Goal:** A booting microkernel with a process table, scheduler, syscall router stub, and a working VFS (tmpfs + OPFS + IndexedDB), but no real processes yet.
- **Scope:** FR-1, FR-2, FR-3 (scheduler scaffold), FR-30, FR-32; Tier-detection in the loader.
- **Exit criteria:** Page boots to `ready` < 1.5 s; a host test can create/read/list files across all three VFS backends and they persist across reload.

#### Phase 1 — First WASI process (M1)

- **Goal:** Run one real `wasm32-wasi` Rust binary as a process under the scheduler, via the SAB syscall ring.
- **Scope:** FR-4, FR-5, FR-9, FR-6 (isolation), Tier-A transport; minimal `proc_exit`/`fd_write` to a captured stdout.
- **Exit criteria:** `hello.wasm` (Rust) spawns, writes to stdout, exits with code 0; a second concurrent process proves isolation (cannot read peer memory).

#### Phase 2 — Userland & terminal  →  **V1 / Marquee "terminal runs real WASI binaries"** (M2)

- **Goal:** A real interactive shell running WASI coreutils with pipes and redirection.
- **Scope:** FR-9..12, FR-14, FR-15..18, FR-34; coreutils built from ≥2 languages (Rust + C/Zig) to prove polyglot.
- **Exit criteria:** From the terminal, a user runs `ls`, `cat`, a pipeline `cat f | grep x`, and a redirect `... > out`, with correct output and exit codes; a deliberately crashing binary terminates without taking down the shell.

#### Phase 3 — Compositor & desktop  →  **Marquee "boot → desktop → run apps"** (M3)

- **Goal:** A windowed desktop where multiple WASM apps run in windows with a file manager.
- **Scope:** FR-21..26, FR-23 (DOM + canvas surfaces), FR-25.
- **Exit criteria:** Boot to desktop; open file manager + terminal + one graphical app concurrently in windows; move/resize/focus work; launch a `.wasm` from the file manager.

#### Phase 4 — Multi-process, IPC, persistence  →  **Marquee "it's really an OS"** (M4)

- **Goal:** Many processes scheduled concurrently, communicating via IPC, with state surviving reload; live `ps`/`top`.
- **Scope:** FR-3 at scale (≥32), IPC channels/shm, FR-33, FR-35 (snapshot, COULD), FR-7 signals.
- **Exit criteria:** 32 concurrent processes sustained within main-thread budget; two processes exchange messages via a channel; `/home` state + open session survive reload (snapshot if implemented); `top` shows live scheduler state.

#### Phase 5 — Emulator as a privileged process  →  **Marquee "Linux in a tab"** (M5)

- **Goal:** Boot a real Linux/BusyBox in a window via a WASM emulator process without breaking isolation or the scheduler.
- **Scope:** FR-27, FR-28, FR-29 (COULD).
- **Exit criteria:** Launch "Linux"; it boots to a shell in a framebuffer window; other WASM_OS processes keep running and remain isolated; the emulator is killable from `top`.

### 4.2 Testing Strategy

- **Unit:** Rust kernel logic (scheduler ordering, capability check matrix, VFS ops) via `cargo test`; TS host units via Vitest.
- **WASI conformance subset:** a curated suite asserting the kernel's `wasi_snapshot_preview1` surface behaves per spec for the syscalls we implement.
- **Integration:** headless-browser (Playwright) tests that boot the real OS and drive real flows (spawn, pipeline, FS persistence) against real OPFS/IndexedDB — **no mocked kernel** (honors the project's E2E definition).
- **E2E (true, per global rule):** Playwright drives the actual UI: boot → terminal → run pipeline → open desktop window → reload → verify `/home` persisted. Every layer the user touches runs for real.
- **Fault injection:** force process traps, full IPC buffers, kernel panic; assert containment (FR-34) and recovery NFRs.
- **Load/bench:** spawn-N harness and frame-rate harness in `tools/`; results gate CI against regression thresholds (§2.2).
- **Security:** capability-escape tests (a process with no FS cap must fail every FS path), cross-process memory-read attempts, COOP/COEP presence check.

### 4.3 Rollout Strategy

- **Tier feature-flagging:** ship Tier A (SAB) and Tier B (cooperative/Asyncify/JSPI) behind runtime detection; allow forcing a tier via URL param for testing.
- **Per-layer enablement:** layers ship behind capability flags so M0–M2 can be released and dogfooded before M3+ exists.
- **Static immutable deploys** with hashed assets; service-worker cache rollover; rollback = re-point to previous build.
- **Canary:** preview deploys per branch; a "dev HUD" build exposes observability for internal testing before promoting to prod.

### 4.4 Operational Readiness

Before a milestone is "production"/publicly demoable:

- Boot succeeds on both execution tiers on the target browser matrix.
- Observability HUD (`top`, audit log, perf counters) is functional.
- Fault-injection suite green; recovery NFR met.
- Offline (service-worker) boot verified.
- A short runbook exists for: "kernel won't boot," "OPFS unavailable," "SAB unavailable / wrong headers," "emulator image fetch fails" (Appendix H).

---

## 5. Milestones

| Milestone | Goal | Exit Criteria | Target Date | Owner |
|-----------|------|---------------|-------------|-------|
| **M0** Kernel & VFS skeleton | Boot to `ready`; tri-backend VFS | Boot <1.5s; files persist across reload on OPFS+IDB+tmpfs | TBD (seq. by dep) | TBD |
| **M1** First WASI process | One Rust WASI binary runs under scheduler | `hello.wasm` runs/exits 0; 2nd proc proves memory isolation | TBD | TBD |
| **M2 — V1** Userland & terminal | Shell + polyglot coreutils + pipes | `ls`, `cat f\|grep x`, `>` redirect work; crash contained | TBD | TBD |
| **M3** Compositor & desktop | Windowed desktop + file manager | 3 apps in windows; move/resize/focus; launch .wasm from FM | TBD | TBD |
| **M4** Multi-proc + IPC + persist | 32 procs, channels, live `top`, reload survives | 32 concurrent; channel message exchange; state survives reload | TBD | TBD |
| **M5** Emulator process | Boot real Linux in a window | Linux boots to shell; peers isolated & running; killable | TBD | TBD |

**Marquee-moment mapping:** "terminal runs WASI binaries" → **M2 (=V1)**; "boot→desktop→apps" → M3; "really an OS / multi-proc+IPC+persist" → M4; "Linux in a tab" → M5. All four requested moments are delivered — sequenced, not simultaneous.

### Dependency Graph

```text
M0 (kernel + VFS)
   │
   ▼
M1 (first WASI process)
   │
   ▼
M2 (userland + terminal)  ◄── V1 release line
   │
   ├──────────────► M3 (compositor + desktop)
   │                      │
   ▼                      ▼
M4 (multi-proc + IPC + persistence)   ──► (needs M3 surfaces for windowed top/apps)
   │
   ▼
M5 (emulator as privileged process)   ──► (needs M3 canvas surface + M4 scheduling at scale)
```

---

## 6. Success Criteria

### 6.1 Launch Metrics

| Metric | Target [PROPOSED] | Measurement Method |
|--------|--------|--------------------|
| V1 (M2) reachable in target browsers | Boot→terminal works in latest Chrome + Firefox (Tier A) and Safari (Tier B) | Playwright matrix run |
| Polyglot proof | ≥ 2 source languages produce running coreutils | CI builds Rust + C/Zig binaries, both pass shell integration tests |
| Process isolation | 100% of cross-process memory-read attempts fail | Security suite |
| Boot performance | Meets §2.2 cold/warm targets on reference machine | Bench harness in CI |
| Crash containment | 0 kernel crashes from process traps over fault-injection suite | Fault-injection CI gate |
| "It's really an OS" (M4) | 32 concurrent procs + IPC + reload-survival demoable | E2E scenario recording |

### 6.2 Ongoing Monitoring

- **Dev HUD** (every build): live `top`, capability audit log, perf counters (boot, spawn p95, syscall overhead, fps).
- **CI dashboards:** per-PR bench results vs. thresholds; conformance + fault-injection pass rates; per-browser E2E matrix.
- **Review cadence [PROPOSED]:** per-milestone exit review; weekly bench-trend check while a phase is active.

### 6.3 Remediation Triggers

| Trigger | Action |
|---------|--------|
| Any process trap crashes the kernel (FR-34 violation) | Block release; treat as P0 |
| Boot time regresses > 25% vs. last green | Bench gate fails PR; investigate before merge |
| Spawn p95 > 2× target | Performance investigation milestone |
| A capability-escape test passes (isolation broken) | P0 security stop-ship + regression test (per global rule) |
| OPFS write loss detected | P0 durability stop-ship |

---

## 7. Risks

| ID | Risk | Impact | Likelihood | Mitigation | Contingency |
|----|------|--------|-----------|------------|-------------|
| R-1 | **Cooperative (Tier B) fallback is not transparent** — no SAB means async syscalls via Asyncify/JSPI, imposing guest build requirements | High | High | Treat Tier B as a distinct, documented compatibility tier; ship Asyncify-instrumented guest builds; detect & message clearly; target JSPI as it matures | Restrict V1 "full" experience to Tier A browsers; Tier B = reduced feature set |
| R-2 | **Polyglot fidelity uneven** — AssemblyScript/WAT WASI support is thinner than Rust/C/Zig | Medium | High | Anchor the polyglot *proof* on Rust + C/Zig (FR-14); treat AS/WAT as SHOULD/COULD with documented ABI shims | Demote AS/WAT to "supported with caveats"; keep the ABI-level claim, scope the practical claim |
| R-3 | **Scope is enormous (5 layers).** Risk of half-finished layers and a non-shippable whole | High | High | Each layer is an independently demoable milestone with hard exit criteria; **V1 is defined as M2**, not "everything" | Ship at M2/M3 as legitimate releases; M4/M5 are stretch |
| R-4 | **Cross-origin isolation tax** — COOP/COEP (for SAB) breaks easy embedding of third-party content & complicates emulator image fetch | Medium | Medium | Serve all assets CORP-compliant or proxied; document hosting header requirement as a hard constraint | Provide a same-origin asset bundle; proxy external emulator images |
| R-5 | **OPFS variance / sync-handle limits** across browsers (esp. Safari) | Medium | Medium | Layered VFS with IndexedDB fallback; abstract backend behind one interface; capability-detect at boot | Run Safari on IDB-only `/home` with a perf caveat |
| R-6 | **Emulator process undermines isolation/scheduling assumptions** (wants to run flat-out, large memory) | Medium | Medium | Special-cased privileged scheduling (FR-28) in a dedicated worker; still capability-bounded; killable | Cap emulator memory/CPU budget; make it an explicitly opt-in heavy app |
| R-7 | **WASI Preview 1 vs 2 split** forces rework if chosen wrong | Medium | Medium | p1 as ABI baseline now, p2/components as the capability/security layer & forward target (Assumption 8) | Maintain a thin adapter so the kernel syscall router can serve both surfaces |
| R-8 | **Single-builder bandwidth** vs. 5-layer scope, no fixed timeline | High | Medium | Dependency-sequenced milestones; ruthless MoSCoW; each layer usable alone | Pause at any completed milestone as a coherent release |

---

## 8. Open Questions

| # | Question | Owner | Due Date |
|---|----------|-------|----------|
| OQ-1 | WASI baseline: confirm **Preview 1 as process ABI + Preview 2/Component Model as capability layer** (Assumption 8). Or go p2-first and accept narrower language support? | Ryan O'Boyle | Before M1 |
| OQ-2 | Networking model for processes: brokered `fetch`/WS/WebTransport capability only (Assumption 9), or invest in a WASI-sockets shim? | Ryan O'Boyle | Before M3 |
| OQ-3 | Target browser matrix: confirm Chrome+Firefox (Tier A) + Safari (Tier B) (Assumption 10). Any mobile target? | Ryan O'Boyle | Before M2 |
| OQ-4 | Confirm/replace the **[PROPOSED]** NFR numeric targets in §2.2 (boot, spawn p95, syscall overhead, concurrency, fps) with owned values | Ryan O'Boyle | Before M2 exit review |
| OQ-5 | Is the optional app-registry / remote-sync server in scope at all, or strictly post-V1? (Affects FR-20, FR-35, compliance) | Ryan O'Boyle | Before M4 |
| OQ-6 | Which emulator core for L4 (v86-class x86 vs a RISC-V core) and which Linux/initrd image? Licensing of bundled image? | Ryan O'Boyle | Before M5 |
| OQ-7 | Scheduler policy specifics: confirm priority round-robin + time accounting; is any determinism guarantee required for the research goal? | Ryan O'Boyle | Before M1 |
| OQ-8 | Timeline & ownership: solo vs. contributors; do milestones get target dates, or stay dependency-only? | Ryan O'Boyle | Open |

---

## Appendices

### Appendix A — Glossary

| Term | Meaning |
|------|---------|
| **WASM / WebAssembly** | Portable binary instruction format; the "CPU/VM" WASM_OS targets as its hardware. |
| **WAT** | WebAssembly Text format — human-readable WASM; one of the polyglot process source forms. |
| **WASI** | WebAssembly System Interface — the standardized syscall ABI; WASM_OS's process interface. |
| **Preview 1 / Preview 2** | WASI generations; p1 is the stable function-import ABI, p2 is interface-typed via the Component Model. |
| **Component Model** | WASM standard for typed, composable modules with interface imports/exports; basis for capability typing. |
| **Capability** | An unforgeable token granting a process access to a specific resource (a FS subtree, the net broker, etc.). |
| **OPFS** | Origin Private File System — fast, origin-scoped browser file storage; backs `/home`. |
| **SAB / Atomics** | SharedArrayBuffer + Atomics — shared memory + synchronization enabling Tier-A blocking syscalls. |
| **COOP/COEP** | HTTP headers enabling cross-origin isolation, prerequisite for SAB. |
| **Asyncify / JSPI** | Techniques to make blocking calls work without SAB (build-time transform / JS Promise Integration). |
| **Tier A / Tier B** | Primary SAB execution tier vs. constrained cooperative fallback tier. |
| **Compositor** | The host component that manages windows and presents DOM/canvas surfaces (Layer 3). |
| **VFS** | Virtual filesystem unifying tmpfs/OPFS/IndexedDB under one POSIX-like tree. |

### Appendix B — API Contracts (summary)

See §3.4. Two surfaces: (1) **Kernel⇄Host control API** (TS) — `spawn/kill/wait/list/grant/revoke/mount/on`. (2) **Process⇄Kernel syscall surface** — WASI `wasi_snapshot_preview1` baseline + `wasmos_kernel` extension namespace (`spawn/chan_open/shm_map/win_surface/net_request`), with the WASI p2 `wasmos:kernel` world as the forward target. Full IDL/witx to be produced at M1 (tracked OQ-1).

### Appendix C — Data Migration Plan

V1 has no server and no prior data, so there is no inbound migration. Forward-compat concern: the **on-disk VFS layout in OPFS/IndexedDB** is the only persisted artifact. Mitigation — version the VFS superblock (`vfs_version`) and write a migration step on boot when the version lags. Snapshot format (FR-35), if built, must also carry a version tag.

### Appendix D — Security Threat Model (summary)

| Asset | Threat | Mitigation |
|-------|--------|------------|
| Other processes' memory | Malicious process reads/writes peer memory | WASM instance isolation + IPC-only sharing via explicit shm capability (FR-6) |
| User files (`/home`) | Untrusted app exfiltrates/destroys files | Default-deny FS; path-subtree capabilities; granular rights |
| Host/browser | Process escapes sandbox to host APIs | All host access via capability-checked brokers; no ambient authority |
| The OS page itself | Cross-origin attacker embeds/abuses it | COOP/COEP isolation; CORP on assets; no third-party untrusted embedding |
| Capability system | Forged/escalated capabilities | Capabilities unforgeable kernel refs; grants only by authorized holder; immediate revoke; audited |
| Emulator process | Heavy/hostile guest affects host OS | Privileged but still capability-bounded, memory/CPU-budgeted, killable (R-6) |

STRIDE pass and per-broker review scheduled at M2 (terminal opens the first untrusted-binary surface).

### Appendix E — Capacity Model

- **Per process:** WASM linear memory budget [PROPOSED] default 16 MB, configurable per image; one Worker (Tier A).
- **Workers:** Tier A uses worker-per-process up to a [PROPOSED] cap (e.g. 64), beyond which a worker pool multiplexes (forward design).
- **VFS:** `/home` target ≥ 500 MB (OPFS), individual files ≤ 64 MB streamed; IndexedDB fallback lower per-browser quotas.
- **Emulator:** [PROPOSED] guest RAM budget 128–512 MB depending on host memory detection.
- **Scheduling budget:** main thread kept < 50% busy at 32 processes; emulator confined to its own worker.

### Appendix F — Cost Model

Running cost is ~$0 in compute: the OS executes entirely on the user's device from static assets. Costs are limited to **static hosting/CDN bandwidth** (kernel + binaries + optional emulator images, possibly tens of MB) and, *only if* the optional registry/remote-sync server (OQ-5) is built, a small backend + storage. No per-user server compute in the core design.

### Appendix G — Decision Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| D-1 | Deliver all four archetypes as **five layers of one system**, not separate apps | Only coherent way to honor "all of the above"; layers compose naturally | 2026-05-30 |
| D-2 | Emulator is **one privileged process**, not the foundation | Keeps WASM_OS WASM-native; folds "Linux in a tab" in cleanly | 2026-05-30 |
| D-3 | **Rust→WASM kernel + TS host**, polyglot WASI processes | Matches repo layout (`crates/`+`packages/`); safety + ecosystem | 2026-05-30 |
| D-4 | **SAB+Atomics primary tier**, cooperative as constrained fallback | True multi-process behavior; fallback honestly scoped (R-1) | 2026-05-30 |
| D-5 | **OPFS primary + IndexedDB fallback** layered VFS | Best perf where available, broad compatibility everywhere | 2026-05-30 |
| D-6 | **Hybrid DOM + canvas** compositor surfaces | Serves both web-native apps and graphical/emulator framebuffers | 2026-05-30 |
| D-7 | **V1 = M2 (terminal)**; other marquee moments → M3/M4/M5 | Makes "all of it" a sequenced deliverable, not a fantasy single release | 2026-05-30 |
| D-8 | **WASI p1 ABI baseline + p2/components as capability layer** [PROPOSED] | Max language breadth now; capability typing as it matures (OQ-1) | 2026-05-30 |
| D-9 | **Centralized Binder** — all bindings generated from one `wit/` source via `tools/binder`, transport-neutral ABI, CI drift gate (FR-36, §3.4.1) | Avoids the N-langs × M-interfaces × 2-transports hand-coding explosion and silent ABI drift in a polyglot OS | 2026-05-30 |

### Appendix H — Runbooks (V1 outline)

| Symptom | First checks | Resolution |
|---------|--------------|------------|
| Kernel won't boot | Console for instantiation error; tier-detection report | Verify COOP/COEP headers; fall back to Tier B; clear corrupt VFS superblock |
| SAB unavailable | Confirm COOP/COEP present and honored; check browser | Serve correct headers; otherwise run Tier B (cooperative) |
| OPFS unavailable | Capability report at boot | VFS auto-falls back to IndexedDB for `/home`; warn user of perf impact |
| Process won't spawn | Capability denial in audit log; image arch | Grant required caps; confirm `wasm32-wasi` target & ABI |
| Emulator image fetch fails | Network broker log; CORP/CORS on image host | Use same-origin/proxied image bundle (R-4) |
| `/home` data missing after reload | VFS version; backend in use | Run superblock migration; check quota eviction |

---

### Appendix I — Validation Checklist (Phase 4 of authoring)

- [x] Every section has real content (no empty sections)
- [x] All functional requirements are testable statements with MoSCoW priority (FR-1..35, FR-NG-1..6)
- [x] All non-functional requirements have measurable targets (numeric values marked **[PROPOSED]** pending OQ-4)
- [x] Architecture section includes diagrams (system overview, execution tiers, 3 data-flow traces, dependency graph)
- [x] Every component has a single responsibility (§3.2)
- [x] Data model covers all entities referenced in requirements (Process, Capability, VNode, Descriptor, IPC, Shm, Audit)
- [x] Security section addresses auth(=capabilities)/encryption(=origin isolation)/access control (§3.7, App D)
- [x] ≥ 3 risks identified with mitigations (8 risks, R-1..R-8)
- [x] Milestones have exit criteria (M0..M5)
- [x] Success metrics are measurable (§6)
- [x] Open questions have owners (OQ-1..OQ-8)
