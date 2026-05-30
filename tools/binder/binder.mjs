#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Kernel is a pure component (wasm32-unknown-unknown): its only imports are
// home-store/mnt-store. Building for wasip1 would link std's phantom WASI imports.
const KERNEL_WASM = join(ROOT, "target", "wasm32-unknown-unknown", "release", "kernel.wasm");
const OUT = join(ROOT, "packages", "abi", "generated");

function transpile(outDir) {
  if (!existsSync(KERNEL_WASM)) {
    throw new Error(`kernel component not found at ${KERNEL_WASM} — run \`npm run build:kernel\` first`);
  }
  mkdirSync(outDir, { recursive: true });
  // jco transpile in INSTANTIATION mode so the host can inject the home-store /
  // mnt-store imports at runtime (default mode resolves imports via generated
  // ESM and exposes no `instantiate`, which boot.ts depends on).
  execFileSync("npx", ["jco", "transpile", KERNEL_WASM, "-o", outDir, "--name", "kernel",
    "--instantiation", "async", "--no-nodejs-compat"],
    { cwd: ROOT, stdio: "inherit" });
}

// The generated *.core*.wasm is a build artifact (a split-out copy of the kernel),
// not a binding. It is .gitignored and excluded from the drift comparison; only the
// textual bindings (.js/.d.ts) are committed and gated.
function bindingFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...bindingFiles(p));
    else if (!e.name.endsWith(".wasm")) out.push(p);
  }
  return out.sort();
}

function gen() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  transpile(OUT);
  console.log(`binder gen: wrote bindings to ${relative(ROOT, OUT)}`);
}

function check() {
  if (!existsSync(OUT)) {
    console.error("binder check: no committed bindings at packages/abi/generated — run `binder gen`");
    process.exit(1);
  }
  const tmp = mkdtempSync(join(tmpdir(), "binder-check-"));
  try {
    transpile(tmp);
    const committed = bindingFiles(OUT).map((p) => relative(OUT, p));
    const fresh = bindingFiles(tmp).map((p) => relative(tmp, p));
    const drift = [];
    const all = new Set([...committed, ...fresh]);
    for (const rel of all) {
      const a = existsSync(join(OUT, rel)) ? readFileSync(join(OUT, rel), "utf8") : null;
      const b = existsSync(join(tmp, rel)) ? readFileSync(join(tmp, rel), "utf8") : null;
      if (a !== b) drift.push(rel);
    }
    if (drift.length) {
      console.error("binder check FAILED — generated bindings drifted from wit/ + kernel:");
      for (const d of drift) console.error("  " + d);
      console.error("Run `npm run build && npm run binder gen` and commit the result.");
      process.exit(1);
    }
    console.log("binder check: bindings are in sync.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const cmd = process.argv[2] ?? "gen";
if (cmd === "gen") gen();
else if (cmd === "check") check();
else { console.error(`unknown command: ${cmd} (use gen|check)`); process.exit(1); }
