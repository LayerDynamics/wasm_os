import { test, expect, type Page, type Locator } from "@playwright/test";

// M4-T8 — graphical System Monitor (FR-33 + FR-8). A real Rust canvas app: it
// draws the live process table from proc_list and acts on the selected process
// via brokered keyboard input, using a launcher-delegated Signal capability.
// End to end: launch from the taskbar → its canvas window renders → click a
// process row to select it → press `k` → the kernel reaps that process. Proven by
// the target disappearing from the live process table.

// Mirror of the app's layout constants (crates/apps/sysmon/src/main.rs).
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
      { timeout: 10_000 },
    )
    .toMatch(/zombie|gone/);
});
