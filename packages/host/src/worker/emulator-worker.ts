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
  /** Files to seed into the 9p share (M5-T8) so the guest sees them in /mnt. */
  shareSeed?: Array<{ name: string; data: Uint8Array }>;
}
type InMessage =
  | BootMessage
  | { type: "input"; text: string }
  | { type: "stop" };

let emulator: V86 | undefined;
/** Full serial console captured so far (boot log + shell I/O). */
let serial = "";
let flushQueued = false;
/** Run-to-budget heartbeat (M5-T5): a periodic tick the kernel accounts as the
 * emulator's CPU activity (it makes no syscalls of its own). */
let heartbeat: ReturnType<typeof setInterval> | undefined;

const ctx = self as unknown as Worker;

// --- Text-mode framebuffer (M5-T4): render v86's VGA console to an RGBA surface ---
// v86 emits `screen-put-char(row,col,chr)` in text mode; we keep a character grid,
// render it to an OffscreenCanvas, and copy the pixels into a shared RGBA buffer
// that the compositor blits to a window (the same surface/present path the M3
// canvas apps use). The console stays 80x25 text — graphics mode is not needed to
// boot to a shell.
const CELL_W = 9;
const CELL_H = 16;
let cols = 80;
let rows = 25;
let grid = new Uint16Array(cols * rows).fill(32);
let screen: OffscreenCanvas | undefined;
let screenCtx: OffscreenCanvasRenderingContext2D | undefined;
let fbSab: SharedArrayBuffer | undefined;
let fbView: Uint8Array | undefined;
let renderQueued = false;

function initScreen(): void {
  const w = cols * CELL_W;
  const h = rows * CELL_H;
  screen = new OffscreenCanvas(w, h);
  screenCtx = screen.getContext("2d") ?? undefined;
  if (screenCtx) {
    screenCtx.font = `${CELL_H}px monospace`;
    screenCtx.textBaseline = "top";
  }
  fbSab = new SharedArrayBuffer(w * h * 4);
  fbView = new Uint8Array(fbSab);
  // Hand the shared framebuffer to the host, which opens the emulator's window.
  ctx.postMessage({ type: "surface", width: w, height: h, sab: fbSab });
  scheduleRender();
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    renderScreen();
  }, 50); // ~20fps coalesced
}

function renderScreen(): void {
  if (!screen || !screenCtx || !fbView) return;
  screenCtx.fillStyle = "#0b0e14";
  screenCtx.fillRect(0, 0, screen.width, screen.height);
  screenCtx.fillStyle = "#cdd3de";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const chr = grid[r * cols + c];
      if (chr && chr !== 32) {
        screenCtx.fillText(String.fromCharCode(chr), c * CELL_W, r * CELL_H);
      }
    }
  }
  const img = screenCtx.getImageData(0, 0, screen.width, screen.height);
  fbView.set(img.data);
  ctx.postMessage({ type: "present" });
}

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
    // virtio-9p shared folder (M5-T8, FR-29): an empty 9p fs the guest auto-mounts
    // (the buildroot image mounts the `host9p` tag on /mnt). We seed it from the
    // host VFS below and mirror guest writes back.
    filesystem: {},
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

  // virtio-9p shared folder (M5-T8): seed the share AFTER the guest attaches to the
  // 9p fs (mounts /mnt) — seeding before/during the attach handshake gives EBUSY.
  emulator.add_listener("9p-attach", (() => {
    for (const f of m.shareSeed ?? []) {
      void emulator?.create_file(f.name, f.data);
    }
  }) as (a: never) => void);
  // When the guest writes a file under the share, read it back and mirror it to the
  // host VFS.
  emulator.add_listener("9p-write-end", (([filename]: [string, number]) => {
    const name = filename.replace(/^\/+/, "");
    void emulator
      ?.read_file(name)
      .then((data) => ctx.postMessage({ type: "9pWrite", name, data }))
      .catch(() => {});
  }) as (a: never) => void);

  // Run-to-budget heartbeat (M5-T5): report a scheduling quantum while running.
  heartbeat = setInterval(() => ctx.postMessage({ type: "tick" }), 250);

  // Framebuffer (M5-T4): mirror the VGA text console into the shared RGBA surface.
  initScreen();
  emulator.add_listener("screen-set-size", (([w, h, bpp]: [number, number, number]) => {
    // Text mode only (bpp 0). Re-init if the console resized before any drawing.
    if (bpp === 0 && w > 0 && h > 0 && w <= 240 && h <= 100 && (w !== cols || h !== rows)) {
      cols = w;
      rows = h;
      grid = new Uint16Array(cols * rows).fill(32);
      initScreen();
    }
  }) as (a: never) => void);
  emulator.add_listener("screen-put-char", (([row, col, chr]: [number, number, number]) => {
    if (row >= 0 && row < rows && col >= 0 && col < cols) {
      grid[row * cols + col] = chr;
      scheduleRender();
    }
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
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      void emulator?.destroy();
      emulator = undefined;
      break;
  }
};
