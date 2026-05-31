import { test, expect, type Page, type Locator } from "@playwright/test";

// M3 marquee (the exit-criteria scenario, end to end): boot → desktop → launch
// the file manager + a graphical app so the terminal and two canvas apps run
// concurrently → move/resize/focus windows (FR-22) → set a wallpaper → reload and
// confirm the desktop rebuilds with the wallpaper restored. The per-task specs
// cover the details; this proves the pieces compose in one live session.

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

async function openApp(page: Page, label: string): Promise<void> {
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: label }).click();
}

const isActive = (win: Locator) => win.evaluate((e) => e.classList.contains("wasmos-window-active"));

test("boot → desktop → 3 windows concurrent → move/resize/focus → reload persists", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".wasmos-window")).toHaveCount(1); // terminal

  // Launch the file manager and the Zig Mandelbrot: three windows on the desktop.
  await openApp(page, "Files");
  await openApp(page, "Mandelbrot");
  await expect.poll(() => page.locator(".wasmos-window canvas").count(), { timeout: 10_000 }).toBe(2);
  await expect(page.locator(".wasmos-window")).toHaveCount(3);

  // The most-recent window (Mandelbrot) is focused; move it by its titlebar.
  const top = page.locator(".wasmos-window").last();
  const before = await top.boundingBox();
  const bar = top.locator(".wasmos-titlebar");
  const bb = await bar.boundingBox();
  if (!before || !bb) throw new Error("no box");
  await page.mouse.move(bb.x + 30, bb.y + 14);
  await page.mouse.down();
  await page.mouse.move(bb.x + 30 - 120, bb.y + 14 + 70, { steps: 8 });
  await page.mouse.up();
  const moved = await top.boundingBox();
  if (!moved) throw new Error("no moved box");
  expect(Math.abs(moved.x - before.x)).toBeGreaterThan(60);

  // Resize it from the south-east handle.
  const sz = await top.boundingBox();
  const h = top.locator(".wasmos-resize-se");
  const hb = await h.boundingBox();
  if (!sz || !hb) throw new Error("no resize box");
  await page.mouse.move(hb.x + 2, hb.y + 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 80, hb.y + 60, { steps: 8 });
  await page.mouse.up();
  const resized = await top.boundingBox();
  if (!resized) throw new Error("no resized box");
  expect(resized.width).toBeGreaterThan(sz.width + 40);

  // Focus switching: click the first app window → it becomes active.
  const first = page.locator(".wasmos-window").nth(1); // the FM (window 0 is terminal)
  await first.locator(".wasmos-titlebar").click();
  await expect.poll(() => isActive(first), { timeout: 3_000 }).toBe(true);
  await expect.poll(() => isActive(top), { timeout: 3_000 }).toBe(false);

  // Set a wallpaper, then reload: the desktop rebuilds and the wallpaper persists.
  await page.locator(".wasmos-settings").click();
  await page.locator('.wasmos-wallpaper[data-name="Forest"]').click();
  await expect.poll(() => page.evaluate(() => document.getElementById("desktop")!.dataset.wallpaper), { timeout: 5_000 }).toBe("Forest");
  await page.evaluate(() => (window as unknown as { __wasmos: { flush(): Promise<void> } }).__wasmos.flush());
  await page.reload();
  await ready(page);
  expect(await page.evaluate(() => document.getElementById("desktop")!.dataset.wallpaper)).toBe("Forest");
  await expect(page.locator(".wasmos-window")).toHaveCount(1); // terminal back (apps are not session-restored in M3)
});
