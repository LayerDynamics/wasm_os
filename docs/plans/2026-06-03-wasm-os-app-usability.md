# WASM_OS — make apps clearly run + be usable within the OS

Date: 2026-06-03

## Context

User reported the OS apps "can't run within the os," pointing at DevTools **Sources**
showing only the kernel wasm + one process-worker module.

**Deep-investigation verdict: the apps DO run as real processes and render.** Verified
empirically on the live deploy:

- Launching each app from the taskbar launcher (`☰ Apps`) spawns a process and renders:
  `Files, Paint, Editor, Mandelbrot, Monitor, Lisp` → pids 3-8, non-blank canvases.
- The Lisp REPL prints its banner; a screenshot shows 5 app windows open concurrently.
- The user's own `listProcs` dump listed `sysmon` + `linux` as **running** processes.

The DevTools Sources panel only lists wasm loaded by URL (`compileStreaming`, the kernel
cores) or compiled-and-running in a worker (hash-named, e.g. `00045d2e` = the shell).
Guests are fetched as bytes into the VFS `/bin` and compiled per-process on `exec`, so
they appear by hash and only while running — not a defect, but it reads as "missing."

The real defects were **usability / identifiability**, not execution.

## What was fixed (all committed to `main`, deployed to Railway)

1. **Keyboard focus on window re-activation** (`Win.onActivate`, commit `f52a92f`).
   Switching away and clicking back to the terminal left the xterm textarea blurred —
   the terminal looked active but was keyboard-dead. The compositor now re-focuses a
   DOM window's content on activation.
2. **Dead-shell recovery** (shell respawn watcher, commit `41bea31`). The shell could
   become an unreaped zombie (`exit` builtin / crash / sysmon kill); the terminal stayed
   bound to the corpse so typing echoed but Enter/Backspace did nothing. The host now
   polls process state and respawns + rebinds a fresh shell, keeping the terminal alive.
   The terminal window is no longer owned by the shell pid (so the shell exiting can't
   close it).
3. **App window titles** (commit `4a6d686`). Process-owned windows were titled
   `App (pid N)`. `SurfaceManager.titleFor` now resolves the launching app's label via
   `SessionManager.appForPid` → `Files`/`Editor`/`Lisp`/`Linux`.
4. **Tiled window placement** (commit `4a6d686`). New windows cascaded onto the same
   top-left origin, burying the terminal. `Compositor.open` now places an un-pinned
   window in the emptiest slot (least overlap with visible windows, preferring top-left,
   first free slot). Restored windows still pin their saved geometry.
5. **Editor forward-Delete** (`KEY_DELETE`, commit `f52a92f`).
6. **Boot speed** (parallel guest load + parallel persisted-store read, commit `7376407`)
   — 6.6× faster guest load under latency; boot-phase timing logged to the console.

## Verification

- Full fast e2e suite **63/63**; host unit tests **21/21**; typecheck clean.
- Red→green regression tests added for: terminal focus-restore, shell respawn, editor
  forward-Delete.
- Live screenshot proof of all apps running with named windows + tiled layout.

## Remaining / optional (not yet done)

- **DevTools observability** — give each compiled guest a `//# sourceURL` (or a named
  `WebAssembly.Module`) so it shows as `editor.wasm` in Sources instead of a hash. Purely
  cosmetic; would prevent the "only the kernel loaded" misread that started this.
- **Window placement polish** — current placement is greedy least-overlap; could add true
  tiling/snap zones if desired.
