import { test, expect, type Page } from "@playwright/test";

// M3-T10 — desktop theming + wallpaper (FR-26), persisted to /home and reapplied
// on boot (FR-30). Pick a wallpaper → the desktop changes and /home/.desktop.json
// is written → reload → the choice is restored from the VFS.

type Win = { __wasmos: { flush(): Promise<void>; control: { fsRead(p: string): Promise<Uint8Array> } } };

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
  await page.waitForFunction(() => Boolean(document.getElementById("desktop")?.dataset.wallpaper), null, {
    timeout: 10_000,
  });
}

const wallpaper = (page: Page) =>
  page.evaluate(() => document.getElementById("desktop")!.dataset.wallpaper);

test("wallpaper choice changes the desktop and survives a reload", async ({ page }) => {
  await ready(page);
  expect(await wallpaper(page)).toBe("Midnight"); // default on first boot

  // Open the settings menu and pick the "Ocean" wallpaper.
  await page.locator(".wasmos-settings").click();
  await page.locator('.wasmos-wallpaper[data-name="Ocean"]').click();
  await expect.poll(() => wallpaper(page), { timeout: 5_000 }).toBe("Ocean");

  // The choice was persisted to the VFS.
  const settingsLen = await page.evaluate(async () => {
    try {
      return (await (window as unknown as Win).__wasmos.control.fsRead("/home/.desktop.json")).length;
    } catch {
      return 0;
    }
  });
  expect(settingsLen).toBeGreaterThan(0);

  // Flush durability, then reload: the wallpaper is restored from /home.
  await page.evaluate(() => (window as unknown as Win).__wasmos.flush());
  await page.reload();
  await ready(page);
  expect(await wallpaper(page)).toBe("Ocean");
});
