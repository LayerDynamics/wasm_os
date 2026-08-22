import { test, expect, type Page } from "@playwright/test";

// concurrency test — ≥32 concurrent processes within the main-thread budget (FR-3). Spawn 32
// spinner processes (each does a little work then parks); the process table holds
// them all AND the desktop/shell stays responsive — a command still runs end to
// end while 32 peers are alive.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string }): Promise<number>;
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      listProcs(): Promise<Array<{ pid: number; name: string; state: string }>>;
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

test("32 concurrent processes are sustained while the shell stays responsive (FR-3)", async ({ page }) => {
  await ready(page);

  // Spawn 32 spinner processes.
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = await (await fetch("/packages/host/guests/spinner.wasm")).arrayBuffer();
    await Promise.all(Array.from({ length: 32 }, () => w.__wasmos.control.spawn(bytes, { name: "spinner" })));
  });

  // The kernel holds them all: init + shell + 32 spinners ⇒ ≥ 34 processes, with
  // at least 32 named "spinner".
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const list = await (window as unknown as Win).__wasmos.control.listProcs();
          return list.filter((p) => p.name === "spinner").length;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(32);

  const total = await page.evaluate(async () => (await (window as unknown as Win).__wasmos.control.listProcs()).length);
  expect(total).toBeGreaterThanOrEqual(34);

  // The main thread is not saturated: a fresh shell command still runs to
  // completion while the 32 peers are alive.
  await page.evaluate(() => {
    const w = window as unknown as Win;
    void w.__wasmos.control.stdin(w.__wasmos.shellPid, new TextEncoder().encode("echo BUDGET-OK-42\n"));
  });
  await page.waitForFunction(() => (window as unknown as Win).__wasmos.term.log().includes("BUDGET-OK-42"), null, {
    timeout: 10_000,
  });
});
