# desktop compositor Status — Compositor & Desktop (webtop)

**Status:** ✅ Complete — current repository verification passed on 2026-08-22 via `npm run verify` (exit 0).

WASM_OS now boots to a **windowed desktop**. A host-side compositor manages real
windows (move / resize / focus / minimize / maximize + z-order) with a taskbar
(launcher + live clock); the shell and userland terminal runs in a window. The new substrate is
**process-owned graphical windows**: a WASI process requests a surface
(`win_surface`, Gpu-gated), draws into a shared framebuffer, and the compositor
blits it to a `<canvas>`; the focused window's keyboard/mouse are **brokered to
the owning process** (`win_read_input`, Input-gated). Seven process windows ship —
**Files**, **Paint**, **Editor**, **Mandelbrot**, **Monitor**, **Lisp**, and
**Welcome** — launchable from the taskbar or each other. One app (Mandelbrot) is authored in
**Zig** (FR-14). Mandelbrot starts from browser CSPRNG-seeded coordinates, pans with a
drag, zooms with `+`/`-`, and generates another seeded view with `N`/Space (`R`
reseeds). Theme + wallpaper persist to `/home`.

## Exit criteria

| # | Criterion | Verified by | Result |
|---|-----------|-------------|--------|
| 1 | Boot reaches a **desktop**: taskbar launcher + live clock; the terminal runs in a window | `e2e/desktop.spec.ts`, `e2e/m3-marquee.spec.ts` | ✅ PASS |
| 2 | **Window lifecycle** — open/close/focus/move/resize/min/max + z-order (FR-22) | `e2e/desktop.spec.ts` (5), `e2e/m3-marquee.spec.ts` (move+resize+focus) | ✅ PASS |
| 3 | **Both surface kinds** concurrently (FR-23): terminal (DOM) + canvas process windows | `e2e/surface.spec.ts`, `e2e/desktop-concurrency.spec.ts` | ✅ PASS |
| 4 | **File manager** (Rust process) browses the VFS and **launches a `.wasm`** (FR-24) | `e2e/filemanager.spec.ts` | ✅ PASS |
| 5 | **Three sophisticated graphical apps**, interactive via brokered input (FR-25); **≥1 in Zig** (FR-14) | `e2e/paint.spec.ts`, `e2e/editor.spec.ts`, `e2e/mandelbrot.spec.ts` (Zig) | ✅ PASS |
| 6 | **Terminal + FM + ≥1 app concurrent**; a crashing app is contained — its window closes, the desktop + shell survive (FR-34) | `e2e/desktop-concurrency.spec.ts` (3) | ✅ PASS |
| 7 | **Wallpaper + theme persist to `/home`** and survive reload (FR-26) | `e2e/theme.spec.ts`, `e2e/m3-marquee.spec.ts` | ✅ PASS |
| 8 | `npm run verify` green **including** the kernel, process, and shell regression suite under the compositor | local `npm run verify` (exit 0) | ✅ PASS |

## Verify gate breakdown (latest local run — 2026-08-22)

```text
build         : kernel component (wasm32-unknown-unknown) + jco bindings regenerated
build:guests  : 20 Rust wasm32-wasip1 guests (incl. filemanager/paint/editor/gfxspike)
                + 2 Zig wasm32-wasi guests (echo.zig, mandelbrot)
binder        : kernel-check — wasmos-sys signatures conform to wit/kernel/kernel.wit: spawn, pipe, wait,
                win-surface, win-present, win-read-input (FR-36)
lint          : clippy clean (-D warnings) on the whole workspace + kernel wasm target
typecheck     : tsc -p packages/host/tsconfig.json --noEmit — clean
cargo test    : workspace passed, including kernel, graphics SDK, and wasmobj tests
vitest        : 32 passed (8 files)
playwright    : 89 passed in the fast browser suite, including desktop windows,
                brokered input, the seven launcher apps, and terminal recovery

Input evidence: the real Chromium matrix sent all 32 named keys to each of the
seven launcher canvas guests (224 keydown events). All 224 were accepted by the
kernel and followed by a guest frame; 0 were dropped or missed. The matrix
records p50/p95/max input-to-paint latency from the browser keydown through the
surface blit, and requires p95 below 100 ms. The default-deny case separately
records one generated event, zero deliveries, and one drop for a process without
the `Input` capability.
```

## Architecture deltas introduced by desktop compositor

- **Compositor** (`packages/host/src/compositor/`) — host/TypeScript, main thread:
  `Window` chrome (titlebar drag, 8-way resize, min/max/close), z-order stack with
  a single focus authority, taskbar (launcher menu + per-window buttons + clock).
- **`win_surface`** (kernel opcode `0x23`, Gpu-gated): the kernel is the surface-id
  authority; the owning **process worker allocates the framebuffer `SharedArrayBuffer`**
  and the kworker routes it to the compositor.
- **`win_present`** is serviced **host-side in the process worker** (copies the guest
  framebuffer into the shared SAB + signals a frame) — **pixels never enter the
  kernel ring**; the compositor blits on `requestAnimationFrame` (coalesced).
- **Input brokering** (`win_read_input`, kernel opcode `0x25`, Input-gated):
  reuses the shell and userland park/resume machinery (`WaitReason::Input`, `deliver_input` ⟷
  `deliver_stdin`). A printable key carries its character code; named keys carry
  codes ≥ 0x100.
- **Capability delegation on spawn**: `k_spawn` grants a child `Gpu`/`Input` only
  if the parent holds them — so the file manager launches graphical apps that draw,
  while the shell delegates nothing to coreutils.
- **`wasmgfx`** guest SDK (`crates/wasmgfx`): software RGBA framebuffer + 8×8 font,
  shared by the Rust canvas apps.

## As-built deviations & decisions

- **`win_present` is a host-side import, not a kernel ring syscall** (per-frame
  performance + race-freedom): the framebuffer SAB is allocated by the worker that
  draws into it, sidestepping the "worker blocked in `Atomics.wait`" deadlock.
- **Large-file I/O fix (found via Paint's 512 KB save):** the SAB ring caps
  requests/responses at 64 KB. `fd_write`/`fd_read` now cap each call to one ring
  payload and report a **short** read/write; libc loops for the remainder (correct
  WASI semantics). Without it a large write silently wrote 0 bytes.
- **Single-click-to-open in the file manager** (not double-click): the app uses
  explicit click handling rather than timing a double-click. Clicking a folder
  navigates; clicking a file launches it.
- **Compositor focus blurs the terminal's xterm** when a canvas window is focused,
  so keystrokes route to the focused app via the input broker, not the shell.
- **`kill` = terminate the worker + record the exit** (host-initiated). The
  process-control layer also provides capability-gated SIGTERM/SIGKILL.
- **Apps are session-restored on reload** — the compositor persists window
  geometry and launcher identity in `/home/.session.json`.
- **Tier A only** (SAB); the framebuffer + input paths use the existing SAB
  substrate. Tier B is out of scope for desktop compositor.

## CI

`.github/workflows/ci.yml` already installs **Zig 0.14.1** (official archive,
sha256-pinned) and builds the Rust, Zig, and WAT guests before host tests; both Zig guests
(`echo.zig`, `mandelbrot.zig`) were verified to compile on 0.14.1. The new app
crates are workspace members, so clippy/`build:guests` cover them with no workflow
change. `test:rust` now also runs the `wasmgfx` unit tests.

## Current boundaries

Process control, IPC, signals, session restore, the network broker, and the Linux
guest are implemented in the later runtime layers. The compositor still presents
software RGBA framebuffers; WebGL acceleration and Tier B input/presentation are
not active paths.
