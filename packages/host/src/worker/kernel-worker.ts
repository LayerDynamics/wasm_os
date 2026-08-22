/**
 * Kernel worker (kworker) — WASI process runtime.
 *
 * Hosts the jco-transpiled kernel component + the OPFS/IndexedDB blockstores
 * (moved here from the main thread). It owns every process's SAB syscall ring,
 * services them with `Atomics.waitAsync` (never blocking), and orchestrates
 * spawn end-to-end: `control.spawn` allocates the PID/fd-table/caps, then the
 * kworker creates the process worker and hands it the guest bytes + ring.
 *
 * The main thread talks to the kernel only through an async postMessage proxy
 * (see boot.ts); each request carries a correlation id answered here.
 */
import type { FeatureReport } from "../features.js";
import { OpfsBlockstore } from "../blockstore/opfs.js";
import { IdbBlockstore } from "../blockstore/idb.js";
import { CachedStore } from "../blockstore/cached.js";
import type { Blockstore } from "../blockstore/types.js";
import { createRing, header, REQ_SEQ } from "../ring/layout.js";
import { RingServer } from "../ring/host.js";
import { OP, Writer } from "../ring/protocol.js";
import type { ExitMessage } from "./process-worker.js";
import type { Root as AbiRoot, instantiate as instantiateKernel } from "@wasmos/abi/kernel";

// Cache-busting token for stable-path artifacts (see boot.ts ASSET_VERSION); kept in
// sync by hand since this worker bundles independently of the main entry.
const ASSET_VERSION = "2";
const ABI_BASE = "/packages/abi/generated";
const ABI_V = `?v=${ASSET_VERSION}`;
const PROCESS_WORKER_URL = `/dist/worker/process-worker.js?v=${ASSET_VERSION}`;
const EMULATOR_WORKER_URL = `/dist/worker/emulator-worker.js?v=${ASSET_VERSION}`;

type Backend = "tmpfs" | "opfs" | "idb";
interface SpawnSpec {
  name: string;
  grantFsSubtree: string;
  grantSpawn: boolean;
  grantGpu: boolean;
  grantInput: boolean;
  grantSignal: boolean;
  grantNet: boolean;
}

/** Synchronous kernel control surface, taken directly from the generated Binder types. */
type KernelControl = AbiRoot["control"];

/** shell and userland park/resume outcome (jco maps `option<list<u8>>` → `Uint8Array | undefined`). */
interface SyscallOutcome {
  reply: Uint8Array | undefined;
  wakeups: Uint32Array;
  termOutput: Uint8Array;
  /** Set when a guest spawned a child the kworker must instantiate (guest spawning).
   *  `terminalStdin` marks a foreground job whose fd 0 is the terminal. */
  spawn?: { pid: number; imagePath: string; terminalStdin: boolean };
  /** pids the kworker must force-terminate (SIGKILL, signals). */
  reap: Uint32Array;
  /** Set when a guest parked on net_request (network broker) — the kworker fetches the URL. */
  net?: { pid: number; url: string };
  /** Set when a guest toggled the terminal line discipline via `tty_set_raw`:
   *  `1` => raw, `0` => cooked, `undefined` => no change (jco maps `option<u8>`). */
  termMode?: number;
}

type KernelModule = { instantiate: typeof instantiateKernel };

type WorkerScope = {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};
const ctx = self as unknown as WorkerScope;

// --- kworker state (populated on init) ---
let control: KernelControl | undefined;
let home: CachedStore | undefined;
let mnt: CachedStore | undefined;
let sys: CachedStore | undefined;

/** Per-process bookkeeping for the worker + ring + waiters. */
interface ProcRuntime {
  worker: Worker;
  ringSab: SharedArrayBuffer;
  server: RingServer;
  abort: AbortController;
  exited: boolean;
  exitCode: number;
  sharedMemory: boolean;
  waiters: Array<(exitCode: number) => void>;
}
const procs = new Map<number, ProcRuntime>();

/** Boot options for the emulator worker (same-origin asset URLs + kernel cmdline). */
interface EmulatorBoot {
  configUrl: string;
  cmdline: string;
  memoryMb?: number;
  shareSeed?: Array<{ name: string; data: Uint8Array }>;
}

