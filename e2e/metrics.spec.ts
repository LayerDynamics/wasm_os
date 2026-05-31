import { test, expect, type Page } from "@playwright/test";

// M4-T1 — process metrics. The kernel accounts a scheduler tick per serviced
// syscall (CPU activity) and stores each process's reported memory size; the
// process table projection (listProcs / the guest proc_list) carries priority,
// cpu_ticks, mem_bytes, and parent. This exercises the real stack: worker reports
// memory → kworker → kernel; the shell's syscalls accrue CPU ticks.

type Proc = { pid: number; name: string; state: string; priority: number; cpuTicks: number; memBytes: number; parent: number };
type Win = {
  __wasmos: {
    control: {
      listProcs(): Promise<Array<{ pid: number; name: string; state: string; priority: number; cpuTicks: bigint; memBytes: number; parent: number }>>;
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

function procs(page: Page): Promise<Proc[]> {
  return page.evaluate(async () => {
    const list = await (window as unknown as Win).__wasmos.control.listProcs();
    // bigint isn't serializable across the evaluate boundary — narrow it.
    return list.map((p) => ({ ...p, cpuTicks: Number(p.cpuTicks) }));
  });
}

test("the process table carries priority, CPU-activity, and memory metrics (FR-33)", async ({ page }) => {
  await ready(page);

  // The shell process reports a real memory size (its worker posted it after
  // instantiation) and accrues CPU ticks as it services syscalls.
  await expect
    .poll(async () => {
      const sh = (await procs(page)).find((p) => p.name === "sh");
      return sh ? sh.memBytes : 0;
    }, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const list = await procs(page);
  const sh = list.find((p) => p.name === "sh");
  expect(sh).toBeTruthy();
  expect(sh!.priority).toBeGreaterThanOrEqual(0);
  expect(sh!.cpuTicks).toBeGreaterThanOrEqual(1); // it has serviced syscalls
  // init (pid 1) is present too — a multi-process table.
  expect(list.some((p) => p.pid === 1)).toBe(true);
  expect(list.length).toBeGreaterThanOrEqual(2);
});
