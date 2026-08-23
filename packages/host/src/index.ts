import { boot, type BootResult } from "./boot.js";
import { isCrossOriginIsolated } from "./features.js";
import { attachTerminal, type TerminalSession } from "./term/terminal.js";
import { Compositor } from "./compositor/compositor.js";
import { SurfaceManager } from "./compositor/surface.js";
import { SessionManager } from "./compositor/session.js";
import { InputMetrics, InputRouter } from "./compositor/input.js";
import { ThemeManager } from "./compositor/theme.js";

// Keep the runtime available from the package's main entry as well as the
// dedicated `@wasmos/host/wasi` export. The desktop launcher and embedders now
// share the same process runtime instead of maintaining a second instantiation
// path.
export {
  WasiRuntime,
  type WasiRuntimeInspection,
  type WasiRuntimeOptions,
  type WasiRuntimeState,
} from "./wasi.js";

// Re-export so the React client can pre-flight the same isolation check this entry
// enforces (and render actionable guidance instead of a cryptic crash).
export { isCrossOriginIsolated } from "./features.js";

/** Executables loaded into the VFS `/bin` at boot (tmpfs, repopulated each boot). */
// "echo.zig" is the Zig-built sibling of "echo" (FR-14 polyglot proof): same WASI
// ABI, observably identical output, runs through the exact same kernel process path.
// "crash" is the fault-injection guest (FR-34): it traps on purpose so the
// crash-containment path (a trapped process must not take down the shell) is
// exercisable from the terminal.
// "watinfo" is hand-authored WAT compiled from guests/wat/watinfo.wat. It reads
// the live /proc/uptime file through WASI and writes the result to the terminal.
const BIN = [
  "sh", "hello", "catfile", "echo", "cat", "grep", "ls", "wc", "cp", "mv", "rm", "mkdir", "pwd", "head", "tail", "env",
  "echo.zig", "watinfo", "crash",
  // desktop compositor graphical apps (canvas surfaces); launchable from the file manager.
  // "mandelbrot" is the Zig polyglot app (FR-14 on the graphics path).
  "gfxspike", "filemanager", "paint", "editor", "mandelbrot", "sysmon", "lisp", "welcome", "spinner", "chandemo", "shmdemo", "sigdemo", "kill", "renice", "ps", "top", "fetch", "mount", "whoami", "touch", "nano",
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
  inputMetrics: InputMetrics;
};

declare global {
  interface Window {
    __wasmos?: ReadyState;
  }
}

/** Admin/process-control tools that also belong in /sbin (FHS). */
const SBIN = new Set(["kill", "renice", "ps", "top", "mount"]);

/** Fetch a built guest `.wasm` and install it into the VFS. Guests live in /usr/bin
 * (canonical) AND /bin (compat, so `/bin/sh`-style paths keep working); admin tools
 * are additionally placed in /sbin. /bin and /usr/bin are tmpfs, re-materialized from
 * the served wasm each boot, so a deploy never serves a stale binary. */
async function loadBin(control: BootResult["control"], name: string): Promise<void> {
  const bytes = await (await fetch(`${GUESTS}/${name}.wasm`)).arrayBuffer();
  const u8 = new Uint8Array(bytes);
  const dests = [`/usr/bin/${name}`, `/bin/${name}`];
  if (SBIN.has(name)) dests.push(`/sbin/${name}`);
  await Promise.all(dests.map((p) => control.fsWrite(p, u8)));
  // The bytes now live in the VFS (FR-30); do NOT retain them in host memory —
  // spawns read each guest back from the VFS via spawnByPath. Letting `bytes` go
  // out of scope here keeps the boot-time footprint bounded on small devices.
}

/** Translate a 12-byte brokered key record (see compositor/input.ts) into the
 * text/escape sequence a serial console expects (Linux framebuffer). Only key-down produces
 * output; key-up and unmapped keys yield "". */
