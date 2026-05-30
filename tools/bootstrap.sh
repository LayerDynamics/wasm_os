#!/usr/bin/env bash
set -euo pipefail

echo "== Rust targets =="
rustup target add wasm32-wasip1 wasm32-unknown-unknown

echo "== cargo-component (kernel -> WASM component) =="
command -v cargo-component >/dev/null 2>&1 || cargo install cargo-component --locked

echo "== wasm-tools (component inspect/validate) =="
command -v wasm-tools >/dev/null 2>&1 || cargo install wasm-tools --locked

echo "== wit-bindgen CLI (binding inspection) =="
command -v wit-bindgen >/dev/null 2>&1 || cargo install wit-bindgen-cli --locked

echo "== binaryen (wasm-opt) =="
command -v wasm-opt >/dev/null 2>&1 || brew install binaryen

echo "== wabt (wat2wasm, for hand-written WAT later) =="
command -v wat2wasm >/dev/null 2>&1 || brew install wabt

echo "== node deps (jco, vitest, playwright via package.json) =="
npm install

echo "== Playwright browser =="
npx playwright install chromium

echo "All toolchain components installed."
