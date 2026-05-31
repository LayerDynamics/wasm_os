import { detectFeatures, type FeatureReport } from "./features.js";

/** Where the bundled kernel worker is served (see the `bundle` build step).
 * esbuild mirrors the src/ layout under dist/, so worker entries land in
 * dist/worker/. */
const KWORKER_URL = "/dist/worker/kernel-worker.js";

export type Backend = "tmpfs" | "opfs" | "idb";
export interface ProcInfo {
  pid: number;
  name: string;
  state: string;
}
export interface SpawnOptions {
  name?: string;
  /** FS subtree granted to the child (read+write); empty = no FS grant. */
  grantFsSubtree?: string;
  grantSpawn?: boolean;
  /** Grant Gpu — required to request a compositor surface (`win_surface`, M3). */
  grantGpu?: boolean;
  /** Grant Input — required to receive brokered keyboard/mouse (M3-T3). */
  grantInput?: boolean;
}

/** A compositor surface a process created (M3): a shared RGBA framebuffer. */
export interface SurfaceInfo {
  pid: number;
  surfaceId: number;
  width: number;
  height: number;
  /** `width*height*4` RGBA bytes, shared with the owning process worker. */
  sab: SharedArrayBuffer;
}
export interface ProcExit {
  exitCode: number;
  /** Must be false — proves the guest ran in non-shared memory (FR-6). */
  sharedMemory: boolean;
}

/**
 * Async control surface. Every call round-trips to the kernel worker (the
 * kernel itself no longer runs on the main thread), so all methods are async.
 */
export interface AsyncKernelControl {
  mount(path: string, on: Backend): Promise<void>;
  fsWrite(path: string, bytes: Uint8Array): Promise<void>;
  fsRead(path: string): Promise<Uint8Array>;
  fsList(path: string): Promise<string[]>;
  fsDelete(path: string): Promise<void>;
  listProcs(): Promise<ProcInfo[]>;
  /** Drain a process's captured `[stdout, stderr]`. */
  takeCapture(pid: number): Promise<[Uint8Array, Uint8Array]>;
  /** Spawn a guest `.wasm` as a process; returns its PID. */
  spawn(wasmBytes: ArrayBuffer, opts?: SpawnOptions): Promise<number>;
  /** Resolve when the process exits, with its exit code + isolation proof. */
  wait(pid: number): Promise<ProcExit>;
  /** Deliver input bytes to a process's stdin (terminal keystrokes, M2). */
  stdin(pid: number, bytes: Uint8Array): Promise<void>;
  /** Bind a process's stdout/stderr to the terminal (writes stream to xterm). */
  bindTerminal(pid: number): Promise<void>;
  /** Register a listener for streamed terminal output (stdout/stderr → xterm). */
  onOutput(cb: (pid: number, bytes: Uint8Array) => void): void;
  /** A process created a compositor surface (M3) — open its canvas window. */
  onSurface(cb: (info: SurfaceInfo) => void): void;
  /** A process published a frame to `surfaceId` (M3) — blit it to the canvas. */
  onPresent(cb: (surfaceId: number) => void): void;
  /** Await durability of all OPFS/IndexedDB writes (used before reload). */
  flush(): Promise<void>;
}

export interface BootResult {
  bootMillis: number;
  features: FeatureReport;
  control: AsyncKernelControl;
  /** Convenience alias of `control.flush` (kept for existing callers/E2E). */
  flush(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export async function boot(): Promise<BootResult> {
  const t0 = performance.now();
  const features = detectFeatures();

  const worker = new Worker(KWORKER_URL, { type: "module" });
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const outputListeners: Array<(pid: number, bytes: Uint8Array) => void> = [];
  const surfaceListeners: Array<(info: SurfaceInfo) => void> = [];
  const presentListeners: Array<(surfaceId: number) => void> = [];

  worker.onmessage = (e: MessageEvent) => {
    const data = e.data as {
      type?: string;
      pid?: number;
      bytes?: Uint8Array;
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
      tag?: string;
      surfaceId?: number;
      width?: number;
      height?: number;
      sab?: SharedArrayBuffer;
    };
    // Streaming (non-RPC) messages: terminal output as processes write it.
    if (data.type === "output") {
      for (const cb of outputListeners) cb(data.pid ?? 0, data.bytes ?? new Uint8Array());
      return;
    }
    // M3 compositor surfaces.
    if (data.type === "surface" && data.surfaceId !== undefined && data.sab) {
      const info: SurfaceInfo = {
        pid: data.pid ?? 0,
        surfaceId: data.surfaceId,
        width: data.width ?? 0,
        height: data.height ?? 0,
        sab: data.sab,
      };
      for (const cb of surfaceListeners) cb(info);
      return;
    }
    if (data.type === "present" && data.surfaceId !== undefined) {
      for (const cb of presentListeners) cb(data.surfaceId);
      return;
    }
    if (typeof data.id !== "number") return; // unknown message
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) {
      p.resolve(data.result);
    } else {
      const err = new Error(data.error ?? "kworker error") as Error & { tag?: string };
      if (data.tag) err.tag = data.tag;
      p.reject(err);
    }
  };
  worker.onerror = (e) => {
    const err = new Error(`kernel worker crashed: ${e.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, cmd, args });
    });
  }

  await call<{ bootMillis: number; features: FeatureReport }>("init", { features });

  const control: AsyncKernelControl = {
    mount: (path, on) => call("mount", { path, on }),
    fsWrite: (path, bytes) => call("fsWrite", { path, bytes }),
    fsRead: (path) => call("fsRead", { path }),
    fsList: (path) => call("fsList", { path }),
    fsDelete: (path) => call("fsDelete", { path }),
    listProcs: () => call("listProcs"),
    takeCapture: (pid) => call("takeCapture", { pid }),
    spawn: (wasmBytes, opts) =>
      call("spawn", {
        wasmBytes,
        spec: {
          name: opts?.name ?? "proc",
          grantFsSubtree: opts?.grantFsSubtree ?? "",
          grantSpawn: opts?.grantSpawn ?? false,
          grantGpu: opts?.grantGpu ?? false,
          grantInput: opts?.grantInput ?? false,
        },
      }),
    wait: (pid) => call("wait", { pid }),
    stdin: (pid, bytes) => call("stdin", { pid, bytes }),
    bindTerminal: (pid) => call("bindTerminal", { pid }),
    onOutput: (cb) => {
      outputListeners.push(cb);
    },
    onSurface: (cb) => {
      surfaceListeners.push(cb);
    },
    onPresent: (cb) => {
      presentListeners.push(cb);
    },
    flush: () => call("flush"),
  };

  return {
    bootMillis: Math.round(performance.now() - t0),
    features,
    control,
    flush: () => control.flush(),
  };
}
