# kernel/VFS bootstrap Status — Kernel & VFS Skeleton + Centralized Binder

This report names the original bootstrap task. It is not a claim that the
later runtime layers are absent; the current implementation also includes the
WASI process, shell, desktop, IPC, and Linux paths described in the other
status reports.

**Status:** ✅ Complete — the current repository gate passed on 2026-08-22 via `npm run verify`.

| Exit criterion | Verified by | Result |
|----------------|-------------|--------|
| Boots to `ready` < 1500 ms | `e2e/boot.spec.ts` test 1 (`bootMillis < 1500`) | ✅ PASS (boot well under budget; `bootMillis` measures kernel init from `boot()`, excludes script/wasm download) |
| Cross-origin isolation (COOP/COEP) effective → tier A | `e2e/boot.spec.ts` test 1 (`crossOriginIsolated === true`, `tier === "A"`) | ✅ PASS |
| VFS read/write/list across tmpfs `/`, OPFS `/home`, IDB `/mnt`, and system `/etc` | `kernel` VFS tests + E2E filesystem workflows | ✅ PASS |
| `/home` (OPFS) + `/mnt` (IndexedDB) persist across reload; tmpfs volatile | `e2e/boot.spec.ts` test 2 (real Chromium, real OPFS/IDB) | ✅ PASS |
| `npm run verify` all green | local (this machine) | ✅ PASS |

## Verify gate breakdown (latest local run — 2026-08-22)

```text
build        : kernel (wasm32) builds; binder gen regenerates bindings from wit/ (build artifact)
typecheck    : tsc --noEmit on host passes against fresh bindings
cargo test   : workspace passed, including 110 kernel tests
vitest       : 32 passed (8 files)
playwright   : 89 passed in the fast browser suite, including boot, persistence,
                                      filesystem hierarchy, process, desktop, and input workflows
clippy       : clean (-D warnings) on both wasm32 + host targets
CI (GitHub)  : runs the full pipeline on Linux x86_64 every push (real Actions)
```

> **Textual bindings are committed and checked.** The split-out core wasm payload is
> still ignored. `binder check` compares the tracked JS/TypeScript output with a
> fresh `jco` run, then checks the guest syscall signatures; `npm run verify` also
> type-checks and exercises the fresh bindings in a real browser.

## Review record (FR-2, FR-3, and storage follow-ups)

After a completeness audit, the following spec-kernel/VFS bootstrap gaps were closed (each with tests):

| Gap | What was added | Verified by |
|-----|----------------|-------------|
| **FR-3 scheduler scaffold** | `sched.rs` — priority round-robin Scheduler + per-process time accounting | 5 unit tests incl. ≥32 concurrent procs; live in `boot()` |
| **FR-2 process table + capabilities** | `types.rs` — `Capability`/`CapabilitySet` (default-deny), `ProcState` machine, `ProcTable` (spawn/kill/reap/has_cap) | 7 unit tests; `boot()` registers `init` (New→Ready→Running) with caps |
| **Live wiring** | `kcore.rs` `KernelCore` joins VFS+table+scheduler+caps; `component` is a thin WIT adapter | 4 kcore tests + E2E asserts `listProcs()==[init/running]` through WASM |
| **Sound verify gate** | `npm run verify` = build (regen bindings from wit/) + typecheck + rust + host + e2e | `npm run verify` exit 0 |
| **Full cold-load timing** | `coldLoadMillis` (navigation start → ready) | E2E asserts `coldLoadMillis < 1500` |
| **Real OPFS test** | in-browser harness exercising `OpfsBlockstore` directly | `e2e/opfs.spec.ts` (real OPFS + IndexedDB) |
| **Generated bindings are tracked output** | textual jco glue is committed and compared by `binder check`; split-out core wasm remains build output | `npm run binder:check` plus real browser E2E |

## Architecture as built

