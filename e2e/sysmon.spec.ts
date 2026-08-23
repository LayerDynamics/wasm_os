import { test, expect, type Page, type Locator } from "@playwright/test";

// system monitor — graphical System Monitor (FR-33 + FR-8). A real Rust canvas app: it
// draws the live process table from proc_list and acts on the selected process
// via brokered keyboard input, using a launcher-delegated Signal capability.
// End to end: launch from the taskbar → its canvas window renders → click a
// process row to select it → press `k` → the kernel reaps that process. Proven by
// the target disappearing from the live process table.

// Mirror of the app's layout constants (crates/apps/sysmon/src/main.rs).
const W = 520;
const H = 360;
const HEADER_H = 34;
const ROW_H = 14;

type Proc = { pid: number; name: string; state: string };
type Win = {
  __wasmos: {
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
      listProcs(): Promise<Proc[]>;
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

function listProcs(page: Page): Promise<Proc[]> {
  return page.evaluate(() => (window as unknown as Win).__wasmos.control.listProcs());
}

test("System Monitor renders the process table and kills the selected process (FR-33/FR-8)", async ({ page }) => {
  await ready(page);

  // A long-lived victim (sigdemo parks in sig_wait) for the monitor to kill.
  const victim = await page.evaluate(async () => {
    const w = (window as unknown as Win).__wasmos;
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    return w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
  });
  expect(victim).toBeGreaterThan(0);

  // Launch the System Monitor from the taskbar (delegates Gpu+Input+Signal).
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Monitor" }).click();

  const canvas: Locator = page.locator(".wasmos-window canvas").last();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no monitor canvas box");

  // The monitor sorts by PID; find the victim's on-screen row. Both this snapshot
  // and the monitor's include the same processes (init, sh, victim, sysmon).
  const procs = (await listProcs(page)).sort((a, b) => a.pid - b.pid);
  const idx = procs.findIndex((p) => p.pid === victim);
  expect(idx).toBeGreaterThanOrEqual(0);

  // Row Y in canvas space → CSS space (the canvas is scaled to its window).
  const rowTop = HEADER_H + ROW_H; // header band + column-header row
  const canvasY = rowTop + idx * ROW_H + ROW_H / 2;
  const cssX = box.x + box.width * 0.5;
  const cssY = box.y + (canvasY / H) * box.height;

  // Click the victim's row (focuses the monitor window + selects the row), then
  // press `k` → the monitor sends SIGKILL to the selected process.
  await page.mouse.click(cssX, cssY);
  await page.keyboard.press("k");

  // The kernel reaped the victim: it leaves the live process table (or zombifies).
  await expect
    .poll(
      async () => {
        const p = (await listProcs(page)).find((x) => x.pid === victim);
        return p?.state ?? "gone";
      },
      { timeout: 20_000 },
    )
    .toMatch(/zombie|gone/);
});

test("System Monitor kills via the keyboard (arrow-select + k), no mouse needed", async ({ page }) => {
  // Regression: the cursor defaulted to row 0 = init (pid 1), which is protected, so
  // pressing k right after launch silently did nothing — the keys looked broken. The
  // selection now seeds on the first killable process, and arrow keys navigate.
  await ready(page);

  const victim = await page.evaluate(async () => {
    const w = (window as unknown as Win).__wasmos;
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    return w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
  });
  expect(victim).toBeGreaterThan(0);

  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Monitor" }).click();
  const canvas: Locator = page.locator(".wasmos-window canvas").last();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600); // the monitor is focused by its launch and rendered

  // Navigate by keyboard to the victim's row: clamp to the top, then arrow down.
  const procs = (await listProcs(page)).sort((a, b) => a.pid - b.pid);
  const idx = procs.findIndex((p) => p.pid === victim);
  expect(idx).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(100);
  for (let i = 0; i < idx; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(30);
  }
  await page.keyboard.press("k");

  await expect
    .poll(async () => (await listProcs(page)).find((x) => x.pid === victim)?.state ?? "gone", { timeout: 20_000 })
    .toMatch(/zombie|gone/);
});

test("System Monitor manages a selected row through the visible KILL control", async ({ page }) => {
  await ready(page);
  const victim = await page.evaluate(async () => {
    const w = (window as unknown as Win).__wasmos;
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    return w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
  });

  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Monitor" }).click();
  const canvas = page.locator(".wasmos-window canvas").last();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no monitor canvas box");
  const procs = (await listProcs(page)).sort((a, b) => a.pid - b.pid);
  const idx = procs.findIndex((p) => p.pid === victim);
  expect(idx).toBeGreaterThanOrEqual(0);

  const rowTop = HEADER_H + ROW_H;
  await page.mouse.click(box.x + box.width * 0.5, box.y + ((rowTop + idx * ROW_H + ROW_H / 2) / H) * box.height);
  await page.mouse.click(box.x + ((6 + 29) / W) * box.width, box.y + ((17 + 6) / H) * box.height);

  await expect
    .poll(async () => (await listProcs(page)).find((p) => p.pid === victim)?.state ?? "gone", { timeout: 20_000 })
    .toMatch(/zombie|gone/);
});
