# `guests/zig/` — Zig guest programs

The Zig half of the FR-14 polyglot proof. A second toolchain produces a guest
that runs through the *identical* kernel process path as the Rust coreutils,
demonstrating that WASM_OS is language-agnostic at the ABI boundary.

## Contents

- **`echo.zig`** — a `wasm32-wasi` build of `echo`, observably **byte-for-byte
  identical** to the Rust `crates/coreutils` `echo`. It talks raw WASI Preview 1
  (`args_sizes_get`/`args_get` to read argv, `fd_write` to emit stdout) and
  deliberately uses only long-stable `std` APIs (no `ArrayList`/`File`/`Io`
  churn) so it builds across Zig releases.

## Build

```sh
npm run build:guests:zig
# => zig build-exe guests/zig/echo.zig -target wasm32-wasi -O ReleaseSmall \
#       -femit-bin=packages/host/guests/echo.zig.wasm
```

`npm run build:guests` runs this automatically after the Cargo guests. The
emitted `.wasm` is installed at `/bin/echo.zig` by the host loader (see the
`BIN` list in `packages/host/src/index.ts`).

## Toolchain

Build verified on Zig **0.16.0-dev** (local) and **0.14.1** (the version pinned
in CI via `mlugg/setup-zig`). `tools/bootstrap.sh` installs Zig locally.

## Tests

- **`packages/host/test/polyglot-echo.test.ts`** runs `echo.wasm` (Rust) and
  `echo.zig.wasm` (Zig) through a real WASI runtime (`node:wasi`) and byte-diffs
  their stdout across six argument shapes.
- **`e2e/terminal.spec.ts`** runs `echo.zig` live through the terminal → shell →
  `wasmos_kernel` spawn path in a real browser.

## Adding another Zig coreutil

1. Drop `<name>.zig` in this directory.
2. Add a `zig build-exe … -femit-bin=packages/host/guests/<name>.zig.wasm` step
   to `build:guests:zig` in `package.json`.
3. Add `"<name>.zig"` to the `BIN` list in `packages/host/src/index.ts`.
