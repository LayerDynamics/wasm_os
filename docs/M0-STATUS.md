# M0 Status — Kernel & VFS Skeleton + Centralized Binder

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
drift gate   : DETERMINISTIC — committed bindings == rebuild (git diff --exit-code, mac + Linux)
cargo test   : 22 passed; 0 failed  (vfs ×6, types/capabilities ×7, scheduler ×5, kcore ×4)
vitest       : 5 passed (2 files)   (features detection ×2, IdbBlockstore ×3)
playwright   : 5 passed             (boot<1.5s+tierA+init-proc; tri-backend persist;
                                      fs-delete unlink+persist across reload;
                                      OpfsBlockstore real-OPFS; IdbBlockstore real-IDB)
clippy       : clean (-D warnings) on both wasm32 + host targets
```

## Post-review gap closure (FR-2, FR-3, sub-gaps)

After a completeness audit, the following spec-M0 gaps were closed (each with tests):

| Gap | What was added | Verified by |
|-----|----------------|-------------|
| **FR-3 scheduler scaffold** | `sched.rs` — priority round-robin Scheduler + per-process time accounting | 5 unit tests incl. ≥32 concurrent procs; live in `boot()` |
| **FR-2 process table + capabilities** | `types.rs` — `Capability`/`CapabilitySet` (default-deny), `ProcState` machine, `ProcTable` (spawn/kill/reap/has_cap) | 7 unit tests; `boot()` registers `init` (New→Ready→Running) with caps |
| **Live wiring** | `kcore.rs` `KernelCore` joins VFS+table+scheduler+caps; `component` is a thin WIT adapter | 4 kcore tests + E2E asserts `listProcs()==[init/running]` through WASM |
| **Sound local drift gate** | `npm run verify` uses `drift` (build + `git diff`), not the weaker `binder:check` | `npm run drift` exit 0 |
| **Full cold-load timing** | `coldLoadMillis` (navigation start → ready) | E2E asserts `coldLoadMillis < 1500` |
| **Real OPFS test** | in-browser harness exercising `OpfsBlockstore` directly | `e2e/opfs.spec.ts` (real OPFS + IndexedDB) |
| **Cross-platform determinism** | bindings rebuilt on **Linux** (Docker) match committed (mac) byte-for-byte | `tools/ci-linux-determinism.sh` → `DETERMINISTIC_LINUX_OK` |

## Architecture as built

- **Kernel:** Rust → WASM **component** built for `wasm32-unknown-unknown` (pure component — imports only `home-store`/`mnt-store`, exports `control`; avoids std's phantom WASI imports that `wasm32-wasip1` would link).
- **Binder:** `wit/` (single source of truth) → `tools/binder gen` runs `jco transpile --instantiation async` into `packages/abi/generated`; `binder check` is the CI drift gate (excludes build-artifact `*.wasm`).
- **Host:** tier detection (SAB/COOP-COEP/OPFS/JSPI) + a **synchronous write-back cache** (`CachedStore`) bridging the kernel's sync imports to async OPFS/IndexedDB — pre-loads at boot, flushes writes back; `flush()` awaited before reload in the E2E.
- **Serving:** static, COOP/COEP headers (`tools/serve.mjs`); the OS runs from a page with no app server.

## Notable execution-time decisions (deviations from the original plan, with cause)

1. **Build target `wasm32-unknown-unknown`** (plan said `wasm32-wasip1`): wasip1 linked 10 phantom WASI imports via std; the kernel needs none, so the pure-component target is correct and keeps host wiring to just the two stores.
2. **`list` → `list-keys`** in WIT: `list` is a reserved WIT keyword.
3. **Synchronous write-back cache** added: generated host imports are synchronous, but OPFS/IndexedDB are async-only — the cache is the bridge (kept Tier-A-without-JSPI working at M0).
4. **Unversioned import keys** at runtime: jco's `instantiate()` reads `wasmos:abi/home-store` (the `@0.1.0` suffix is types-only).
5. **`wit-bindgen-rt`** runtime dep required by cargo-component-generated bindings (distinct from the `wit-bindgen` codegen crate).

## Post-M0 follow-up closure (2026-05-31)

Five review follow-ups were actioned. Three were completed; two were explicitly
kept deferred by product decision (they require separate-milestone architecture).

| # | Item | Disposition | Evidence |
|---|------|-------------|----------|
| 1 | `fs-delete` control verb (was the lone `#[allow(dead_code)]`) | **Done** — added to `wit/control.wit`; `Vfs::delete`/`KernelCore::delete`/component `fs_delete`; host `KernelControl.fsDelete`; bindings regenerated. `Blockstore::delete` now has a real caller (dead_code removed). | `vfs::tests::delete_*` (2) + `e2e/boot.spec.ts` "fsDelete unlinks across backends and the deletion persists across reload" |
| 2 | Actually **use** SAB/JSPI (not just report) | **Deferred (decision)** — requires M1 worker-per-process execution + SharedArrayBuffer syscall ring; no honest M0-scoped partial. | tracked below |
| 3 | Hierarchical VFS dirs | **Deferred (decision)** — real directory tree + `fd_readdir` is M2. | tracked below |
| 4 | Cross-platform binding determinism on CI's arch | **Done** — `jco` on **linux/amd64** regenerates all 5 git-tracked glue files (`kernel.js` + 4 `.d.ts`) byte-identical to the committed mac/arm64 output. | `tools/verify-linux-determinism.sh` → `JCO_AMD64_GLUE_DETERMINISTIC`; full end-to-end rebuild remains gated in CI via `tools/ci-linux-determinism.sh` |
| 5 | clippy `should_implement_trait` on `Scheduler::next` | **Done** — renamed `next` → `pick_next` (a non-`Iterator` `next` was misleading); all call sites updated. | `cargo clippy -D warnings` clean on wasm32 + host |

## Deferred to M1/M2 (genuinely out of M0 scope; tracked)

- `wasmos:kernel` guest syscall world + `wit-bindgen` Rust/C guest stubs; Asyncify/JSPI Tier-B path.
- **(item 2)** Worker-per-process execution + SharedArrayBuffer ring transport; actual WASM process *execution* and real *use* of SAB/JSPI (the table/scheduler/caps scaffolding is in place and tier detection *reports* SAB/JSPI; M1 attaches real instances and consumes them).
- Control `spawn`/`kill` exposed over WIT (the `ProcTable` methods exist and are tested, awaiting their WIT callers). `fs-delete` is now exposed (see follow-up #1 above).
- **(item 3)** Hierarchical VFS dirs (M0 uses flat keys); revisit with `fd_readdir` in M2.

> Resolved (were watch-items): cross-platform binding determinism is now **proven** — byte-identical glue on linux/amd64 (`tools/verify-linux-determinism.sh`, fast jco check) and end-to-end on Linux (`tools/ci-linux-determinism.sh`); CI runs the full rebuild + drift gate on every push.
