# WASM_OS — shell and userland (Userland & Terminal — V1) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `lore:execute` to implement this plan task-by-task.
> **Scope guard:** Do ONLY what is listed here. This plan delivers SPEC-1 milestone **shell and userland = V1** (the "terminal runs real WASI binaries" marquee). It STOPS at shell and userland's exit criteria. Do NOT start desktop compositor (the windowed compositor/desktop), process control and IPC (IPC channels/shm at scale, snapshot, signals beyond crash-kill), or Linux guest integration (the emulator). If you discover adjacent issues, note them under **TODO / deferred** and continue.
> **Builds on:** WASI process runtime (first WASI process) — 100% complete and merged (`docs/M1-STATUS.md`). shell and userland extends the WASI process runtime kworker + SAB syscall ring + WASI p1 router; it does **not** rebuild them.

**Goal:** A real interactive terminal (xterm) bound to a **guest shell process** that runs WASI coreutils with pipelines and I/O redirection. From the terminal a user runs `ls`, `cat f`, `cat f | grep x`, and `... > out` with correct output and exit codes; a deliberately-crashing binary terminates without taking down the shell — SPEC-1 milestone **shell and userland** (Phase 2, §4.1).

**Traces:** FR-9..12 (run WASI modules), **FR-14** (polyglot: ≥1 Rust + ≥1 Zig coreutil, identical observable behavior), FR-15 (xterm bound to a shell process), FR-16 (`$PATH`, built-ins + on-disk binaries, exit codes), FR-17 (pipelines `a|b|c` + redirection `>`/`>>`/`<` via kernel pipes/fds), **FR-18** (the 13 coreutils), FR-34 (crash contained — terminal survives), FR-36 (the `wasmos:kernel` guest bindings come from the Binder).

---

## Decisions (confirmed 2026-05-31 via /lore:plan)

1. **Guest shell process** (spec-faithful, §3.4 + Workflow A). The shell is a real Rust `wasm32-wasip1` process that drives pipelines via a **new `wasmos_kernel` guest syscall extension** (`spawn`/`pipe`/`wait`/`dup2`). Cost is concentrated in this extension + the guest-spawn choreography + the Binder guest stubs — accepted.
2. **Zig** is the FR-14 second toolchain (`zig build-exe -target wasm32-wasi`; single self-contained toolchain, trivial in CI).
3. **Full FR-18 set** — all 13 coreutils (`ls cat echo cp mv rm mkdir pwd grep head tail wc env`), Rust, with ≥1 also built in Zig for the polyglot proof.

### Decided substrate (NOT user questions — load-bearing plan content)

- **Park/resume syscalls (the spine).** WASI process runtime's ring is request→*immediate* response. shell and userland introduces **deferred** responses: a not-ready blocking syscall (stdin read with no data, pipe read empty, pipe write full, `wait` on a live child) **parks** — the guest stays blocked in `Atomics.wait` while the kworker services other rings — and completes later when the event arrives. This one mechanism unifies stdin, pipes, and `wait`. Built and tested **first** (Task 1) because everything interactive depends on it.
- **Hierarchical VFS** replaces the kernel/VFS bootstrap/WASI process runtime flat-key store: a real in-memory directory tree (inodes) that loads from / flushes to the blockstore, with a **versioned superblock** and a **migration** that imports WASI process runtime's flat keys (the WASI process runtime persistence E2E MUST keep passing — no silent data break; Appendix C).
- **Pipes are kernel objects** (bounded byte buffer + wait-queue), built on park/resume.
- **Streaming I/O**: WASI process runtime's `take-capture` drains stdout *at exit*; a terminal needs bytes *while the process runs*. A separate main↔kworker **streaming channel** carries keystroke→stdin and stdout/stderr→xterm, distinct from the control RPC.
- **`wasmos:kernel` guest stubs are Binder-generated** from `wit/kernel.wit` (FR-36), with the drift gate; the process-worker shim provides the matching host-side imports.
- **`/bin` is populated at boot (load executables INTO the VFS).** Coreutils + the shell are built to served `.wasm` assets, but `$PATH` resolution and `wasmos_kernel.spawn(image-path)` read the image **from the kernel VFS** — so the binaries must be loaded into the VFS, not merely fetchable. A **boot-time `/bin` loader** fetches each served `/<name>.wasm` and `control.fsWrite("/bin/<name>", bytes)`. **`/bin` lives in tmpfs and is repopulated every boot** — ephemeral, which deliberately sidesteps any interaction with the OPFS/IDB persistence + flat→hierarchical migration (only `/home` and `/mnt` persist). Without this step every exit-criterion command dies at the prompt with "not found"; it is a hard prerequisite of the Task 7 spine checkpoint.
- **WASI process runtime stays green.** Every WASI process runtime/kernel/VFS bootstrap test (boot, tri-backend persistence, spawn/stdout/exit, isolation, crash containment, catfile FS) must survive shell and userland's refactors. Streaming stdout supersedes the `take-capture` model — port those assertions, don't delete the coverage.

