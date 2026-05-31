import { test, expect, type Page } from "@playwright/test";

// M3-T9 — launcher, multi-window concurrency, and crash containment (FR-21/22/34).
// Apps launch from the taskbar menu into their own windows and run concurrently;
// closing one leaves the rest; a graphical app that traps has its window closed
// while the desktop, the terminal, and the shell keep running.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantGpu?: boolean; grantInput?: boolean }): Promise<number>;
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
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

async function openApp(page: Page, label: string): Promise<void> {
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: label }).click();
}

function canvasCount(page: Page): Promise<number> {
  return page.locator(".wasmos-window canvas").count();
}

test("the launcher opens multiple apps concurrently in their own windows", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".wasmos-window")).toHaveCount(1); // terminal only

  await openApp(page, "Files");
  await expect.poll(() => canvasCount(page), { timeout: 10_000 }).toBe(1);
  await openApp(page, "Mandelbrot");
  await expect.poll(() => canvasCount(page), { timeout: 10_000 }).toBe(2);

  // Terminal + two app windows are all on screen at once.
  await expect(page.locator(".wasmos-window")).toHaveCount(3);
  for (const c of await page.locator(".wasmos-window canvas").all()) await expect(c).toBeVisible();
  // The taskbar lists every window.
  expect(await page.locator(".wasmos-task").count()).toBe(3);
});

test("closing one window leaves the others and the desktop running", async ({ page }) => {
  await ready(page);
  await openApp(page, "Files");
  await openApp(page, "Paint");
  await expect.poll(() => canvasCount(page), { timeout: 10_000 }).toBe(2);

  // Close the top (most-recent, focused) window via its close button.
  const top = page.locator(".wasmos-window").last();
  await top.locator('[data-act="close"]').click();

  await expect.poll(() => canvasCount(page), { timeout: 5_000 }).toBe(1); // one app remains
  await expect(page.locator("#desktop")).toBeVisible();
});

test("a crashing graphical app is contained — its window closes, the shell survives (FR-34)", async ({ page }) => {
  await ready(page);

  // gfxspike traps on Escape. Launch it directly, focus it, then crash it.
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/gfxspike.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "gfxspike", grantGpu: true, grantInput: true });
  });
  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => canvasCount(page), { timeout: 10_000 }).toBe(1);

  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5); // focus it
  await page.keyboard.press("Escape"); // → std::process::abort()

  // The trapped app's window is gone; the terminal window survives.
  await expect.poll(() => canvasCount(page), { timeout: 8_000 }).toBe(0);
  await expect(page.locator(".wasmos-window")).toHaveCount(1); // the terminal

  // The kernel + shell are unharmed: a new command still runs end-to-end.
  await page.evaluate(() => {
    const w = window as unknown as Win;
    void w.__wasmos.control.stdin(w.__wasmos.shellPid, new TextEncoder().encode("echo SURVIVED-9\n"));
  });
  await page.waitForFunction(() => (window as unknown as Win).__wasmos.term.log().includes("SURVIVED-9"), null, {
    timeout: 10_000,
  });
});