- **Kernel:** Rust → WASM **component** built for `wasm32-unknown-unknown` (pure component — imports `home-store`, `mnt-store`, and `sys-store`, exports `control`; avoids std's phantom WASI imports that `wasm32-wasip1` would link).
- **Binder:** contracts under `wit/` are the source of truth. `tools/binder gen`
  runs `jco transpile --instantiation async` for the component, while
  `binder kernel-check` checks every guest stub's full signature against
  `wit/kernel/kernel.wit`. `npm run binder:check` runs both gates.
- **Host:** tier detection (SAB/COOP-COEP/OPFS/JSPI) + a **synchronous write-back cache** (`CachedStore`) bridging the kernel's sync imports to async OPFS/IndexedDB — pre-loads at boot, flushes writes back; `flush()` awaited before reload in the E2E.
- **Serving:** static, COOP/COEP headers (`tools/serve.mjs`); the OS runs from a page with no app server.

## Notable execution-time decisions (deviations from the original plan, with cause)

1. **Build target `wasm32-unknown-unknown`** (plan said `wasm32-wasip1`): wasip1 linked 10 phantom WASI imports via std; the kernel needs none, so the pure-component target is correct and keeps host wiring to just the two stores.
2. **`list` → `list-keys`** in WIT: `list` is a reserved WIT keyword.
3. **Synchronous write-back cache** added: generated host imports are synchronous, but OPFS/IndexedDB are async-only — the cache is the bridge (kept Tier-A-without-JSPI working at kernel/VFS bootstrap).
4. **Unversioned import keys** at runtime: jco's `instantiate()` reads `wasmos:abi/home-store` (the `@0.1.0` suffix is types-only).
5. **`wit-bindgen-rt`** runtime dep required by cargo-component-generated bindings (distinct from the `wit-bindgen` codegen crate).

## Post-kernel/VFS bootstrap follow-up closure (2026-05-31)

Five review follow-ups were actioned. The two items that required later runtime
layers were completed by those later tasks; their current boundaries are listed
below.

| # | Item | Disposition | Evidence |
|---|------|-------------|----------|
| 1 | `fs-delete` control verb (was the lone `#[allow(dead_code)]`) | **Done** — added to `wit/control.wit`; `Vfs::delete`/`KernelCore::delete`/component `fs_delete`; host `KernelControl.fsDelete`; bindings regenerated. `Blockstore::delete` now has a real caller (dead_code removed). | `vfs::tests::delete_*` (2) + `e2e/boot.spec.ts` "fsDelete unlinks across backends and the deletion persists across reload" |
| 2 | Actually **use** SAB/JSPI (not just report) | **Implemented by the WASI process runtime** — worker-per-process execution uses the SharedArrayBuffer syscall ring; JSPI remains optional. | `e2e/process.spec.ts`, ring tests |
| 3 | Hierarchical VFS dirs | **Implemented by shell and userland** — real directory tree and `fd_readdir` are live. | filesystem E2E and kernel VFS tests |
| 4 | Cross-platform binding determinism on CI's arch | **Corrected by real CI** — the first assumption (byte-identical glue cross-arch) was **false**: GitHub CI x86_64 emitted different jco identifier de-dup (`get$1` vs `get`) than mac arm64 because `cargo-component`'s component import ordering differs per arch. Earlier local "determinism" checks missed this (`verify-linux-determinism.sh` ran jco against the *mac-built* wasm; `ci-linux-determinism.sh` ran on the *pre-fs-delete* kernel). **Resolution:** textual bindings are tracked for review and checked by Binder; split-out core wasm payloads remain ignored. | real GitHub Actions finding → root-caused → gate redesigned; `npm run binder:check` green |
| 5 | clippy `should_implement_trait` on `Scheduler::next` | **Done** — renamed `next` → `pick_next` (a non-`Iterator` `next` was misleading); all call sites updated. | `cargo clippy -D warnings` clean on wasm32 + host |

## Current boundaries

- `wasmos:kernel` is a checked WIT contract for the hand-written Rust guest
  transport in `crates/wasmos-sys`; the active process guests use that ring path.
- Worker-per-process execution, the SharedArrayBuffer transport, process control,
  signals, live metrics, hierarchical directories, `/proc`, and `/dev` are active
  in the later runtime layers.
- Tier B (Asyncify/JSPI or a `postMessage` syscall transport) is not shipped.
  `startDesktop` requires cross-origin isolation and fails clearly when SAB is
  unavailable; the feature report still records the browser capability.

> Watch-item resolution: cross-platform binding determinism is **not** assumed — it
> was disproven by real CI (jco glue differs by arch). Textual bindings are tracked
> so the generated result is reviewable; the legacy
> `tools/ci-linux-determinism.sh` / `tools/verify-linux-determinism.sh` scripts are
> retained only as historical diagnostics; they are **no longer part of the gate**.
> The authoritative check is the real GitHub Actions run (Linux x86_64) on every push.
