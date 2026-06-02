#!/usr/bin/env bash
#
# Reproducibly assemble the vendored riscv64 guest image from upstream sources.
#
# Produces (next to this script):
#   bbl64.bin              riscv-pk Berkeley Boot Loader (BSD)            [bios]
#   kernel-riscv64.bin     Linux kernel raw image (GPLv2 guest payload)  [kernel]
#   root-riscv64.bin       ext2 BusyBox rootfs (canonical raw image)
#   riscv64-rootfs/        the rootfs split into TinyEMU's web block-device format
#                          (blk.txt descriptor + 256KB-aligned blk*.bin chunks)
#
# You do NOT need to run this to use WASM_OS — the binaries are committed via
# git-LFS and served as-is. The Dockerfile runs it so the container is built fully
# from source with no LFS dependency. Requires: curl, tar, gcc, shasum.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

DISKIMAGE_URL="https://bellard.org/tinyemu/diskimage-linux-riscv-2018-09-23.tar.gz"
DISKIMAGE_SHA256="808ecc1b32efdd76103172129b77b46002a616dff2270664207c291e4fde9e14"
# splitimg lives in the TinyEMU source; reuse the same pinned tarball as the core build.
TINYEMU_URL="https://bellard.org/tinyemu/tinyemu-2019-12-21.tar.gz"
TINYEMU_SHA256="be8351f2121819b3172fcedce5cb1826fa12c87da1b7ed98f269d3e802a05555"
# A single block keeps the vendored chunk count minimal (the 4MB disk is one block).
BLOCK_SIZE_KB=4096

command -v gcc >/dev/null || { echo "error: gcc not on PATH"; exit 1; }
# Portable SHA-256 (Linux sha256sum / macOS shasum).
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo ">> download diskimage (bbl + kernel + rootfs)"
curl -fsSL -o disk.tar.gz "$DISKIMAGE_URL"
echo "$DISKIMAGE_SHA256  disk.tar.gz" | sha256 -c -
tar xzf disk.tar.gz
DI="diskimage-linux-riscv-2018-09-23"

echo ">> download TinyEMU source (for splitimg)"
curl -fsSL -o tiny.tar.gz "$TINYEMU_URL"
echo "$TINYEMU_SHA256  tiny.tar.gz" | sha256 -c -
tar xzf tiny.tar.gz
gcc -O2 -DCONFIG_VERSION='"2019-12-21"' -I tinyemu-2019-12-21 \
  tinyemu-2019-12-21/splitimg.c tinyemu-2019-12-21/cutils.c -o splitimg

echo ">> place bios + kernel + raw rootfs"
cp -f "$DI/bbl64.bin" "$DI/kernel-riscv64.bin" "$DI/root-riscv64.bin" "$HERE/"

echo ">> split rootfs into the web block-device format"
rm -rf "$HERE/riscv64-rootfs"
mkdir -p "$HERE/riscv64-rootfs"
./splitimg "$DI/root-riscv64.bin" "$HERE/riscv64-rootfs" "$BLOCK_SIZE_KB"

echo "=== wrote riscv64 image to $HERE ==="
sha256 "$HERE/bbl64.bin" "$HERE/kernel-riscv64.bin" "$HERE/riscv64-rootfs/blk.txt" "$HERE/riscv64-rootfs"/blk*.bin
