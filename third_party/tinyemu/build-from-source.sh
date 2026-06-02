#!/usr/bin/env bash
#
# Reproducibly build the MIT TinyEMU riscv64 core to WASM.
#
# This is the recipe behind the vendored binaries in this directory
# (riscvemu64-wasm.wasm + riscvemu64-wasm.js). You do NOT need to run it to use
# WASM_OS — the built binaries are committed via git-LFS and served as-is. Run it
# only to (re)generate or audit them from upstream MIT source.
#
# Requirements: emscripten (emcc) on PATH. No riscv toolchain is involved — emcc
# targets wasm32; the emulator C source becomes the WASM core.
#
#   third_party/tinyemu/build-from-source.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_URL="https://bellard.org/tinyemu/tinyemu-2019-12-21.tar.gz"
SRC_SHA256="be8351f2121819b3172fcedce5cb1826fa12c87da1b7ed98f269d3e802a05555"
SRC_DIR="tinyemu-2019-12-21"

command -v emcc >/dev/null || { echo "error: emcc (emscripten) not on PATH"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo ">> download $SRC_URL"
curl -fsSL -o src.tar.gz "$SRC_URL"
echo "$SRC_SHA256  src.tar.gz" | shasum -a 256 -c -
tar xzf src.tar.gz
cd "$SRC_DIR"

# -DEMSCRIPTEN: route fs_wget/fs_net to TinyEMU's BUILTIN crypto (bundled aes.h +
# sha256.h), NOT openssl. Modern emscripten only defines __EMSCRIPTEN__, so the
# source's `#if defined(EMSCRIPTEN)` guards would otherwise take the openssl path.
# We build ONLY the wasm riscv64 target (the 2019 Makefile.js also builds asm.js +
# rv32, which modern emscripten dropped / we don't need).
CFLAGS=(-O2 -DEMSCRIPTEN -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -fno-strict-aliasing
        -DCONFIG_FS_NET -Wno-implicit-function-declaration -Wno-incompatible-pointer-types
        -Wno-int-conversion -Wno-implicit-int -Wno-deprecated-pragma)

OBJS=(jsemu softfp virtio fs fs_net fs_wget fs_utils simplefb pci json block_net
      iomem cutils aes sha256 riscv_machine machine)
for o in "${OBJS[@]}"; do emcc "${CFLAGS[@]}" -c -o "$o.js.o" "$o.c"; done
emcc "${CFLAGS[@]}" -DMAX_XLEN=64 -DCONFIG_RISCV_MAX_XLEN=64 -c -o riscv_cpu64.js.o riscv_cpu.c

# Exported C entrypoints driven from JS (see emulator-worker.ts), plus ccall/cwrap.
LDFLAGS=(-O3 --closure 0
  -sEXIT_RUNTIME=0 -sFILESYSTEM=0 -sWASM=1 -sINITIAL_MEMORY=67108864 -sALLOW_MEMORY_GROWTH=1
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  # ES6 module factory: emulator-worker.ts is a module worker that imports it; the
  # repo is "type":"module" so a CommonJS output would be mis-parsed as ESM.
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTinyEmu
  "-sEXPORTED_FUNCTIONS=['_console_queue_char','_vm_start','_fs_import_file','_display_key_event','_display_mouse_event','_display_wheel_event','_net_write_packet','_net_set_carrier']"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap']"
  # Worker glue (vendored next to this script), NOT upstream js/lib.js which targets
  # the jslinux HTML page (globals term/Browser/document). Ours delegates the C
  # imports to hooks emulator-worker.ts installs (serial/framebuffer/9p, no DOM).
  --js-library "$HERE/lib.js")
emcc "${LDFLAGS[@]}" -o riscvemu64-wasm.js \
  riscv_cpu64.js.o riscv_machine.js.o machine.js.o jsemu.js.o softfp.js.o virtio.js.o \
  fs.js.o fs_net.js.o fs_wget.js.o fs_utils.js.o simplefb.js.o pci.js.o json.js.o \
  block_net.js.o iomem.js.o cutils.js.o aes.js.o sha256.js.o

cp -f riscvemu64-wasm.js riscvemu64-wasm.wasm MIT-LICENSE.txt "$HERE/"
echo "=== wrote artifacts to $HERE ==="
shasum -a 256 "$HERE/riscvemu64-wasm.wasm" "$HERE/riscvemu64-wasm.js"
