import { test, expect, type Page, type Locator } from "@playwright/test";

// file manager — the file manager (FR-24): a real Rust WASI process that draws a canvas
// surface, browses the VFS, and LAUNCHES a file as a process (delegating
// Gpu+Input so a graphical app gets its own window). This drives the real thing:
// spawn the FM → descend into /bin → click a file → a second canvas window opens.

// Backing-store geometry must match crates/apps/filemanager (HEADER_H, ROW_H, W, H).
const HEADER_H = 22;
const ROW_H = 14;
const FB_W = 460;
const FB_H = 340;
// "↑ Up" button hit region in the header (UP_X0..UP_X1 in the FM source).
const UP_X0 = 4;
const UP_X1 = 44;

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

/** Click a point given in backing-store (framebuffer) coordinates. */
async function clickBacking(page: Page, canvas: Locator, bx: number, by: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.click(box.x + box.width * (bx / FB_W), box.y + box.height * (by / FB_H));
}

/** FNV-1a checksum over a downsample of the canvas pixels — distinguishes listings. */
function checksum(canvas: Locator): Promise<string> {
  return canvas.evaluate((cv: HTMLCanvasElement) => {
    const ctx = cv.getContext("2d")!;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < d.length; i += 16) {
      h ^= d[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  });
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

test("the file manager ascends out of a folder via the header 'Up' button (FR-24 usability)", async ({ page }) => {
  // Regression for "no way to go back": descending into a folder must be reversible
  // through an obvious header control. Differential pixel test — the listing after
  // ascending must match the root listing exactly.
  await ready(page);
  await spawnFm(page);

  const fm = page.locator(".wasmos-window canvas").first();
  await expect(fm).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  const root = await checksum(fm);

  // Descend into the first directory (row 0 at "/").
  await clickRow(page, fm, 0);
  await page.waitForTimeout(350);
  const sub = await checksum(fm);
  expect(sub, "descending into a folder should change the listing").not.toBe(root);

  // Click the "↑ Up" button in the header — this must return to the root listing.
  await clickBacking(page, fm, (UP_X0 + UP_X1) / 2, HEADER_H / 2);
  await page.waitForTimeout(350);
  const back = await checksum(fm);
  expect(back, "the header Up button should return to the root listing").toBe(root);
});