---

## Architecture additions

```text
 MAIN THREAD                         streaming I/O channel (postMessage)
  xterm.js  ──keystroke bytes──────────────────────────────┐
     ▲  ◄──stdout/stderr chunks──────────────────────────┐ │
     │                                control RPC (async) │ │
  ┌──┴──────────────────────── kernel worker (kworker) ───┴─┴────────────┐
  │  KernelCore: proc table + fd tables + sched + caps + HIERARCHICAL VFS │
  │  + PIPES (kernel objects) + PARK/RESUME wait-queues                   │
  │  service_syscall → outcome{ reply?, wakeups[], term_output[] }        │
  │  guest-spawn choreography: read image from VFS → new process worker   │
  └───▲────────────▲───────────────────────▲───────────────▲─────────────┘
   ring│         ring│                   ring│            ring│
  ┌────┴────┐  ┌─────┴──────┐        ┌───────┴───┐   ┌────────┴────────┐
  │ shell   │  │ cat        │─stdout→│KERNEL PIPE│→  │ grep (stdin=pipe)│→ terminal
  │ .wasm   │  │ (wasi)     │        └───────────┘   └─────────────────┘
  │ wasmos_ │  └────────────┘   coreutils are PLAIN WASI (no wasmos_kernel)
  │ kernel  │
  └─────────┘
```

**Key contract change — `service-syscall` outcome (Task 1):**

```wit
record syscall-outcome {
  // none => the syscall PARKED: the kworker keeps the request bytes and does
  // NOT bump RESP_SEQ; the guest stays blocked until a later wakeup re-drives it.
  reply: option<list<u8>>,
  // pids whose parked syscalls are now runnable; the kworker re-calls
  // service-syscall(pid, stashed-request) for each (recursively).
  wakeups: list<u32>,
  // bytes a terminal-bound fd produced during this syscall → streamed to xterm.
  term-output: list<u8>,
}
service-syscall: func(pid: u32, request: list<u8>) -> syscall-outcome;

// host → shell stdin (terminal keystrokes); returns pids to wake.
deliver-stdin: func(pid: u32, bytes: list<u8>) -> list<u32>;
```

---

## shell and userland exit criteria (definition of done)

1. Boot reaches an **interactive terminal** (xterm) bound to a running Rust **shell process** (`listProcs` shows `shell`); typed characters echo and reach the shell's stdin.
2. `ls` lists a real directory; `cat f` prints a file's contents; **`cat f | grep x`** prints only matching lines (real kernel pipe between two processes); **`echo hi > out`** then `cat out` shows `hi` (redirection via the VFS). All report correct **exit codes** (`echo $?`-style or shell-reported).
3. The **13 FR-18 coreutils** run from the terminal, resolved via `$PATH` from the VFS; **≥1 is built in Zig** (FR-14) with observable behavior identical to its Rust sibling.
4. A deliberately-crashing binary run from the shell (e.g. in a pipeline) **terminates without taking down the shell or terminal** (FR-34); the prompt returns.
5. `npm run verify` is green, **including** the kernel/VFS bootstrap/WASI process runtime regression suite (boot, tri-backend persistence across reload, WASI process runtime process spawn/isolation/crash), now running through the refactored VFS + streaming I/O.

