import { test, expect, type Page, type Locator } from "@playwright/test";

// Mandelbrot app — Mandelbrot explorer (Zig), the polyglot graphical app (FR-14 on the desktop compositor
// graphics path). It speaks the same wasmos_kernel surface+input ABI as the Rust
// apps. The test proves it renders a structured fractal, zooms, and generates
// another view on demand through real brokered keyboard input.

type Win = {
  __wasmos: {
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantGpu?: boolean; grantInput?: boolean }): Promise<number>;
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

// A fingerprint of the canvas pixels (sum of all channel bytes).
function fingerprint(canvas: Locator): Promise<number> {
  return canvas.evaluate((cv: HTMLCanvasElement) => {
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s;
  });
}

test("the Zig Mandelbrot renders, zooms, and generates fresh views on keyboard input (FR-14)", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/mandelbrot.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "mandelbrot", grantGpu: true, grantInput: true });
  });

  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  // The fractal is structured: a black in-set region AND coloured escape bands.
  await expect.poll(() => fingerprint(canvas), { timeout: 10_000 }).toBeGreaterThan(0);
  const black = await canvas.evaluate((cv: HTMLCanvasElement) => {
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let blk = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) blk++;
    return blk;
  });
  expect(black).toBeGreaterThan(100); // the in-set body is rendered black

  const before = await fingerprint(canvas);

  // Focus the canvas window, then zoom in with '=' a few times → recompute.
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(150);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Equal"); // '=' → zoom in
    await page.waitForTimeout(150);
  }

  // Zooming produced a different frame.
  await expect.poll(() => fingerprint(canvas), { timeout: 8_000 }).not.toBe(before);

  const zoomed = await fingerprint(canvas);
  await page.keyboard.press("n");
  await expect.poll(() => fingerprint(canvas), { timeout: 8_000 }).not.toBe(zoomed);

  const generated = await fingerprint(canvas);
  await page.keyboard.press("Space");
  await expect.poll(() => fingerprint(canvas), { timeout: 8_000 }).not.toBe(generated);

  const spaced = await fingerprint(canvas);
  await page.keyboard.press("r");
  await expect.poll(() => fingerprint(canvas), { timeout: 8_000 }).not.toBe(spaced);
});
