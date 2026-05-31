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
  serviceSyscall(pid: number, request: Uint8Array): Uint8Array;
  exitCode(pid: number): number | undefined;
  takeCapture(pid: number): [Uint8Array, Uint8Array];
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
  abort: AbortController;
  exited: boolean;
  exitCode: number;
  sharedMemory: boolean;
  waiters: Array<(exitCode: number) => void>;
}
const procs = new Map<number, ProcRuntime>();

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

  if (msg.exit.kind === "trap") {
    // A trapping guest never reached proc_exit; record the exit in the kernel
    // so the process zombifies and `wait` resolves (FR-34 containment).
    requireControl().serviceSyscall(pid, encodeProcExit(msg.exit.code));
  }
  rt.exited = true;
  rt.exitCode = msg.exit.code;
  rt.sharedMemory = msg.sharedMemory;

  // Tear down the worker + ring servicing loop.
  rt.abort.abort();
  wakeRing(rt.ringSab);
  rt.worker.terminate();

  for (const resolve of rt.waiters) resolve(rt.exitCode);
  rt.waiters = [];
}

function spawn(spec: SpawnSpec, wasmBytes: ArrayBuffer): number {
  const ctl = requireControl();
  const pid = ctl.spawn(spec);

  const ringSab = createRing();
  const abort = new AbortController();
  const server = new RingServer(ringSab);
  // Service this ring until the process exits (loop re-arms per syscall).
  void server
    .serve((req) => ctl.serviceSyscall(pid, req), { signal: abort.signal })
    .catch((e) => console.error(`ring serve error for pid ${pid}:`, e));

  const worker = new Worker(PROCESS_WORKER_URL, { type: "module" });
  worker.onmessage = (e: MessageEvent) => onProcExit(pid, e.data as ExitMessage);
  worker.postMessage({ wasmBytes, pid, ringSab });

  procs.set(pid, {
    worker,
    ringSab,
    abort,
    exited: false,
    exitCode: 0,
    sharedMemory: false,
    waiters: [],
  });
  return pid;
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
