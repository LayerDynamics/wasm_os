# M5 Status — Emulator as a Privileged Process ("Linux in a tab")

**Status:** ✅ Complete — all nine exit criteria met (verified 2026-06-01 via the fast `npm run verify` + the slow boot lane, both green).

WASM_OS now boots a **real Linux**. Launch **"Linux"** from the taskbar and a v86
x86 emulator — integrated as a single **privileged `Native` process** — boots a
BusyBox/Buildroot kernel to an interactive shell inside a **framebuffer window**,
while every other WASM_OS process keeps running and stays isolated. The emulator is
a first-class PID: it appears in `proc_list`/`top`, accrues CPU via run-to-budget
accounting, takes **brokered keyboard input**, shares files with the host through a
**virtio-9p folder**, is **killable** from userland, and is **restored on reload**.
M5 also resolves **OQ-2** with a capability-gated **`net_request`** broker + a
`fetch` coreutil. This is L5 — the final layer of the spec.

## Exit criteria

| # | Criterion | Verified by | Result |
|---|-----------|-------------|--------|
| 1 | **Launch "Linux" → a real kernel boots to a shell** in a window (serial-asserted, FR-27) | `e2e/emulator-spike.spec.ts`, `e2e/emulator-process.spec.ts` | ✅ PASS |
| 2 | **Peers keep running + isolated** while Linux runs (FR-6/FR-28) | `e2e/emulator-process.spec.ts`, `e2e/emulator-schedule.spec.ts` | ✅ PASS |
| 3 | **Killable from `top`/userland** — reaped; peers survive (exit criteria) | `e2e/emulator-schedule.spec.ts` (`kill -9`), `e2e/emulator-process.spec.ts` | ✅ PASS |
| 4 | **Interactive guest shell** via brokered keystrokes (FR-27) | `e2e/emulator-interactive.spec.ts` (`$((6*7))`→42) | ✅ PASS |
| 5 | **Framebuffer window** renders the guest console (FR-23) | `e2e/emulator-window.spec.ts` | ✅ PASS |
| 6 | **`net_request`** brokered networking + `fetch` coreutil; default-deny (OQ-2) | `e2e/net.spec.ts`, kernel unit test | ✅ PASS |
| 7 | **virtio-9p shared folder** crosses files host↔guest (FR-29) | `e2e/emulator-9p.spec.ts` | ✅ PASS |
| 8 | **Linux restored after reload**; shared folder persists (FR-35 tie-in) | `e2e/emulator-session.spec.ts` | ✅ PASS |
| 9 | `npm run verify` green **including** the M0–M4 regression suite | local `npm run verify` (exit 0) + slow lane | ✅ PASS |

## Verify gate breakdown (latest local run — 2026-06-01)

```text
build         : kernel component (wasm32-unknown-unknown) + jco bindings regenerated
build:guests  : 31 Rust wasm32-wasip1 guests (adds the fetch coreutil) + 2 Zig
binder        : kernel-check — wasmos-sys conforms to kernel.wit, 19 verbs (adds
                net-request to the M4 set)
lint          : clippy clean (-D warnings) on the whole workspace + kernel wasm target
typecheck     : tsc -p packages/host/tsconfig.json --noEmit — clean
cargo test    : 94 passed (kernel 91 — adds the emulator Native-process lifecycle +
                net_request cap/park/deliver tests; wasmgfx 3)
vitest        : 14 passed
playwright    : fast lane 53 + slow lane 8 = 61 — M0–M4 regression + M5 (boot/process/
                interactive/window/schedule/net/9p/session/manifest)
```

## Architecture deltas introduced by M5

- **Emulator = v86 (x86), vendored under `third_party/v86/` (GPLv2)** + a BusyBox
  bzImage under `assets/linux/`, both stored via **git-lfs**. It runs in a dedicated
  **`emulator-worker`** (true parallelism — never stalls the main thread or other
  process workers).
