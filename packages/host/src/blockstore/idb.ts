import type { Blockstore } from "./types.js";

const DB = "wasmos";
const STORE = "blocks";

function open(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbBlockstore implements Blockstore {
  constructor(private db: IDBDatabase, private ns: string) {}

  static async create(namespace: string, dbName = DB): Promise<IdbBlockstore> {
    return new IdbBlockstore(await open(dbName), namespace);
  }

  private k(key: string) { return `${this.ns}:${key}`; }

  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = await this.tx<ArrayBuffer | undefined>("readonly", (s) => s.get(this.k(key)));
    return v ? new Uint8Array(v) : undefined;
  }

  async put(key: string, value: Uint8Array): Promise<boolean> {
    try {
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      await this.tx("readwrite", (s) => s.put(buf, this.k(key)));
      return true;
    } catch { return false; }
  }

  async list(prefix: string): Promise<string[]> {
    const keys = await this.tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    const full = `${this.ns}:${prefix}`;
    return keys
      .map(String)
      .filter((k) => k.startsWith(full))
      .map((k) => k.slice(this.ns.length + 1));
  }

  async delete(key: string): Promise<boolean> {
    const existed = (await this.get(key)) !== undefined;
    await this.tx("readwrite", (s) => s.delete(this.k(key)));
    return existed;
  }
}
