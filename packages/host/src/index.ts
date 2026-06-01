import { boot, type BootResult } from "./boot.js";
import { attachTerminal, type TerminalSession } from "./term/terminal.js";
import { Compositor } from "./compositor/compositor.js";
import { SurfaceManager } from "./compositor/surface.js";
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
  "gfxspike", "filemanager", "paint", "editor", "mandelbrot", "spinner", "chandemo", "shmdemo",
];
const GUESTS = "/packages/host/guests";

/** Boot result + cold-load timing + the running shell/terminal session. */
export type ReadyState = BootResult & {
  coldLoadMillis: number;
  shellPid: number;
  term: TerminalSession;
  compositor: Compositor;
  surfaces: SurfaceManager;
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

async function main() {
  const result = await boot();
  // Capture full cold-load (navigation start → kernel ready) BEFORE the userland
  // spins up, so this stays comparable to M0/M1.
  const coldLoadMillis = Math.round(performance.now());
  const { control } = result;

  // Populate /bin, then launch the shell as a terminal-bound process.
  const bins: Record<string, ArrayBuffer> = {};
  for (const name of BIN) bins[name] = await loadBin(control, name);
  const shellPid = await control.spawn(bins.sh!, { name: "sh", grantSpawn: true, grantFsSubtree: "/" });
  await control.bindTerminal(shellPid);

  // Bring up the desktop compositor and run the terminal inside its first window
  // (a DOM surface). The content host keeps id="terminal" so xterm sizing + the
  // existing E2E selectors continue to work under the compositor.
  const desktop = document.getElementById("desktop") ?? document.body;
  const taskbarEl = document.getElementById("taskbar") ?? document.body;
  const compositor = new Compositor(desktop, taskbarEl);

  // Desktop theme + wallpaper, persisted to /home (FR-26); applied on boot.
  new ThemeManager(control, desktop, taskbarEl);

  // Brokered input (M3-T3): the focused canvas window's keyboard/mouse is routed
  // to its owning process; keys target the active canvas window.
  const inputRouter = new InputRouter(
    (pid, bytes) => void control.deliverInput(pid, bytes),
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
  control.onExit((pid) => compositor.closeByOwner(pid));

  // Taskbar launcher: spawn each graphical app with its minimal capability set.
  const launch = (name: string, opts: { grantGpu?: boolean; grantInput?: boolean; grantSpawn?: boolean; grantFsSubtree?: string }) =>
    void control.spawn(bins[name]!, { name, ...opts });
  compositor.setLauncherApps([
    { label: "Files", launch: () => launch("filemanager", { grantGpu: true, grantInput: true, grantSpawn: true, grantFsSubtree: "/" }) },
    { label: "Paint", launch: () => launch("paint", { grantGpu: true, grantInput: true, grantFsSubtree: "/" }) },
    { label: "Editor", launch: () => launch("editor", { grantGpu: true, grantInput: true, grantFsSubtree: "/" }) },
    { label: "Mandelbrot", launch: () => launch("mandelbrot", { grantGpu: true, grantInput: true }) },
  ]);

  const termWin = compositor.open({ title: "Terminal — sh", width: 724, height: 460, ownerPid: shellPid, surface: "dom" });
  const termHost = document.createElement("div");
  termHost.id = "terminal";
  termWin.content.appendChild(termHost);
  const term = attachTerminal(termHost, control, shellPid);

  const state: ReadyState = { ...result, coldLoadMillis, shellPid, term, compositor, surfaces };
  window.__wasmos = state;

  const status = document.getElementById("status");
  if (status) {
    status.textContent = `ready in ${coldLoadMillis}ms · tier ${result.features.tier} · shell pid ${shellPid}`;
  }
  window.dispatchEvent(
    new CustomEvent("wasmos:ready", { detail: { bootMillis: result.bootMillis, coldLoadMillis, features: result.features } }),
  );
}

main().catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  throw e;
});