---

## Phase A — Substrate (prove the spine before anything else)

### Task 1: Park/resume syscall mechanism (the spike — highest risk, do first)

**Files:** `wit/control.wit` (outcome record + deliver-stdin); `crates/kernel/src/syscall.rs` + `types.rs` (wait-queues, PARK path); `crates/kernel/src/kcore.rs`; `crates/kernel/src/lib.rs` (component); `packages/host/src/ring/host.ts` (deferred response); `packages/host/src/worker/kernel-worker.ts` (stash parked requests, re-drive on wakeups); tests.

**Step 1 — WIT:** add `syscall-outcome` + change `service-syscall` to return it; add `deliver-stdin`. Regenerate bindings.

**Step 2 — kernel:** introduce a `WaitReason` per parked pid (`Stdin`, `Pipe(read_id)`, `PipeWrite(id)`, `Wait(child_pid)`) and per-resource wait-queues in `KernelCore`. `service_syscall` returns `Parked` (reply=None) when a blocking read/write/wait can't complete; the matching event handler returns the woken pids. A per-process **stdin buffer** is added now so the spike is end-to-end.

**Step 3 — host:** `RingServer` gains a deferred mode — `serve`'s loop, on a `parked` outcome, does **not** bump RESP_SEQ. The kworker keeps `Map<pid, stashedRequest>`; on a wakeup list it re-drives parked pids.

> **Cascade discipline (correctness-critical — the shell and userland analog of the WASI process runtime ring race).** Process wakeups as an **iterative work-queue, not recursion**, and guard against **double-waking**: a pid can appear in two wakeup lists in one drain (e.g. a pipe write *and* a writer-close), but the guest did exactly one `Atomics.wait`, so bumping its `RESP_SEQ` twice corrupts the *next* syscall's response. Rules: (1) **remove a pid from the parked-stash the instant it is scheduled for re-drive**, so a duplicate wakeup is a no-op; (2) **dedup pids within a single wakeup batch**; (3) stash lifecycle — stash on `reply=None`; on re-drive, if it replies → bump `RESP_SEQ` and clear the stash; if it parks *again* (e.g. `wait` re-checking a not-yet-exited child) → re-stash and do not bump. Add a unit test that double-wakes a single parked pid and asserts exactly one `RESP_SEQ` bump.

**Step 4 — the spike test (TDD, the gate for the whole milestone):**

- Kernel unit test: process parks on a stdin read (empty); `deliver_stdin(pid, b"hi")` returns `[pid]`; re-driving the read returns `b"hi"`.
- **Real cross-thread test** (extend `packages/host/test/ring.test.ts` or a new `park.test.ts` with `worker_threads`): a client blocks on a read that parks; the server delivers bytes later; the client's `Atomics.wait` returns the delivered bytes — proving deferred fulfilment works across the real ring.
- **WASI process runtime ring tests stay green** (the request→immediate-response path is the `reply=Some` fast path).

→ **Do not proceed past Task 1 until the deferred round-trip passes.** This is the spine.

---

### Task 2: Hierarchical VFS (real directories) + persistence migration

**Files:** `crates/kernel/src/vfs.rs` (rewrite to a dir tree); `crates/kernel/src/syscall.rs` (real `fd_readdir`, `path_open` create/dirs); tests; migration path.

**Step 1 — node model:** an in-memory tree — `Inode { Dir(BTreeMap<String, Ino>) | File(Vec<u8>) }`, a root inode, path resolution that walks components, and ops: `mkdir`, `rmdir` (empty-check), `unlink`, `rename`, `readdir` (immediate children), `read`/`write`/`create`, `stat`. Keep the tri-backend mount table (tmpfs/opfs/idb) — each mount owns a subtree.

**Step 2 — persistence + migration:** persist via the existing blockstores. Write a **superblock** key (`__vfs_version` = 2) + serialize the tree (file content at path keys; directory structure recorded so empty dirs survive). On boot: if the superblock is absent/`<2`, run the **WASI process runtime flat-key migration** — interpret every existing `"/home/a/b"` key as a file at that path, building the nested tree — then write the v2 superblock. The CachedStore preload still feeds this at boot.

