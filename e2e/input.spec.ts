import { test, expect, type Page, type Locator } from "@playwright/test";

// brokered input — brokered input (FR-25). The focused canvas window's mouse/keyboard is
// delivered to its owning process (win_read_input, Input-gated). gfxspike draws a
// white marker that follows the pointer, so moving the mouse over the canvas
// visibly CHANGES the presented framebuffer — proving the full loop: real pointer
// → compositor → deliver_input → kernel park/resume → guest redraw → present →
// blit. Default-deny is covered in surface.spec.ts (no-Gpu) + here (no Input).

type Win = {
  __wasmos: {
    control: {
      spawn(bytes: ArrayBuffer, opts?: { name?: string; grantGpu?: boolean; grantInput?: boolean }): Promise<number>;
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

async function spawnSpike(page: Page, gpu: boolean, input: boolean): Promise<void> {
  await page.evaluate(
    async ({ gpu, input }) => {
      const w = window as unknown as Win;
      const bytes = await (await fetch("/packages/host/guests/gfxspike.wasm")).arrayBuffer();
      await w.__wasmos.control.spawn(bytes, { name: "gfxspike", grantGpu: gpu, grantInput: input });
    },
    { gpu, input },
  );
}

function pixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate(
    (cv: HTMLCanvasElement, p: { x: number; y: number }) => {
      const ctx = cv.getContext("2d")!;
      const d = ctx.getImageData(p.x, p.y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { x, y },
  );
}

const isWhite = (p: number[]) => p[0] === 255 && p[1] === 255 && p[2] === 255;

test("moving the mouse over a canvas moves a marker the process draws (FR-25)", async ({ page }) => {
  await ready(page);
  await spawnSpike(page, true, true);

  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  // Wait for the initial frame (marker starts at the centre, 96,64).
  await expect.poll(async () => isWhite(await pixel(canvas, 96, 64)), { timeout: 10_000 }).toBe(true);

  // Move the real pointer to the canvas's upper-left quadrant → backing ~(48,32).
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25, { steps: 6 });

  // The marker follows the pointer: (48,32) becomes white...
  await expect.poll(async () => isWhite(await pixel(canvas, 48, 32)), { timeout: 10_000 }).toBe(true);
  // ...and the old centre is no longer the marker (it returned to the gradient).
  expect(isWhite(await pixel(canvas, 96, 64))).toBe(false);
});

test("a process WITHOUT Input gets a surface but no events (default-deny)", async ({ page }) => {
  await ready(page);
  await spawnSpike(page, true, false); // Gpu but not Input

  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => isWhite(await pixel(canvas, 96, 64)), { timeout: 10_000 }).toBe(true);

  // Move the pointer; with no Input capability the guest never sees events, so the
  // centre marker stays put (the upper-left quadrant never becomes the marker).
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25, { steps: 6 });
  await page.waitForTimeout(600);
  expect(isWhite(await pixel(canvas, 48, 32))).toBe(false);
  expect(isWhite(await pixel(canvas, 96, 64))).toBe(true); // marker never moved
});
