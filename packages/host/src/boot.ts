import { detectFeatures, type FeatureReport } from "./features.js";
import { OpfsBlockstore } from "./blockstore/opfs.js";
import { IdbBlockstore } from "./blockstore/idb.js";
import { CachedStore } from "./blockstore/cached.js";
import type { Blockstore } from "./blockstore/types.js";

/** Where the Binder writes the jco-transpiled component (served at site root). */
const ABI_BASE = "/packages/abi/generated";

/** Structural shape of the generated `control` export (jco camelCase names). */
export type Backend = "tmpfs" | "opfs" | "idb";
export interface KernelControl {
  boot(features: FeatureReport): { ready: boolean; bootMillis: number; features: FeatureReport };
  mount(path: string, on: Backend): void;
  fsWrite(path: string, bytes: Uint8Array): void;
  fsRead(path: string): Uint8Array;
  fsList(path: string): string[];
  listProcs(): { pid: number; name: string; state: string }[];
}

export interface BootResult {
  bootMillis: number;
  features: FeatureReport;
  control: KernelControl;
  /** Await durability of all writes to OPFS/IndexedDB (used before reload). */
  flush(): Promise<void>;
}

export async function boot(): Promise<BootResult> {
  const t0 = performance.now();
  const features = detectFeatures();

  // Backing stores: /home on OPFS (IndexedDB fallback), /mnt on IndexedDB.
  const homeBacking: Blockstore = features.opfs
    ? await OpfsBlockstore.create("home")
    : await IdbBlockstore.create("home");
  const mntBacking: Blockstore = await IdbBlockstore.create("mnt");

  // Pre-load persisted data into synchronous write-back caches BEFORE boot,
  // so the kernel's synchronous imports observe data from previous sessions.
  const home = await CachedStore.load(homeBacking);
  const mnt = await CachedStore.load(mntBacking);

  // Instantiate the kernel component (jco async-instantiation mode). The kernel
  // is split into kernel.coreN.wasm modules fetched on demand by getCoreModule.
  const mod: {
    instantiate(
      getCoreModule: (path: string) => Promise<WebAssembly.Module>,
      imports: Record<string, unknown>,
    ): Promise<{ control: KernelControl }>;
  } = await import(/* @vite-ignore */ `${ABI_BASE}/kernel.js`);

  const getCoreModule = (path: string) =>
    WebAssembly.compileStreaming(fetch(`${ABI_BASE}/${path}`));

  // jco's instantiate() reads UNVERSIONED import keys at runtime (the @0.1.0
  // suffix appears only in the .d.ts ImportObject type).
  const instance = await mod.instantiate(getCoreModule, {
    "wasmos:abi/home-store": home.imports(),
    "wasmos:abi/mnt-store": mnt.imports(),
  });

  const control = instance.control;
  const status = control.boot(features);
  if (!status.ready) throw new Error("kernel failed to reach ready");

  return {
    bootMillis: Math.round(performance.now() - t0),
    features,
    control,
    flush: async () => {
      await Promise.all([home.flush(), mnt.flush()]);
    },
  };
}