**Step 3 — tests:** unit tests for mkdir/readdir/nested paths/rename/rmdir/unlink; a migration test (seed flat keys → boot → tree has nested dirs, files readable); **real `fd_readdir`** replaces the WASI process runtime synthesized version (update `syscall::fd_readdir_*` test). **WASI process runtime persistence E2E MUST still pass** (run it; if the migration is wrong, fix it — do not weaken the test).

---

### Task 3: Pipes as kernel objects

**Files:** `crates/kernel/src/pipe.rs` (new); `types.rs` (`DescKind::PipeRead{id}` / `PipeWrite{id}`); `syscall.rs` (fd_read/fd_write/fd_close route to pipes, park/resume); tests.

**Step 1:** a `Pipe { buf: VecDeque<u8>, capacity, writers_open, readers_open }` table keyed by id. `fd_read` on an empty-but-open pipe → **park** (reason `Pipe(id)`); a write wakes parked readers. `fd_write` on a full pipe → **park** (reason `PipeWrite(id)`); a read wakes parked writers. Closing all write ends → reads return EOF (0 bytes, not park). Closing all read ends → writes get `EPIPE`.

**Step 2 — tests:** reader parks then a write delivers; backpressure (writer parks on full, reader drains, writer wakes); EOF on writer close; EPIPE on reader close. All via the park/resume machinery from Task 1.

---

### Task 4: Streaming stdin/stdout + the terminal I/O channel

**Files:** `types.rs` (`DescKind::Terminal`); `syscall.rs` (terminal-bound `fd_write` → `term-output`); `kernel-worker.ts` (forward `term-output` to main, route `stdin` messages to `deliver-stdin`); `boot.ts` (streaming channel API); tests.

**Step 1:** a process whose fd 1/2 is `Terminal` produces `term-output` in its syscall outcome; the kworker posts `{type:'output', bytes}` to the main thread as a **streaming message** (separate from control RPC ids). Keystrokes arrive from main as `{type:'stdin', pid, bytes}` → kworker calls `deliver-stdin` → re-drives parked readers.

**Step 2:** supersede WASI process runtime `take-capture` — the WASI process runtime process E2E asserted captured stdout at exit; shell and userland's stdout is streamed. Port those assertions to consume the stream (a host-side accumulator for tests), keeping the coverage. `take-capture` may remain for non-terminal processes (pipelines’ buffered stages) but the terminal path is the stream.

