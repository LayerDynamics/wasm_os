/**
 * WASI Preview 1 runtime for one isolated guest process.
 *
 * This is the process boundary: it owns WebAssembly instantiation, wires the
 * standard WASI imports and the WASM_OS kernel extension, validates the guest
 * memory contract, and starts the module. The import implementations remain in
 * `wasi-shim.ts`; this class owns the lifecycle that turns those imports into a
 * running WASI process.
 */
import { RingClient } from "../ring/guest.js";
import {
  makeKernelImports,
  makeWasiImports,
  type SurfaceHost,
} from "./wasi-shim.js";

export interface WasiRuntimeOptions {
  /** The stock `wasm32-wasip1` guest module to execute. */
  wasmBytes: ArrayBuffer;
  /** The guest's private syscall ring. */
  ring: RingClient;
  /** Host hooks for compositor surfaces created by the guest. */
  surfaces: SurfaceHost;
}

export interface WasiRuntimeState {
  /** The instantiated guest. Exposed for process metrics and diagnostics. */
  instance: WebAssembly.Instance;
  /** The guest's private, non-shared linear memory. */
  memory: WebAssembly.Memory;
  /** Whether the guest violated the process isolation memory contract. */
  sharedMemory: boolean;
  /** The imports requested by the guest, grouped by namespace and name. */
  imports: ReadonlyArray<{ module: string; name: string; kind: string }>;
}

export interface WasiRuntimeInspection {
  imports: ReadonlyArray<{ module: string; name: string; kind: string }>;
  exports: ReadonlyArray<{ name: string; kind: string }>;
}

/**
 * Instantiate and run one WASI Preview 1 process.
 *
 * Every guest gets a separate runtime instance. The runtime never gives a guest
 * another process's memory: its only shared object is the ring supplied by the
 * kernel worker for that process. `proc_exit` still propagates as `ProcExit`
 * from the import layer so the worker can report the guest's exit code.
 */
export class WasiRuntime {
  private instance: WebAssembly.Instance | undefined;
  private module: WebAssembly.Module | undefined;
  private imports: WasiRuntimeInspection["imports"] = [];
  private started = false;

  constructor(private readonly options: WasiRuntimeOptions) {}

  /** Instantiate the module and validate its required WASI process exports. */
  async instantiate(): Promise<WasiRuntimeState> {
    if (this.instance) return this.state();

    this.module = await WebAssembly.compile(this.options.wasmBytes);
    this.imports = WebAssembly.Module.imports(this.module).map((entry) => ({
      module: entry.module,
      name: entry.name,
      kind: entry.kind,
    }));

    const getMemory = (): WebAssembly.Memory => {
      const memory = this.instance?.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new WebAssembly.LinkError("WASI guest must export a linear memory named `memory`");
      }
      return memory;
    };

    const wasi = makeWasiImports(getMemory, this.options.ring);
    const wasmosKernel = makeKernelImports(getMemory, this.options.ring, this.options.surfaces);
    const instance = await WebAssembly.instantiate(this.module, {
      wasi_snapshot_preview1: wasi,
      wasmos_kernel: wasmosKernel,
    });
    this.instance = instance;

    if (typeof instance.exports._start !== "function") {
      throw new WebAssembly.LinkError("WASI guest must export `_start`");
    }
    return this.state();
  }

  /** Instantiate, then enter the guest's WASI `_start` entrypoint. */
  async run(): Promise<WasiRuntimeState> {
    const state = await this.instantiate();
    if (this.started) throw new Error("WASI runtime cannot be started twice");
    this.started = true;
    (state.instance.exports._start as () => void)();
    return state;
  }

  /** Return the validated runtime state after instantiation. */
  state(): WasiRuntimeState {
    if (!this.instance) throw new Error("WASI runtime has not been instantiated");
    const memory = this.instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new WebAssembly.LinkError("WASI guest must export a linear memory named `memory`");
    }
    return {
      instance: this.instance,
      memory,
      sharedMemory: memory.buffer instanceof SharedArrayBuffer,
      imports: this.imports,
    };
  }

  /** Inspect a guest module without instantiating it or starting its code. */
  static async inspect(wasmBytes: ArrayBuffer): Promise<WasiRuntimeInspection> {
    const module = await WebAssembly.compile(wasmBytes);
    return {
      imports: WebAssembly.Module.imports(module).map((entry) => ({
        module: entry.module,
        name: entry.name,
        kind: entry.kind,
      })),
      exports: WebAssembly.Module.exports(module).map((entry) => ({
        name: entry.name,
        kind: entry.kind,
      })),
    };
  }
}
