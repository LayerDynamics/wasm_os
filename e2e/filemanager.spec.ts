import { test, expect, type Page, type Locator } from "@playwright/test";

// M3-T5 — the file manager (FR-24): a real Rust WASI process that draws a canvas
// surface, browses the VFS, and LAUNCHES a file as a process (delegating
// Gpu+Input so a graphical app gets its own window). This drives the real thing:
// spawn the FM → descend into /bin → click a file → a second canvas window opens.

// Backing-store geometry must match crates/apps/filemanager (HEADER_H, ROW_H, H).
const HEADER_H = 22;
const ROW_H = 14;
const FB_H = 340;

type Win = {
  __wasmos: {
    control: {
      spawn(
        bytes: ArrayBuffer,
        opts?: { name?: string; grantGpu?: boolean; grantInput?: boolean; grantSpawn?: boolean; grantFsSubtree?: string },
      ): Promise<number>;
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

async function spawnFm(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/filemanager.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, {
      name: "filemanager",
      grantGpu: true,
      grantInput: true,
      grantSpawn: true,
      grantFsSubtree: "/",
    });
  });
}

/** Click backing-store row `i` on the file manager's canvas. */
async function clickRow(page: Page, canvas: Locator, i: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const yBacking = HEADER_H + i * ROW_H + ROW_H / 2;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * (yBacking / FB_H));
}

function canvasCount(page: Page): Promise<number> {
  return page.locator(".wasmos-window canvas").count();
}

test("the file manager browses the VFS and launches a file into a new window (FR-24)", async ({ page }) => {
  await ready(page);
  await spawnFm(page);

  // The FM canvas window appears (the terminal is a DOM surface, so this is the
  // only canvas so far).
  const fm = page.locator(".wasmos-window canvas").first();
  await expect(fm).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => canvasCount(page), { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(300); // initial listing drawn

  // Row 0 at "/" is the first directory ("bin"); click it to descend into /bin.
  await clickRow(page, fm, 0);
  await page.waitForTimeout(300);

  // Click file rows in /bin until launching one opens a second canvas window.
  // (Coreutils exit without a surface; the graphical apps — filemanager/gfxspike —
  // open one.) Row 0 is "..", so start at 1.
  let opened = false;
  for (let i = 1; i <= 18 && !opened; i++) {
    await clickRow(page, fm, i);
    await page.waitForTimeout(250);
    if ((await canvasCount(page)) >= 2) opened = true;
  }
  expect(opened).toBe(true);
  await expect.poll(() => canvasCount(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
});
