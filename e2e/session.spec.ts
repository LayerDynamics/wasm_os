import { test, expect, type Page, type Locator } from "@playwright/test";

// M4-T9 — desktop session snapshot/restore (FR-35). Launch an app, move its
// window, and the layout is written to /home/.session.json. After a reload the
// SessionManager re-spawns the app and restores its window geometry — the desktop
// comes back. The VFS already persists file contents (FR-30); this restores the
// window/process layout on top of it. Mirrors the theme-persistence pattern.

type Win = { __wasmos: { flush(): Promise<void>; control: { fsRead(p: string): Promise<Uint8Array> } } };

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
}

function canvasWindow(page: Page): Locator {
  return page.locator(".wasmos-window").filter({ has: page.locator("canvas") });
}

async function windowPos(win: Locator): Promise<{ left: number; top: number }> {
  return win.evaluate((el) => ({ left: parseInt((el as HTMLElement).style.left), top: parseInt((el as HTMLElement).style.top) }));
}

async function sessionLen(page: Page): Promise<number> {
  return page.evaluate(async () => {
    try {
      return (await (window as unknown as Win).__wasmos.control.fsRead("/home/.session.json")).length;
    } catch {
      return 0;
    }
  });
}

test("an open app window is restored at its saved position after a reload (FR-35)", async ({ page }) => {
  await ready(page);
  // Only the terminal (a DOM window) is open at first boot — no canvas app yet.
  await expect(canvasWindow(page)).toHaveCount(0);

  // Launch Paint from the taskbar; its canvas window opens.
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Paint" }).click();
  const win = canvasWindow(page);
  await expect(win).toHaveCount(1, { timeout: 10_000 });

  // Drag its titlebar to a distinctive position (a real user move).
  const bar = win.locator(".wasmos-titlebar");
  const box = await bar.boundingBox();
  if (!box) throw new Error("no titlebar box");
  const targetLeft = 360;
  const targetTop = 210;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetLeft + 40, targetTop + box.height / 2, { steps: 10 });
  await page.mouse.up();

  const moved = await windowPos(win);
  expect(moved.left).toBeGreaterThan(300); // it actually moved to the right

  // The layout was persisted to the VFS.
  await expect.poll(() => sessionLen(page), { timeout: 5_000 }).toBeGreaterThan(0);

  // Flush durability, then reload: the app is re-spawned and its window restored.
  await page.evaluate(() => (window as unknown as Win).__wasmos.flush());
  await page.reload();
  await ready(page);

  // Without any manual launch, Paint's window reappears at the saved position.
  const restored = canvasWindow(page);
  await expect(restored).toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(async () => (await windowPos(restored)).left, { timeout: 5_000 })
    .toBe(moved.left);
  await expect.poll(async () => (await windowPos(restored)).top, { timeout: 5_000 }).toBe(moved.top);
});
