#!/usr/bin/env bash
# FAST cross-platform glue-determinism spot-check (complements the full
# end-to-end rebuild in tools/ci-linux-determinism.sh).
#
# The only git-tracked Binder output is the jco GLUE (kernel.js + *.d.ts); the
# core *.wasm is gitignored. That glue is emitted by jco (pure JS/wasm) from the
# component's WIT type-section, so the real cross-platform risk is "does jco emit
# identical text on CI's linux/amd64?". This script answers exactly that, quickly,
# by running jco on linux/amd64 against an already-built kernel component and
# diffing the 5 tracked files against the committed copy. No Rust toolchain in the
# container (seconds, not minutes).
#
# Prereq: the kernel component is built locally first:
#   npm run build:kernel
# Run:
#   bash tools/verify-linux-determinism.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WASM_REL="target/wasm32-unknown-unknown/release/kernel.wasm"
if [ ! -f "$REPO/$WASM_REL" ]; then
  echo "kernel component missing at $WASM_REL — run 'npm run build:kernel' first" >&2
  exit 1
fi

cat > /tmp/jco-amd64-check.sh <<'INNER'
set -euo pipefail
echo "== arch / node / jco =="; uname -m; node --version
npm i -g @bytecodealliance/jco@^1.4.0 >/dev/null 2>&1
jco --version
rm -rf /tmp/out; mkdir -p /tmp/out
jco transpile /repo/target/wasm32-unknown-unknown/release/kernel.wasm \
  -o /tmp/out --name kernel --instantiation async --no-nodejs-compat >/dev/null
status=0
for f in kernel.js kernel.d.ts \
         interfaces/wasmos-abi-control.d.ts \
         interfaces/wasmos-abi-home-store.d.ts \
         interfaces/wasmos-abi-mnt-store.d.ts; do
  if diff -q "/repo/packages/abi/generated/$f" "/tmp/out/$f" >/dev/null 2>&1; then
    echo "  IDENTICAL: $f"
  else
    echo "  DIFFERS:   $f"; diff -u "/repo/packages/abi/generated/$f" "/tmp/out/$f" | sed -n '1,30p'; status=1
  fi
done
[ "$status" -eq 0 ] && echo "JCO_AMD64_GLUE_DETERMINISTIC" || echo "JCO_AMD64_GLUE_DRIFT"
exit $status
INNER

exec docker run --rm --platform linux/amd64 \
  -v "$REPO":/repo \
  -v /tmp/jco-amd64-check.sh:/tmp/c.sh \
  node:24-bookworm bash /tmp/c.sh