/** The host /home subtree bridged into the guest's 9p share (9p shared folder, FR-29). */
const SHARE_DIR = "/home/shared";

/** Read the files under the share dir to seed the guest's 9p mount (9p shared folder). */
function readShareSeed(): Array<{ name: string; data: Uint8Array }> {
  const seed: Array<{ name: string; data: Uint8Array }> = [];
  try {
    // fsList returns FULL paths; the 9p file name is the basename.
    for (const full of requireControl().fsList(SHARE_DIR)) {
      const name = full.split("/").pop() ?? full;
      try {
        seed.push({ name, data: requireControl().fsRead(full) });
      } catch {
        /* a sub-directory or unreadable entry — skip */
      }
    }
  } catch {
    /* no share dir yet */
  }
  return seed;
}
/** The privileged emulator process (Linux guest integration): a Native process whose body is a dedicated
 * TinyEMU worker, tracked separately from the ring-driven `procs` so the wasi path is
 * untouched. Killing it (window close or SIGKILL/reap) terminates this worker. */
interface EmulatorRuntime {
  worker: Worker;
  serial: string;
  exited: boolean;
  surfaceId?: number;
}
const emulators = new Map<number, EmulatorRuntime>();
/** Surface ids for emulator framebuffers, in a high namespace that can't collide
 * with the kernel's win_surface ids (allocated from 1). */
let nextEmulatorSurfaceId = 0x7000_0000;

/**
 * Parked syscalls (shell and userland): a pid → the request bytes it parked on. While parked,
 * the guest stays blocked in `Atomics.wait`; a wakeup re-drives the request.
 */
const parked = new Map<number, Uint8Array>();

/** Desktop compositor surfaces: `surface_id -> owning pid` (present authorization). */
const surfaceOwners = new Map<number, number>();

/**
 * Terminal foreground-job stack (in-terminal editor support). The bottom is the
 * interactive shell (seeded on `bindTerminal`); a child whose fd 0 is the
 * terminal (a foreground job — `spawn-request.terminal-stdin`) is pushed on
 * spawn and popped on exit. Terminal keystrokes route to the TOP, so a running
 * foreground program (nano, `cat`, `grep`) receives input while the shell is
 * parked in `wait()`. Empty until the terminal is bound.
 */
const terminalFg: number[] = [];
/** True while the foreground program holds the terminal in raw line discipline
 * (set via `tty_set_raw`). Reset to cooked when that program exits — so a crash
 * never leaves the terminal echo-less and unusable. */
let terminalRaw = false;

/** The pid that should receive terminal keystrokes right now (foreground top). */
function terminalForeground(): number | undefined {
  return terminalFg[terminalFg.length - 1];
}

/** Apply a terminal line-discipline change and tell the main-thread terminal. */
function setTerminalRaw(raw: boolean): void {
  if (raw === terminalRaw) return;
  terminalRaw = raw;
  ctx.postMessage({ type: "termMode", raw });
}

/** A syscall may have toggled raw mode (`tty_set_raw`). Honor it ONLY for the
 * current foreground process, so a background program cannot hijack the
 * terminal's discipline. `term_mode` is `1` (raw) / `0` (cooked) / undefined. */
function applyTermMode(pid: number, termMode: number | undefined): void {
  if (termMode === undefined) return;
  if (pid !== terminalForeground()) return;
  setTerminalRaw(termMode === 1);
}

/** Drive one syscall: complete it now, or park it; then process its wakeups. */
function driveSyscall(pid: number, request: Uint8Array): void {
  const rt = procs.get(pid);
  if (!rt) return;
  const outcome = requireControl().serviceSyscall(pid, request);
  if (outcome.termOutput.length > 0) {
    ctx.postMessage({ type: "output", pid, bytes: outcome.termOutput });
  }
  applyTermMode(pid, outcome.termMode);
  if (outcome.reply === undefined) {
    parked.set(pid, request); // park — do NOT complete the ring
  } else {
    rt.server.complete(outcome.reply);
  }
  // Side-effects run AFTER the caller's reply is completed: a failing child spawn
  // (e.g. an unreadable image) must not strand the parent blocked in the ring, and
  // a self-kill's reply must land before its worker is torn down.
  if (outcome.spawn) handleSpawnRequest(outcome.spawn);
  if (outcome.net) handleNetRequest(outcome.net);
  for (const r of outcome.reap) killProcess(r); // SIGKILL reap (signals)
  processWakeups(outcome.wakeups);
}

