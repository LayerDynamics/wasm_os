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

test("Backspace deletes the last character in the terminal line", async ({ page }) => {
  // Regression: the shell's read_line pushed the DEL byte into the command and the
  // terminal never echoed a destructive backspace, so Backspace could not delete.
  // Now the terminal erases visually (\b \b) and the shell drops the char, so a
  // typo corrected with Backspace runs the intended command.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  await page.locator("#terminal").click();
  // Type "lsX", delete the stray X, then run — the shell must execute `ls`, not `lsX`.
  await page.keyboard.type("lsX", { delay: 30 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");

  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/\bbin\b/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toMatch(/\bbin\b/); // `ls` ran and listed /bin
  expect(log).not.toContain("lsX: command not found"); // the X was truly deleted

  // Backspace at an empty prompt must not eat the prompt or the previous output.
  const before = await readLog();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(150);
  expect(await readLog()).toBe(before); // nothing erased past the start of the line
});

test("the terminal respawns its shell after it exits (no dead echo-only terminal)", async ({ page }) => {
  // Regression: the shell could exit (the `exit` builtin, a crash, or being killed
  // from System Monitor) and become an UNREAPED ZOMBIE. The terminal stayed bound to
  // the corpse — typing echoed locally but Enter/Backspace silently did nothing (the
  // user's exact report). An unreaped zombie never fires onExit, so the host now polls
  // process state and respawns the shell, keeping the terminal usable.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  await page.locator("#terminal").click();
  const shell0 = await page.evaluate(
    () => (window as unknown as { __wasmos: { term: { shellPid(): number } } }).__wasmos.term.shellPid(),
  );

  // Kill the shell with the `exit` builtin → it becomes a zombie.
  await page.keyboard.type("exit", { delay: 20 });
  await page.keyboard.press("Enter");

  // The watcher (≤1.5s) must respawn a NEW shell the terminal is rebound to.
  await page.waitForFunction(
    (old) => (window as unknown as { __wasmos: { term: { shellPid(): number } } }).__wasmos.term.shellPid() !== old,
    shell0,
    { timeout: 8_000 },
  );

  // And the terminal must run commands again — it recovered, it is not a dead box.
  await page.keyboard.type("echo RECOVERED", { delay: 20 });
  await page.keyboard.press("Enter");
  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 50; i++) {
    log = await readLog();
    if (/\nRECOVERED/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toMatch(/\nRECOVERED/); // command ran on the respawned shell
  expect(log).toContain("[shell exited — restarted]");
});

test("terminal keeps working after switching to another window and back (focus restore)", async ({ page }) => {
  // Regression: the compositor marked a re-clicked window active + raised it, but
  // never restored DOM focus to a DOM window's content. So after launching another
  // window and clicking back to the terminal, the xterm textarea stayed blurred —
  // the terminal looked active but was keyboard-DEAD (typing/Backspace/Delete all
  // silently lost). Now `Win.onActivate` re-focuses the xterm textarea on activate.
  //
  // The bug only reproduces through the *titlebar* click: clicking the content
  // (#terminal) natively focuses the textarea and hides the defect; the titlebar's
  // beginMove() calls preventDefault(), suppressing that native focus.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  // Launch a second window (the editor, a canvas app) so it becomes the active
  // window and the terminal's textarea loses focus.
  await page.evaluate(() =>
    (window as unknown as { __wasmos: { session: { launch(n: string): Promise<unknown> } } }).__wasmos.session.launch("editor"),
  );
  await page.waitForFunction(() => document.querySelectorAll("#desktop canvas").length >= 1, null, { timeout: 20_000 });
  await page.waitForTimeout(500);

  // Switch BACK to the terminal by clicking its titlebar (not its content).
  const termTitlebar = page.locator(".wasmos-window", { has: page.locator("#terminal") }).locator(".wasmos-titlebar");
  await termTitlebar.click();
  await page.waitForTimeout(200);

  // The xterm textarea must have regained keyboard focus.
  expect(await page.evaluate(() => !!document.getElementById("terminal")?.contains(document.activeElement))).toBe(true);

  // And real typing + Backspace must now reach the shell: "lsX" → Backspace → `ls`.
  await page.keyboard.type("lsX", { delay: 30 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/\bbin\b/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toMatch(/\bbin\b/); // `ls` ran — the terminal was NOT keyboard-dead
  expect(log).not.toContain("lsX: command not found");
});

test("pasting a multi-character command ending in a newline runs it", async ({ page }) => {
  // Regression: onData used to drop the WHOLE chunk if it contained any
  // non-printable character, so a paste like "ls\n" (printable text + newline)
  // vanished. The handler now processes the chunk character-by-character, so the
  // printable run is delivered and the embedded newline submits the command.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);
  await page.waitForFunction(
    () => ((window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log()).includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );

  // Paste delivers the text to xterm as a single onData chunk (incl. the newline).
  await page.evaluate(() => {
    const w = window as unknown as { __wasmos: { term: { term: { paste(s: string): void } } } };
    w.__wasmos.term.term.paste("ls\n");
  });

  const readLog = () =>
    page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/\bbin\b/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toContain("ls"); // the printable run was delivered, not dropped
  expect(log).toMatch(/\bbin\b/); // ...and the newline submitted it, so `ls` ran
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