> **Stdin routing limitation (documented, not a bug).** `deliver-stdin` delivers keystrokes to the **shell** pid. None of the shell and userland exit-criterion commands read interactive stdin (`cat f` uses a file arg; `grep` reads its pipe), so this is sufficient for shell and userland. A bare foreground `cat` with no argument *would* read interactive stdin and hang (keystrokes accumulate in the shell's buffer while it is parked on `wait`). Routing interactive stdin to the running foreground child requires job control (FR-19), which is **explicitly deferred** — so this is a **known, documented shell and userland limitation**, recorded in `docs/M2-STATUS.md` and the TODO list, not a surprise hang.

---

## Phase B — `wasmos_kernel` + shell spine

### Task 5: `wasmos_kernel` WIT world + Binder Rust guest stubs + guest-spawn choreography

**Files:** `wit/kernel.wit` (new world); `tools/binder` (emit + check Rust guest stubs); `crates/wasmos-sys` (generated guest crate); `packages/host/src/worker/wasi-shim.ts` (+ `wasmos_kernel` import namespace); `kernel-worker.ts` (spawn choreography); `syscall.rs` (SPAWN/PIPE/WAIT/DUP2 opcodes); tests.

**Step 1 — `wit/kernel.wit`:** the guest process-control surface — `spawn(image-path, argv, env, stdio)` → pid, `pipe()` → `(read-fd, write-fd)`, `wait(pid)` → exit-code (parks), `dup2(old, new)`. `stdio` lets the shell set a child's fd0/1/2 to a pipe end, a file, or the terminal.

**Step 2 — Binder:** `binder gen` runs `wit-bindgen` (Rust guest) against `wit/kernel.wit` → `crates/wasmos-sys` (typed stubs importing a flat `wasmos_kernel` module). `binder check` covers drift (FR-36). **Verify the generated import module name matches what the JS shim provides** (validate naming first, like WASI process runtime's jco-in-worker check; if wit-bindgen's component-style naming doesn't yield a clean core-module import, the Binder emits the thin stub + a conformance validator — the spec-sanctioned path for non-upstream targets, §3.4.1).

**Step 3 — shim + choreography:** the process-worker shim adds the `wasmos_kernel` imports, marshalling SPAWN/PIPE/WAIT/DUP2 to new ring opcodes. SPAWN: kernel allocates child pid + fd table (per `stdio`) + caps (delegated subset of the shell's), returns pid; the **kworker** reads `image-path` from the VFS, creates the child process worker + ring, and arms servicing — while the shell's `wait` parks. WAIT resumes when the child's `proc_exit` returns the parent in its wakeup list.

**Step 4 — tests:** kernel unit tests for spawn (child registered, caps delegated, stdio fds wired), pipe fds, wait park/resume on child exit. A focused integration test (Node or a minimal E2E) spawning a child from a guest and reading its piped output.

---

### Task 6: Terminal (xterm.js) on the main thread, bound to the shell

**Files:** `packages/host/package.json` (xterm dep); `packages/host/src/term/terminal.ts`; `index.ts`/`index.html` (mount xterm); `boot.ts` (spawn the shell at boot, wire the streaming channel).

**Step 1 — the `/bin` loader (hard prerequisite).** Add a boot step that, after the kworker is ready and **before** spawning the shell, loads every executable into the VFS: for each served `/<name>.wasm` asset, fetch its bytes and `control.fsWrite("/bin/<name>", bytes)`. `/bin` is **tmpfs, repopulated each boot**. The set grows as Tasks 9/10 add coreutils; for the Task 7 checkpoint it must include at least `/bin/sh` and `/bin/echo` (so build a minimal Rust `echo` as part of the spine, ahead of the full coreutils fan-out in Task 9).

**Step 2 — xterm:** add `@xterm/xterm`; mount a terminal in the page. After `/bin` is loaded, **spawn the shell process** (`/bin/sh` from the VFS) with fd0/1/2 = the terminal. Wire: `term.onData(bytes => control.stdin(shellPid, bytes))`; streaming `output` messages → `term.write(bytes)`.

**Step 3:** the shell isn't written yet (Task 7) — **no placeholder/echo-stub is allowed** here; gate this task's E2E on Task 7's minimal shell. Order Tasks 6+7 together: `/bin` loader + terminal + minimal shell proven as one checkpoint.

---

### Task 7: Minimal shell (Rust guest) — one command end-to-end ← spine-proven checkpoint

**Files:** `crates/sh` (new Rust guest); install to VFS `/bin/sh`.

**Step 1:** the shell reads a line from stdin (parks until the terminal delivers it), parses **one** simple command + args, resolves it via `$PATH` (`/bin`) in the VFS, `wasmos_kernel.spawn`s it with stdio inherited from the terminal, `wait`s, prints the exit status, and loops with a prompt.

**Step 2 — checkpoint E2E:** terminal boots → type `echo hi` → `hi` appears in xterm → prompt returns. This proves the entire spine (terminal ↔ stdin park/resume ↔ shell ↔ spawn ↔ child stdout stream ↔ exit/wait) end-to-end before the long tail.

---

## Phase C — Fan out to full userland

### Task 8: Shell — pipelines, redirection, built-ins, exit codes

**Files:** `crates/sh` (extend).

- **Pipelines** `a | b | c`: `wasmos_kernel.pipe()` per stage boundary; spawn each stage with stdin/stdout set to the pipe ends (via `stdio`/`dup2`); close unused ends; `wait` all; pipeline exit = last stage.
- **Redirection** `>`, `>>`, `<`: `path_open` the target in the VFS and set the child's stdio to that fd.
- **Built-ins**: `cd`, `pwd`, `exit`, and `$?` (last exit code). `$PATH` resolution against `/bin`.
- Tests: shell-level unit tests where feasible; full coverage via the Task 12 E2E.

### Task 9: Coreutils in Rust (the 13 FR-18 utilities)

**Files:** `crates/coreutils/*` (one bin per util, or a multi-call binary); install to VFS `/bin`.

Implement `ls cat echo cp mv rm mkdir pwd grep head tail wc env` as plain `wasm32-wasip1` binaries on the WASI process runtime WASI surface + the hierarchical VFS (no `wasmos_kernel` needed). Built spine-first: `ls cat echo grep wc` first (they satisfy the exit criteria), then `cp mv rm mkdir pwd head tail env`. Each gets a focused behavior check.

### Task 10: Polyglot proof — one coreutil in Zig (FR-14)

**Files:** `guests/zig/<util>` (e.g. `wc` or `echo`); `tools/bootstrap.sh` + `package.json` (`build:guests` adds the Zig build); CI.

Build one FR-18 util with `zig build-exe -target wasm32-wasi`; install it (or a `/bin/<util>.zig` variant) and assert **observable behavior identical** to the Rust sibling (FR-14). Wire the Zig toolchain into bootstrap + CI.

### Task 11: Crash containment in the shell (FR-34)

A crashing binary (reuse/adapt WASI process runtime `crash`) run from the shell — standalone and **inside a pipeline** — traps; the shell observes a non-zero/trap child exit, prints an error, and the **prompt returns**; the terminal and kworker survive. Covered by an E2E case.

### Task 12: E2E (real browser) + polyglot CI + M2-STATUS + verify

**Files:** `e2e/terminal.spec.ts`; `.github/workflows/ci.yml`; `docs/M2-STATUS.md`.

**Step 1 — `e2e/terminal.spec.ts`** (real Chromium, real workers, real ring, real xterm): boot → terminal; drive keystrokes and assert xterm output for: `ls`, `cat f`, **`cat f | grep x`**, **`echo hi > out`** then `cat out`, exit codes, the Zig util, and the crash-containment case. Reload → VFS persistence intact (migration + hierarchical).

**Step 2 — regression:** the kernel/VFS bootstrap/WASI process runtime E2E (`boot.spec`, `opfs.spec`, `process.spec`) MUST still pass through the refactored VFS + streaming I/O — port assertions where the model changed (streaming stdout), never weaken them.

**Step 3 — CI/status:** add the Zig toolchain to CI + `build:guests`; keep the clippy/typecheck/lint gates; write `docs/M2-STATUS.md` with **real** `npm run verify` numbers + as-built deviations. Run `npm run verify` green.

---

## Done criteria (verify before declaring complete)

```bash
npm run verify
```

All five shell and userland exit criteria hold; the kernel/VFS bootstrap/WASI process runtime regression suite is green; `binder check` (incl. the new `wasmos:kernel` stubs) is in sync; clippy `-D warnings` clean. **STOP here** — desktop compositor (compositor/desktop) is the next plan.

---

## TODO / deferred (do NOT do in this plan)

- **desktop compositor:** windowed compositor/desktop, file manager, input brokering, canvas surfaces.
- **process control and IPC:** IPC channels/shm at scale (≥32 procs), session snapshot/restore, full signals (`SIGTERM`/`SIGKILL` semantics beyond crash-kill), live `ps`/`top` UI (FR-33).
- AssemblyScript (FR-11) + hand-authored WAT (FR-12) guests — SHOULD-tier polyglot, beyond the Rust+Zig FR-14 proof.
- Job control (`&`, `jobs`, fg/bg — FR-19), package mechanism (FR-20). **Consequence (documented shell and userland limitation):** interactive stdin routes only to the shell, so a bare foreground `cat` (no file arg) reading stdin hangs — routing stdin to the foreground child needs job control.
- Real capability-gated clock/entropy brokers (still deterministic stubs from WASI process runtime; §3.6).
- `Atomics.waitAsync` `postMessage`-wakeup fallback (still single-path); Tier B (Asyncify/JSPI).
- OPFS sync access handles to retire the `CachedStore` bridge.
