# M0 Status — Kernel & VFS Skeleton + Centralized Binder

**Status:** ✅ Complete — all exit criteria met (verified 2026-05-31 via `npm run verify`).

| Exit criterion | Verified by | Result |
|----------------|-------------|--------|
| Boots to `ready` < 1500 ms | `e2e/boot.spec.ts` test 1 (`bootMillis < 1500`) | ✅ PASS (boot well under budget; full test 248–278 ms incl. nav) |
| Tri-backend VFS read/write/list (tmpfs `/`, OPFS `/home`, IDB `/mnt`) | `kernel` `vfs::tests` (4) + E2E test 2 | ✅ PASS |
| `/home` (OPFS) + `/mnt` (IndexedDB) persist across reload; tmpfs volatile | `e2e/boot.spec.ts` test 2 (real Chromium, real OPFS/IDB) | ✅ PASS |
| `npm run verify` all green | local (this machine) | ✅ PASS |

## Verify gate breakdown (latest local run)

```text
binder check : bindings are in sync.
cargo test   : 4 passed; 0 failed   (vfs routing, prefix list, not-found, bad-path)
vitest       : 5 passed (2 files)    (features detection ×2, IdbBlockstore ×3)
playwright   : 2 passed              (boot<1.5s+tier; tri-backend persist across reload)
```

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

## Deferred to M1 (out of scope here; tracked)

- `wasmos:kernel` guest syscall world + `wit-bindgen` Rust/C guest stubs; Asyncify/JSPI Tier-B path.
- Worker-per-process execution + SharedArrayBuffer ring transport.
- Control `fs-delete`/unlink wiring (the `Blockstore::delete` contract method exists, awaiting its caller).
- Hierarchical VFS dirs (M0 uses flat keys); revisit with `fd_readdir` in M2.
- Cross-platform determinism of committed `kernel.js` vs CI-regenerated (glue is platform-independent; watch the first CI run).
