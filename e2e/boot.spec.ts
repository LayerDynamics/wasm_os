import { test, expect, type Page } from "@playwright/test";

/** Attach error capture and wait until boot sets window.__wasmos (race-free). */
async function waitForBoot(page: Page, errors: string[]): Promise<void> {
  try {
    await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, { timeout: 15_000 });
  } catch {
    throw new Error("kernel did not reach ready. Browser errors:\n" + (errors.join("\n") || "(none captured)"));
  }
}

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  return errors;
}

test("boots to ready under 1.5s and reports a tier", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  const result = await page.evaluate(() => {
    const w = (window as unknown as {
      __wasmos: { bootMillis: number; coldLoadMillis: number; features: { tier: string; opfs: boolean; crossOriginIsolated: boolean } };
    }).__wasmos;
    return { bootMillis: w.bootMillis, coldLoadMillis: w.coldLoadMillis, features: w.features };
  });
  // coldLoadMillis is the FULL cold boot from navigation start (HTML + script +
  // wasm download + kernel init) — the spec's real <1500ms cold-boot criterion.
  expect(result.coldLoadMillis).toBeLessThan(1500);
  // bootMillis (kernel init only) is necessarily within the full cold load.
  expect(result.bootMillis).toBeLessThanOrEqual(result.coldLoadMillis);
  // The dev/E2E server sets COOP/COEP, so isolation MUST hold and tier MUST be A.
  // This verifies the headers actually take effect (not just that a tier is reported).
  expect(result.features.crossOriginIsolated).toBe(true);
  expect(result.features.tier).toBe("A");
  await expect(page.locator("#status")).toContainText("ready in");

  // FR-2/FR-3 live through the real WASM boundary: boot registers the `init`
  // process and the scheduler runs it. listProcs() must reflect that.
  const procs = await page.evaluate(() =>
    (window as unknown as { __wasmos: { control: { listProcs(): { pid: number; name: string; state: string }[] } } })
      .__wasmos.control.listProcs(),
  );
  expect(procs).toEqual([{ pid: 1, name: "init", state: "running" }]);
});

test("writes to /home (OPFS) and /mnt (IndexedDB) survive a reload", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  // Write across all three backends through the real kernel control API,
  // then flush so OPFS/IndexedDB writes are durable before reload.
  await page.evaluate(async () => {
    const w = (window as unknown as { __wasmos: { control: any; flush: () => Promise<void> } }).__wasmos;
    const enc = new TextEncoder();
    w.control.fsWrite("/scratch.txt", enc.encode("tmp"));
    w.control.fsWrite("/home/persisted.txt", enc.encode("home-data"));
    w.control.fsWrite("/mnt/persisted.txt", enc.encode("mnt-data"));
    await w.flush();
  });

  // Reload: tmpfs is gone, OPFS + IndexedDB persist.
  await page.reload();
  await waitForBoot(page, errors);

  const after = await page.evaluate(() => {
    const c = (window as unknown as { __wasmos: { control: any } }).__wasmos.control;
    const dec = new TextDecoder();
    const read = (p: string) => { try { return dec.decode(c.fsRead(p)); } catch { return null; } };
    return {
      scratch: read("/scratch.txt"),
      home: read("/home/persisted.txt"),
      mnt: read("/mnt/persisted.txt"),
      homeList: c.fsList("/home"),
    };
  });

  expect(after.home).toBe("home-data");      // OPFS persisted
  expect(after.mnt).toBe("mnt-data");         // IndexedDB persisted
  expect(after.scratch).toBeNull();           // tmpfs correctly volatile
  expect(after.homeList).toContain("/home/persisted.txt");
});

test("fsDelete unlinks across backends and the deletion persists across reload", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  // Seed one file per persistent backend, flush to durable storage.
  await page.evaluate(async () => {
    const w = (window as unknown as { __wasmos: { control: any; flush: () => Promise<void> } }).__wasmos;
    const enc = new TextEncoder();
    w.control.fsWrite("/home/del.txt", enc.encode("home-del"));
    w.control.fsWrite("/mnt/del.txt", enc.encode("mnt-del"));
    await w.flush();
  });

  // Delete through the real kernel control verb, then assert in-session state:
  // gone from read/list, and a second delete reports the WIT not-found variant.
  const inSession = await page.evaluate(async () => {
    const w = (window as unknown as { __wasmos: { control: any; flush: () => Promise<void> } }).__wasmos;
    const dec = new TextDecoder();
    w.control.fsDelete("/home/del.txt");
    w.control.fsDelete("/mnt/del.txt");
    await w.flush();
    const read = (p: string) => { try { return dec.decode(w.control.fsRead(p)); } catch { return null; } };
    let secondDeleteTag: string | null = null;
    try { w.control.fsDelete("/home/del.txt"); } catch (e: any) { secondDeleteTag = e?.payload?.tag ?? e?.tag ?? "threw"; }
    return {
      home: read("/home/del.txt"),
      mnt: read("/mnt/del.txt"),
      homeList: w.control.fsList("/home"),
      mntList: w.control.fsList("/mnt"),
      secondDeleteTag,
    };
  });

  expect(inSession.home).toBeNull();                          // unlinked
  expect(inSession.mnt).toBeNull();
  expect(inSession.homeList).not.toContain("/home/del.txt");  // gone from listing
  expect(inSession.mntList).not.toContain("/mnt/del.txt");
  expect(inSession.secondDeleteTag).not.toBeNull();           // re-delete => not-found

  // Reload: the deletion must be durable (not resurrected from OPFS/IndexedDB).
  await page.reload();
  await waitForBoot(page, errors);

  const afterReload = await page.evaluate(() => {
    const c = (window as unknown as { __wasmos: { control: any } }).__wasmos.control;
    const dec = new TextDecoder();
    const read = (p: string) => { try { return dec.decode(c.fsRead(p)); } catch { return null; } };
    return { home: read("/home/del.txt"), mnt: read("/mnt/del.txt"), homeList: c.fsList("/home"), mntList: c.fsList("/mnt") };
  });

  expect(afterReload.home).toBeNull();                          // stayed deleted in OPFS
  expect(afterReload.mnt).toBeNull();                           // stayed deleted in IndexedDB
  expect(afterReload.homeList).not.toContain("/home/del.txt");
  expect(afterReload.mntList).not.toContain("/mnt/del.txt");
});
