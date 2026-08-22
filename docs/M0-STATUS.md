# kernel/VFS bootstrap Status — Kernel & VFS Skeleton + Centralized Binder

**Status:** ✅ Complete — all exit criteria met (verified 2026-05-31 via `npm run verify`).

| Exit criterion | Verified by | Result |
|----------------|-------------|--------|
| Boots to `ready` < 1500 ms | `e2e/boot.spec.ts` test 1 (`bootMillis < 1500`) | ✅ PASS (boot well under budget; `bootMillis` measures kernel init from `boot()`, excludes script/wasm download) |
| Cross-origin isolation (COOP/COEP) effective → tier A | `e2e/boot.spec.ts` test 1 (`crossOriginIsolated === true`, `tier === "A"`) | ✅ PASS |
| Tri-backend VFS read/write/list (tmpfs `/`, OPFS `/home`, IDB `/mnt`) | `kernel` `vfs::tests` (4) + E2E test 2 | ✅ PASS |
| `/home` (OPFS) + `/mnt` (IndexedDB) persist across reload; tmpfs volatile | `e2e/boot.spec.ts` test 2 (real Chromium, real OPFS/IDB) | ✅ PASS |
| `npm run verify` all green | local (this machine) | ✅ PASS |

## Verify gate breakdown (latest local run)

```text
build        : kernel (wasm32) builds; binder gen regenerates bindings from wit/ (build artifact)
typecheck    : tsc --noEmit on host passes against fresh bindings
cargo test   : 22 passed; 0 failed  (vfs ×6, types/capabilities ×7, scheduler ×5, kcore ×4)
vitest       : 5 passed (2 files)   (features detection ×2, IdbBlockstore ×3)
playwright   : 5 passed             (boot<1.5s+tierA+init-proc; tri-backend persist;
                                      fs-delete unlink+persist across reload;
                                      OpfsBlockstore real-OPFS; IdbBlockstore real-IDB)
clippy       : clean (-D warnings) on both wasm32 + host targets
CI (GitHub)  : runs the full pipeline on Linux x86_64 every push (real Actions)
```

> **Textual bindings are committed and checked.** The split-out core wasm payload is
> still ignored. `binder check` compares the tracked JS/TypeScript output with a
> fresh `jco` run, then checks the guest syscall signatures; `npm run verify` also
> type-checks and exercises the fresh bindings in a real browser.

## Post-review gap closure (FR-2, FR-3, sub-gaps)

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

- **Kernel:** Rust → WASM **component** built for `wasm32-unknown-unknown` (pure component — imports only `home-store`/`mnt-store`, exports `control`; avoids std's phantom WASI imports that `wasm32-wasip1` would link).
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

Five review follow-ups were actioned. Three were completed; two were explicitly
kept deferred by product decision (they require separate-milestone architecture).

| # | Item | Disposition | Evidence |
|---|------|-------------|----------|
| 1 | `fs-delete` control verb (was the lone `#[allow(dead_code)]`) | **Done** — added to `wit/control.wit`; `Vfs::delete`/`KernelCore::delete`/component `fs_delete`; host `KernelControl.fsDelete`; bindings regenerated. `Blockstore::delete` now has a real caller (dead_code removed). | `vfs::tests::delete_*` (2) + `e2e/boot.spec.ts` "fsDelete unlinks across backends and the deletion persists across reload" |
| 2 | Actually **use** SAB/JSPI (not just report) | **Deferred (decision)** — requires WASI process runtime worker-per-process execution + SharedArrayBuffer syscall ring; no honest kernel/VFS bootstrap-scoped partial. | tracked below |
| 3 | Hierarchical VFS dirs | **Deferred (decision)** — real directory tree + `fd_readdir` is shell and userland. | tracked below |
| 4 | Cross-platform binding determinism on CI's arch | **Corrected by real CI** — the first assumption (byte-identical glue cross-arch) was **false**: GitHub CI x86_64 emitted different jco identifier de-dup (`get$1` vs `get`) than mac arm64 because `cargo-component`'s component import ordering differs per arch. Earlier local "determinism" checks missed this (`verify-linux-determinism.sh` ran jco against the *mac-built* wasm; `ci-linux-determinism.sh` ran on the *pre-fs-delete* kernel). **Resolution:** textual bindings are tracked for review and checked by Binder; split-out core wasm payloads remain ignored. | real GitHub Actions finding → root-caused → gate redesigned; `npm run binder:check` green |
| 5 | clippy `should_implement_trait` on `Scheduler::next` | **Done** — renamed `next` → `pick_next` (a non-`Iterator` `next` was misleading); all call sites updated. | `cargo clippy -D warnings` clean on wasm32 + host |

## Deferred to process-runtime and shell work (genuinely out of kernel/VFS bootstrap scope; tracked)

- `wasmos:kernel` guest syscall world + `wit-bindgen` Rust/C guest stubs; Asyncify/JSPI Tier-B path.
- **(item 2)** Worker-per-process execution + SharedArrayBuffer ring transport; actual WASM process *execution* and real *use* of SAB/JSPI (the table/scheduler/caps scaffolding is in place and tier detection *reports* SAB/JSPI; WASI process runtime attaches real instances and consumes them).
- Control `spawn`/`kill` exposed over WIT (the `ProcTable` methods exist and are tested, awaiting their WIT callers). `fs-delete` is now exposed (see follow-up #1 above).
- **(item 3)** Hierarchical VFS dirs (kernel/VFS bootstrap uses flat keys); revisit with `fd_readdir` in shell and userland.

> Watch-item resolution: cross-platform binding determinism is **not** assumed — it
> was disproven by real CI (jco glue differs by arch). Textual bindings are tracked
> so the generated result is reviewable; the legacy
> `tools/ci-linux-determinism.sh` / `tools/verify-linux-determinism.sh` scripts are
> retained only as historical diagnostics; they are **no longer part of the gate**.
> The authoritative check is the real GitHub Actions run (Linux x86_64) on every push.
