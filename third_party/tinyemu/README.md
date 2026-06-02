# Vendored TinyEMU (M5 emulator core — RISC-V, permissive)

WASM_OS L5 boots a real Linux by hosting a CPU emulator with a WASM core as a
single privileged process (FR-27/FR-28). This is the **permissively-licensed**
core that replaced the GPLv2 `third_party/v86/`: **[TinyEMU](https://bellard.org/tinyemu/)**,
a riscv64 emulator by Fabrice Bellard, built from source to WASM.

## ✅ License — MIT

TinyEMU is **MIT** (see `MIT-LICENSE.txt`, © 2016–2018 Fabrice Bellard). Bundling and
serving these binaries imposes **no copyleft** on WASM_OS — the reason for the switch
away from v86 (GPLv2). The guest Linux kernel under `assets/linux/` is GPLv2, but it
runs as a guest *payload* the emulator executes (mere aggregation, like shipping any
distro image) — it does not reach the application's own code.

## Contents & provenance

| File | Source | Notes |
|------|--------|-------|
| `riscvemu64-wasm.wasm` | built from TinyEMU `2019-12-21` | The riscv64 emulator CPU core. |
| `riscvemu64-wasm.js` | built (emscripten glue) | Module loader; links `lib.js` (below). |
| `lib.js` | this repo (worker glue) | Implements the emscripten `--js-library` imports against worker hooks (serial / framebuffer / 9p), replacing upstream `js/lib.js` which targets the jslinux HTML page. |
| `MIT-LICENSE.txt` | TinyEMU `2019-12-21` | The upstream MIT license, copied verbatim. |

Upstream source: `https://bellard.org/tinyemu/tinyemu-2019-12-21.tar.gz`
SHA-256 `be8351f2121819b3172fcedce5cb1826fa12c87da1b7ed98f269d3e802a05555`.

## Using these binaries (clone / deploy) — no toolchain needed

The binaries are committed via **git-LFS** (see `.gitattributes`). A fresh clone or a
server deploy only needs the LFS objects, not emscripten/Docker:

```sh
scripts/setup-vendored-assets.sh   # = git lfs install && git lfs pull + a sanity check
```

This is the same model the previous v86 core already used.

## Regenerating the core from source (maintainer / CI only)

Only needed to rebuild or audit the `.wasm`. Requires `emcc` (emscripten) on PATH — no
RISC-V toolchain is involved (emcc targets wasm32; the emulator C source becomes the
WASM core):

```sh
third_party/tinyemu/build-from-source.sh
```

The recipe downloads the pinned MIT source, applies one small documented patch (the
FR-29 9p backend: back `fs0` with the MEMFS-backed `fs_disk` instead of the network
filesystem), builds **only** the riscv64 wasm target with modern-emscripten flags
(`-DEMSCRIPTEN` routes crypto to TinyEMU's builtin AES/SHA, so there is **no openssl
dependency**), links our worker `lib.js`, and writes the artifacts here.

The guest riscv64 Linux image is vendored separately under `assets/linux/` with its own
from-source recipe.
