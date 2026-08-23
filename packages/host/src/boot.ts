import { detectFeatures, type FeatureReport } from "./features.js";

/** Cache-busting token for the stable-path build artifacts (workers + kernel ABI).
 * These live at fixed URLs whose bytes change every deploy; a `?v=` that we bump when
 * the worker/ABI protocol changes evicts any copy a browser cached `immutable` before
 * the server's cache headers were corrected (otherwise a fresh main bundle could call
 * a year-old kernel-worker.js → "unknown kworker command"). */
export const ASSET_VERSION = "2";

/** Where the bundled kernel worker is served (see the `bundle` build step).
 * esbuild mirrors the src/ layout under dist/, so worker entries land in
 * dist/worker/. */
const KWORKER_URL = `/dist/worker/kernel-worker.js?v=${ASSET_VERSION}`;

export type Backend = "tmpfs" | "opfs" | "idb";
export interface ProcInfo {
  pid: number;
  name: string;
  state: string;
  priority: number;
  /** Scheduler ticks (one per serviced syscall) — kernel-activity metric (process control and IPC). */
  cpuTicks: bigint;
  memBytes: number;
  /** Parent pid, or 0 for a host-spawned root. */
  parent: number;
}
export interface SpawnOptions {
  name?: string;
  /** FS subtree granted to the child (read+write); empty = no FS grant. */
  grantFsSubtree?: string;
  grantSpawn?: boolean;
  /** Grant Gpu — required to request a compositor surface (`win_surface`, desktop compositor). */
  grantGpu?: boolean;
  /** Grant Input — required to receive brokered keyboard/mouse (brokered input). */
  grantInput?: boolean;
  /** Grant Signal — process-control authority for the `kill` builtin (signals). */
  grantSignal?: boolean;
  /** Grant Net — brokered networking for the `fetch` coreutil (network broker). */
  grantNet?: boolean;
}

/** Build the kernel spawn-spec from host spawn options (shared by spawn paths). */
function spawnSpec(opts?: SpawnOptions) {
  return {
    name: opts?.name ?? "proc",
    grantFsSubtree: opts?.grantFsSubtree ?? "",
    grantSpawn: opts?.grantSpawn ?? false,
    grantGpu: opts?.grantGpu ?? false,
    grantInput: opts?.grantInput ?? false,
    grantSignal: opts?.grantSignal ?? false,
    grantNet: opts?.grantNet ?? false,
  };
}

/** Options for launching the emulator process (Linux guest integration). The MIT TinyEMU runtime is a
 * fixed vendored asset; the caller chooses the VM config (which names the bios,
 * kernel, and rootfs) plus an optional extra cmdline. */
export interface EmulatorOptions {
  name?: string;
  /** Same-origin URL of the TinyEMU VM config (.cfg) to boot. */
  configUrl: string;
  /** Extra kernel cmdline appended to the cfg's own cmdline. */
  cmdline?: string;
  memoryMb?: number;
}

/** A small JSON descriptor naming an image to boot, fetched at runtime (runtime image selection). */
export interface ImageManifest {
  name?: string;
  configUrl: string;
  cmdline?: string;
}

// The default riscv64 VM config (names the vendored bios/kernel/rootfs).
const DEFAULT_CONFIG_URL = "/assets/linux/wasmos-riscv64.cfg";

/** Build the emulator-worker boot message for a given VM config (Linux guest integration). */
function emulatorBoot(configUrl: string, cmdline?: string, memoryMb = 128) {
  return {
    configUrl: configUrl || DEFAULT_CONFIG_URL,
    cmdline: cmdline ?? "",
    memoryMb,
  };
}

