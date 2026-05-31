/**
 * Process worker (M1) — one per process, the unit of isolation (FR-6).
 *
 * Receives a guest `wasm32-wasip1` module + a syscall ring, instantiates the
 * guest with the hand-written WASI shim, and runs `_start`. The guest's linear
 * memory is its OWN non-shared `WebAssembly.Memory`; the only SAB this worker
 * touches is its own syscall ring. There is no path to a peer's memory — that
 * is the structural isolation guarantee.
 *
 * `proc_exit` unwinds via the {@link ProcExit} sentinel; a WASM trap (panic /
 * unreachable) is caught here and reported as a contained crash (FR-34). Either
 * way the worker posts its exit and terminates.
 */
import { RingClient } from "../ring/guest.js";
import { makeWasiImports, makeKernelImports, ProcExit } from "./wasi-shim.js";

interface SpawnMessage {
  wasmBytes: ArrayBuffer;
  pid: number;
  ringSab: SharedArrayBuffer;
}

export interface ExitMessage {
  pid: number;
  exit: { kind: "exit" | "trap"; code: number; message?: string };
  /** True only if the guest memory was shared — must be false (isolation proof). */
  sharedMemory: boolean;
}

/** Minimal view of the dedicated-worker global (avoids DOM/WebWorker lib clash). */
type WorkerScope = {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};
const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (ev: MessageEvent) => {
  const { wasmBytes, pid, ringSab } = ev.data as SpawnMessage;
  const ring = new RingClient(ringSab);
  let instance: WebAssembly.Instance | undefined;
  const getMemory = () => instance!.exports.memory as WebAssembly.Memory;
  const wasi = makeWasiImports(getMemory, ring);
  const wasmosKernel = makeKernelImports(getMemory, ring);
  let sharedMemory = false;

  try {
    const result = await WebAssembly.instantiate(wasmBytes, {
      wasi_snapshot_preview1: wasi,
      wasmos_kernel: wasmosKernel,
    });
    instance = result.instance;
    const mem = instance.exports.memory as WebAssembly.Memory;
    sharedMemory = mem.buffer instanceof SharedArrayBuffer;

    const start = instance.exports._start as () => void;
    start();
    // _start returned without calling proc_exit → conventional exit 0.
    const msg: ExitMessage = { pid, exit: { kind: "exit", code: 0 }, sharedMemory };
    ctx.postMessage(msg);
  } catch (err) {
    if (err instanceof ProcExit) {
      const msg: ExitMessage = { pid, exit: { kind: "exit", code: err.code }, sharedMemory };
      ctx.postMessage(msg);
    } else {
      // WASM trap, LinkError, panic — contained to this process only.
      const msg: ExitMessage = {
        pid,
        exit: { kind: "trap", code: 134, message: String(err) },
        sharedMemory,
      };
      ctx.postMessage(msg);
    }
  } finally {
    ctx.close();
  }
};
