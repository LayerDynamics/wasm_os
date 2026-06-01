import { test, expect, type Page, type Locator } from "@playwright/test";

// Flagship "Lisp" runtime app — a real Scheme interpreter running as a wasm32-wasip1
// canvas process. End to end: launch from the taskbar → a REPL window opens → type
// a recursive program through the brokered keyboard → the interpreter evaluates it
// in its persistent environment → the result is shown and saved to the VFS. We
// assert on the persisted session transcript (canvas text can't be read as pixels),
// which proves the whole runtime works: lexer → parser → eval → closures/recursion.

type Win = { __wasmos: { control: { fsRead(p: string): Promise<Uint8Array> } } };

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".wasmos-window", { timeout: 10_000 });
}

function sessionText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    try {
      return new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/.lisp-session.txt"));
    } catch {
      return "";
    }
  });
}

test("the Lisp runtime evaluates a recursive program typed into the REPL", async ({ page }) => {
  await ready(page);

  // Launch the Lisp app; its REPL canvas window opens.
  await page.locator(".wasmos-launcher").click();
  await page.locator(".wasmos-launch-item", { hasText: "Lisp" }).click();
  const canvas: Locator = page.locator(".wasmos-window canvas").last();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  // Click the canvas so it is the focused window (brokered keyboard target).
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Define fib in the persistent environment, then call it. fib(10) = 55.
  await page.keyboard.type("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))", { delay: 8 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("(fib 10)", { delay: 12 });
  await page.keyboard.press("Enter");

  // The interpreter evaluated the recursion and the result was rendered + persisted.
  await expect.poll(() => sessionText(page), { timeout: 10_000 }).toContain("=> 55");

  // A follow-up expression uses the SAME environment (define persisted across lines).
  await page.keyboard.type("(map (lambda (x) (* x x)) (list 1 2 3 4))", { delay: 8 });
  await page.keyboard.press("Enter");
  await expect.poll(() => sessionText(page), { timeout: 10_000 }).toContain("=> (1 4 9 16)");
});
