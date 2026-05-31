/**
 * Kernel worker (kworker) — M1.
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

const ABI_BASE = "/packages/abi/generated";
const PROCESS_WORKER_URL = "/dist/worker/process-worker.js";

type Backend = "tmpfs" | "opfs" | "idb";
interface SpawnSpec {
  name: string;
  grantFsSubtree: string;
  grantSpawn: boolean;
  grantGpu: boolean;
  grantInput: boolean;
}

/** Synchronous kernel control surface (jco-generated export shape). */
interface KernelControl {
  boot(f: FeatureReport): { ready: boolean; bootMillis: number; features: FeatureReport };
  mount(path: string, on: Backend): void;
  fsWrite(path: string, bytes: Uint8Array): void;
  fsRead(path: string): Uint8Array;
  fsList(path: string): string[];
  fsDelete(path: string): void;
  listProcs(): Array<{ pid: number; name: string; state: string }>;
  spawn(spec: SpawnSpec): number;
  serviceSyscall(pid: number, request: Uint8Array): SyscallOutcome;
  deliverStdin(pid: number, bytes: Uint8Array): Uint32Array;
  deliverInput(pid: number, bytes: Uint8Array): Uint32Array;
  bindTerminal(pid: number): void;
  exitCode(pid: number): number | undefined;
  takeCapture(pid: number): [Uint8Array, Uint8Array];
}

/** M2 park/resume outcome (jco maps `option<list<u8>>` → `Uint8Array | undefined`). */
interface SyscallOutcome {
  reply: Uint8Array | undefined;
  wakeups: Uint32Array;
  termOutput: Uint8Array;
  /** Set when a guest spawned a child the kworker must instantiate (M2-T5). */
  spawn?: { pid: number; imagePath: string };
}

interface KernelModule {
  instantiate(
    getCoreModule: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, unknown>,
  ): Promise<{ control: KernelControl }>;
}

type WorkerScope = {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};
const ctx = self as unknown as WorkerScope;

// --- kworker state (populated on init) ---
let control: KernelControl | undefined;
let home: CachedStore | undefined;
let mnt: CachedStore | undefined;

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

/**
 * Parked syscalls (M2): a pid → the request bytes it parked on. While parked,
 * the guest stays blocked in `Atomics.wait`; a wakeup re-drives the request.
 */
const parked = new Map<number, Uint8Array>();

/** M3 compositor surfaces: `surface_id -> owning pid` (present authorization). */
const surfaceOwners = new Map<number, number>();

/** Drive one syscall: complete it now, or park it; then process its wakeups. */
function driveSyscall(pid: number, request: Uint8Array): void {
  const rt = procs.get(pid);
  if (!rt) return;
  const outcome = requireControl().serviceSyscall(pid, request);
  if (outcome.termOutput.length > 0) {
    ctx.postMessage({ type: "output", pid, bytes: outcome.termOutput });
  }
  if (outcome.spawn) handleSpawnRequest(outcome.spawn);
  if (outcome.reply === undefined) {
    parked.set(pid, request); // park — do NOT complete the ring
  } else {
    rt.server.complete(outcome.reply);
  }
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
    if (outcome.spawn) handleSpawnRequest(outcome.spawn);
    if (outcome.reply === undefined) {
      parked.set(w, request); // parked again (e.g. wait on a not-yet-exited child)
    } else {
      rt.server.complete(outcome.reply);
    }
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
  home = await CachedStore.load(homeBacking);
  mnt = await CachedStore.load(mntBacking);

  // Dynamic import via a non-literal path so the bundler keeps it external; the
  // browser fetches the generated component + its core modules at runtime.
  const kernelUrl = `${ABI_BASE}/kernel.js`;
  const mod: KernelModule = await import(/* @vite-ignore */ kernelUrl);
  const getCoreModule = (path: string) =>
    WebAssembly.compileStreaming(fetch(`${ABI_BASE}/${path}`));

  const instance = await mod.instantiate(getCoreModule, {
    "wasmos:abi/home-store": home.imports(),
    "wasmos:abi/mnt-store": mnt.imports(),
  });
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
  // `wait()` would hang (M2-T5) — and a trap would not be contained (FR-34).
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
    };
    // M3 compositor surfaces: a process worker created a surface or published a
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

/** Host-initiated spawn (the M1 path): allocate the PID, then instantiate. */
function spawn(spec: SpawnSpec, wasmBytes: ArrayBuffer): number {
  const pid = requireControl().spawn(spec);
  instantiateProcess(pid, wasmBytes);
  return pid;
}

/**
 * Guest-initiated spawn (KSPAWN, M2): the kernel already allocated the child's
 * PID/fds/caps and returned a `spawn` request. Read its image from the VFS and
 * bring it to life.
 */
function handleSpawnRequest(req: { pid: number; imagePath: string }): void {
  const image = requireControl().fsRead(req.imagePath);
  instantiateProcess(req.pid, image);
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
      case "listProcs":
        result = requireControl().listProcs();
        break;
      case "takeCapture":
        result = requireControl().takeCapture(args.pid as number);
        break;
      case "spawn":
        result = spawn(args.spec as SpawnSpec, args.wasmBytes as ArrayBuffer);
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
      case "deliverInput": {
        // Deliver brokered keyboard/mouse to the focused window's process (M3-T3);
        // wake any parked win_read_input.
        const wakeups = requireControl().deliverInput(args.pid as number, args.bytes as Uint8Array);
        processWakeups(wakeups);
        result = undefined;
        break;
      }
      case "bindTerminal":
        requireControl().bindTerminal(args.pid as number);
        result = undefined;
        break;
      case "flush":
        await Promise.all([home?.flush(), mnt?.flush()]);
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
