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
const KERNEL_WIT = join(ROOT, "wit", "kernel", "kernel.wit");
const GUEST_SRC = join(ROOT, "crates", "wasmos-sys", "src", "lib.rs");

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
// not a binding. It is excluded from the drift comparison; the textual bindings
// (.js/.d.ts) are committed and gated.
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
    console.error("binder check: generated bindings are missing — run `binder gen`");
    process.exit(1);
  }
  const tracked = execFileSync("git", ["ls-files", "--cached", "packages/abi/generated"], { cwd: ROOT, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).filter((p) => !p.endsWith(".wasm"));
  if (!tracked.length) {
    console.error("binder check: packages/abi/generated has no tracked textual bindings; stage `binder gen` output");
    process.exit(1);
  }
  const tmp = mkdtempSync(join(tmpdir(), "binder-check-"));
  try {
    transpile(tmp);
    const committed = tracked.map((p) => p.slice("packages/abi/generated/".length));
    const fresh = bindingFiles(tmp).map((p) => relative(tmp, p));
    const drift = [];
    const all = new Set([...committed, ...fresh]);
    for (const rel of all) {
      const a = committed.includes(rel) ? execFileSync("git", ["show", `:${join("packages/abi/generated", rel)}`], { cwd: ROOT, encoding: "utf8" }) : null;
      const b = existsSync(join(tmp, rel)) ? readFileSync(join(tmp, rel), "utf8") : null;
      if (a !== b) drift.push(rel);
    }
    if (drift.length) {
      console.error("binder check FAILED — generated bindings drifted from wit/ + kernel:");
      for (const d of drift) console.error("  " + d);
      console.error("Run `npm run build && git add packages/abi/generated` to refresh the tracked result.");
      process.exit(1);
    }
    console.log("binder check: bindings are in sync.");
    kernelCheck();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if ("(<[{".includes(value[i])) depth += 1;
    if (")>]}".includes(value[i])) depth -= 1;
    if (value[i] === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (value.slice(start).trim()) parts.push(value.slice(start).trim());
  return parts;
}

function splitGeneric(type) {
  const start = type.indexOf("<");
  if (start < 0 || !type.endsWith(">")) return null;
  return [type.slice(0, start), type.slice(start + 1, -1)];
}

function rustTypeForWit(type, { returnType = false } = {}) {
  const t = type.replace(/\s+/g, " ").trim();
  const generic = splitGeneric(t);
  if (generic?.[0] === "list") {
    const inner = rustTypeForWit(generic[1], { returnType });
    if (generic[1].trim() === "u8") return returnType ? "Vec<u8>" : "&[u8]";
    if (generic[1].trim() === "string") return returnType ? "Vec<&str>" : "&[&str]";
    return `Vec<${inner}>`;
  }
  if (generic?.[0] === "result") {
    const values = splitTopLevel(generic[1]);
    return `Result<${rustTypeForWit(values[0], { returnType: true })}, ${rustTypeForWit(values[1], { returnType: true })}>`;
  }
  if (generic?.[0] === "tuple") {
    return returnType ? `(${splitTopLevel(generic[1]).map((v) => rustTypeForWit(v, { returnType: true })).join(", ")})` : "&[Stdio; 3]";
  }
  const primitive = {
    string: "&str",
    bool: "bool",
    u8: "u8",
    u16: "u16",
    u32: "u32",
    u64: "u64",
    s32: "i32",
  }[t];
  if (primitive) return primitive;
  return t.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function parseWitFunctions(wit) {
  const functions = [];
  const pattern = /^\s*([a-z][a-z0-9-]*)\s*:\s*func\(([^)]*)\)(?:\s*->\s*([^;]+))?\s*;/gim;
  for (const match of wit.matchAll(pattern)) {
    const params = splitTopLevel(match[2]).map((param) => {
      const colon = param.indexOf(":");
      if (colon < 0) throw new Error(`invalid WIT parameter: ${param}`);
      return { name: param.slice(0, colon).trim(), type: rustTypeForWit(param.slice(colon + 1), { returnType: false }) };
    });
    functions.push({
      name: match[1].replace(/-/g, "_"),
      params,
      result: match[3] ? rustTypeForWit(match[3], { returnType: true }) : "()",
    });
  }
  return functions;
}

function parseRustFunctions(src) {
  const functions = new Map();
  const pattern = /pub\s+fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^]*?)\)\s*(?:->\s*([^\{]+))?\s*\{/g;
  for (const match of src.matchAll(pattern)) {
    const params = splitTopLevel(match[2].replace(/\/\/[^\n]*/g, "")).map((param) => {
      const colon = param.indexOf(":");
      if (colon < 0) return { name: param.trim(), type: "" };
      return { name: param.slice(0, colon).trim(), type: param.slice(colon + 1).replace(/\s+/g, " ").trim() };
    }).filter((param) => param.name);
    functions.set(match[1], { params, result: match[3] ? match[3].replace(/\s+/g, " ").trim() : "()" });
  }
  return functions;
}

function normalizeRustType(type) {
  return type.replace(/\s+/g, " ").replace(/&'static /g, "&").trim();
}

/**
 * Conformance gate for the wasmos_kernel guest extension. The extension uses a
 * core-module syscall import rather than Component Model calls, so jco cannot
 * emit its transport. Binder still owns the WIT contract and checks every
 * public guest stub's parameter and return types against it; a name-only check
 * would let wire-incompatible changes through.
 */
function kernelCheck() {
  if (!existsSync(KERNEL_WIT) || !existsSync(GUEST_SRC)) {
    console.error("binder kernel-check: wasmos-sys wit/ or src/ missing");
    process.exit(1);
  }
  const witFunctions = parseWitFunctions(readFileSync(KERNEL_WIT, "utf8"));
  const rustFunctions = parseRustFunctions(readFileSync(GUEST_SRC, "utf8"));
  const errors = [];
  for (const wit of witFunctions) {
    const rust = rustFunctions.get(wit.name);
    if (!rust) {
      errors.push(`${wit.name}: missing public Rust function`);
      continue;
    }
    if (rust.params.length !== wit.params.length) {
      errors.push(`${wit.name}: WIT declares ${wit.params.length} parameters, Rust has ${rust.params.length}`);
      continue;
    }
    for (let i = 0; i < wit.params.length; i += 1) {
      const expected = normalizeRustType(wit.params[i].type);
      const actual = normalizeRustType(rust.params[i].type);
      if (expected !== actual) errors.push(`${wit.name}.${wit.params[i].name}: WIT expects ${expected}, Rust has ${actual}`);
    }
    const expectedResult = normalizeRustType(wit.result);
    const actualResult = normalizeRustType(rust.result);
    if (expectedResult !== actualResult) errors.push(`${wit.name}: WIT returns ${expectedResult}, Rust returns ${actualResult}`);
  }
  if (errors.length) {
    console.error("binder kernel-check FAILED — guest stubs do not match kernel.wit:");
    for (const error of errors) console.error("  " + error);
    process.exit(1);
  }
  console.log(`binder kernel-check: ${witFunctions.length} wasmos-sys stubs match kernel.wit signatures.`);
}

const cmd = process.argv[2] ?? "gen";
if (cmd === "gen") gen();
else if (cmd === "check") check();
else if (cmd === "kernel-check") kernelCheck();
else { console.error(`unknown command: ${cmd} (use gen|check|kernel-check)`); process.exit(1); }
