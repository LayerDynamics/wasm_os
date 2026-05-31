import { test, expect, type Page } from "@playwright/test";

// M3-T2 — the compositor-surface spine (FR-23 canvas/WebGL framebuffer surfaces).
// A WASI process requests a surface (win_surface, Gpu-gated), draws into a shared
// framebuffer, and presents it (win_present); the compositor blits it to a real
// <canvas> in a window. The whole path is real — worker → ring → kernel →
// shared SAB → main-thread canvas. The pixels never enter the kernel ring.

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
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 }); // terminal window
}

async function spawnSpike(page: Page, grantGpu: boolean): Promise<void> {
  await page.evaluate(async (gpu) => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/gfxspike.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "gfxspike", grantGpu: gpu });
  }, grantGpu);
}

test("a process with Gpu draws into a canvas surface the compositor presents", async ({ page }) => {
  await ready(page);
  await spawnSpike(page, true);

  // A canvas window appears (in addition to the terminal).
  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  // The framebuffer the guest presented is non-blank: poll until pixels arrive
  // (present → rAF blit is async), then assert a large fraction are coloured.
  await expect
    .poll(
      async () =>
        canvas.evaluate((cv: HTMLCanvasElement) => {
          const ctx = cv.getContext("2d");
          if (!ctx) return 0;
          const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
          let coloured = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] || d[i + 1] || d[i + 2]) coloured++;
          }
          return coloured;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(1000);

  // The pattern is structured, not a flat fill: the centre is the white square.
  const centre = await canvas.evaluate((cv: HTMLCanvasElement) => {
    const ctx = cv.getContext("2d")!;
    const p = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
    return [p[0], p[1], p[2]];
  });
  expect(centre).toEqual([255, 255, 255]);
});

test("a process WITHOUT Gpu cannot get a surface (default-deny) — no canvas window", async ({ page }) => {
  await ready(page);
  await spawnSpike(page, false); // no Gpu → win_surface returns NOTCAPABLE → guest exits 1

  // Give it time to (fail to) create a surface; the desktop survives and no
  // canvas window is ever opened.
  await page.waitForTimeout(1000);
  await expect(page.locator(".wasmos-window canvas")).toHaveCount(0);
  await expect(page.locator("#desktop")).toBeVisible();
});
