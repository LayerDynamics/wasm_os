import { test, expect, type Page } from "@playwright/test";

// runtime image selection — boot an image resolved at runtime. Rather than a hardcoded launcher URL,
// the system fetches a small image manifest at launch and boots the kernel it
// names ("run the image from within it"). The bios/kernel/rootfs are loaded by TinyEMU
// from its URL (it is far larger than a syscall-ring payload); the manifest is the
// small, runtime-fetched indirection.

const MANIFEST = "/assets/linux/image-manifest.json";
test.setTimeout(120_000);

type Win = {
  __wasmos: {
    control: {
      spawnEmulatorFromManifest(manifestUrl: string): Promise<number>;
      onEmulatorSerial(cb: (pid: number, text: string) => void): void;
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

test("the emulator boots an image resolved from a runtime-fetched manifest (run the image from within it)", async ({ page }) => {
  await ready(page);

  const pid = await page.evaluate(async (manifest) => {
    const w = (window as unknown as Win).__wasmos;
    (window as unknown as { __emuSerial: string }).__emuSerial = "";
    w.control.onEmulatorSerial((_p, text) => {
      (window as unknown as { __emuSerial: string }).__emuSerial = text;
    });
    return w.control.spawnEmulatorFromManifest(manifest);
  }, MANIFEST);
  expect(pid).toBeGreaterThan(0);

  // The manifest named the riscv64 VM config; TinyEMU booted it to a shell.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __emuSerial: string }).__emuSerial), {
      timeout: 90_000,
      intervals: [1000],
    })
    .toContain("~ #");
});
