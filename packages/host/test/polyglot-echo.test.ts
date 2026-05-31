// FR-14 polyglot proof: the Zig-built `echo` must be observably identical to the
// Rust-built `echo`. Both are plain WASI Preview 1 modules, so we run each through
// a real WASI runtime (Node's `node:wasi`, the same ABI the kernel speaks) and
// assert byte-for-byte identical stdout across a spread of argument shapes.
//
// Inputs are the artifacts `npm run build:guests` installs into
// packages/host/guests/ (echo.wasm = Rust, echo.zig.wasm = Zig). `verify` runs
// build:guests before test:host so these exist; we fail loudly if they don't,
// rather than silently skipping the proof.
import { describe, it, expect, beforeAll } from "vitest";
import { WASI } from "node:wasi";
import { readFileSync, openSync, closeSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const guests = fileURLToPath(new URL("../guests/", import.meta.url));
const RUST = join(guests, "echo.wasm");
const ZIG = join(guests, "echo.zig.wasm");

const scratch = mkdtempSync(join(tmpdir(), "polyglot-echo-"));
let counter = 0;

/** Run an echo `.wasm` with `args` through node:wasi; return the exact stdout bytes. */
function runEcho(wasmPath: string, args: string[]): Uint8Array {
  const outPath = join(scratch, `out-${counter++}.bin`);
  const fd = openSync(outPath, "w");
  try {
    const wasi = new WASI({
      version: "preview1",
      args: ["echo", ...args],
      env: {},
      stdout: fd,
      returnOnExit: true,
    });
    const mod = new WebAssembly.Module(readFileSync(wasmPath));
    // node:wasi types getImportObject() loosely; it is a valid WASM imports object.
    const imports = wasi.getImportObject() as unknown as WebAssembly.Imports;
    const instance = new WebAssembly.Instance(mod, imports);
    wasi.start(instance);
  } finally {
    closeSync(fd);
  }
  return readFileSync(outPath);
}

describe("FR-14 polyglot echo (Zig ≡ Rust)", () => {
  beforeAll(() => {
    if (!existsSync(RUST) || !existsSync(ZIG)) {
      throw new Error(
        `Missing guest binaries (RUST=${existsSync(RUST)}, ZIG=${existsSync(ZIG)}). ` +
          `Run \`npm run build:guests\` first (verify does this before test:host).`,
      );
    }
  });

  // Edge shapes that would expose any divergence in joining/spacing/termination.
  const cases: Array<{ name: string; args: string[]; expect: string }> = [
    { name: "two words", args: ["hello", "world"], expect: "hello world\n" },
    { name: "single arg", args: ["a"], expect: "a\n" },
    { name: "no args → bare newline", args: [], expect: "\n" },
    { name: "embedded double space preserved", args: ["spaces  preserved?", "x"], expect: "spaces  preserved? x\n" },
    { name: "embedded tab preserved", args: ["tab\there"], expect: "tab\there\n" },
    { name: "many args", args: ["1", "2", "3", "4", "5"], expect: "1 2 3 4 5\n" },
  ];

  for (const c of cases) {
    it(`produces identical bytes: ${c.name}`, () => {
      const rust = runEcho(RUST, c.args);
      const zig = runEcho(ZIG, c.args);
      const dec = new TextDecoder();
      // Both match the documented contract...
      expect(dec.decode(rust)).toBe(c.expect);
      expect(dec.decode(zig)).toBe(c.expect);
      // ...and, more strongly, are byte-for-byte equal to each other.
      expect(Buffer.from(zig).equals(Buffer.from(rust))).toBe(true);
    });
  }
});
