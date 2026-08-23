# `guests/` — non-Cargo guest programs

Guest programs for WASM_OS that are **not** built by Cargo live here. The Rust
guests (`hello`, `crash`, `catfile`, `sh`, the 21 `coreutils`) are Cargo crates
under [`crates/`](../crates) and are built with `cargo build --target
wasm32-wasip1`. Anything compiled by a *different* toolchain lives in `guests/`
so it has an obvious, language-named home instead of being wedged into the Cargo
workspace.

| Subdir | Toolchain | Target | Contents |
|--------|-----------|--------|----------|
| [`zig/`](./zig) | Zig (`zig build-exe`) | `wasm32-wasi` | `echo.zig` — the FR-14 polyglot guest |
| [`wat/`](./wat) | WABT (`wat2wasm`) | WASI Preview 1 core module | `watinfo.wat` — reads live `/proc/uptime` and writes it to stdout |

All guests, regardless of toolchain, compile to the **same WASI Preview 1 ABI**
and are installed into the VFS `/usr/bin` and compatibility `/bin` paths by the
host loader ([`packages/host/src/index.ts`](../packages/host/src/index.ts)), so the kernel
runs them through one identical process path. That is the whole point of the
polyglot story: the OS does not care what language a program was written in.

## Build

`npm run build:guests` builds every guest — the Cargo programs, the Zig programs,
and the WAT utility — and copies the resulting `.wasm` files into
`packages/host/guests/` (gitignored build output). The separate steps are
`npm run build:guests:zig` and `npm run build:guests:wat`.
