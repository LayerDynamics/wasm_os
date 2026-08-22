import { test, expect, type Page } from "@playwright/test";

// emulator CPU accounting — run-to-budget scheduling + killable-from-top (FR-28 + the Linux guest integration exit
// criteria, closing Phase A). The emulator runs in its own worker (true
// parallelism); the kernel accounts its activity as CPU in proc_list/top via
// wall-budget heartbeats. While Linux runs, a concurrent wasm32-wasi process keeps
// running and stays isolated; killing the emulator (the userland kill path, the
// CLI counterpart of the System Monitor) reaps it, and the peer + desktop survive.

const IMAGE = "/assets/linux/wasmos-riscv64.cfg";
test.setTimeout(120_000);

type Proc = { pid: number; name: string; state: string; cpu: number };
type Win = {
  __wasmos: {
    shellPid: number;
    control: {
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
      spawnEmulator(o: { name?: string; configUrl: string }): Promise<number>;
      onEmulatorSerial(cb: (pid: number, text: string) => void): void;
      listProcs(): Promise<Array<{ pid: number; name: string; state: string; cpuTicks: bigint }>>;
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

// proc_list with cpuTicks coerced to Number (bigint can't cross page.evaluate).
function procs(page: Page): Promise<Proc[]> {
  return page.evaluate(async () => {
    const list = await (window as unknown as Win).__wasmos.control.listProcs();
    return list.map((p) => ({ pid: p.pid, name: p.name, state: p.state, cpu: Number(p.cpuTicks) }));
  });
}

const stateOf = async (page: Page, pid: number) => (await procs(page)).find((p) => p.pid === pid)?.state ?? "gone";

test("the emulator accrues CPU in top, is killable, and peers keep running (FR-28)", async ({ page }) => {
  await ready(page);

  const { peer, emu } = await page.evaluate(async (image) => {
    const w = (window as unknown as Win).__wasmos;
    (window as unknown as { __emuSerial: string }).__emuSerial = "";
    w.control.onEmulatorSerial((_p, text) => {
      (window as unknown as { __emuSerial: string }).__emuSerial = text;
    });
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    const peerPid = await w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
    const emuPid = await w.control.spawnEmulator({ name: "linux", configUrl: image });
    return { peer: peerPid, emu: emuPid };
  }, IMAGE);

  // Linux boots to a shell while the peer runs (concurrency).
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __emuSerial: string }).__emuSerial), {
      timeout: 90_000,
      intervals: [1000],
    })
    .toContain("~ #");

  // Run-to-budget accounting: the emulator accrues CPU activity in top.
  await expect.poll(async () => (await procs(page)).find((p) => p.pid === emu)?.cpu ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

  // The unrelated wasm process is still alive (isolation preserved while Linux ran).
  expect(await stateOf(page, peer)).not.toBe("gone");

  // Kill the emulator from userland (the CLI counterpart of the System Monitor):
  // the shell's `kill -9` → SIGKILL → reap → its worker is torn down.
  await page.evaluate((p) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(`kill -9 ${p}\n`));
  }, emu);

  await expect.poll(() => stateOf(page, emu), { timeout: 10_000 }).toMatch(/zombie|gone/);

  // The peer survives, and the desktop/terminal are still up.
  expect(await stateOf(page, peer)).not.toBe("gone");
  await expect(page.locator("#terminal")).toBeVisible();
});
