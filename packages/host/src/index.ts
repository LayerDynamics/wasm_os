import { boot, type BootResult } from "./boot.js";
import { attachTerminal, type TerminalSession } from "./term/terminal.js";
import { Compositor } from "./compositor/compositor.js";
import { SurfaceManager } from "./compositor/surface.js";
import { SessionManager } from "./compositor/session.js";
import { InputRouter } from "./compositor/input.js";
import { ThemeManager } from "./compositor/theme.js";

/** Executables loaded into the VFS `/bin` at boot (tmpfs, repopulated each boot). */
// "echo.zig" is the Zig-built sibling of "echo" (FR-14 polyglot proof): same WASI
// ABI, observably identical output, runs through the exact same kernel process path.
// "crash" is the fault-injection guest (FR-34): it traps on purpose so the
// crash-containment path (a trapped process must not take down the shell) is
// exercisable from the terminal.
const BIN = [
  "sh", "echo", "cat", "grep", "ls", "wc", "cp", "mv", "rm", "mkdir", "pwd", "head", "tail", "env",
  "echo.zig", "crash",
  // M3 graphical apps (canvas surfaces); launchable from the file manager.
  // "mandelbrot" is the Zig polyglot app (FR-14 on the graphics path).
  "gfxspike", "filemanager", "paint", "editor", "mandelbrot", "sysmon", "spinner", "chandemo", "shmdemo", "sigdemo", "kill", "renice", "ps", "top", "fetch",
];
const GUESTS = "/packages/host/guests";

/** Boot result + cold-load timing + the running shell/terminal session. */
export type ReadyState = BootResult & {
  coldLoadMillis: number;
  shellPid: number;
  term: TerminalSession;
  compositor: Compositor;
  surfaces: SurfaceManager;
  session: SessionManager;
};

declare global {
  interface Window {
    __wasmos?: ReadyState;
  }
}

/** Fetch a built guest `.wasm` and install it into the VFS `/bin`. */
async function loadBin(control: BootResult["control"], name: string): Promise<ArrayBuffer> {
  const bytes = await (await fetch(`${GUESTS}/${name}.wasm`)).arrayBuffer();
  await control.fsWrite(`/bin/${name}`, new Uint8Array(bytes));
  return bytes;
}

/** Translate a 12-byte brokered key record (see compositor/input.ts) into the
 * text/escape sequence a serial console expects (M5-T4). Only key-down produces
 * output; key-up and unmapped keys yield "". */
function keyEventToConsoleText(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = dv.getUint8(0);
  if (kind !== 4) return ""; // EV_KEY_DOWN only
  const key = dv.getUint32(6, true);
  if (key < 0x100) return String.fromCharCode(key); // printable (layout+shift applied)
  switch (key) {
    case 0x100: return "\n"; // Enter
    case 0x101: return "\x7f"; // Backspace → DEL
    case 0x102: return "\x1b[D"; // ArrowLeft
    case 0x103: return "\x1b[C"; // ArrowRight
    case 0x104: return "\x1b[A"; // ArrowUp
    case 0x105: return "\x1b[B"; // ArrowDown
    case 0x106: return "\t"; // Tab
    case 0x107: return "\x1b"; // Escape
    default: return "";
  }
}

