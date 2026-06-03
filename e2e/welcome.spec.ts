import { test, expect, type Page } from "@playwright/test";

// Welcome — the guided intro app (L3). A real wasm32-wasip1 canvas process that opens
// CENTERED and renders a few navigable slides. This proves it launches as a process,
// opens centered, and that arrow-key navigation changes the rendered slide.

type Win = {
  __wasmos: {
    session: { launch(name: string): Promise<number | undefined> };
    compositor: { windowList(): Array<{ id: number; title: string }> };
    control: { listProcs(): Promise<Array<{ pid: number; name: string; state: string }>> };
  };
};

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );
}

/** FNV-1a hash of the last desktop canvas (so we can tell slides apart). */
function hashLastCanvas(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = [...document.querySelectorAll("#desktop canvas")].pop() as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 17) {
      h ^= d[i]!;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  });
}

test("Welcome guide launches as a process, opens centered, and navigates slides", async ({ page }) => {
  await ready(page);

  // Launch the Welcome app (the React client also auto-opens it on a first visit; here
  // we launch explicitly so the test is deterministic regardless of that gate).
  await page.evaluate(() => (window as unknown as Win).__wasmos.session.launch("welcome"));
  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);

  // It runs as a real process.
  const procs = await page.evaluate(() => (window as unknown as Win).__wasmos.control.listProcs());
  expect(procs.some((p) => p.name === "welcome")).toBe(true);

  // Its window is titled "Welcome" (not "App (pid N)").
  const titles = await page.evaluate(() => (window as unknown as Win).__wasmos.compositor.windowList().map((w) => w.title));
  expect(titles).toContain("Welcome");

  // It opens centered: the window is roughly horizontally centered in the desktop.
  const centered = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".wasmos-window")].find(
      (e) => e.querySelector(".wasmos-title")?.textContent === "Welcome",
    ) as HTMLElement;
    const r = el.getBoundingClientRect();
    const desk = document.getElementById("desktop")!.getBoundingClientRect();
    const winCenter = r.x + r.width / 2;
    const deskCenter = desk.x + desk.width / 2;
    return Math.abs(winCenter - deskCenter);
  });
  expect(centered).toBeLessThan(40); // within 40px of the desktop's horizontal center

  // Slide navigation: pressing → must change the rendered slide (distinct canvases).
  await page.locator(".wasmos-window", { has: page.locator("canvas") }).first().locator(".wasmos-titlebar").click();
  const seen = new Set<number>();
  seen.add(await hashLastCanvas(page));
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
    seen.add(await hashLastCanvas(page));
  }
  expect(seen.size).toBe(6); // six distinct slides reached via the arrow key

  // Going back works too: ← returns to a previously-seen render.
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(250);
  expect(seen.has(await hashLastCanvas(page))).toBe(true);
});
