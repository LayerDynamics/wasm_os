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
      spawn(
        bytes: ArrayBuffer,
        opts?: {
          name?: string;
          grantGpu?: boolean;
          grantInput?: boolean;
          grantSpawn?: boolean;
          grantSignal?: boolean;
          grantFsSubtree?: string;
        },
      ): Promise<number>;
      kill(pid: number): Promise<void>;
    };
    inputMetrics: {
      reset(): void;
      snapshot(): {
        generated: number;
        delivered: number;
        rendered: number;
        dropped: number;
        missed: number;
        pending: number;
        p50Millis: number | null;
        p95Millis: number | null;
        maxMillis: number | null;
        deliveryRate: number;
        dropRate: number;
        missedRate: number;
        byKey: Record<string, { generated: number; delivered: number; rendered: number; dropped: number; missed: number }>;
      };
    };
  };
};

const NAMED_KEYS = [
  "Enter", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab", "Escape", "Delete",
  "Home", "End", "Insert", "PageUp", "PageDown", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8",
  "F9", "F10", "F11", "F12", "CapsLock", "NumLock", "ScrollLock", "Pause", "PrintScreen", "ContextMenu",
] as const;

const INPUT_APPS = [
  { name: "welcome", opts: { grantGpu: true, grantInput: true } },
  { name: "filemanager", opts: { grantGpu: true, grantInput: true, grantSpawn: true, grantFsSubtree: "/" } },
  { name: "paint", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/" } },
  { name: "editor", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/" } },
  { name: "sysmon", opts: { grantGpu: true, grantInput: true, grantSignal: true } },
  { name: "lisp", opts: { grantGpu: true, grantInput: true, grantFsSubtree: "/home" } },
] as const;

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

  await page.keyboard.press("a");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Win).__wasmos.inputMetrics.snapshot().dropped))
    .toBe(1);
  const metrics = await page.evaluate(() => (window as unknown as Win).__wasmos.inputMetrics.snapshot());
  expect(metrics.generated).toBe(1);
  expect(metrics.delivered).toBe(0);
  expect(metrics.dropRate).toBe(1);
});

test("every named key reaches and is consumed by every launcher canvas guest", async ({ page }) => {
  await ready(page);

  for (const app of INPUT_APPS) {
    const pid = await page.evaluate(async ({ name, opts }) => {
      const w = window as unknown as Win;
      const bytes = await (await fetch(`/packages/host/guests/${name}.wasm`)).arrayBuffer();
      return w.__wasmos.control.spawn(bytes, opts);
    }, app);
    const canvas = page.locator(".wasmos-window canvas").last();
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error(`no canvas for ${app.name}`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await page.evaluate(() => (window as unknown as Win).__wasmos.inputMetrics.reset());
    for (const key of NAMED_KEYS) await page.keyboard.press(key);

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as Win).__wasmos.inputMetrics.snapshot().rendered),
        { timeout: 20_000 },
      )
      .toBe(NAMED_KEYS.length);

    const metrics = await page.evaluate(() => (window as unknown as Win).__wasmos.inputMetrics.snapshot());
    expect(metrics.generated, `${app.name}: generated`).toBe(NAMED_KEYS.length);
    expect(metrics.delivered, `${app.name}: delivered`).toBe(NAMED_KEYS.length);
    expect(metrics.rendered, `${app.name}: rendered`).toBe(NAMED_KEYS.length);
    expect(metrics.dropped, `${app.name}: dropped`).toBe(0);
    expect(metrics.missed, `${app.name}: missed`).toBe(0);
    expect(metrics.pending, `${app.name}: pending`).toBe(0);
    expect(metrics.p50Millis, `${app.name}: p50`).not.toBeNull();
    expect(metrics.p95Millis, `${app.name}: p95`).not.toBeNull();
    expect(metrics.maxMillis, `${app.name}: max`).not.toBeNull();
    expect(metrics.p95Millis!, `${app.name}: p95 input-to-paint`).toBeLessThan(100);
    expect(metrics.deliveryRate, `${app.name}: delivery rate`).toBe(1);
    expect(metrics.dropRate, `${app.name}: drop rate`).toBe(0);
    expect(metrics.missedRate, `${app.name}: missed rate`).toBe(0);
    console.info(
      `[input metrics] ${app.name}: samples=${metrics.rendered} p50=${metrics.p50Millis}ms ` +
        `p95=${metrics.p95Millis}ms max=${metrics.maxMillis}ms dropped=${metrics.dropped} missed=${metrics.missed}`,
    );
    for (const key of NAMED_KEYS) {
      const perKey = metrics.byKey[key];
      expect(perKey, `${app.name}: ${key} metric`).toBeDefined();
      expect(perKey.generated, `${app.name}: ${key} generated`).toBe(1);
      expect(perKey.delivered, `${app.name}: ${key} delivered`).toBe(1);
      expect(perKey.rendered, `${app.name}: ${key} rendered`).toBe(1);
      expect(perKey.dropped, `${app.name}: ${key} dropped`).toBe(0);
      expect(perKey.missed, `${app.name}: ${key} missed`).toBe(0);
    }

    await page.evaluate((target) => (window as unknown as Win).__wasmos.control.kill(target), pid);
  }
});
