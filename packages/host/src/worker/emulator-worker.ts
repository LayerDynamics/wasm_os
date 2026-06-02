/**
 * Emulator worker (L5 / M5) — hosts the MIT TinyEMU riscv64 emulator in a dedicated
 * worker so a real Linux kernel boots in true parallelism, never stalling the main
 * thread or other process workers (FR-28). This is the body of the privileged
 * "emulator" process: it makes no WASI syscalls; it runs TinyEMU's own CPU loop
 * (a self-scheduling emscripten_async_call loop) and talks to the host over
 * postMessage (serial text out, keystrokes in, framebuffer, lifecycle).
 *
 * TinyEMU is MIT (vendored under third_party/tinyemu/), built from source — it
 * replaced the GPLv2 v86 x86 core. The guest is riscv64 Linux on virtio-console
 * (hvc0) with an ext2 rootfs on virtio-block; the boot is asserted on serial TEXT,
 * not pixels.
 */
// The emscripten ES6 module factory (built by third_party/tinyemu/build-from-source.sh).
// Loaded at runtime from the served path, NOT bundled (marked external in the bundle
// script), and resolved same-origin by the module worker's loader. (TinyEMU is MIT.)
import createTinyEmu from "/third_party/tinyemu/riscvemu64-wasm.js";

interface BootMessage {
  type: "boot";
  /** Same-origin URL of the TinyEMU VM config (.cfg) to boot. */
  configUrl: string;
  /** Extra kernel cmdline appended to the cfg's own cmdline. */
  cmdline?: string;
  memoryMb?: number;
  /** Files to seed into the 9p share (FR-29) so the guest sees them in /mnt. */
  shareSeed?: Array<{ name: string; data: Uint8Array }>;
}
type InMessage = BootMessage | { type: "input"; text: string } | { type: "stop" };

/** The instantiated TinyEMU module (emscripten Module with ccall + heap + MEMFS). */
interface EmuFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { size: number; mtime: Date; mode: number };
}
interface EmuModule {
  ccall(name: string, ret: string | null, argTypes: string[], args: unknown[]): unknown;
  HEAPU8: Uint8Array;
  FS: EmuFS;
}
let emu: EmuModule | undefined;

/** The in-memory MEMFS dir backing the FR-29 9p share (cfg fs0 file = /share). */
const SHARE_DIR = "/share";
/** Whether we've auto-mounted the 9p share in the guest (once, at first prompt). */
let mounted = false;
/** Last-seen size+mtime of each shared file, to detect guest write-backs to mirror. */
const shareSnapshot = new Map<string, string>();
let shareWatch: ReturnType<typeof setInterval> | undefined;

/** Send text to the guest console (hvc0) one byte at a time. */
function sendInput(text: string): void {
  if (!emu) return;
  for (const b of new TextEncoder().encode(text)) {
    emu.ccall("console_queue_char", null, ["number"], [b]);
  }
}

/** Mirror any guest writes under the 9p share back to the host VFS (FR-29). */
function pollShareWriteback(): void {
  if (!emu) return;
  let names: string[];
  try {
    names = emu.FS.readdir(SHARE_DIR).filter((n) => n !== "." && n !== "..");
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const st = emu.FS.stat(`${SHARE_DIR}/${name}`);
      const tag = `${st.size}:${st.mtime.getTime()}`;
      if (shareSnapshot.get(name) === tag) continue;
      shareSnapshot.set(name, tag);
      const data = emu.FS.readFile(`${SHARE_DIR}/${name}`);
      ctx.postMessage({ type: "9pWrite", name, data });
    } catch {
      /* a file vanished mid-poll; skip */
    }
  }
}

/** Full serial console captured so far (boot log + shell I/O). */
let serial = "";
let flushQueued = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

const ctx = self as unknown as Worker;

// --- Framebuffer (M5): render the serial console to an RGBA surface ----------
// The guest console is on ttyS0/hvc0 — a byte stream, not a character grid. We keep
// a scrollback of decoded lines (ANSI stripped), render the last `ROWS` of them to
// an OffscreenCanvas, and copy the pixels into a shared RGBA buffer the compositor
// blits to a window (the same surface/present path the M3 canvas apps use).
const CELL_W = 8;
const CELL_H = 16;
const COLS = 80;
const ROWS = 25;
let screen: OffscreenCanvas | undefined;
let screenCtx: OffscreenCanvasRenderingContext2D | undefined;
let fbView: Uint8Array | undefined;
let renderQueued = false;
let surfacePosted = false;

