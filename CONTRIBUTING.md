# Contributing to WASM_OS

Thanks for your interest. WASM_OS is an experimental browser-hosted operating
system (see the [README](README.md)). Contributions are most useful when they
make one of the existing runtime paths clearer, better tested, or easier to run.

## Ground rules

- **The gate is `npm run verify`.** Every change should pass it before it lands —
  kernel and guest builds, ABI drift checks, Rust lint and workspace tests,
  TypeScript checks for the host and React client, the React production build,
  host tests, and the real-browser E2E. No mocked layers, no skipped gates.
- **The ABI lives in `wit/`.** It is the single source of truth for the component
  boundary and the guest syscall extension. If you change either contract, run
  `npm run binder:check` and update the generated or conformance output — see
  [`docs/stack/wit.md`](docs/stack/wit.md).
- **No placeholders.** No stubs, `TODO`/`unimplemented!`, simulated output, or
  dead code. If something is called, it is implemented.
- **Match the surrounding code.** Comment density, naming, and idiom should look
  like the file you are editing.

## Getting set up

> Requires an evergreen Chromium or Firefox and a cross-origin-isolated context
> (the bundled dev server sets the COOP/COEP headers for you).

```bash
# Install the toolchain (rust targets, cargo-component, wasm-tools, zig, node deps, playwright)
./tools/bootstrap.sh

# Build everything and serve it
npm run build          # kernel component + jco bindings
npm run build:guests   # Rust + Zig wasm32-wasi guests
npm run bundle         # esbuild host → dist/
node tools/serve.mjs   # http://localhost:8080
```

## The verification gate

Run the whole thing before opening a PR:

```bash
npm run verify
```

Individual gates (all part of `verify`):

| Command | What it checks |
|---------|----------------|
| `npm run build` | kernel WASM component builds; jco bindings regenerate from `wit/` |
| `npm run build:guests` | all Rust + Zig `wasm32-wasi` guests build |
| `npm run binder:kernel-check` | guest syscall stubs conform to the extension ABI (FR-36) |
| `npm run lint` | `cargo clippy` (workspace + kernel `wasm32`) with `-D warnings` |
| `npm run typecheck` | `tsc --noEmit` on the host |
| `npm run test:rust` | every Cargo workspace package, including kernel, `wasmgfx`, `wasmobj`, and filemanager tests |
| `npm run test:host` | Vitest (features, blockstores, ring, polyglot byte-diff) |
| `npm run typecheck:web` | Type-checks the packaged React client in `apps/web` |
| `npm run build:web` | Builds the packaged React client and hashed browser assets |
| `npm run test:e2e` | Playwright in real Chromium — real OPFS/IndexedDB, real workers |

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the full pipeline on
Linux x86_64 on every push.

### Testing expectations

- **Fix a bug → add a regression test** that fails before the fix and passes after.
- **E2E means end-to-end.** The `e2e/` suite drives the real system in a browser
  (keystrokes → workers → kernel → storage). Do not relabel an integration or smoke
  test as E2E.
- Kernel logic is unit-tested off-WASM via the crate's `rlib` (`cargo test -p kernel`).

## Where things live

- [`crates/kernel`](crates/kernel) — the microkernel (built as a WASM component).
- [`crates/sh`](crates/sh), [`crates/coreutils`](crates/coreutils),
  [`crates/apps`](crates/apps) — userland guests (`wasm32-wasip1` core modules).
- [`packages/host`](packages/host) — the TypeScript host (workers, SAB ring,
  compositor, terminal, blockstores).
- [`wit/`](wit) — the ABI. [`docs/stack/`](docs/stack) explains how WASM, WASI, and
  WIT are used; [`docs/specs/`](docs/specs) holds the design specs; `docs/M*-STATUS.md`
  record the verified exit criteria for each concrete subsystem task.

## Commits & PRs

- Use clear, conventional-style messages (`feat(scope):`, `fix(scope):`,
  `docs:`, `test:`, `chore:`).
- Keep a PR focused; explain what changed and why, and note any difference from a
  spec or plan.
- A PR is ready when `npm run verify` is green with zero regressions.

## License

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
