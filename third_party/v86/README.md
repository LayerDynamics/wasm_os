# Vendored v86 (M5 emulator core)

WASM_OS L5 boots a real Linux by hosting **[v86](https://github.com/copy/v86)** — a
mature x86 emulator with a WASM core — as a single privileged process (FR-27/FR-28).
These files are vendored (not built from source here) and loaded at runtime by
`packages/host/src/worker/emulator-worker.ts`.

## ⚠️ License — GPLv2

**v86 is GPLv2** (see `LICENSE`). Bundling/serving it makes the distributed WASM_OS
subject to GPLv2 for these components. This was an explicit M5 decision (see
`docs/plans/2026-06-01-wasm-os-m5-emulator.md`). If copyleft becomes unacceptable,
the fallback is a permissively-licensed RISC-V core (e.g. TinyEMU, MIT).

## Contents & provenance

| File | Source | Notes |
|------|--------|-------|
| `libv86.mjs` | npm `v86@0.5.359` `build/libv86.mjs` | ESM build; loaded as an external module by the worker (its node-only `require()` branches are runtime-guarded). |
| `v86.wasm` | npm `v86@0.5.359` `build/v86.wasm` | The emulator CPU core (~2 MB). |
| `seabios.bin` | `github.com/copy/v86` `bios/seabios.bin` | PC BIOS. |
| `vgabios.bin` | `github.com/copy/v86` `bios/vgabios.bin` | VGA BIOS. |

The guest Linux image lives separately under `assets/linux/buildroot-bzimage.bin`
(BusyBox/Buildroot bzImage with an embedded initramfs, from copy.sh's v86 demo
images) — it boots to a BusyBox shell on `ttyS0` and auto-mounts a virtio-9p share
named `host9p` on `/mnt` (the hook used for the FR-29 shared folder).
