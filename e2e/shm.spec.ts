import { test, expect, type Page } from "@playwright/test";

// M4-T4 — shared memory (FR-6). The writer process creates a kernel-arbitrated
// region, fills it, spawns a reader child, grants it access, and releases a
// channel barrier; the reader maps the region and reads bytes the writer wrote in
// a different address space, then persists them. Verifying the file proves real
// cross-process shared memory end to end (shm_create/write → grant → shm_map/read).

type Win = {
  __wasmos: {
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string; grantSpawn?: boolean }): Promise<number>;
      fsRead(path: string): Promise<Uint8Array>;
    };
  };
};

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
}

test("a process reads bytes another process wrote into a shared region (FR-6 shm)", async ({ page }) => {
  await ready(page);

  // Spawn the writer; it self-spawns the reader (needs Spawn) and grants it access.
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/shmdemo.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "shmdemo", grantFsSubtree: "/", grantSpawn: true });
  });

  // The reader mapped the region and persisted exactly what the writer wrote.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          try {
            return new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/shm-out.txt"));
          } catch {
            return "";
          }
        }),
      { timeout: 12_000 },
    )
    .toBe("SHARED-MEMORY-WORKS");
});