/**
 * Re-drive parked pids made runnable by an event. **Iterative, de-duplicated
 * work-queue** (NOT recursion): a pid removed from the stash the instant it is
 * scheduled, so a duplicate wakeup is a no-op and a guest's `RESP_SEQ` is
 * bumped exactly once per `Atomics.wait`.
 */
function processWakeups(wakeups: Uint32Array | number[]): void {
  const queue: number[] = [...new Set(Array.from(wakeups))];
  while (queue.length > 0) {
    const w = queue.shift() as number;
    const request = parked.get(w);
    if (request === undefined) continue; // not parked / already handled (dedup)
    parked.delete(w); // remove BEFORE re-drive so a duplicate wakeup no-ops
    const rt = procs.get(w);
    if (!rt) continue;
    const outcome = requireControl().serviceSyscall(w, request);
    if (outcome.termOutput.length > 0) {
      ctx.postMessage({ type: "output", pid: w, bytes: outcome.termOutput });
    }
    applyTermMode(w, outcome.termMode);
    if (outcome.reply === undefined) {
      parked.set(w, request); // parked again (e.g. wait on a not-yet-exited child)
    } else {
      rt.server.complete(outcome.reply);
    }
    // Side-effects after the reply (see driveSyscall) so a failed spawn can't strand
    // the re-driven caller.
    if (outcome.spawn) handleSpawnRequest(outcome.spawn);
    if (outcome.net) handleNetRequest(outcome.net);
    for (const r of outcome.reap) killProcess(r); // SIGKILL reap (signals)
    for (const nw of outcome.wakeups) if (!queue.includes(nw)) queue.push(nw);
  }
}

/** Pump a process's ring: read each request and drive it (may park). */
async function pump(pid: number, server: RingServer, signal: AbortSignal): Promise<void> {
  for (;;) {
    const req = await server.nextRequest({ signal });
    if (req === null) return;
    driveSyscall(pid, req);
  }
}

function encodeProcExit(code: number): Uint8Array {
  return new Writer().u8(OP.PROC_EXIT).u32(code >>> 0).build();
}

/** Wake a process's serve loop so it observes the abort and exits cleanly. */
function wakeRing(ringSab: SharedArrayBuffer): void {
  const h = header(ringSab);
  Atomics.add(h, REQ_SEQ, 1);
  Atomics.notify(h, REQ_SEQ);
}

async function init(features: FeatureReport): Promise<{ bootMillis: number; features: FeatureReport }> {
  const t0 = performance.now();

  const homeBacking: Blockstore = features.opfs
    ? await OpfsBlockstore.create("home")
    : await IdbBlockstore.create("home");
  const mntBacking: Blockstore = await IdbBlockstore.create("mnt");
  // System dirs (/etc, /var, …) persist to a SEPARATE OPFS store from /home so the two
  // can be wiped independently (IndexedDB fallback when OPFS is unavailable).
  const sysBacking: Blockstore = features.opfs
    ? await OpfsBlockstore.create("sys")
    : await IdbBlockstore.create("sys");
  const tStore = performance.now();
  [home, mnt, sys] = await Promise.all([
    CachedStore.load(homeBacking),
    CachedStore.load(mntBacking),
    CachedStore.load(sysBacking),
  ]);
  console.info(`[wasmos boot] persisted store load: ${Math.round(performance.now() - tStore)}ms`);

  // Dynamic import via a non-literal path so the bundler keeps it external; the
  // browser fetches the generated component + its core modules at runtime.
  const kernelUrl = `${ABI_BASE}/kernel.js${ABI_V}`;
  const mod: KernelModule = await import(/* @vite-ignore */ kernelUrl);
  const getCoreModule = (path: string) =>
    WebAssembly.compileStreaming(fetch(`${ABI_BASE}/${path}${ABI_V}`));

  const kernelImports = {
    "wasmos:abi/home-store": home.imports(),
    "wasmos:abi/mnt-store": mnt.imports(),
    "wasmos:abi/sys-store": sys.imports(),
  } as unknown as Parameters<typeof instantiateKernel>[1];
  const instance = await mod.instantiate(getCoreModule, kernelImports);
  control = instance.control;
  const status = control.boot(features);
  if (!status.ready) throw new Error("kernel failed to reach ready");

  return { bootMillis: Math.round(performance.now() - t0), features };
}

