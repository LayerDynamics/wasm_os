import { test, expect, type Page } from "@playwright/test";

// message channels — message channels (the IPC marquee). Two processes rendezvous on a named
// channel; one sends a message, the other receives it. The receiver persists the
// payload to the VFS, so the test verifies real cross-process delivery end to end:
// guest chan_send → kernel channel → guest chan_recv (park/resume) → file.

type Win = {
  __wasmos: {
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
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

test("two processes exchange a message over a named channel (FR-6 IPC)", async ({ page }) => {
  await ready(page);

  // Spawn two chandemo instances. They rendezvous on the channel "demo": whoever
  // opens first sends MESSAGE; the other receives it and writes it to the VFS.
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/chandemo.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "chandemo", grantFsSubtree: "/" });
    await w.__wasmos.control.spawn(bytes, { name: "chandemo", grantFsSubtree: "/" });
  });

  // The receiver delivered the sender's message and persisted it.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          try {
            return new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/chan-out.txt"));
          } catch {
            return "";
          }
        }),
      { timeout: 10_000 },
    )
    .toBe("HELLO-OVER-CHANNEL");
});
