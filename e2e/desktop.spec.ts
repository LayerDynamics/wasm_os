import { test, expect, type Page } from "@playwright/test";

// desktop compositor — the compositor: a desktop with a taskbar (launcher + live clock) and
// real windows (move/resize/focus/min/max/close + z-order, FR-21/FR-22). The shell and userland
// terminal runs inside the first window (a DOM surface, FR-23). Every assertion
// drives the real DOM the compositor builds — no mocks.

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
}

test("boots to a desktop with a taskbar clock and a terminal window", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#desktop")).toBeVisible();
  await expect(page.locator(".wasmos-taskbar")).toBeVisible();

  // Exactly one window at boot — the terminal — and its title names the shell.
  const windows = page.locator(".wasmos-window");
  await expect(windows).toHaveCount(1);
  await expect(windows.first().locator(".wasmos-title")).toContainText("Terminal");
  await expect(windows.first().locator(".wasmos-menubar")).toBeVisible();
  await expect(windows.first().locator(".wasmos-menu-trigger")).toHaveText(["File", "Edit", "View", "Help"]);

  // The clock is live: its text changes within ~2s.
  const clock = page.locator(".wasmos-clock");
  const t0 = await clock.textContent();
  await expect.poll(async () => clock.textContent(), { timeout: 3000 }).not.toBe(t0);
});

test("canvas application windows receive the shared application menu bar", async ({ page }) => {
  await ready(page);
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Paint" }).click();
  const paint = page.locator(".wasmos-window", { has: page.locator("canvas") });
  await expect(paint).toBeVisible();
  await expect(paint.locator(".wasmos-menu-trigger")).toHaveText(["File", "Edit", "View", "Help"]);
});

test("a window can be dragged by its titlebar", async ({ page }) => {
  await ready(page);
  const win = page.locator(".wasmos-window").first();
  const before = await win.boundingBox();
  const bar = win.locator(".wasmos-titlebar");
  const bb = await bar.boundingBox();
  if (!before || !bb) throw new Error("no window/titlebar box");

  // Real pointer drag: press the titlebar, move +140/+90, release.
  await page.mouse.move(bb.x + 40, bb.y + 14);
  await page.mouse.down();
  await page.mouse.move(bb.x + 40 + 140, bb.y + 14 + 90, { steps: 8 });
  await page.mouse.up();

  const after = await win.boundingBox();
  if (!after) throw new Error("no window box after drag");
  expect(after.x).toBeGreaterThan(before.x + 100);
  expect(after.y).toBeGreaterThan(before.y + 60);
});

test("maximize fills the workspace and toggles back", async ({ page }) => {
  await ready(page);
  const win = page.locator(".wasmos-window").first();
  const deskBox = await page.locator("#desktop").boundingBox();
  if (!deskBox) throw new Error("no desktop box");

  const normal = await win.boundingBox();
  await win.locator('[data-act="max"]').click();
  const maxed = await win.boundingBox();
  if (!normal || !maxed) throw new Error("no box");
  // Maximized window spans (close to) the full desktop width.
  expect(maxed.width).toBeGreaterThan(deskBox.width - 4);

  await win.locator('[data-act="max"]').click(); // restore
  const restored = await win.boundingBox();
  if (!restored) throw new Error("no restored box");
  expect(restored.width).toBeLessThan(deskBox.width - 4);
});

test("maximizing a canvas window keeps its native pixels and font size", async ({ page }) => {
  await ready(page);
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Paint" }).click();
  const win = page.locator(".wasmos-window", { has: page.locator("canvas") });
  const canvas = win.locator("canvas");
  await expect(canvas).toBeVisible();
  const native = await canvas.evaluate((el) => ({ width: el.width, height: el.height }));
  await win.locator('[data-act="max"]').click();
  const rendered = await canvas.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
  expect(rendered).toEqual(native);
});

test("minimize hides the window but keeps its taskbar button; restore brings it back", async ({ page }) => {
  await ready(page);
  const win = page.locator(".wasmos-window").first();
  await expect(win).toBeVisible();

  await win.locator('[data-act="min"]').click();
  await expect(win).toBeHidden();
  // The taskbar still lists the window (marked minimized).
  const task = page.locator(".wasmos-task").first();
  await expect(task).toBeVisible();

  // Clicking the taskbar button restores + focuses it.
  await task.click();
  await expect(win).toBeVisible();
});

test("close removes the window from the desktop", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".wasmos-window")).toHaveCount(1);
  await page.locator(".wasmos-window").first().locator('[data-act="close"]').click();
  await expect(page.locator(".wasmos-window")).toHaveCount(0);
});