function requireControl(): KernelControl {
  if (!control) throw new Error("kworker not initialized");
  return control;
}

/** Handle a process worker's exit (clean exit or contained trap, FR-34). */
function onProcExit(pid: number, msg: ExitMessage): void {
  const rt = procs.get(pid);
  if (!rt || rt.exited) return;

  // If the kernel does not already know this process exited, record it now. A
  // guest that returns from `_start` (or traps) never sends a ring `proc_exit`,
  // so without this the kernel never zombifies it and a parent parked in
  // `wait()` would hang (guest spawning) — and a trap would not be contained (FR-34).
  if (requireControl().exitCode(pid) === undefined) {
    const outcome = requireControl().serviceSyscall(pid, encodeProcExit(msg.exit.code));
    processWakeups(outcome.wakeups);
  }
  rt.exited = true;
  rt.exitCode = msg.exit.code;
  rt.sharedMemory = msg.sharedMemory;

  // Tear down the worker + ring pump; drop any stashed parked request.
  parked.delete(pid);
  rt.abort.abort();
  wakeRing(rt.ringSab);
  rt.worker.terminate();

  for (const resolve of rt.waiters) resolve(rt.exitCode);
  rt.waiters = [];

  // If this was a terminal foreground job, pop it so keystrokes fall back to the
  // job beneath it (ultimately the shell). If it held the terminal in raw mode,
  // restore cooked discipline — otherwise a crashed editor would leave the
  // terminal with no echo and swallowing keys (brick prevention).
  const fgIdx = terminalFg.lastIndexOf(pid);
  if (fgIdx !== -1) {
    const wasForeground = fgIdx === terminalFg.length - 1;
    terminalFg.splice(fgIdx, 1);
    if (wasForeground && terminalRaw) setTerminalRaw(false);
  }

  // Drop this process's surface ownership and tell the main thread so the
  // compositor closes any windows it owned (crash containment, FR-34).
  for (const [sid, owner] of surfaceOwners) if (owner === pid) surfaceOwners.delete(sid);
  ctx.postMessage({ type: "exit", pid });

  // Free the runtime entry — its ~128 KiB ring SAB and dead RingServer would
  // otherwise leak for the whole session (every short-lived shell command leaks
  // one). Waiters are already resolved above; a late waitFor() falls back to the
  // kernel's recorded exit code via the !rt branch.
  procs.delete(pid);
}

/** Host-initiated kill (desktop compositor): close a window → reap its process. Records the exit
 * (zombifies + releases pipes/surfaces + wakes waiters) then tears the worker
 * down via onProcExit. A no-op if the process already exited. */
function killProcess(pid: number): void {
  // The emulator (Linux guest integration) is a Native process with no ring — reap its worker directly.
  const emu = emulators.get(pid);
  if (emu) {
    reapEmulator(pid, emu);
    return;
  }
  const rt = procs.get(pid);
  if (!rt || rt.exited) return;
  onProcExit(pid, { pid, exit: { kind: "exit", code: 137 }, sharedMemory: rt.sharedMemory });
}

/** Register + boot the privileged emulator process (Linux guest integration, FR-27/FR-28): the kernel
 * allocates a Native PID, then a dedicated TinyEMU worker runs it. Serial output is
 * relayed to the main thread; killing the PID terminates this worker. */
