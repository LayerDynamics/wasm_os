import type { Blockstore } from "./types.js";

/** Encodes a vfs path into a single OPFS filename (paths are flat keys at kernel/VFS bootstrap). */
function enc(key: string): string {
  return encodeURIComponent(key);
}

export class OpfsBlockstore implements Blockstore {
  constructor(private root: FileSystemDirectoryHandle) {}

  static async create(namespace: string): Promise<OpfsBlockstore> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(namespace, { create: true });
    return new OpfsBlockstore(dir);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const fh = await this.root.getFileHandle(enc(key));
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch { return undefined; }
  }

  async put(key: string, value: Uint8Array): Promise<boolean> {
    try {
      const fh = await this.root.getFileHandle(enc(key), { create: true });
      const w = await fh.createWritable();
      // Copy into a guaranteed ArrayBuffer-backed view (the input may be
      // SharedArrayBuffer-backed, which the Writable stream type rejects).
      const buf = new Uint8Array(value.byteLength);
      buf.set(value);
      await w.write(buf);
      await w.close();
      return true;
    } catch { return false; }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    // @ts-expect-error: async iterator is standard on FileSystemDirectoryHandle.
    for await (const name of this.root.keys()) {
      const key = decodeURIComponent(name);
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }

  async delete(key: string): Promise<boolean> {
    try { await this.root.removeEntry(enc(key)); return true; } catch { return false; }
  }
}
