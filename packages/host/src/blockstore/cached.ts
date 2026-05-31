import type { Blockstore } from "./types.js";

/**
 * Synchronous write-back cache over an async Blockstore (OPFS/IndexedDB).
 *
 * The kernel imports `home-store`/`mnt-store` as SYNCHRONOUS functions
 * (`get`/`put`/`listKeys`/`delete` return values directly), but OPFS and
 * IndexedDB are async-only. This cache bridges the gap:
 *   - `load()` pulls all persisted keys into an in-memory mirror at boot
 *     (awaited BEFORE the kernel boots, so reads see persisted data).
 *   - sync `get/put/listKeys/delete` operate on the mirror (no await).
 *   - writes are queued to the async backing store; `flush()` awaits them.
 *
 * Persistence is real: writes reach OPFS/IndexedDB. Callers that need
 * durability before a reload (the E2E) await `flush()` first.
 */
export class CachedStore {
  private mirror = new Map<string, Uint8Array>();
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(private backing: Blockstore) {}

  static async load(backing: Blockstore): Promise<CachedStore> {
    const store = new CachedStore(backing);
    const keys = await backing.list("");
    for (const key of keys) {
      const value = await backing.get(key);
      if (value) store.mirror.set(key, value);
    }
    return store;
  }

  /** The synchronous import object the kernel binds to (jco names). */
  imports() {
    return {
      get: (key: string): Uint8Array | undefined => this.mirror.get(key),
      put: (key: string, value: Uint8Array): boolean => {
        // Copy: the bytes come from wasm linear memory and may be reused.
        const copy = value.slice();
        this.mirror.set(key, copy);
        this.enqueue(() => this.backing.put(key, copy));
        return true;
      },
      listKeys: (prefix: string): string[] =>
        [...this.mirror.keys()].filter((k) => k.startsWith(prefix)),
      delete: (key: string): boolean => {
        const existed = this.mirror.has(key);
        this.mirror.delete(key);
        this.enqueue(() => this.backing.delete(key));
        return existed;
      },
    };
  }

  private enqueue(op: () => Promise<unknown> | unknown): void {
    this.pending = this.pending.then(op, op);
  }

  /** Await all queued writes so they are durable in the backing store. */
  async flush(): Promise<void> {
    await this.pending;
  }
}
