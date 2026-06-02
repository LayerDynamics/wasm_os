import { test, expect, type Page } from "@playwright/test";

// M5-T2 — the emulator as a privileged (Native, non-ring) process. It is launched
// through the kernel (a real PID + capability set), boots Linux in its dedicated
// worker, shows up in proc_list/top, and is killable — all while a normal
// wasm32-wasi process keeps running and stays isolated (FR-6/FR-27/FR-28).

const IMAGE = "/assets/linux/wasmos-riscv64.cfg";
test.setTimeout(120_000);

type Proc = { pid: number; name: string; state: string };
type Win = {
  __wasmos: {
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
      spawnEmulator(o: { name?: string; configUrl: string }): Promise<number>;
      onEmulatorSerial(cb: (pid: number, text: string) => void): void;
      listProcs(): Promise<Proc[]>;
      kill(pid: number): Promise<void>;
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

test("the emulator runs as a killable privileged process while a peer stays isolated", async ({ page }) => {
  await ready(page);

  const { peer, emu } = await page.evaluate(async (image) => {
    const w = (window as unknown as Win).__wasmos;
    // Accumulate the emulator's serial console for the boot assertion.
    (window as unknown as { __emuSerial: string }).__emuSerial = "";
    w.control.onEmulatorSerial((_pid, text) => {
      (window as unknown as { __emuSerial: string }).__emuSerial = text;
    });
    // A long-lived wasm32-wasi peer (sigdemo parks forever in sig_wait).
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    const peerPid = await w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
    // Launch the privileged emulator process.
    const emuPid = await w.control.spawnEmulator({ name: "linux", configUrl: image });
    return { peer: peerPid, emu: emuPid };
  }, IMAGE);
  expect(emu).toBeGreaterThan(0);

  // It is a first-class process in the table: name "linux", running.
  await expect
    .poll(async () => (await listProcs(page)).find((p) => p.pid === emu)?.state ?? "gone", { timeout: 5_000 })
    .toBe("running");
  expect((await listProcs(page)).find((p) => p.pid === emu)?.name).toBe("linux");

  // It is really executing — Linux boots to an interactive shell in its worker.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __emuSerial: string }).__emuSerial), {
      timeout: 90_000,
      intervals: [1000],
    })
    .toContain("~ #");

  // The unrelated wasm process kept running throughout (isolation/concurrency).
  expect((await listProcs(page)).find((p) => p.pid === peer)?.state).not.toBe("gone");

  // Kill the emulator (the System Monitor / window-close path) — it is reaped.
  await page.evaluate((p) => (window as unknown as Win).__wasmos.control.kill(p), emu);
  await expect
    .poll(async () => (await listProcs(page)).find((p) => p.pid === emu)?.state ?? "gone", { timeout: 10_000 })
    .toMatch(/zombie|gone/);

  // The peer survives the emulator's death.
  expect((await listProcs(page)).find((p) => p.pid === peer)?.state).not.toBe("gone");
});
