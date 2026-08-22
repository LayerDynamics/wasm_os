import { test, expect, type Page, type Locator } from "@playwright/test";

// Paint app — Paint (FR-23 + FR-25 + VFS persistence). A real Rust canvas app: drag
// the mouse to draw into a shared framebuffer, pick a palette colour, and save the
// drawing to the VFS. Every layer is real — pointer → deliver_input → guest draws
// → present → blit; save → std::fs::write → kernel VFS.

const FB_W = 400;
const FB_H = 320;

type Win = {
  __wasmos: {
    control: {
      spawn(bytes: ArrayBuffer, opts?: { name?: string; grantGpu?: boolean; grantInput?: boolean; grantFsSubtree?: string }): Promise<number>;
      fsRead(path: string): Promise<Uint8Array>;
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

async function spawnPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/paint.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "paint", grantGpu: true, grantInput: true, grantFsSubtree: "/" });
  });
}

function pixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate(
    (cv: HTMLCanvasElement, p: { x: number; y: number }) => {
      const d = cv.getContext("2d")!.getImageData(p.x, p.y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { x, y },
  );
}

test("paint draws strokes, switches colour, and saves to the VFS", async ({ page }) => {
  await ready(page);
  await spawnPaint(page);
  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);

  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const at = (bx: number, by: number) => ({ x: box.x + box.width * (bx / FB_W), y: box.y + box.height * (by / FB_H) });
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    const a = at(x0, y0);
    const b = at(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  };

  // Default colour is red: a stroke across the canvas leaves red pixels.
  await drag(80, 160, 300, 160);
  await expect
    .poll(async () => {
      const p = await pixel(canvas, 190, 160);
      return p[0] > 150 && p[1] < 120 && p[2] < 120;
    }, { timeout: 8_000 })
    .toBe(true);

  // Pick the black swatch (swatch 0, centred near backing x=13, y=12) then draw in
  // a fresh band: the new stroke is black.
  await page.mouse.click(at(13, 12).x, at(13, 12).y);
  await page.waitForTimeout(150);
  await drag(80, 250, 300, 250);
  await expect
    .poll(async () => {
      const p = await pixel(canvas, 190, 250);
      return p[0] < 70 && p[1] < 70 && p[2] < 70;
    }, { timeout: 8_000 })
    .toBe(true);

  // Click SAVE (toolbar, backing ~x=264 y=12) → /home/paint.img is written.
  await page.mouse.click(at(264, 12).x, at(264, 12).y);
  await page.waitForTimeout(400);
  const saved = await page.evaluate(
    async () => (await (window as unknown as Win).__wasmos.control.fsRead("/home/paint.img")).length,
  );
  expect(saved).toBeGreaterThan(12 + FB_W * FB_H); // header + at least the pixels
});
