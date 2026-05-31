import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IdbBlockstore } from "../src/blockstore/idb.js";

describe("IdbBlockstore", () => {
  let store: IdbBlockstore;
  beforeEach(async () => {
    store = await IdbBlockstore.create("mnt", `db-${Math.floor(performance.now())}-${globalThis.crypto.randomUUID()}`);
  });

  it("round-trips bytes", async () => {
    expect(await store.put("/mnt/a.txt", new Uint8Array([1, 2, 3]))).toBe(true);
    expect(Array.from((await store.get("/mnt/a.txt"))!)).toEqual([1, 2, 3]);
  });

  it("lists by prefix", async () => {
    await store.put("/mnt/x", new Uint8Array([1]));
    await store.put("/mnt/y", new Uint8Array([2]));
    const keys = (await store.list("/mnt/")).sort();
    expect(keys).toEqual(["/mnt/x", "/mnt/y"]);
  });

  it("returns undefined for missing keys", async () => {
    expect(await store.get("/mnt/nope")).toBeUndefined();
  });
});
