import { test, expect, type Page } from "@playwright/test";

// Linux session restore — Linux in the desktop session (FR-35 tie-in). The emulator is registered
// with the SessionManager, so a running Linux window is recorded in the session
// manifest and re-opened after a reload — and the 9p shared folder (/home/shared)
// persists via OPFS. Per the milestone scope this is a session/layout restore (the
// guest re-boots and its shared files persist), NOT a freeze-dry of live VM memory.

type Win = {
  __wasmos: {
    flush(): Promise<void>;
    control: { fsWrite(p: string, b: Uint8Array): Promise<void>; fsRead(p: string): Promise<Uint8Array> };
  };
};
test.setTimeout(120_000);

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
}

const canvasWindows = (page: Page) => page.locator(".wasmos-window").filter({ has: page.locator("canvas") });

test("a running Linux is restored after a reload and the shared folder persists (FR-35)", async ({ page }) => {
  await ready(page);
  await expect(canvasWindows(page)).toHaveCount(0);

  // A file in the shared folder (persists via OPFS-backed /home).
  await page.evaluate(() =>
    (window as unknown as Win).__wasmos.control.fsWrite("/home/shared/persist.txt", new TextEncoder().encode("PERSISTED-7")),
  );

  // Launch Linux; its framebuffer window opens and the session records it.
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Linux" }).click();
  await expect(canvasWindows(page)).toHaveCount(1, { timeout: 15_000 });
  // Give the debounced session save a moment, then flush durability.
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as Win).__wasmos.flush());

  // Reload: the session re-opens Linux (re-boots into a window) with no manual launch.
  await page.reload();
  await ready(page);
  await expect(canvasWindows(page)).toHaveCount(1, { timeout: 20_000 });

  // The shared-folder file survived the reload (OPFS persistence).
  const persisted = await page.evaluate(async () => {
    try {
      return new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/shared/persist.txt"));
    } catch {
      return "";
    }
  });
  expect(persisted).toBe("PERSISTED-7");
});