function spawnEmulator(name: string, boot: EmulatorBoot): number {
  const pid = requireControl().spawnEmulator(name);
  const worker = new Worker(EMULATOR_WORKER_URL, { type: "module" });
  const emu: EmulatorRuntime = { worker, serial: "", exited: false };
  emulators.set(pid, emu);
  worker.onmessage = (e: MessageEvent) => {
    const d = e.data as {
      type?: string;
      text?: string;
      width?: number;
      height?: number;
      sab?: SharedArrayBuffer;
      name?: string;
      data?: Uint8Array;
    };
    if (d.type === "serial" && typeof d.text === "string") {
      emu.serial = d.text;
      ctx.postMessage({ type: "emulatorSerial", pid, text: d.text });
    } else if (d.type === "started") {
      ctx.postMessage({ type: "emulatorStarted", pid });
    } else if (d.type === "surface" && d.sab) {
      // The emulator's framebuffer — relay it as a compositor surface (reusing the
      // desktop compositor surface/present path), with a high surface id owned by this process.
      const sid = nextEmulatorSurfaceId++;
      emu.surfaceId = sid;
      surfaceOwners.set(sid, pid);
      ctx.postMessage({ type: "surface", pid, surfaceId: sid, width: d.width, height: d.height, sab: d.sab });
    } else if (d.type === "present" && emu.surfaceId !== undefined) {
      ctx.postMessage({ type: "present", surfaceId: emu.surfaceId });
    } else if (d.type === "tick") {
      // Run-to-budget accounting (emulator CPU accounting): the emulator is alive and consuming a
      // scheduling budget — surface it as CPU activity in proc_list/top.
      requireControl().accountEmulator(pid, 1n);
    } else if (d.type === "9pWrite" && d.name && d.data) {
      // A guest write under the 9p share — mirror it back to the host VFS (9p shared folder).
      requireControl().fsWrite(`${SHARE_DIR}/${d.name}`, d.data);
    }
  };
  // Seed the guest's 9p share with the current host /home/shared contents (9p shared folder).
  worker.postMessage({ type: "boot", ...boot, shareSeed: readShareSeed() });
  return pid;
}

/** Deliver brokered keystrokes to the emulator's guest console (guest console input). The text
 * is written to the guest's hvc0 console (the shell's stdin) by the emulator worker. */
function emulatorInput(pid: number, text: string): void {
  const emu = emulators.get(pid);
  if (emu && !emu.exited) emu.worker.postMessage({ type: "input", text });
}

/** Tear down the emulator worker + zombify its PID in the kernel (Linux guest integration kill/reap). */
function reapEmulator(pid: number, emu: EmulatorRuntime): void {
  if (emu.exited) return;
  emu.exited = true;
  // If the kernel doesn't already know it exited (e.g. window-close, not SIGKILL),
  // record it so proc_list zombifies it and any waiter wakes.
  if (requireControl().exitCode(pid) === undefined) {
    const outcome = requireControl().serviceSyscall(pid, encodeProcExit(137));
    processWakeups(outcome.wakeups);
  }
  emu.worker.terminate();
  for (const [sid, owner] of surfaceOwners) if (owner === pid) surfaceOwners.delete(sid);
  ctx.postMessage({ type: "exit", pid });
  // Free the runtime entry — otherwise the EmulatorRuntime (including its
  // accumulated serial buffer) is retained for the rest of the session.
  emulators.delete(pid);
}

/**
 * Bring an already-allocated process (PID + fd table + caps registered in the
 * kernel) to life: create its ring, pump it, and start its worker on the given
 * guest image. Shared by host-initiated spawn and guest-initiated spawn (KSPAWN).
 */