- **A `Native` process kind** (`crates/kernel/src/types.rs`): the emulator is a
  first-class PID with a capability set (Gpu+Input+Net+FS), in `proc_list`/`top`,
  killable via the M4 signal/reap path — but **never pumped by the WASI ring** (it
  runs its own CPU loop). `spawn_emulator` registers it; the host tracks it in a
  separate `emulators` map so the wasi ring path is untouched.
- **Serial-first, framebuffer-second** (the spike's finding): the kernel boot log is
  on the VGA console; the userspace banner + shell are on **ttyS0**, which is what we
  capture + assert. The framebuffer window mirrors v86's text console
  (`screen-put-char`) into an OffscreenCanvas → a shared RGBA SAB → the **existing M3
  surface/present path** (the compositor opens a canvas window with no changes). The
  surface is locked to one window (transient boot mode changes don't spawn more).
- **Brokered input → guest**: the focused emulator window's keystrokes are translated
  (printable + Enter/Backspace/arrows → ANSI) and written to the guest's ttyS0.
- **Run-to-budget accounting (FR-28)**: the worker reports periodic wall-budget
  heartbeats; `account_emulator` credits the scheduler (only for the emulator pid) so
  its CPU shows in `top` despite making no syscalls.
- **`net_request` broker (OQ-2)**: a capability-gated syscall (`0x40`) that parks the
  caller (`WaitReason::NetReq`) and emits `SyscallOutcome.net` so the host performs
  the actual `fetch`, then `deliver_net` wakes the caller. The `Net` capability is
  delegated to a `fetch` coreutil exactly as `Signal` is to `kill`/`renice`.
- **virtio-9p shared folder (FR-29)**: v86's `filesystem:{}` 9p device (the buildroot
  image auto-mounts the `host9p` tag on `/mnt`); the host seeds it from `/home/shared`
  on the `9p-attach` event and mirrors guest writes back (`9p-write-end` → `read_file`
  → VFS).
- **Session restore (FR-35)**: the emulator is registered with the M4 SessionManager,
  so a running Linux is recorded in `/home/.session.json` and re-opened on reload; the
  9p share persists via OPFS-backed `/home`.

## As-built deviations & decisions

- **v86 is GPLv2** — bundling it makes those components copyleft. An explicit M5
  decision (`docs/plans/2026-06-01-...`); isolated under `third_party/v86/` with its
  license and a provenance README.
- **Verification is serial-text based, never pixel-exact** — the framebuffer window
  is exercised by "a canvas appears + renders (non-blank)", not pixel diffs.
- **FR-35 here is session/layout restore, not a freeze-dry of live wasm memory** (the
  latter is infeasible in-tab): Linux re-boots on reload and its shared files persist.
- **"Run the image from within it"** is delivered two ways: any image URL is bootable
  (v86 fetches it host-side), and `spawnEmulatorFromManifest` boots an image named by
  a small manifest fetched at runtime. (Multi-MB images can't traverse the 60 KB
  net-broker ring, so the broker is the *guest* networking capability, separate from
  the emulator's host-side image load.)
- **9p seeding races**: seeding before/during the 9p attach handshake gives EBUSY;
  seeding on `9p-attach` (post-mount) with an empty initial fs works. `fsList` returns
  full paths, so the 9p file name is the basename.

## CI

`.github/workflows/ci.yml` checks out with `lfs: true` (materializes the vendored v86
runtime + the Linux image) and runs **two E2E lanes**: the **fast lane**
(`--project=fast`, M0–M4 + light M5, seconds) and a separate **slow lane**
(`--project=slow`, the 8 Linux-boot tests, multi-second) so a slow boot can never
flake the fast suite. The new `fetch` coreutil + the emulator worker are picked up by
`build:guests`/`bundle` with no other workflow change.

## Deferred (per spec)

Tier B (Asyncify/JSPI), WASI p2 components (FR-13), a full WASI-sockets shim (beyond
the brokered `net_request`), multiple concurrent emulator instances, and a live-VM
memory snapshot. With M5, all five layers (L0–L5) of the spec are delivered.
