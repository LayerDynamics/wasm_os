/**
 * Emulator worker (L5 / M5) — hosts the v86 x86 emulator in a dedicated worker so
 * a real Linux kernel boots in true parallelism, never stalling the main thread or
 * other process workers (FR-28). This is the body of the privileged "emulator"
 * process: it makes no WASI syscalls; it runs v86's own CPU loop and talks to the
 * host over postMessage (serial text out, keystrokes in, lifecycle).
 *
 * v86 is GPLv2 (vendored under third_party/v86/). For M5-T1 it boots serial-only
 * (no screen) so the boot can be asserted on serial-console TEXT, not pixels.
 */
// Loaded at runtime from the served path (NOT bundled): libv86.mjs contains
// node-only `require("perf_hooks"/"fs"/"crypto")` branches that are guarded by
// runtime environment checks (the browser takes the `performance.now` path), but
// esbuild can't statically bundle them. It is marked external in the bundle script
// and resolved same-origin by the worker's module loader. (v86 is GPLv2.)
import { V86 } from "/third_party/v86/libv86.mjs";

interface BootMessage {
  type: "boot";
  /** Same-origin URLs for the v86 runtime + guest image. */
  wasmPath: string;
  bios: string;
  vgaBios: string;
  bzimage: string;
  cmdline: string;
  memoryMb?: number;
}
type InMessage =
  | BootMessage
  | { type: "input"; text: string }
  | { type: "stop" };

let emulator: V86 | undefined;
/** Full serial console captured so far (boot log + shell I/O). */
let serial = "";
let flushQueued = false;

const ctx = self as unknown as Worker;

function flushSerial(): void {
  if (flushQueued) return;
  flushQueued = true;
  // Coalesce byte-at-a-time serial output into one post per macrotask tick.
  setTimeout(() => {
    flushQueued = false;
    ctx.postMessage({ type: "serial", text: serial });
  }, 40);
}

function boot(m: BootMessage): void {
  emulator = new V86({
    wasm_path: m.wasmPath,
    bios: { url: m.bios },
    vga_bios: { url: m.vgaBios },
    bzimage: { url: m.bzimage },
    cmdline: m.cmdline,
    autostart: true,
    disable_speaker: true,
    // No screen_container: serial-only headless boot (M5-T1). The framebuffer
    // surface is wired in M5-T4.
    memory_size: (m.memoryMb ?? 64) * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
  });
  // Decode the guest's ttyS0 byte stream into the running console text.
  const decoder = new TextDecoder();
  emulator.add_listener("serial0-output-byte", ((byte: number) => {
    serial += decoder.decode(new Uint8Array([byte]), { stream: true });
    flushSerial();
  }) as (a: never) => void);
  emulator.add_listener("emulator-started", (() => {
    ctx.postMessage({ type: "started" });
  }) as (a: never) => void);
}

ctx.onmessage = (e: MessageEvent<InMessage>) => {
  const d = e.data;
  switch (d.type) {
    case "boot":
      boot(d);
      break;
    case "input":
      // The guest console is on ttyS0, so serial is the shell's stdin (M5-T3).
      emulator?.serial0_send(d.text);
      break;
    case "stop":
      void emulator?.destroy();
      emulator = undefined;
      break;
  }
};