/** A compositor surface a process created (desktop compositor): a shared RGBA framebuffer. */
export interface SurfaceInfo {
  pid: number;
  /** Kernel process name, including guests launched from the file manager. */
  name?: string;
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

export interface InputDelivery {
  accepted: boolean;
  wakeups: Uint32Array;
}

/**
 * Async control surface. Every call round-trips to the kernel worker (the
 * kernel itself no longer runs on the main thread), so all methods are async.
 */
export interface AsyncKernelControl {
  mount(path: string, on: Backend): Promise<void>;
  fsWrite(path: string, bytes: Uint8Array): Promise<void>;
  /** Create a directory and all missing parents (`mkdir -p`); idempotent. */
  fsMkdirp(path: string): Promise<void>;
  /** Seed the kernel's /dev/[u]random generator with real host CSPRNG entropy. */
  seedEntropy(seed: Uint8Array): Promise<void>;
  fsRead(path: string): Promise<Uint8Array>;
  fsList(path: string): Promise<string[]>;
  fsDelete(path: string): Promise<void>;
  listProcs(): Promise<ProcInfo[]>;
  /** Drain a process's captured `[stdout, stderr]`. */
  takeCapture(pid: number): Promise<[Uint8Array, Uint8Array]>;
  /** Spawn a guest `.wasm` as a process; returns its PID. */
  spawn(wasmBytes: ArrayBuffer, opts?: SpawnOptions): Promise<number>;
  /** Spawn from a guest image already installed in the VFS (e.g. /usr/bin/sh).
   * The kworker reads the bytes from the VFS, so the host never retains a copy —
   * the dominant boot-memory saving over keeping every guest's bytes resident. */
  spawnByPath(imagePath: string, opts?: SpawnOptions): Promise<number>;
  /** Launch the privileged emulator process (Linux guest integration, FR-27): a Native process whose
   * body is a dedicated TinyEMU worker booting a real Linux. Returns its PID. */
  spawnEmulator(opts: EmulatorOptions): Promise<number>;
  /** Boot the emulator from an image named by a manifest fetched at runtime
   * (runtime image selection) — the system loads + runs an image resolved at launch, not hardcoded. */
  spawnEmulatorFromManifest(manifestUrl: string): Promise<number>;
  /** Register a listener for the emulator's serial console (running text, Linux guest integration). */
  onEmulatorSerial(cb: (pid: number, text: string) => void): void;
  /** Deliver brokered keystrokes to the emulator's guest console (guest console input). */
  emulatorInput(pid: number, text: string): Promise<void>;
  /** Resolve when the process exits, with its exit code + isolation proof. */
  wait(pid: number): Promise<ProcExit>;
  /** Deliver input bytes to a process's stdin (terminal keystrokes, shell and userland). */
  stdin(pid: number, bytes: Uint8Array): Promise<void>;
  /** Deliver keystrokes to the terminal's current foreground job (a running
   *  editor/filter, else the shell). The kworker tracks the foreground stack so
   *  input reaches a program like nano while the shell is parked in `wait()`. */
  terminalInput(bytes: Uint8Array): Promise<boolean>;
  /** A foreground program toggled the terminal's line discipline via
   *  `tty_set_raw` — `raw` true means pass keys through verbatim (no echo, no
   *  line buffering); false restores cooked mode. Reset to cooked if it exits. */
  onTermMode(cb: (raw: boolean) => void): void;
  /** Deliver brokered input events to the focused window's process (brokered input). */
  deliverInput(pid: number, bytes: Uint8Array): Promise<InputDelivery>;
  /** Bind a process's stdout/stderr to the terminal (writes stream to xterm). */
  bindTerminal(pid: number): Promise<void>;
  /** Register a listener for streamed terminal output (stdout/stderr → xterm). */
  onOutput(cb: (pid: number, bytes: Uint8Array) => void): void;
  /** A process created a compositor surface (desktop compositor) — open its canvas window. */
  onSurface(cb: (info: SurfaceInfo) => void): void;
  /** A process published a frame to `surfaceId` (desktop compositor) — blit it to the canvas. */
  onPresent(cb: (surfaceId: number) => void): void;
  /** Kill a process (desktop compositor): close a window → reap its process. */
  kill(pid: number): Promise<void>;
  /** A process exited/trapped (desktop compositor) — close its windows (crash containment). */
  onExit(cb: (pid: number) => void): void;
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
  const exitListeners: Array<(pid: number) => void> = [];
  const emulatorSerialListeners: Array<(pid: number, text: string) => void> = [];
  const termModeListeners: Array<(raw: boolean) => void> = [];

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
      name?: string;
      width?: number;
      height?: number;
      sab?: SharedArrayBuffer;
      text?: string;
      raw?: boolean;
    };
    // Streaming (non-RPC) messages: terminal output as processes write it.
    if (data.type === "output") {
      for (const cb of outputListeners) cb(data.pid ?? 0, data.bytes ?? new Uint8Array());
      return;
    }
    // Desktop compositor surfaces.
    if (data.type === "surface" && data.surfaceId !== undefined && data.sab) {
      const info: SurfaceInfo = {
        pid: data.pid ?? 0,
        name: data.name,
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
    if (data.type === "exit" && data.pid !== undefined) {
      for (const cb of exitListeners) cb(data.pid);
      return;
    }
    // Linux guest integration: the emulator process's serial console (running text).
    if (data.type === "emulatorSerial" && data.pid !== undefined) {
      for (const cb of emulatorSerialListeners) cb(data.pid, data.text ?? "");
      return;
    }
    // A foreground program toggled the terminal's raw/cooked line discipline.
    if (data.type === "termMode") {
      for (const cb of termModeListeners) cb(data.raw ?? false);
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
    fsMkdirp: (path) => call("fsMkdirp", { path }),
    seedEntropy: (seed) => call("seedEntropy", { seed }),
    fsRead: (path) => call("fsRead", { path }),
    fsList: (path) => call("fsList", { path }),
    fsDelete: (path) => call("fsDelete", { path }),
    listProcs: () => call("listProcs"),
    takeCapture: (pid) => call("takeCapture", { pid }),
    spawn: (wasmBytes, opts) => call("spawn", { wasmBytes, spec: spawnSpec(opts) }),
    spawnByPath: (imagePath, opts) => call("spawnByPath", { imagePath, spec: spawnSpec(opts) }),
    spawnEmulator: (opts) =>
      call("spawnEmulator", {
        name: opts.name ?? "linux",
        boot: emulatorBoot(opts.configUrl, opts.cmdline, opts.memoryMb),
      }),
    spawnEmulatorFromManifest: async (manifestUrl) => {
      // Fetch a small image descriptor at runtime, then boot the config it names
      // ("run the image from within it", runtime image selection). The descriptor is small enough to
      // travel any path; the bios/kernel/rootfs are loaded by TinyEMU from the cfg.
      const res = await fetch(manifestUrl);
      if (!res.ok) {
        throw new Error(`image manifest fetch failed: ${res.status} ${res.statusText}`);
      }
      const m = (await res.json()) as ImageManifest;
      // Constrain a provided configUrl to a same-origin absolute path so a manifest
      // cannot aim TinyEMU at an arbitrary external config (which itself names the
      // bios/kernel/rootfs it loads). An empty/absent value uses the default config.
      if (m.configUrl && !(m.configUrl.startsWith("/") && !m.configUrl.startsWith("//"))) {
        throw new Error(`image manifest configUrl must be a same-origin path: ${m.configUrl}`);
      }
      return call<number>("spawnEmulator", {
        name: m.name ?? "linux",
        boot: emulatorBoot(m.configUrl, m.cmdline),
      });
    },
    onEmulatorSerial: (cb) => {
      emulatorSerialListeners.push(cb);
    },
    emulatorInput: (pid, text) => call("emulatorInput", { pid, text }),
    wait: (pid) => call("wait", { pid }),
    stdin: (pid, bytes) => call("stdin", { pid, bytes }),
    terminalInput: (bytes) => call("terminalInput", { bytes }),
    onTermMode: (cb) => {
      termModeListeners.push(cb);
    },
    deliverInput: (pid, bytes) => call("deliverInput", { pid, bytes }),
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
    kill: (pid) => call("kill", { pid }),
    onExit: (cb) => {
      exitListeners.push(cb);
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
