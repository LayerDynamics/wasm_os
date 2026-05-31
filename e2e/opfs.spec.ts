import { test, expect, type Page } from "@playwright/test";

/** Load the test harness page and wait for the blockstore classes to attach. */
async function harness(page: Page): Promise<void> {
  await page.goto("/packages/host/test-harness.html");
  await page.waitForFunction(
    () => Boolean((window as unknown as { __stores?: unknown }).__stores),
    null,
    { timeout: 15_000 },
  );
}

test("OpfsBlockstore round-trips against REAL OPFS in the browser", async ({ page }) => {
  await harness(page);

  const r = await page.evaluate(async () => {
    const { OpfsBlockstore } = (window as unknown as {
      __stores: { OpfsBlockstore: { create(ns: string): Promise<any> } };
    }).__stores;
    // Unique namespace so the test is independent of any prior OPFS state.
    const store = await OpfsBlockstore.create(`opfs-test-${globalThis.crypto.randomUUID()}`);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    await store.put("/a.txt", enc.encode("alpha"));
    await store.put("/b.txt", enc.encode("beta"));

    const a = dec.decode(await store.get("/a.txt"));
    const list = (await store.list("/")).sort();
    const missing = (await store.get("/nope")) === undefined;
    const deleted = await store.delete("/a.txt");
    const afterDelete = (await store.get("/a.txt")) === undefined;
    const listAfter = (await store.list("/")).sort();

    return { a, list, missing, deleted, afterDelete, listAfter };
  });

  expect(r.a).toBe("alpha");                       // get returns written bytes
  expect(r.list).toEqual(["/a.txt", "/b.txt"]);    // list by prefix
  expect(r.missing).toBe(true);                    // absent key -> undefined
  expect(r.deleted).toBe(true);                    // delete reports existed
  expect(r.afterDelete).toBe(true);                // gone after delete
  expect(r.listAfter).toEqual(["/b.txt"]);         // list reflects deletion
});

test("IdbBlockstore round-trips against REAL IndexedDB in the browser", async ({ page }) => {
  await harness(page);

  const r = await page.evaluate(async () => {
    const { IdbBlockstore } = (window as unknown as {
      __stores: { IdbBlockstore: { create(ns: string, db?: string): Promise<any> } };
    }).__stores;
    const store = await IdbBlockstore.create("mnt", `idb-test-${globalThis.crypto.randomUUID()}`);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    await store.put("/mnt/x", enc.encode("ex"));
    const x = dec.decode(await store.get("/mnt/x"));
    const list = await store.list("/mnt/");
    const deleted = await store.delete("/mnt/x");
    const afterDelete = (await store.get("/mnt/x")) === undefined;
    return { x, list, deleted, afterDelete };
  });

  expect(r.x).toBe("ex");
  expect(r.list).toEqual(["/mnt/x"]);
  expect(r.deleted).toBe(true);
  expect(r.afterDelete).toBe(true);
});
