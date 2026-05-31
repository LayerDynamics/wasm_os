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
cargo test   : 20 passed; 0 failed  (vfs ×4, types/capabilities ×7, scheduler ×5, kcore ×4)
vitest       : 5 passed (2 files)   (features detection ×2, IdbBlockstore ×3)
playwright   : 4 passed             (boot<1.5s+tierA+init-proc; tri-backend persist;
                                      OpfsBlockstore real-OPFS; IdbBlockstore real-IDB)
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

## Deferred to M1 (genuinely out of M0 scope; tracked)

- `wasmos:kernel` guest syscall world + `wit-bindgen` Rust/C guest stubs; Asyncify/JSPI Tier-B path.
- Worker-per-process execution + SharedArrayBuffer ring transport; actual WASM process *execution* (the table/scheduler/caps scaffolding is in place; M1 attaches real instances).
- Control `fs-delete`/unlink + `spawn`/`kill` exposed over WIT (the `ProcTable`/`Blockstore` methods exist and are tested, awaiting their WIT callers).
- Hierarchical VFS dirs (M0 uses flat keys); revisit with `fd_readdir` in M2.

> Resolved (were watch-items): cross-platform binding determinism is now **proven** on Linux (`tools/ci-linux-determinism.sh` → byte-identical), and CI is run for real (see CI status below).
