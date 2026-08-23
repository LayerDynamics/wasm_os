# Linux guest status — TinyEMU as a privileged process

**Status:** Complete — the fast gate passed on 2026-08-22 and the separate slow Linux
lane passed all eight workflows serially on 2026-08-22.

WASM_OS boots a real RISC-V Linux guest. Launch **Linux** from the taskbar and
TinyEMU runs the BusyBox/Buildroot image in a dedicated worker. The guest is
registered as one privileged `Native` process: it has a PID, appears in `ps` and
`top`, accepts brokered keyboard input, renders into a framebuffer window, can
be killed, and can be reopened with the desktop session. The host also exposes a
capability-gated `net_request` broker and a `fetch` utility to WASI guests.

## Exit criteria

| # | Criterion | Verified by | Result |
|---|---|---|---|
| 1 | Launch Linux and boot the RISC-V kernel to a shell in a window | `e2e/emulator-spike.spec.ts`, `e2e/emulator-process.spec.ts` | ✅ PASS |
| 2 | Keep regular processes running and isolated while Linux runs | `e2e/emulator-process.spec.ts`, `e2e/emulator-schedule.spec.ts` | ✅ PASS |
| 3 | Kill the Linux process and reap it without killing a peer | `e2e/emulator-schedule.spec.ts`, `e2e/emulator-process.spec.ts` | ✅ PASS |
| 4 | Send keyboard input to the guest shell and receive its output | `e2e/emulator-interactive.spec.ts` | ✅ PASS |
| 5 | Render the guest console through the existing canvas surface path | `e2e/emulator-window.spec.ts` | ✅ PASS |
| 6 | Broker a capability-gated network request for a WASI guest | `e2e/net.spec.ts`, kernel unit tests | ✅ PASS |
| 7 | Share files through the host's `/home/shared` and the guest's `/mnt` | `e2e/emulator-9p.spec.ts` | ✅ PASS |
| 8 | Reopen Linux after reload and preserve the shared folder | `e2e/emulator-session.spec.ts` | ✅ PASS |
| 9 | Keep the earlier kernel, process, shell, desktop, IPC, and persistence checks green | `npm run verify` plus the slow lane | ✅ PASS |

## Verification record (2026-08-22)

```text
build         : kernel component and generated bindings
build:guests  : Rust wasm32-wasip1 guests plus the Zig guests (the current command
                also builds the hand-authored WAT utility)
binder        : wasmos-sys signatures conform to wit/kernel/kernel.wit, including net_request
lint          : clippy clean on the workspace and kernel WASM target
typecheck     : host TypeScript clean
cargo test    : kernel, graphics SDK, and emulator/network lifecycle tests passed
vitest        : host tests passed
playwright    : 89 fast workflows passed; 8 slow Linux workflows passed with one
                worker (the TinyEMU lane is intentionally serialized to avoid
                starting several multi-megabyte emulators at once)
```

## Implementation details

- **TinyEMU core:** `third_party/tinyemu/` contains the MIT RISC-V emulator,
  built from the pinned source recipe. The guest bootloader, Linux kernel, and
  BusyBox/Buildroot root filesystem are documented in `assets/linux/README.md`.
- **Native process:** `crates/kernel/src/types.rs` distinguishes the emulator
  from WASI processes. `spawn_emulator` registers its PID; the host tracks the
  emulator worker separately from the syscall-ring workers.
- **Console rendering:** TinyEMU exposes the guest `hvc0` console to the worker.
  The worker converts text output into an RGBA framebuffer and reuses the normal
  compositor surface/present path.
- **Input:** the focused emulator window translates printable keys, Enter,
  Backspace, and arrows into guest console input.
- **CPU accounting:** the emulator worker reports periodic wall-clock budgets;
  `account_emulator` credits those budgets to the emulator PID so `top` can show
  activity even though the guest does not use the WASI syscall ring.
- **Network broker:** `net_request` parks a WASI caller, sends a request to the
  host, and `deliver_net` wakes the caller with the response. The `Net`
  capability is delegated to the `fetch` utility only from an authorized shell.
- **9p share:** TinyEMU mounts the `host9p` device at `/mnt`. The host seeds it
  from `/home/shared` after the attach event and mirrors guest writes back into
  the VFS.
- **Session restore:** the compositor records the Linux window and configuration
  in `/home/.session.json`; reload recreates the guest and restores the window.

## Decisions and limitations

- TinyEMU is MIT licensed. Its license, source version, and build recipe are in
  `third_party/tinyemu/README.md`.
- The framebuffer check asserts that a canvas renders non-blank output; it does
  not compare pixels.
- Reload recreates the Linux guest and restores its window and shared files. It
  does not snapshot live emulator memory.
- The runtime supports one emulator instance. It provides brokered `fetch`, not a
  complete WASI sockets implementation.
- The 9p share is seeded after the attach handshake because earlier seeding can
  race the guest mount. Paths returned by `fsList` are normalized to basenames
  before they are written to the guest share.

## CI

CI runs a normal fast browser suite and a separate slow suite for Linux boot. The
emulator core and Linux image are built from the repository's pinned recipes, and
the emulator worker and `fetch` utility are included in the normal build.