async function main() {
  const result = await boot();
  // Capture full cold-load (navigation start → kernel ready) BEFORE the userland
  // spins up, so this stays comparable to M0/M1.
  const coldLoadMillis = Math.round(performance.now());
  const { control } = result;

  // Populate /bin, then launch the shell as a terminal-bound process.
  const bins: Record<string, ArrayBuffer> = {};
  for (const name of BIN) bins[name] = await loadBin(control, name);
  const shellPid = await control.spawn(bins.sh!, {
    name: "sh",
    grantSpawn: true,
    grantFsSubtree: "/",
    grantSignal: true, // the user's process-control authority: enables `kill` (M4-T5)
    grantNet: true, // brokered networking authority: enables `fetch` (M5-T6)
  });
  await control.bindTerminal(shellPid);

  // Bring up the desktop compositor and run the terminal inside its first window
  // (a DOM surface). The content host keeps id="terminal" so xterm sizing + the
  // existing E2E selectors continue to work under the compositor.
  const desktop = document.getElementById("desktop") ?? document.body;
  const taskbarEl = document.getElementById("taskbar") ?? document.body;
  const compositor = new Compositor(desktop, taskbarEl);

  // Desktop theme + wallpaper, persisted to /home (FR-26); applied on boot.
  new ThemeManager(control, desktop, taskbarEl);

  // The emulator processes (M5) — their windows route keys to the guest console as
  // text, not as brokered input-event records (they make no win_read_input syscall).
  const emulatorPids = new Set<number>();

  // Brokered input (M3-T3): the focused canvas window's keyboard/mouse is routed
  // to its owning process; keys target the active canvas window. For an emulator
  // window, keystrokes are translated to console text and sent to the guest (M5-T4).
  const inputRouter = new InputRouter(
    (pid, bytes) => {
      if (emulatorPids.has(pid)) {
        const text = keyEventToConsoleText(bytes);
        if (text) void control.emulatorInput(pid, text);
      } else {
        void control.deliverInput(pid, bytes);
      }
    },
    () => {
      const w = compositor.activeWindow();
      return w && w.surface === "canvas" ? w.ownerPid : undefined;
    },
  );

  // Process-owned canvas surfaces (M3): a process calls win_surface → a canvas
  // window opens here and its shared framebuffer is blitted on present.
  const surfaces = new SurfaceManager(compositor, (canvas, pid) => inputRouter.bindCanvas(canvas, pid));
  control.onSurface((info) => surfaces.onSurface(info));
  control.onPresent((id) => surfaces.onPresent(id));

  // Closing a process window reaps the owning process (M3-T9); a process that
  // exits or traps has its windows closed (crash containment, FR-34).
  compositor.onWindowClosed = (id, ownerPid) => {
    surfaces.closeByWindow(id);
    if (ownerPid !== undefined) void control.kill(ownerPid);
  };
  control.onExit((pid) => {
    compositor.closeByOwner(pid);
    emulatorPids.delete(pid);
  });

  // Session snapshot/restore (M4-T9, FR-35): records open app windows + geometry
  // to /home/.session.json and re-opens them on the next boot.
  const session = new SessionManager(control, compositor);

  // The launchable graphical apps + their minimal capability sets. Registered
  // with the SessionManager so the taskbar launcher AND session restore spawn
  // them the same way (and each launch is tagged for persistence).
  type AppOpts = { grantGpu?: boolean; grantInput?: boolean; grantSpawn?: boolean; grantSignal?: boolean; grantFsSubtree?: string };
  const APPS: Array<{ name: string; label: string; opts: AppOpts }> = [
    { name: "filemanager", label: "Files", opts: { grantGpu: true, grantInput: true, grantSpawn: true, grantFsSubtree: "/" } },
    { name: "paint", label: "Paint", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/" } },
    { name: "editor", label: "Editor", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/" } },
    { name: "mandelbrot", label: "Mandelbrot", opts: { grantGpu: true, grantInput: true } },
    // System Monitor needs Signal (process control) in addition to Gpu+Input.
    { name: "sysmon", label: "Monitor", opts: { grantGpu: true, grantInput: true, grantSignal: true } },
  ];
  for (const app of APPS) {
    session.register(app.name, () => control.spawn(bins[app.name]!, { name: app.name, ...app.opts }));
  }
  // Launch the privileged emulator process (M5): boots real Linux into a window.
  const launchLinux = async () => {
    const pid = await control.spawnEmulator({ name: "linux", bzimage: "/assets/linux/buildroot-bzimage.bin" });
    emulatorPids.add(pid);
  };
  compositor.setLauncherApps([
    ...APPS.map((a) => ({ label: a.label, launch: () => void session.launch(a.name) })),
    { label: "Linux", launch: () => void launchLinux() },
  ]);

  const termWin = compositor.open({ title: "Terminal — sh", width: 724, height: 460, ownerPid: shellPid, surface: "dom" });
  const termHost = document.createElement("div");
  termHost.id = "terminal";
  termWin.content.appendChild(termHost);
  const term = attachTerminal(termHost, control, shellPid);

  const state: ReadyState = { ...result, coldLoadMillis, shellPid, term, compositor, surfaces, session };
  window.__wasmos = state;

  const status = document.getElementById("status");
  if (status) {
    status.textContent = `ready in ${coldLoadMillis}ms · tier ${result.features.tier} · shell pid ${shellPid}`;
  }
  window.dispatchEvent(
    new CustomEvent("wasmos:ready", { detail: { bootMillis: result.bootMillis, coldLoadMillis, features: result.features } }),
  );

  // Re-open the apps from the previous session (FR-35). Fire-and-forget: their
  // windows stream in as each process boots and requests its surface.
  void session.restore();
}

main().catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  throw e;
});