function instantiateProcess(pid: number, wasmBytes: ArrayBuffer | Uint8Array): void {
  const ringSab = createRing();
  const abort = new AbortController();
  const server = new RingServer(ringSab);

  // Register the runtime BEFORE pumping so driveSyscall can find it.
  procs.set(pid, {
    worker: undefined as unknown as Worker, // set below
    ringSab,
    server,
    abort,
    exited: false,
    exitCode: 0,
    sharedMemory: false,
    waiters: [],
  });

  // Pump this process's ring until it exits — each request is driven (may park).
  void pump(pid, server, abort.signal).catch((e) =>
    console.error(`ring pump error for pid ${pid}:`, e),
  );

  const worker = new Worker(PROCESS_WORKER_URL, { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const d = e.data as {
      type?: string;
      surfaceId?: number;
      width?: number;
      height?: number;
      sab?: SharedArrayBuffer;
      bytes?: number;
    };
    // process control and IPC ps/top: the worker reported its guest memory size.
    if (d.type === "mem" && d.bytes !== undefined) {
      requireControl().setProcMem(pid, d.bytes);
      return;
    }
    // Desktop compositor surfaces: a process worker created a surface or published a
    // frame. Track ownership (surface_id -> pid) and relay to the main thread,
    // which drives the canvas window + blits the shared framebuffer.
    if (d.type === "surface" && d.surfaceId !== undefined) {
      surfaceOwners.set(d.surfaceId, pid);
      ctx.postMessage({ type: "surface", pid, surfaceId: d.surfaceId, width: d.width, height: d.height, sab: d.sab });
      return;
    }
    if (d.type === "present" && d.surfaceId !== undefined) {
      // Only the owning process may present its surface.
      if (surfaceOwners.get(d.surfaceId) === pid) {
        ctx.postMessage({ type: "present", surfaceId: d.surfaceId });
      }
      return;
    }
    onProcExit(pid, e.data as ExitMessage);
  };
  worker.postMessage({ wasmBytes, pid, ringSab });
  procs.get(pid)!.worker = worker;
}

/** Host-initiated spawn (the WASI process runtime path): allocate the PID, then instantiate. */
function spawn(spec: SpawnSpec, wasmBytes: ArrayBuffer): number {
  const pid = requireControl().spawn(spec);
  instantiateProcess(pid, wasmBytes);
  return pid;
}

/** Host-initiated spawn from a VFS image path: read the already-loaded guest from
 * the kernel VFS rather than shipping its bytes across the boundary. This lets the
 * host launch the shell and apps without retaining a copy of every guest's bytes
 * in main-thread memory — they live once in the VFS (FR-30). */
function spawnByPath(spec: SpawnSpec, imagePath: string): number {
  const pid = requireControl().spawn(spec);
  instantiateProcess(pid, requireControl().fsRead(imagePath));
  return pid;
}

/**
 * Guest-initiated spawn (KSPAWN, shell and userland): the kernel already allocated the child's
 * PID/fds/caps and returned a `spawn` request. Read its image from the VFS and
 * bring it to life.
 */
function handleSpawnRequest(req: { pid: number; imagePath: string; terminalStdin: boolean }): void {
  try {
    const image = requireControl().fsRead(req.imagePath);
    instantiateProcess(req.pid, image);
  } catch (e) {
    // The kernel already allocated the child PID. If we cannot bring it to life
    // (unreadable/corrupt image), forge its exit so a parent parked in wait() is
    // released and the zombie is reaped — never leave it as a process that was
    // allocated but never started, which would hang the shell forever.
    console.error(`spawn of pid ${req.pid} (${req.imagePath}) failed:`, e);
    if (requireControl().exitCode(req.pid) === undefined) {
      const outcome = requireControl().serviceSyscall(req.pid, encodeProcExit(127));
      processWakeups(outcome.wakeups);
    }
    return;
  }
  // A foreground job (its fd 0 is the terminal) becomes the new keystroke target
  // until it exits; the shell that spawned it is parked in wait() beneath it.
  if (req.terminalStdin) terminalFg.push(req.pid);
}

/** Cap a brokered network response so a large or hostile URL cannot balloon kernel
 * memory in one shot (the body is copied into the kernel by deliverNet). */
const MAX_NET_BYTES = 8 * 1024 * 1024;

/** Perform a guest's brokered network request (network broker): the kernel parked the
 * caller after checking its Net capability; we fetch the URL and deliver the
 * body back (waking the caller). A failure delivers ok=false (guest sees IO). */
function handleNetRequest(req: { pid: number; url: string }): void {
  // Deliver exactly once, guarding deliverNet itself: the parked caller may have
  // exited, in which case there is simply nothing to wake (no unhandled rejection).
  const deliver = (ok: boolean, body: Uint8Array): void => {
    let wakeups: Uint32Array | number[] | undefined;
    try {
      wakeups = requireControl().deliverNet(req.pid, ok, body);
    } catch (e) {
      console.error(`deliverNet for pid ${req.pid} failed:`, e);
      return;
    }
    if (wakeups) processWakeups(wakeups);
  };
  void fetch(req.url)
    .then(async (r) => {
      const bytes = new Uint8Array(await r.arrayBuffer());
      // Clamp what reaches the kernel; the worker still reads the full body, but the
      // kernel copy (and the guest-visible payload) is bounded.
      deliver(true, bytes.length > MAX_NET_BYTES ? bytes.subarray(0, MAX_NET_BYTES) : bytes);
    })
    .catch(() => deliver(false, new Uint8Array()));
}

function waitFor(pid: number): Promise<{ exitCode: number; sharedMemory: boolean }> {
  const rt = procs.get(pid);
  if (!rt) {
    // Unknown to the kworker — fall back to the kernel's recorded exit code.
    const code = requireControl().exitCode(pid) ?? 0;
    return Promise.resolve({ exitCode: code, sharedMemory: false });
  }
  if (rt.exited) return Promise.resolve({ exitCode: rt.exitCode, sharedMemory: rt.sharedMemory });
  return new Promise((resolve) => {
    rt.waiters.push(() => resolve({ exitCode: rt.exitCode, sharedMemory: rt.sharedMemory }));
  });
}

interface Request {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
}

ctx.onmessage = async (ev: MessageEvent) => {
  const { id, cmd, args = {} } = ev.data as Request;
  try {
    let result: unknown;
    switch (cmd) {
      case "init":
        result = await init(args.features as FeatureReport);
        break;
      case "mount":
        result = requireControl().mount(args.path as string, args.on as Backend);
        break;
      case "fsWrite":
        result = requireControl().fsWrite(args.path as string, args.bytes as Uint8Array);
        break;
      case "fsRead":
        result = requireControl().fsRead(args.path as string);
        break;
      case "fsList":
        result = requireControl().fsList(args.path as string);
        break;
      case "fsDelete":
        result = requireControl().fsDelete(args.path as string);
        break;
      case "fsMkdirp":
        result = requireControl().fsMkdirp(args.path as string);
        break;
      case "seedEntropy":
        result = requireControl().seedEntropy(args.seed as Uint8Array);
        break;
      case "listProcs":
        result = requireControl().listProcs();
        break;
      case "takeCapture":
        result = requireControl().takeCapture(args.pid as number);
        break;
      case "spawn":
        result = spawn(args.spec as SpawnSpec, args.wasmBytes as ArrayBuffer);
        break;
      case "spawnByPath":
        result = spawnByPath(args.spec as SpawnSpec, args.imagePath as string);
        break;
      case "spawnEmulator":
        result = spawnEmulator(args.name as string, args.boot as EmulatorBoot);
        break;
      case "emulatorInput":
        emulatorInput(args.pid as number, args.text as string);
        result = undefined;
        break;
      case "wait":
        result = await waitFor(args.pid as number);
        break;
      case "stdin": {
        // Deliver terminal keystrokes to a process's stdin; wake parked readers.
        const wakeups = requireControl().deliverStdin(args.pid as number, args.bytes as Uint8Array);
        processWakeups(wakeups);
        result = undefined;
        break;
      }
      case "terminalInput": {
        // Deliver keystrokes to the current terminal foreground job (the stack
        // top), so a running editor/filter gets input while the shell waits. No
        // foreground yet (terminal not bound) → drop the bytes.
        const target = terminalForeground();
        if (target !== undefined) {
          const wakeups = requireControl().deliverStdin(target, args.bytes as Uint8Array);
          processWakeups(wakeups);
        }
        result = undefined;
        break;
      }
      case "deliverInput": {
        // Deliver brokered keyboard/mouse to the focused window's process (brokered input);
        // wake any parked win_read_input.
        const wakeups = requireControl().deliverInput(args.pid as number, args.bytes as Uint8Array);
        processWakeups(wakeups);
        result = undefined;
        break;
      }
      case "bindTerminal":
        requireControl().bindTerminal(args.pid as number);
        // (Re)seat the foreground stack on the interactive shell: keystrokes go
        // here whenever no foreground job is running. A respawned shell rebinds,
        // resetting any stale foreground/raw state to a clean cooked prompt.
        terminalFg.length = 0;
        terminalFg.push(args.pid as number);
        if (terminalRaw) setTerminalRaw(false);
        result = undefined;
        break;
      case "kill":
        killProcess(args.pid as number);
        result = undefined;
        break;
      case "flush":
        await Promise.all([home?.flush(), mnt?.flush(), sys?.flush()]);
        result = undefined;
        break;
      default:
        throw new Error(`unknown kworker command: ${cmd}`);
    }
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    // Preserve the WIT fs-error variant tag (jco throws a tagged value) so the
    // main thread can distinguish e.g. not-found from io-failure.
    const e = err as { payload?: { tag?: string }; tag?: string };
    const tag = e?.payload?.tag ?? e?.tag;
    ctx.postMessage({ id, ok: false, error: String(err), tag });
  }
};
