import { test, expect, type Page, type Locator } from "@playwright/test";

// Linux framebuffer — the emulator framebuffer window (FR-23/FR-27). Launching "Linux" from the
// taskbar opens a canvas window; the emulator worker renders the guest's serial
// console into a shared RGBA framebuffer (the same surface/present path the desktop compositor
// canvas apps use), which the compositor blits. We assert the window appears and
// becomes non-blank as the console renders — presence/update, NOT pixel-exact.

test.setTimeout(120_000);

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
}

/** Count canvas pixels brighter than the console background (= rendered text). */
function litPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d");
    if (!ctx || !c.width || !c.height) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 60 || data[i + 1]! > 60 || data[i + 2]! > 60) lit++;
    }
    return lit;
  });
}

test("launching Linux opens a framebuffer window that renders the guest console", async ({ page }) => {
  await ready(page);
  // No canvas windows initially (only the DOM terminal).
  await expect(page.locator(".wasmos-window canvas")).toHaveCount(0);

  // Launch the emulator from the taskbar.
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Linux" }).click();

  // Its framebuffer window opens.
  const canvas = page.locator(".wasmos-window canvas").last();
  await expect(canvas).toBeVisible({ timeout: 15_000 });

  // The console renders into it (text appears) as Linux boots — the window is no
  // longer blank. This proves the emulator serial → shared framebuffer → compositor
  // blit path works end to end.
  await expect.poll(() => litPixels(canvas), { timeout: 90_000, intervals: [1000] }).toBeGreaterThan(200);
});
