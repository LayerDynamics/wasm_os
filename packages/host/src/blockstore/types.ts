/** Matches wit/blockstore.wit — implemented by the host, imported by the kernel. */
export interface Blockstore {
  get(key: string): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  put(key: string, value: Uint8Array): Promise<boolean> | boolean;
  list(prefix: string): Promise<string[]> | string[];
  delete(key: string): Promise<boolean> | boolean;
}
