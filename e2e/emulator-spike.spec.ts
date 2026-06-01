import { test, expect, type Page } from "@playwright/test";

// M5-T1 — v86 boot SPIKE. Boots a real Linux (BusyBox/Buildroot bzImage) in a
// dedicated worker via v86, captures the guest's ttyS0 serial console, and asserts
// on the serial TEXT (not framebuffer pixels). This resolves the empirical unknowns
// the rest of M5 builds on: worker loading, v86 API shape, boot time, and the
// serial markers that prove "Linux booted to a shell".

const V86 = "/third_party/v86";
const IMAGE = "/assets/linux/buildroot-bzimage.bin";

// A real kernel boot takes seconds; give it room.
test.setTimeout(120_000);

async function bootSerial(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.evaluate(
    ([v86, image]) => {
      const w = window as unknown as { __serial: string; __emu?: Worker };
      w.__serial = "";
      const worker = new Worker("/dist/worker/emulator-worker.js", { type: "module" });
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { type: string; text?: string };
        if (d.type === "serial" && typeof d.text === "string") w.__serial = d.text;
      };
      worker.postMessage({
        type: "boot",
        wasmPath: `${v86}/v86.wasm`,
        bios: `${v86}/seabios.bin`,
        vgaBios: `${v86}/vgabios.bin`,
        bzimage: image,
        // Route the kernel console + shell to the serial port so we can assert on text.
        cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
        memoryMb: 128,
      });
      w.__emu = worker;
    },
    [V86, IMAGE],
  );
}

function serial(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __serial: string }).__serial ?? "");
}

test("v86 boots a real Linux kernel to a shell, asserted over the serial console", async ({ page }) => {
  await bootSerial(page);

  // NOTE (spike finding): this image routes the KERNEL boot log to the VGA console
  // (tty0), so "Linux version" never appears on ttyS0. The userspace init banner and
  // the interactive shell ARE on serial — that's what proves "booted to a shell".

  // 1) Userspace init ran (the Buildroot/v86 banner is printed by /etc/init).
  await expect
    .poll(() => serial(page), { timeout: 90_000, intervals: [1000] })
    .toContain("Files send via emulator appear in /mnt/");

  // 2) An interactive BusyBox shell was reached (its prompt).
  await expect.poll(() => serial(page), { timeout: 30_000, intervals: [500] }).toContain("~%");

  // Surface what we captured (boot time + markers) into the test log for the
  // M5-STATUS notes the plan calls for.
  const text = await serial(page);
  console.log("=== SPIKE serial tail (last 600 chars) ===\n" + text.slice(-600));
});
