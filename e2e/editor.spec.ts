import { test, expect, type Page } from "@playwright/test";

// M3-T7 — text editor (FR-24 association target). A real Rust canvas app: it opens
// a file, edits it from brokered keyboard input, and saves with Ctrl+S. The proof
// rounds-trips through the VFS: seed a file → edit → save → read back the bytes.

type Win = {
  __wasmos: {
    control: {
      spawn(b: ArrayBuffer, o?: { name?: string; grantGpu?: boolean; grantInput?: boolean; grantFsSubtree?: string }): Promise<number>;
      fsWrite(path: string, bytes: Uint8Array): Promise<void>;
      fsRead(path: string): Promise<Uint8Array>;
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

test("the editor opens a file, edits it, and saves back to the VFS (Ctrl+S)", async ({ page }) => {
  await ready(page);

  // Seed the default document, then launch the editor (no argv → /home/untitled.txt).
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    await w.__wasmos.control.fsWrite("/home/untitled.txt", new TextEncoder().encode("SEED"));
    const bytes = await (await fetch("/packages/host/guests/editor.wasm")).arrayBuffer();
    await w.__wasmos.control.spawn(bytes, { name: "editor", grantGpu: true, grantInput: true, grantFsSubtree: "/" });
  });

  const canvas = page.locator(".wasmos-window canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);

  // Click the editor canvas to ensure it is the focused canvas window (this also
  // blurs the terminal so keystrokes route to the editor, not the shell).
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(150);

  // Type at the start of the document, then save with Ctrl+S.
  await page.keyboard.type("abc", { delay: 30 });
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+KeyS");
  await page.waitForTimeout(400);

  // The saved file reflects the edit: "abc" inserted before the seed text.
  const text = await page.evaluate(async () => {
    const bytes = await (window as unknown as Win).__wasmos.control.fsRead("/home/untitled.txt");
    return new TextDecoder().decode(bytes);
  });
  expect(text).toBe("abcSEED");
});
