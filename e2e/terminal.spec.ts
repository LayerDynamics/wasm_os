import { test, expect, type Page } from "@playwright/test";

// M2 spine checkpoint (FR-15/16): a real xterm terminal, bound to a real Rust
// shell process, runs a real WASI coreutil end-to-end. Every layer runs: real
// keystrokes → xterm → control.stdin → shell stdin (park/resume) → wasmos_kernel
// spawn → child runs → stdout streams back to xterm. No mocks.

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });
  return errors;
}

async function waitReady(page: Page, errors: string[]): Promise<void> {
  try {
    await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
      timeout: 20_000,
    });
  } catch {
    throw new Error("terminal did not reach ready. Browser errors:\n" + (errors.join("\n") || "(none)"));
  }
}

test("terminal runs `echo` end-to-end through the real shell process", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  // The shell prompt should already be on screen (the shell wrote it to stdout).
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos$"),
    null,
    { timeout: 10_000 },
  );

  // Type a command into the REAL terminal (xterm's textarea captures keystrokes).
  await page.locator("#terminal").click();
  await page.keyboard.type("echo ohai");
  await page.keyboard.press("Enter");

  // The command's OUTPUT must appear — distinct from the locally-echoed input.
  // "ohai" appears once as echoed input and once as `echo`'s output → count >= 2.
  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 60; i++) {
    log = await readLog();
    if ((log.match(/ohai/g) || []).length >= 2) break;
    await page.waitForTimeout(200);
  }
  if ((log.match(/ohai/g) || []).length < 2) {
    const procs = await page.evaluate(
      () => (window as unknown as { __wasmos: { control: { listProcs(): Promise<unknown> } } }).__wasmos.control.listProcs(),
    );
    throw new Error(
      `command did not produce output.\nlog=${JSON.stringify(log)}\nprocs=${JSON.stringify(procs)}\nerrors=${errors.join(" | ")}`,
    );
  }
  // The echoed command line is present, the output line is present, and the
  // shell printed a fresh prompt afterwards (the command completed + reaped).
  expect(log).toContain("echo ohai");
  expect((log.match(/ohai/g) || []).length).toBeGreaterThanOrEqual(2);
  expect((log.match(/wasmos\$/g) || []).length).toBeGreaterThanOrEqual(2); // prompt returned
});
