# M2 Status — Userland & Terminal (V1)

**Status:** ✅ Complete — all five exit criteria met (verified 2026-05-31 via `npm run verify`, exit 0).

WASM_OS now boots to an **interactive xterm terminal bound to a real Rust shell
process**. The shell resolves programs from `/bin` over the hierarchical VFS,
wires them together with **kernel pipes**, redirects I/O to files, reports exit
codes, and survives crashes. Thirteen FR-18 coreutils run as isolated
`wasm32-wasip1` processes; **one (`echo`) is also built in Zig** and proven
byte-for-byte identical to its Rust sibling (FR-14). Every layer is real —
keystrokes → xterm → `control.stdin` → shell stdin (park/resume) → `wasmos_kernel`
spawn → child process → stdout streamed back to xterm. No mocks.

## Exit criteria

| # | Criterion | Verified by | Result |
|---|-----------|-------------|--------|
| 1 | Boot reaches an **interactive terminal** bound to a running Rust **shell**; typed chars echo and reach the shell's stdin | `e2e/terminal.spec.ts` (real keystrokes → `echo` output); `e2e/boot.spec.ts` listProcs shows `sh` | ✅ PASS |
| 2 | `ls`/`cat`; **`cat f \| grep x`** (real kernel pipe); **`echo hi > out`** then `cat out` (redirection); correct **exit codes** (`$?`) | `e2e/shell.spec.ts` (pipeline, redirect, `$?`=1); `e2e/coreutils.spec.ts` (mkdir+ls) | ✅ PASS |
| 3 | The **13 FR-18 coreutils** run from the terminal via `$PATH`; **≥1 built in Zig** (FR-14), observably identical to its Rust sibling | `e2e/coreutils.spec.ts` (cp/mv/rm, wc/head); `packages/host/test/polyglot-echo.test.ts` (node:wasi byte-diff, 6 cases); `e2e/terminal.spec.ts` (`echo.zig` live) | ✅ PASS |
| 4 | A deliberately-crashing binary from the shell — standalone **and in a pipeline** — terminates without taking down the shell/terminal (FR-34); the prompt returns | `e2e/crash.spec.ts` (standalone, `crash\|wc`, `cat\|crash`, + normal-pipeline prompt-return); kernel `proc_exit_of_writer/reader_*` regressions | ✅ PASS |
| 5 | `npm run verify` green **including** the M0/M1 regression suite, through the refactored VFS + streaming I/O | local `npm run verify` (exit 0) | ✅ PASS |

## Verify gate breakdown (latest local run — 2026-05-31)

```text
build         : kernel component (wasm32-unknown-unknown) + jco bindings regenerated
build:guests  : 17 Rust wasm32-wasip1 guests + 1 Zig wasm32-wasi guest (echo.zig)
binder        : kernel-check — wasmos-sys spawn/pipe/wait match wit/kernel.wit (FR-36)
lint          : clippy clean (-D warnings) on workspace + kernel wasm32-unknown-unknown
typecheck     : tsc -p packages/host/tsconfig.json --noEmit — clean
cargo test    : 69 passed; 0 failed
                (vfs ×13, types+fd-table, scheduler, kcore, syscall router incl.
                 pipes, park/resume, kspawn/kpipe/kwait, fs-mutation, crash-containment ×3)
vitest        : 14 passed (4 files) — features ×2, polyglot-echo ×6 (node:wasi),
                IdbBlockstore ×3, SAB ring ×3
playwright    : 21 passed — M0 (boot<1.5s, tri-backend persist across reload, fsDelete,
                real OPFS, real IDB), M1 (hello spawn, two-proc isolation, crash
                containment, catfile path_open+fd_read), M2 (terminal echo + Zig util,
                shell pipeline/redirect/$?, coreutils mkdir+ls/cp-mv-rm/wc-head,
                crash containment ×4)
```

## Architecture as built (M2 deltas over M1)

- **Park/resume syscalls.** A blocking syscall that can't complete returns
  `reply=None` (parked); the guest stays in `Atomics.wait`. A later event
  (stdin delivery, pipe write/read, child exit) returns the woken pids and the
  kworker re-drives them. Wakeups are processed as an **iterative, de-duplicated
  work-queue** so a pid woken twice in one drain bumps its `RESP_SEQ` exactly
  once (the M2 analog of the M1 ring race).
- **Hierarchical VFS** over the flat blockstores: real directories
  (`fd_readdir`, 24-byte WASI dirents), `path_filestat_get`, mkdir/rmdir/rename/
  unlink. M1 flat file keys migrate in place under a version stamp.
- **Kernel pipes** (`crates/kernel/src/pipe.rs`): bounded 64 KB buffers with
  reader/writer ref-counts; backpressure parks the writer, EOF on last-writer
  close, EPIPE on last-reader close — all through park/resume.
- **`wasmos_kernel` guest extension** (opcodes 0x20+ over the same ring):
  `spawn`/`pipe`/`wait`. Typed stubs in `crates/wasmos-sys`; the Binder
  `kernel-check` enforces stub/WIT conformance (FR-36). Guest-spawn
  choreography: the kernel allocates the child (PID/fds/caps), returns a
  `spawn` request, and the kworker reads the image from the VFS and instantiates
  it in its own non-shared-memory process worker.
- **Streaming terminal I/O** (`DescKind::Terminal`): a process's stdout/stderr
  stream to xterm as `term-output` messages; keystrokes flow back through
  `control.stdin` to the process's stdin buffer.

## As-built deviations & decisions

- **Zig `echo` installed as `/bin/echo.zig`** (a sibling, not a replacement for
  the Rust `echo`), so both run side by side and parity is directly observable.
  Parity is pinned two ways: a **node:wasi** host test byte-diffs the two
  binaries across 6 argument shapes, and `e2e/terminal.spec.ts` runs `echo.zig`
  live through the kernel.
- **`echo.zig` uses only long-stable Zig std APIs** (raw WASI syscalls +
  `page_allocator`, no `ArrayList`/`File`/`Io` churn). Verified to build on both
  the local **0.16.0-dev** toolchain and **0.14.1** (the version pinned in CI).
- **`crash` is installed in `/bin`** so the FR-34 crash-containment path is
  exercisable from the terminal. It is the M1 fault-injection guest
  (`std::process::abort` → wasm `unreachable`).
- **`proc_exit` releases the dying process's pipe ends** (added in M2-T11). This
  is load-bearing for FR-34 *and* for ordinary pipeline termination: without it
  the last stage parks forever waiting for an EOF that never comes. The regression
  was observed directly (pre-fix, `cat | grep` and `crash | wc` time out without
  returning the prompt) and is now covered by 3 kernel tests + 4 E2E cases.
- **Shell built-ins** (`cd`, `pwd`, `exit`, `$?`) run only as a standalone
  command (not inside a pipeline), matching the plan's scope.
- A trapped child surfaces as **exit code 134** (128 + SIGABRT); the shell prints
  `sh: <stage>: terminated abnormally (exit 134)` for any stage with code ≥ 128.

## CI

`.github/workflows/ci.yml` installs **Zig 0.14.1** (`mlugg/setup-zig`), builds
the Rust + Zig guests **before** host tests (so the polyglot byte-diff test has
its inputs), and keeps the clippy / typecheck / lint / rust-test / host-test /
e2e gates. The kernel bindings remain a build artifact (regenerated, not
byte-diffed) per the M1 rationale.
