/**
 * Process worker (WASI process runtime) — one per process, the unit of isolation (FR-6).
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
import { ProcExit } from "./wasi-shim.js";
import { WasiRuntime } from "./wasi-runtime.js";

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
  // Desktop compositor surfaces: this worker owns each surface's framebuffer SAB and
  // relays surface/present notifications to the kworker (→ compositor). Pixels are
  // copied guest-memory → SAB here; they never enter the kernel ring.
  const surfaces = new Map<number, Uint8Array>(); // surfaceId -> framebuffer SAB view
  const runtime = new WasiRuntime({
    wasmBytes,
    ring,
    surfaces: {
      onSurface(surfaceId: number, width: number, height: number): void {
        const sab = new SharedArrayBuffer(width * height * 4);
        surfaces.set(surfaceId, new Uint8Array(sab));
        ctx.postMessage({ type: "surface", pid, surfaceId, width, height, sab });
      },
      onPresent(surfaceId: number, src: Uint8Array): void {
        const view = surfaces.get(surfaceId);
        if (!view) return;
        view.set(src.subarray(0, view.length));
        ctx.postMessage({ type: "present", pid, surfaceId });
      },
    },
  });
  let sharedMemory = false;

  try {
    // Publish memory metrics as soon as the guest exists. `_start` may remain
    // inside a blocking WASI read for the lifetime of an interactive process,
    // so waiting until run() returns would leave the process table at zero.
    const state = await runtime.instantiate();
    sharedMemory = state.sharedMemory;
    // Report the instantiated guest memory size for `ps`/`top` (process control and IPC).
    ctx.postMessage({ type: "mem", pid, bytes: state.memory.buffer.byteLength });
    await runtime.run();
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
