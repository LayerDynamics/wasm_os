# WASM_OS app and terminal usability — current behavior

Date: 2026-08-23
Status: implemented

WASM_OS is a browser-hosted desktop where the terminal and graphical apps are
real WASI/WASM processes. This record describes the live paths that matter when
someone opens the desktop and starts typing; it is not a deployment log.

## Desktop entry points

The launcher registers these process-backed apps in
`packages/host/src/index.ts`:

- Welcome
- Files
- Paint
- Editor
- Monitor
- Lisp

Each launcher entry resolves to a guest image, starts a process, and gives the
process the capabilities needed for its surface and input. The terminal is a
separate DOM window backed by the shell process. The packaged React client
starts with the Welcome guide as the only visible window; the terminal is
minimized but remains available from the taskbar. Saved app windows wait until
the Welcome guide has been dismissed, so a new visitor sees the instructions
before the previous session is restored. Linux is an additional privileged
process entry, not a replacement for the WASI apps.

## Runtime entry points

These are the non-test callers that make the workspace artifacts usable:

| Code | Production entry point |
|---|---|
| `crates/sh` | `startDesktop` installs and starts `/usr/bin/sh`; the terminal stays bound to that process and respawns it after exit. |
| `crates/coreutils` | `startDesktop` installs all 21 binaries under `/usr/bin` and `/bin` (`kill`, `renice`, `ps`, `top`, and `mount` also under `/sbin`); the shell resolves them through `$PATH`. |
| `crates/apps/{welcome,filemanager,paint,editor,sysmon,lisp}` | `startDesktop` registers each app with the taskbar and session restore, then spawns it from its VFS path with its declared capabilities. |
| `crates/apps/nano` | The shell resolves `/usr/bin/nano`; nano takes the terminal into raw input mode and uses the shared document helpers. |
| `crates/hello`, `catfile`, `crash`, `spinner`, `chandemo`, `shmdemo`, `sigdemo` | Boot installs each executable in the VFS, so the shell and the file manager can start it. `shmdemo` self-spawns its reader; the channel demo is usable as two pipeline stages; the signal and spinner processes are observable through the System Monitor. |
| `crates/gfxspike` | Boot installs it as an executable WASM file; the file manager’s generic executable path starts it with `Gpu` and `Input`. |
| `guests/zig/*` and `guests/wat/watinfo.wat` | The build scripts emit artifacts into the same VFS loader: `echo.zig` and `watinfo` are shell commands. |
| `crates/wasmgfx`, `crates/wasmobj`, `crates/wasmos-sys` | These are libraries rather than standalone guests. The canvas apps import `wasmgfx`, Editor/File Manager/nano import `wasmobj`, and the shell, demos, and graphical apps import `wasmos-sys`. |
| `packages/host/src/worker/wasi-runtime.ts` | `process-worker.ts` constructs one runtime for every spawned WASI process; `packages/host/src/wasi.ts` and the package export expose the same runtime type to host embedders. |

## Input behavior

The compositor converts browser keyboard events into the kernel input event
format. Printable keys use Unicode code points. Named keys have stable
`KEY_*` values, including navigation, paging, insert, delete, function, lock,
pause, print-screen, and context-menu keys.

The terminal has two input modes:

- Cooked shell input edits a local line before submitting it to the shell. It
  supports insertion, Backspace, Delete, Home, End, left/right arrows, command
  history, Ctrl-A/E/U/W/C/D, Tab as four spaces, Escape sequences, and pasted
  text containing a newline.
- Raw input is forwarded unchanged to the foreground guest. Nano uses this
  path, so its own cursor movement, save prompts, and control keys remain under
  nano's control.

The editor consumes the brokered Home, End, Delete, and Tab keys directly. Tab
inserts four spaces; Home and End move within the current line. Files, Paint,
Monitor, Lisp, and the Linux console receive their respective
brokered input events through the same compositor path.

## Document path

The canvas Editor and nano share the document lifecycle in
`crates/wasmobj/src/wasi.rs`. A valid wasmobj is opened by extracting its
payload, a plain file is opened as bytes, and save writes a content-bearing
wasmobj when the destination is a `.wasm` path. This keeps the object format in
the live app path instead of maintaining separate editor and nano logic.

## Verification

The current local verification run completed on 2026-08-23:

```text
Binder generation/check: passed; 20 wasmos-sys stubs matched the WIT contract
Rust workspace tests: passed
Host tests: 32 passed
Fast browser workflows: 88 passed
Slow Linux browser workflows: 8 passed
```

The fast browser coverage includes launcher process creation, editor editing and
save, nano raw input, terminal history/navigation/paste/focus recovery, the
named-key matrix, and WAT reading `/proc/uptime` through WASI. The slow lane
boots and drives the real TinyEMU Linux guest, including its 9p shared folder,
serial console, process lifecycle, reload recovery, and framebuffer window.
These checks exercise the production entry points; the reachability claims above
come from the host registration and import paths in the source.

The named-key matrix sends all 32 stable named-key values to each of the six
launcher canvas guests: Welcome, Files, Paint, Editor, Monitor, and Lisp. That is
192 real browser keydown events. The run recorded 192 generated, 192
kernel-accepted, and 192 guest-rendered events, with 0 dropped, 0 missed,
and 0 pending. The measured input-to-paint results were:

| Guest | p50 | p95 | max |
|-------|-----|-----|-----|
| Welcome | 2.93 ms | 28.47 ms | 29.82 ms |
| Files | 4.41 ms | 8.99 ms | 9.87 ms |
| Paint | 4.13 ms | 7.90 ms | 8.45 ms |
| Editor | 3.92 ms | 9.73 ms | 10.61 ms |
| Monitor | 3.81 ms | 9.41 ms | 11.33 ms |
| Lisp | 6.04 ms | 13.49 ms | 14.30 ms |

The negative capability check is also real: a guest without `Input` generated
one event, accepted zero, and recorded one drop. `InputMetrics` keeps separate
generated, delivered, rendered, dropped, and missed counters and exposes p50,
p95, max, and rates through `window.__wasmos.inputMetrics`. The terminal E2E
also resets the same recorder, types a real `echo latency` command, waits for
the shell output, and asserts that keystroke-to-echo p50/p95/max exist, p95 is
below 100 ms, and dropped, missed, and pending counts are all zero.
The latest isolated terminal run measured 13 input samples at p50 31.36 ms,
p95 33.63 ms, and max 33.63 ms.

## Follow-up work

The remaining usability work is polish rather than a missing execution path:
the cooked line editor does not attempt full terminal emulation for wrapped
wide-character layouts, and the canvas apps still own their own editing and
display behavior. Those are bounded improvements to existing live paths.
