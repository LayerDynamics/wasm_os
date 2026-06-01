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
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
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
  expect((log.match(/wasmos:/g) || []).length).toBeGreaterThanOrEqual(2); // prompt returned
});

test("a non-existent command reports `command not found` without crashing the kernel", async ({ page }) => {
  // Regression: typing a typo used to make k_spawn allocate a child and emit a
  // SpawnRequest, after which the host's fsRead(image) threw ("ring pump error")
  // and the shell's wait() hung. The kernel now validates the image exists and
  // returns NOENT so the shell prints a clean diagnostic and keeps going.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  await page.locator("#terminal").click();
  await page.keyboard.type("nosuchcmd_xyz");
  await page.keyboard.press("Enter");

  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (log.includes("command not found")) break;
    await page.waitForTimeout(150);
  }
  expect(log).toContain("nosuchcmd_xyz: command not found");

  // The shell recovered: a fresh prompt printed AND a real command still runs.
  await page.keyboard.type("echo recovered");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if ((log.match(/recovered/g) || []).length >= 2) break;
    await page.waitForTimeout(150);
  }
  expect((log.match(/recovered/g) || []).length).toBeGreaterThanOrEqual(2);
  // No host-side crash leaked to the page (no "ring pump"/ComponentError console.error).
  expect(errors.join("\n")).not.toMatch(/ring pump|ComponentError/);
});

test("arrow / navigation keys do not corrupt the xterm parser", async ({ page }) => {
  // Regression: the terminal used to echo raw key input straight back into xterm,
  // so an arrow key's escape sequence (ESC[A) fed xterm's own parser and produced
  // "Parsing error" spam. Escape-prefixed input is now dropped, not echoed.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  await page.locator("#terminal").click();
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"]) {
    await page.keyboard.press(key);
  }
  // A normal command typed afterwards must still run cleanly.
  await page.keyboard.type("echo afterarrows");
  await page.keyboard.press("Enter");

  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if ((log.match(/afterarrows/g) || []).length >= 2) break;
    await page.waitForTimeout(150);
  }
  expect((log.match(/afterarrows/g) || []).length).toBeGreaterThanOrEqual(2);
  expect(errors.join("\n")).not.toMatch(/Parsing error/i);
});

test("env prints the real per-process environment end-to-end (FR-18)", async ({ page }) => {
  // The whole environ path runs for real: the `env` guest calls std::env::vars()
  // → environ_sizes_get/environ_get → the shim → the kernel returns this process's
  // actual env (PATH/HOME/TERM/PWD), inherited from the shell on spawn. No stub.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  await page.locator("#terminal").click();
  await page.keyboard.type("env");
  await page.keyboard.press("Enter");

  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 50; i++) {
    log = await readLog();
    if (log.includes("PATH=/bin") && log.includes("HOME=/home")) break;
    await page.waitForTimeout(150);
  }
  expect(log).toContain("PATH=/bin");
  expect(log).toContain("HOME=/home");
  expect(log).toContain("TERM=xterm-256color");
  expect(log).toContain("PWD=");
});

test("the Zig coreutil (echo.zig) runs end-to-end through the terminal (FR-14)", async ({ page }) => {
  // The polyglot proof in the LIVE system: a Zig-built `wasm32-wasi` binary runs
  // through the identical terminal → shell → wasmos_kernel spawn → process path as
  // the Rust coreutils. (The byte-for-byte parity vs the Rust echo is pinned by the
  // node:wasi host test; this proves the kernel actually executes the Zig guest.)
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  await page.locator("#terminal").click();
  await page.keyboard.type("echo.zig zig-polyglot-OK");
  await page.keyboard.press("Enter");

  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 60; i++) {
    log = await readLog();
    if ((log.match(/zig-polyglot-OK/g) || []).length >= 2) break; // echoed input + program output
    await page.waitForTimeout(200);
  }
  // Output line distinct from the echoed input → the Zig binary actually ran.
  expect((log.match(/zig-polyglot-OK/g) || []).length).toBeGreaterThanOrEqual(2);
  expect((log.match(/wasmos:/g) || []).length).toBeGreaterThanOrEqual(2); // prompt returned
});