function initScreen(): void {
  if (surfacePosted) return; // open the emulator window exactly once
  surfacePosted = true;
  const w = COLS * CELL_W;
  const h = ROWS * CELL_H;
  screen = new OffscreenCanvas(w, h);
  screenCtx = screen.getContext("2d") ?? undefined;
  if (screenCtx) {
    screenCtx.font = `${CELL_H}px monospace`;
    screenCtx.textBaseline = "top";
  }
  const fbSab = new SharedArrayBuffer(w * h * 4);
  fbView = new Uint8Array(fbSab);
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
  // Strip ANSI escapes + carriage returns, keep the last ROWS lines as a log view.
  const clean = serial.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  const lines = clean.split("\n");
  const view = lines.slice(-ROWS);
  screenCtx.fillStyle = "#0b0e14";
  screenCtx.fillRect(0, 0, screen.width, screen.height);
  screenCtx.fillStyle = "#cdd3de";
  for (let r = 0; r < view.length; r++) {
    const line = view[r] ?? "";
    screenCtx.fillText(line.slice(0, COLS), 0, r * CELL_H);
  }
  const img = screenCtx.getImageData(0, 0, screen.width, screen.height);
  fbView.set(img.data);
  ctx.postMessage({ type: "present" });
}

function flushSerial(): void {
  if (flushQueued) return;
  flushQueued = true;
  setTimeout(() => {
    flushQueued = false;
    ctx.postMessage({ type: "serial", text: serial });
  }, 40);
}

const dec = new TextDecoder();

async function boot(m: BootMessage): Promise<void> {
  // Hooks the (vendored) lib.js calls from inside the wasm module.
  (globalThis as unknown as { __wasmosEmu: unknown }).__wasmosEmu = {
    serial: (bytes: Uint8Array) => {
      serial += dec.decode(bytes, { stream: true });
      flushSerial();
      scheduleRender();
      // FR-29: once the guest shell is up, auto-mount the host 9p share on /mnt and
      // start mirroring guest writes back to the host VFS.
      if (!mounted && /~ #/.test(serial)) {
        mounted = true;
        sendInput("mount -t 9p host9p /mnt -o trans=virtio,version=9p2000.L\n");
        shareWatch = setInterval(pollShareWriteback, 1500);
      }
    },
    consoleSize: () => [COLS, ROWS],
    fb: () => {}, // serial-only boot: no graphics device in the cfg
    downloading: () => {},
  };

  initScreen();
  // Run-to-budget heartbeat (FR-28): report a scheduling quantum while running, so
  // the emulator's CPU activity shows in `top` (it makes no syscalls of its own).
  heartbeat = setInterval(() => ctx.postMessage({ type: "tick" }), 250);

  emu = (await createTinyEmu({
    locateFile: (p: string) => `/third_party/tinyemu/${p}`,
    printErr: () => {},
  })) as EmuModule;

  // FR-29: create the in-memory 9p share dir (cfg fs0 = /share, served by fs_disk)
  // and seed it from the host VFS BEFORE boot, so it exists when fs_disk_init runs.
  try {
    emu.FS.mkdir(SHARE_DIR);
  } catch {
    /* already exists */
  }
  for (const f of m.shareSeed ?? []) {
    try {
      emu.FS.writeFile(`${SHARE_DIR}/${f.name}`, f.data);
      shareSnapshot.set(f.name, ""); // seeded files are host-origin; don't mirror back
    } catch {
      /* skip an unwritable seed entry */
    }
  }

  // vm_start(url, ram_mb, cmdline, pwd, width, height, has_network). Width/height 0 =
  // serial-only (no framebuffer device). The cfg paths resolve against this URL.
  const cfgUrl = new URL(m.configUrl, self.location.origin).href;
  emu.ccall(
    "vm_start",
    null,
    ["string", "number", "string", "string", "number", "number", "number"],
    [cfgUrl, m.memoryMb ?? 128, m.cmdline ?? "", "", 0, 0, 0],
  );
  ctx.postMessage({ type: "started" });
}

ctx.onmessage = (e: MessageEvent<InMessage>) => {
  const d = e.data;
  switch (d.type) {
    case "boot":
      void boot(d);
      break;
    case "input":
      // The guest console is on hvc0; feed each byte to TinyEMU's input fifo.
      sendInput(d.text);
      break;
    case "stop":
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      if (shareWatch !== undefined) clearInterval(shareWatch);
      shareWatch = undefined;
      // The emscripten run loop self-schedules; dropping our reference + clearing the
      // heartbeat stops our involvement. The worker is terminated by the host (M5-T9).
      emu = undefined;
      break;
  }
};
