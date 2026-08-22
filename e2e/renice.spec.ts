import { test, expect, type Page } from "@playwright/test";

// runtime priority — runtime priority (FR-8). The `renice` coreutil changes a running
// process's scheduling priority live; the kernel re-buckets it in the run queue
// and surfaces the new value through proc_list. The shell delegates its Signal
// capability to `renice` (it reprioritises another process), mirroring `kill`.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
      listProcs(): Promise<Array<{ pid: number; name: string; state: string; priority: number }>>;
    };
  };
};

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => (window as unknown as Win).__wasmos.term.log().includes("wasmos:"), null, {
    timeout: 10_000,
  });
}

function priorityOf(page: Page, pid: number): Promise<number | undefined> {
  return page.evaluate(async (p) => {
    const procs = await (window as unknown as Win).__wasmos.control.listProcs();
    return procs.find((x) => x.pid === p)?.priority;
  }, pid);
}

test("renice changes a running process's priority live (FR-8)", async ({ page }) => {
  await ready(page);

  // sigdemo parks forever in sig_wait → a stable, long-lived renice target.
  const pid = await page.evaluate(async () => {
    const w = (window as unknown as Win).__wasmos;
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    return w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
  });
  expect(pid).toBeGreaterThan(0);

  // It starts at the default user priority (5).
  await expect.poll(() => priorityOf(page, pid), { timeout: 5_000 }).toBe(5);

  // Renice it up to 12 from the shell; the kernel applies it and proc_list reports it.
  await page.evaluate((p) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(`renice 12 ${p}\n`));
  }, pid);

  await expect.poll(() => priorityOf(page, pid), { timeout: 10_000 }).toBe(12);
});
