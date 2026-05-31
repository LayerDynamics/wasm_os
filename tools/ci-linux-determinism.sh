#!/usr/bin/env bash
# Reproduce the CI build on Linux and prove the committed (mac-generated) WIT
# bindings are byte-identical when regenerated on Linux — i.e. the Binder drift
# gate will not false-fail cross-platform, and generated `kernel.js` is
# deterministic across host OS.
#
# Run from the repo root:
#   docker run --rm -v "$PWD":/src:ro node:24-bookworm bash /src/tools/ci-linux-determinism.sh
#
# It copies the repo into the container (so the host tree / node_modules / target
# are never touched), installs the Rust + component toolchain, rebuilds the
# kernel and regenerates bindings, then `git diff --exit-code` against the
# committed bindings. Exit 0 => deterministic + CI steps green on Linux.
set -euo pipefail

echo "::: 0. system deps :::"
apt-get update -qq
apt-get install -y -qq git curl build-essential >/dev/null

echo "::: 1. copy repo into container (host tree untouched) :::"
cp -r /src /build
cd /build
rm -rf node_modules dist target   # gitignored build dirs carried from the host
git config --global --add safe.directory /build

echo "::: 2. rust toolchain :::"
curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.95.0 --target wasm32-unknown-unknown >/dev/null
. "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

echo "::: 3. component tooling (cargo-component + wasm-tools) :::"
cargo install cargo-component wasm-tools --locked

echo "::: 4. npm ci :::"
npm ci

echo "::: 5. build kernel + regenerate bindings on Linux :::"
npm run build:kernel
npm run binder gen

echo "::: 6. DETERMINISM GATE — committed (mac) bindings vs Linux-regenerated :::"
if git diff --exit-code -- packages/abi/generated; then
  echo "RESULT: DETERMINISTIC_LINUX_OK — bindings byte-identical cross-platform"
else
  echo "RESULT: NON_DETERMINISTIC — Linux bindings differ from committed; see diff above"
  exit 1
fi

echo "::: 7. rust tests on Linux :::"
cargo test -p kernel

echo "::: 8. host (vitest) tests on Linux :::"
npx vitest run

echo "ALL_LINUX_CHECKS_PASSED"