function keyEventToConsoleText(bytes: Uint8Array): string {
  // The record is a fixed 12 bytes (kind @0, keycode u32 @6). Guard the length so a
  // short/malformed buffer returns "" instead of throwing a RangeError out of the
  // (fire-and-forget) input delivery path.
  if (bytes.byteLength < 12) return "";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = dv.getUint8(0);
  if (kind !== 4) return ""; // EV_KEY_DOWN only
  const key = dv.getUint32(6, true);
  if (key < 0x100) return String.fromCodePoint(key); // printable (layout+shift applied)
  switch (key) {
    case 0x100: return "\n"; // Enter
    case 0x101: return "\x7f"; // Backspace → DEL
    case 0x102: return "\x1b[D"; // ArrowLeft
    case 0x103: return "\x1b[C"; // ArrowRight
    case 0x104: return "\x1b[A"; // ArrowUp
    case 0x105: return "\x1b[B"; // ArrowDown
    case 0x106: return "\t"; // Tab
    case 0x107: return "\x1b"; // Escape
    case 0x108: return "\x1b[3~"; // Delete
    case 0x109: return "\x1b[H"; // Home
    case 0x10a: return "\x1b[F"; // End
    case 0x10b: return "\x1b[2~"; // Insert
    case 0x10c: return "\x1b[5~"; // PageUp
    case 0x10d: return "\x1b[6~"; // PageDown
    case 0x10e: return "\x1bOP"; // F1
    case 0x10f: return "\x1bOQ"; // F2
    case 0x110: return "\x1bOR"; // F3
    case 0x111: return "\x1bOS"; // F4
    case 0x112: return "\x1b[15~"; // F5
    case 0x113: return "\x1b[17~"; // F6
    case 0x114: return "\x1b[18~"; // F7
    case 0x115: return "\x1b[19~"; // F8
    case 0x116: return "\x1b[20~"; // F9
    case 0x117: return "\x1b[21~"; // F10
    case 0x118: return "\x1b[23~"; // F11
    case 0x119: return "\x1b[24~"; // F12
    default: return "";
  }
}

/** Options for {@link startDesktop} — lets a host shell (e.g. the React client in
 * apps/web) supply its own container elements + a status callback. All optional;
 * they default to the `#desktop`/`#taskbar`/`#status` DOM ids of the plain entry. */
export interface StartOptions {
  desktop?: HTMLElement;
  taskbar?: HTMLElement;
  /** Called with the boot status line (the React shell renders it as chrome). */
  onStatus?: (text: string) => void;
  /** Open the centered Welcome guide on load, every visit, until the user closes
   *  it once (the dismissal is remembered). The React client sets this; off by
   *  default so the deterministic E2E harness isn't perturbed by an extra window. */
  welcomeOnLoad?: boolean;
}

/** Boot the kernel + bring up the full WASM_OS desktop (compositor, terminal,
 * surfaces, input brokering, session restore, the app launcher) into the given
 * containers. Returns the ready state (also published on `window.__wasmos`). This
 * is the single entry both the plain bundle and the React client call. */
