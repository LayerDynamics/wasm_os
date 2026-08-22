import { test, expect, type Page } from "@playwright/test";

// guest console input — interactive guest shell via brokered keyboard input. We boot Linux, wait
// for its shell, then deliver keystrokes through the host input broker into the
// guest's ttyS0. via hvc0. The command's OUTPUT is asserted on serial. The marker uses shell
// arithmetic (`$((6*7))` → 42) so a pass proves the guest actually EXECUTED the
// command — not merely echoed the typed characters back.

const IMAGE = "/assets/linux/wasmos-riscv64.cfg";
test.setTimeout(120_000);

type Win = {
  __wasmos: {
    control: {
      spawnEmulator(o: { name?: string; configUrl: string }): Promise<number>;
      onEmulatorSerial(cb: (pid: number, text: string) => void): void;
      emulatorInput(pid: number, text: string): Promise<void>;
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

const serial = (page: Page) => page.evaluate(() => (window as unknown as { __emuSerial: string }).__emuSerial ?? "");

test("keystrokes brokered to the guest run a command and its output returns (FR-27)", async ({ page }) => {
  await ready(page);

  const emu = await page.evaluate(async (image) => {
    const w = (window as unknown as Win).__wasmos;
    (window as unknown as { __emuSerial: string }).__emuSerial = "";
    w.control.onEmulatorSerial((_p, text) => {
      (window as unknown as { __emuSerial: string }).__emuSerial = text;
    });
    return w.control.spawnEmulator({ name: "linux", configUrl: image });
  }, IMAGE);

  // Wait until the BusyBox shell is interactive.
  await expect.poll(() => serial(page), { timeout: 90_000, intervals: [1000] }).toContain("~ #");

  // Type a command whose result is computed by the guest shell.
  await page.evaluate((p) => (window as unknown as Win).__wasmos.control.emulatorInput(p, "echo OUT-$((6*7))\n"), emu);

  // The guest evaluated `$((6*7))` to 42 and printed it back over serial.
  await expect.poll(() => serial(page), { timeout: 30_000, intervals: [500] }).toContain("OUT-42");
});
