#!/usr/bin/env bash
#
# Materialize the vendored binary assets (emulator core + guest Linux image) into
# their expected locations. These are committed via git-LFS, so a fresh clone or a
# deploy only needs THIS — no emscripten, no Docker, no buildroot. The toolchain is
# only required to *regenerate* the binaries (see third_party/*/build-from-source.sh).
#
#   scripts/setup-vendored-assets.sh
#
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v git-lfs >/dev/null 2>&1; then
  echo "git-lfs is required. Install it:  brew install git-lfs   (or your package manager)"
  exit 1
fi

echo ">> git lfs install + pull"
git lfs install --local
git lfs pull

# Verify the expected assets exist and are REAL files, not unresolved LFS pointers
# (an LFS pointer is a tiny text file beginning with 'version https://git-lfs...').
missing=0
check() {
  local f="$1" min="$2"
  if [ ! -f "$f" ]; then echo "  MISSING: $f"; missing=1; return; fi
  if head -c 64 "$f" | grep -q "git-lfs"; then echo "  UNRESOLVED LFS POINTER: $f (run 'git lfs pull')"; missing=1; return; fi
  local sz; sz=$(wc -c < "$f")
  if [ "$sz" -lt "$min" ]; then echo "  TOO SMALL ($sz bytes): $f"; missing=1; return; fi
  echo "  ok: $f ($sz bytes)"
}

echo ">> verifying vendored assets"
# Whichever emulator core is vendored (v86 today; tinyemu after the RISC-V switch).
[ -e third_party/tinyemu/riscvemu64-wasm.wasm ] && check third_party/tinyemu/riscvemu64-wasm.wasm 50000
[ -e third_party/v86/v86.wasm ] && check third_party/v86/v86.wasm 500000
for img in assets/linux/*.bin; do [ -e "$img" ] && check "$img" 500000; done

if [ "$missing" -ne 0 ]; then
  echo "!! some assets are missing/unresolved — see above"; exit 1
fi
echo "=== vendored assets ready ==="
