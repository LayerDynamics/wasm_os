import { test, expect, type Page } from "@playwright/test";

// Linux guest boot — emulator boot SPIKE. Boots a real riscv64 Linux (BusyBox/Buildroot) in a
// dedicated worker via the MIT TinyEMU core, captures the guest's hvc0 serial
// console, and asserts on the serial TEXT (not framebuffer pixels) — proving worker
// loading, the TinyEMU vm_start/console API shape, boot time, and the serial markers
// that prove "Linux booted to a shell".

const CFG = "/assets/linux/wasmos-riscv64.cfg";

// A real kernel boot takes seconds; give it room.
test.setTimeout(120_000);

async function bootSerial(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.evaluate((cfg) => {
    const w = window as unknown as { __serial: string; __emu?: Worker };
    w.__serial = "";
    const worker = new Worker("/dist/worker/emulator-worker.js", { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; text?: string };
      if (d.type === "serial" && typeof d.text === "string") w.__serial = d.text;
    };
    // The boot message names the TinyEMU VM config; the worker loads the MIT core +
    // the bios/kernel/rootfs it references and routes hvc0 serial back over postMessage.
    worker.postMessage({ type: "boot", configUrl: cfg, memoryMb: 128 });
    w.__emu = worker;
  }, CFG);
}

function serial(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __serial: string }).__serial ?? "");
}

test("TinyEMU boots a real riscv64 Linux kernel to a shell, asserted over the serial console", async ({ page }) => {
  await bootSerial(page);

  // 1) The kernel reached userspace: it mounted the ext2 root over virtio-block.
  await expect
    .poll(() => serial(page), { timeout: 90_000, intervals: [1000] })
    .toContain("VFS: Mounted root");

  // 2) An interactive BusyBox shell was reached (its prompt).
  await expect.poll(() => serial(page), { timeout: 30_000, intervals: [500] }).toContain("~ #");

  const text = await serial(page);
  console.log("=== SPIKE serial tail (last 600 chars) ===\n" + text.slice(-600));
});
