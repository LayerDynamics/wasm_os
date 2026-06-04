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
  /** First backing-store write failure since the last flush(), surfaced there. */
  private writeError: unknown = undefined;

  private constructor(private backing: Blockstore) {}

  static async load(backing: Blockstore): Promise<CachedStore> {
    const store = new CachedStore(backing);
    const keys = await backing.list("");
    // Read every persisted block CONCURRENTLY — this runs before the kernel boots on
    // every reload, and a sequential await-per-key walk over a grown OPFS/IndexedDB
    // store is a dominant cold-boot cost. The backends serve concurrent gets fine.
    const values = await Promise.all(keys.map((key) => backing.get(key)));
    keys.forEach((key, i) => {
      const value = values[i];
      if (value) store.mirror.set(key, value);
    });
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
    // Run each op after the previous one SETTLES (keeps writes ordered), but capture
    // the first backing failure instead of swallowing it. The previous form,
    // `pending.then(op, op)`, reused `op` as the catch handler — so a rejected write
    // silently re-ran the next op against the rejection value and consumed the
    // error, leaving flush() resolving as if every write had succeeded.
    const run = () =>
      Promise.resolve()
        .then(op)
        .catch((e) => {
          if (this.writeError === undefined) this.writeError = e;
          console.error("CachedStore: backing write failed:", e);
        });
    this.pending = this.pending.then(run, run);
  }

  /** Await all queued writes so they are durable in the backing store. Rejects if
   * any queued write failed since the last flush, so a caller relying on durability
   * (the E2E) sees the lost write instead of a false success. */
  async flush(): Promise<void> {
    await this.pending;
    if (this.writeError !== undefined) {
      const e = this.writeError;
      this.writeError = undefined;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}