export async function startDesktop(opts: StartOptions = {}): Promise<ReadyState> {
  // WASM_OS's synchronous syscall ring is built on SharedArrayBuffer + Atomics,
  // which a browser only exposes in a CROSS-ORIGIN-ISOLATED context. Some
  // environments — most often an in-app webview (a link opened inside another
  // app) or an older mobile OS — do not provide it even when the server sends the
  // right COOP/COEP headers. Fail here with a clear, actionable message instead of
  // a cryptic "Can't find variable: SharedArrayBuffer" deep in worker startup.
  if (!isCrossOriginIsolated()) {
    throw new Error(
      "WASM_OS needs a cross-origin-isolated browser context (SharedArrayBuffer is " +
        "unavailable here). Open the page directly in a supported isolated Chromium or Firefox " +
        "window — not inside another app's in-app browser.",
    );
  }
  const result = await boot();
  // Capture full cold-load (navigation start → kernel ready) BEFORE the userland
  // spins up, so this stays comparable to kernel/VFS bootstrap/WASI process runtime.
  const coldLoadMillis = Math.round(performance.now());
  const { control } = result;

  // Seed the kernel's /dev/[u]random generator with real host CSPRNG entropy (the
  // deterministic kernel has no RNG of its own). 32 bytes from the browser's crypto.
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  await control.seedEntropy(entropy);

  // Install every guest into the VFS, then launch the shell as a terminal-bound
  // process. Loaded in bounded BATCHES rather than all at once: fetching all ~37
  // guests in parallel — each held as an ArrayBuffer and copied 2-3× across the
  // ring simultaneously — produces a transient allocation spike that a
  // memory-constrained mobile browser can reject ("out of memory") right on the
  // boot screen. A small concurrency cap keeps round-trips multiplexed (fast) while
  // bounding peak memory; the bytes are not retained host-side (see loadBin).
  const tGuests = performance.now();
  const LOAD_CONCURRENCY = 6;
  for (let i = 0; i < BIN.length; i += LOAD_CONCURRENCY) {
    await Promise.all(BIN.slice(i, i + LOAD_CONCURRENCY).map((name) => loadBin(control, name)));
  }
  console.info(
    `[wasmos boot] kernel-ready: ${coldLoadMillis}ms · guest load (${BIN.length} bins): ` +
      `${Math.round(performance.now() - tGuests)}ms`,
  );
  // Seed /etc with real system config (persistent sys store) on first boot only —
  // never clobber a file the user has edited. Written BEFORE the shell starts so it
  // can source /etc/profile (PATH) and print /etc/motd as its login banner.
  const ETC_DEFAULTS: Record<string, string> = {
    "/etc/hostname": "wasmos\n",
    "/etc/os-release":
      'NAME="WASM_OS"\nID=wasmos\nPRETTY_NAME="WASM_OS — a microkernel OS in your browser tab"\n' +
      'VERSION="0.1"\nVERSION_ID="0.1"\nHOME_URL="https://github.com/LayerDynamics/wasm_os"\n',
    "/etc/motd":
      "Welcome to WASM_OS — a real microkernel OS running in this browser tab.\n" +
      "  • `ls /` to explore the filesystem, or open  ☰ Apps\n" +
      "  • `cat /etc/os-release` for details · `cat /proc/uptime` for liveness\n",
    "/etc/profile": "# /etc/profile — system-wide shell startup\nexport PATH=/usr/bin:/bin:/sbin\nexport HOME=/home\n",
    "/etc/passwd": "root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home:/bin/sh\n",
  };
  const enc = new TextEncoder();
  await Promise.all(
    Object.entries(ETC_DEFAULTS).map(async ([path, body]) => {
      try {
        await control.fsRead(path); // already present (a prior boot, possibly edited)
      } catch {
        await control.fsWrite(path, enc.encode(body));
      }
    }),
  );

  // Spawn the shell and bind it to the terminal. Factored out so the terminal can
  // RESPAWN it if it exits (the `exit` builtin, a crash, or being killed) — otherwise
  // the terminal is left talking to a zombie and silently drops every keystroke.
  const spawnShell = async (): Promise<number> => {
    const pid = await control.spawnByPath("/usr/bin/sh", {
      name: "sh",
      grantSpawn: true,
      grantFsSubtree: "/",
      grantSignal: true, // the user's process-control authority: enables `kill` (signals)
      grantNet: true, // brokered networking authority: enables `fetch` (network broker)
    });
    await control.bindTerminal(pid);
    return pid;
  };
  const shellPid = await spawnShell();

  // Bring up the desktop compositor and run the terminal inside its first window
  // (a DOM surface). The content host keeps id="terminal" so xterm sizing + the
  // existing E2E selectors continue to work under the compositor.
  const desktop = opts.desktop ?? document.getElementById("desktop") ?? document.body;
  const taskbarEl = opts.taskbar ?? document.getElementById("taskbar") ?? document.body;
  const compositor = new Compositor(desktop, taskbarEl);

  // Desktop theme + wallpaper, persisted to /home (FR-26); applied on boot.
  new ThemeManager(control, desktop, taskbarEl);

  // The emulator processes (Linux guest integration) — their windows route keys to the guest console as
  // text, not as brokered input-event records (they make no win_read_input syscall).
  const emulatorPids = new Set<number>();
  const inputMetrics = new InputMetrics();

  // Brokered input (brokered input): the focused canvas window's keyboard/mouse is routed
  // to its owning process; keys target the active canvas window. For an emulator
  // window, keystrokes are translated to console text and sent to the guest (Linux framebuffer).
  const inputRouter = new InputRouter(
    async (pid, bytes) => {
      if (emulatorPids.has(pid)) {
        const text = keyEventToConsoleText(bytes);
        if (!text) return false;
        await control.emulatorInput(pid, text);
        return true;
      } else {
        const delivery = await control.deliverInput(pid, bytes);
        return delivery.accepted;
      }
    },
    () => {
      const w = compositor.activeWindow();
      return w && w.surface === "canvas" ? w.ownerPid : undefined;
    },
    inputMetrics,
  );

  // Session snapshot/restore (session restore, FR-35): records open app windows + geometry to
  // /home/.session.json and re-opens them on the next boot. Created BEFORE the
  // SurfaceManager so each process-owned window can be titled by its launching app.
  const session = new SessionManager(control, compositor);

  // The launchable graphical apps + their minimal capability sets. Registered with
  // the SessionManager so the taskbar launcher AND session restore spawn them the
  // same way (and each launch is tagged for persistence).
  type AppOpts = { grantGpu?: boolean; grantInput?: boolean; grantSpawn?: boolean; grantSignal?: boolean; grantFsSubtree?: string };
  const APPS: Array<{ name: string; label: string; opts: AppOpts }> = [
    { name: "welcome", label: "Welcome", opts: { grantGpu: true, grantInput: true } },
    { name: "filemanager", label: "Files", opts: { grantGpu: true, grantInput: true, grantSpawn: true, grantFsSubtree: "/" } },
    { name: "paint", label: "Paint", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/" } },
    { name: "editor", label: "Editor", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/" } },
    { name: "mandelbrot", label: "Mandelbrot", opts: { grantGpu: true, grantInput: true } },
    // System Monitor needs Signal (process control) in addition to Gpu+Input.
    { name: "sysmon", label: "Monitor", opts: { grantGpu: true, grantInput: true, grantSignal: true } },
    { name: "lisp", label: "Lisp", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/home" } },
  ];
  // pid → human label so a process-owned window shows "Editor"/"Linux", not "App (pid 5)".
  const APP_LABELS: Record<string, string> = { linux: "Linux" };
  for (const app of APPS) APP_LABELS[app.name] = app.label;

  // Process-owned canvas surfaces (desktop compositor): a process calls win_surface → a canvas window
  // opens here (titled by the launching app) and its framebuffer is blitted on present.
  const surfaces = new SurfaceManager(
    compositor,
    (canvas, pid) => inputRouter.bindCanvas(canvas, pid),
    (pid) => {
      const name = session.appForPid(pid);
      return (name && APP_LABELS[name]) || `App (pid ${pid})`;
    },
    (pid) => session.appForPid(pid) === "welcome", // the guide opens centered
    (pid) => inputMetrics.markCanvasRendered(pid),
  );
  control.onSurface((info) => surfaces.onSurface(info));
  control.onPresent((id) => surfaces.onPresent(id));

  control.onExit((pid) => {
    compositor.closeByOwner(pid);
    emulatorPids.delete(pid);
  });

  for (const app of APPS) {
    session.register(app.name, () => control.spawnByPath(`/usr/bin/${app.name}`, { name: app.name, ...app.opts }));
  }
  // The privileged emulator process (Linux guest integration): boots real Linux into a window. Registered
  // with the SessionManager so it is part of the session (re-opens on reload, FR-35);
  // its window is tagged "linux" and its keystrokes route to the guest console.
  session.register("linux", async () => {
    const pid = await control.spawnEmulator({ name: "linux", configUrl: "/assets/linux/wasmos-riscv64.cfg" });
    emulatorPids.add(pid);
    return pid;
  });
  compositor.setLauncherApps([
    ...APPS.map((a) => ({ label: a.label, launch: () => void session.launch(a.name) })),
    { label: "Linux", launch: () => void session.launch("linux") },
  ]);

  // The terminal window is deliberately NOT owned by the shell pid: the shell is a
  // RESTARTABLE service behind it, so the shell exiting must not close the window
  // (and `onExit`'s closeByOwner must not target it). Shell cleanup on window-close
  // is handled explicitly below.
  const termWin = compositor.open({ title: "Terminal — sh", width: 724, height: 460, surface: "dom" });
  const termHost = document.createElement("div");
  termHost.id = "terminal";
  termWin.content.appendChild(termHost);
  const term = attachTerminal(termHost, control, shellPid, inputMetrics);
  // Restore xterm keyboard focus whenever the terminal window is (re)activated —
  // otherwise switching to another window and clicking back leaves the terminal
  // visually active but keyboard-dead (typing/Backspace/Delete silently lost).
  termWin.onActivate = () => term.focus();
  term.focus();

  // Keep a live shell behind the terminal (init/getty-style). The shell can exit via
  // the `exit` builtin, a crash/trap, or being killed (e.g. from System Monitor); an
  // unreaped zombie never fires onExit, so poll process state and respawn on death.
  // Without this the terminal stays bound to a zombie and every keystroke is silently
  // dropped — typing echoes locally but Enter/Backspace do nothing.
  let respawning = false;
  const shellWatch = window.setInterval(async () => {
    if (respawning) return;
    let procs;
    try {
      procs = await control.listProcs();
    } catch {
      return; // transient; re-check next tick
    }
    const sh = procs.find((p) => p.pid === term.shellPid());
    if (sh && sh.state !== "zombie") return; // still alive
    respawning = true;
    try {
      const pid = await spawnShell();
      term.setShell(pid);
      term.notice("\r\n[shell exited — restarted]\r\n");
    } catch {
      // spawn failed (e.g. mid-teardown); leave respawning cleared to retry next tick.
    } finally {
      respawning = false;
    }
  }, 1500);

  // Closing a process window reaps the owning process (launcher and window lifecycle); a process that exits
  // or traps has its windows closed (crash containment, FR-34). Closing the TERMINAL
  // window instead stops the shell watcher and kills the current shell explicitly
  // (the window has no ownerPid, so the generic path below won't).
  compositor.onWindowClosed = (id, ownerPid) => {
    surfaces.closeByWindow(id);
    if (id === termWin.id) {
      window.clearInterval(shellWatch);
      void control.kill(term.shellPid());
      return;
    }
    if (ownerPid !== undefined) void control.kill(ownerPid);
  };

  const state: ReadyState = { ...result, coldLoadMillis, shellPid, term, compositor, surfaces, session, inputMetrics };
  window.__wasmos = state;

  const statusText = `ready in ${coldLoadMillis}ms · tier ${result.features.tier} · shell pid ${shellPid}`;
  opts.onStatus?.(statusText);

  // Record a real boot log to /var/log (the kernel's actual boot facts for this run).
  void control.fsWrite(
    "/var/log/boot.log",
    enc.encode(
      `WASM_OS boot\n` +
        `kernel boot: ${result.bootMillis}ms\n` +
        `cold load (nav -> kernel ready): ${coldLoadMillis}ms\n` +
        `feature tier: ${result.features.tier}\n` +
        `guests loaded: ${BIN.length}\n` +
        `shell pid: ${shellPid}\n`,
    ),
  );
  const status = document.getElementById("status");
  if (status) {
    status.textContent = statusText;
  }
  window.dispatchEvent(
    new CustomEvent("wasmos:ready", { detail: { bootMillis: result.bootMillis, coldLoadMillis, features: result.features } }),
  );

  // The Welcome guide is owned by the on-load logic below — it opens every visit
  // until dismissed — so it must NOT be recorded or re-opened by the session
  // snapshot, or it would double-open (restore + on-load) or get stuck open.
  if (opts.welcomeOnLoad) session.setTransient("welcome");

  // Re-open the apps from the previous session (FR-35). Fire-and-forget: their
  // windows stream in as each process boots and requests its surface.
  void session.restore();

  // Open the Welcome guide centered on every load, until the user dismisses it.
  // Closing its window (which reaps its process) writes a dismissal marker so it
  // stays closed on later visits. Gated to the real client (opts.welcomeOnLoad)
  // so the deterministic E2E harness isn't perturbed by an extra window.
  if (opts.welcomeOnLoad) {
    void (async () => {
      const dismissed = "/home/.welcome-dismissed";
      try {
        await control.fsRead(dismissed);
        return; // the user closed it on a previous visit — honor that, stay closed
      } catch {
        // never dismissed — open the guide
      }
      const pid = await session.launch("welcome");
      if (pid === undefined) return;
      // Persist the dismissal when the user closes the guide's window — its process
      // is reaped on close, firing onExit — so it does not reappear next load.
      control.onExit((exited) => {
        if (exited === pid) void control.fsWrite(dismissed, new Uint8Array([1])).catch(() => {});
      });
    })();
  }

  return state;
}
