import { test, expect, type Page } from "@playwright/test";

// 9p shared folder — virtio-9p shared folder (FR-29). The host /home/shared subtree is bridged
// into the guest's 9p mount (the emulator worker auto-mounts the host9p tag on
// /mnt). Files cross BOTH ways: a file written in host /home/shared is seeded into
// the 9p fs and read inside the guest; a file the guest writes under /mnt is
// mirrored back to the host VFS.

const IMAGE = "/assets/linux/wasmos-riscv64.cfg";
test.setTimeout(120_000);

type Win = {
  __wasmos: {
    control: {
      fsWrite(path: string, bytes: Uint8Array): Promise<void>;
      fsRead(path: string): Promise<Uint8Array>;
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

test("files cross the host VFS and the guest Linux via the 9p shared folder (FR-29)", async ({ page }) => {
  await ready(page);

  // Seed a host file, then launch — the emulator seeds it into the guest 9p share.
  const emu = await page.evaluate(async (image) => {
    const w = (window as unknown as Win).__wasmos;
    await w.control.fsWrite("/home/shared/host-greeting.txt", new TextEncoder().encode("FROM-HOST-9P"));
    (window as unknown as { __emuSerial: string }).__emuSerial = "";
    w.control.onEmulatorSerial((_p, text) => {
      (window as unknown as { __emuSerial: string }).__emuSerial = text;
    });
    return w.control.spawnEmulator({ name: "linux", configUrl: image });
  }, IMAGE);

  await expect.poll(() => serial(page), { timeout: 90_000, intervals: [1000] }).toContain("~ #");

  // host → guest: the guest reads the file the host placed in the share.
  await page.evaluate((p) => (window as unknown as Win).__wasmos.control.emulatorInput(p, "cat /mnt/host-greeting.txt\n"), emu);
  await expect.poll(() => serial(page), { timeout: 30_000, intervals: [500] }).toContain("FROM-HOST-9P");

  // guest → host: the guest writes a file under /mnt; it is mirrored to the host VFS.
  await page.evaluate((p) => (window as unknown as Win).__wasmos.control.emulatorInput(p, "echo FROM-GUEST-9P > /mnt/guest-note.txt\n"), emu);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            return new TextDecoder()
              .decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/shared/guest-note.txt"))
              .trim();
          } catch {
            return "";
          }
        }),
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe("FROM-GUEST-9P");
});
