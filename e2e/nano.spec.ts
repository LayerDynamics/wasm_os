import { test, expect, type Page } from "@playwright/test";

// In-terminal `nano` checkpoint: a real wasm32-wasip1 editor takes over the
// terminal in raw mode and edits a file end-to-end. Every layer runs for real:
// keystrokes → xterm → control.terminalInput → kworker foreground routing →
// nano's stdin (raw) → nano edits + renders ANSI → stdout streams to xterm →
// Ctrl-O writes the file through the real VFS. No mocks. This also exercises the
// foreground-stdin delivery and the tty_set_raw raw/cooked discipline switch.

type W = { __wasmos: { term: { log(): string }; control: { listProcs(): Promise<Array<{ pid: number; name: string }>>; kill(pid: number): Promise<void>; fsWrite(path: string, bytes: Uint8Array): Promise<void> } } };
const win = () => window as unknown as W;

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });
  return errors;
}

const readLog = (page: Page) => page.evaluate(() => (window as unknown as W).__wasmos.term.log());

async function waitReady(page: Page, errors: string[]): Promise<void> {
  try {
    await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
      timeout: 20_000,
    });
  } catch {
    throw new Error("terminal did not reach ready. Browser errors:\n" + (errors.join("\n") || "(none)"));
  }
  await page.waitForFunction(() => (window as unknown as W).__wasmos.term.log().includes("wasmos:"), null, {
    timeout: 10_000,
  });
  await page.locator("#terminal").click();
}

/** Poll the terminal log until `pred` holds (or fail with the log for context). */
async function waitForLog(page: Page, pred: (log: string) => boolean, what: string): Promise<string> {
  let log = "";
  for (let i = 0; i < 60; i++) {
    log = await readLog(page);
    if (pred(log)) return log;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${what}.\nlog tail=${JSON.stringify(log.slice(-300))}`);
}

async function pidByName(page: Page, name: string): Promise<number | undefined> {
  const procs = await page.evaluate(() => (window as unknown as W).__wasmos.control.listProcs());
  const match = procs.filter((p) => p.name === name).sort((a, b) => b.pid - a.pid)[0];
  return match?.pid;
}

test("nano edits a file end-to-end: open, type, Ctrl-O save, Ctrl-X exit, verify with cat", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  // Launch the real editor on a new file. Its raw-mode UI (title + key hints) must
  // paint — proof tty_set_raw took effect and nano's ANSI output reached xterm.
  await page.keyboard.type("nano /tmp/note.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitForLog(page, (l) => l.includes("WASM_OS nano") && l.includes("Write Out"), "nano UI to render");

  // Type a line; it shows because nano echoes via its own screen repaint (raw mode
  // means the terminal does NOT locally echo — the program owns the screen).
  await page.keyboard.type("Hello nano world", { delay: 15 });
  await waitForLog(page, (l) => l.includes("Hello nano world"), "typed text to render");

  // Ctrl-O writes the buffer to the VFS; nano reports the line count.
  await page.keyboard.press("Control+o");
  await waitForLog(page, (l) => /\[ Wrote 1 line \]/.test(l), "save confirmation");

  // Ctrl-X exits back to the shell prompt (raw mode is released; cooked restored).
  await page.keyboard.press("Control+x");
  await waitForLog(page, (l) => l.trimEnd().endsWith("$"), "shell prompt after exit");

  // The file truly persisted: read it back through the shell.
  const before = (await readLog(page)).length;
  await page.keyboard.type("cat /tmp/note.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  const log = await waitForLog(page, (l) => l.slice(before).includes("Hello nano world"), "cat to show saved file");
  expect(log.slice(before)).toContain("Hello nano world");
  expect(errors.join("\n")).not.toMatch(/ring pump|ComponentError|Parsing error/);
});

test("nano opens an existing file, shows its content, and appends + saves it", async ({ page }) => {
  // The load path on a real pre-existing file: read_to_string → split lines →
  // render. Then move to the end, append a second line, save, and read it back —
  // the original content AND the appended line must both persist.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  // Seed a file with content through the real VFS (not via nano).
  await page.evaluate(() =>
    (window as unknown as W).__wasmos.control.fsWrite("/tmp/pre.txt", new TextEncoder().encode("line one\n")),
  );

  await page.keyboard.type("nano /tmp/pre.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  // The existing content is shown AND nano reports it read the line (load worked).
  await waitForLog(page, (l) => l.includes("line one") && /Read 1 line\b/.test(l), "existing file to load");

  // Go to end of the buffer, open a new line, type a second line.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two", { delay: 20 });
  await page.keyboard.press("Control+o");
  await waitForLog(page, (l) => /\[ Wrote 2 lines \]/.test(l), "save confirmation for 2 lines");
  await page.keyboard.press("Control+x");
  await waitForLog(page, (l) => l.trimEnd().endsWith("$"), "shell prompt after exit");

  const before = (await readLog(page)).length;
  await page.keyboard.type("cat /tmp/pre.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  const log = await waitForLog(
    page,
    (l) => l.slice(before).includes("line one") && l.slice(before).includes("line two"),
    "cat to show original + appended lines",
  );
  expect(log.slice(before)).toContain("line one");
  expect(log.slice(before)).toContain("line two");
});

test("Ctrl-X on a modified buffer prompts to save, and 'y' writes the file", async ({ page }) => {
  // The most common real editor interaction: edit, hit Ctrl-X without Ctrl-O, get
  // the "Save modified buffer?" prompt, answer Y → the file is written on exit.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  await page.keyboard.type("nano /tmp/prompt.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitForLog(page, (l) => l.includes("WASM_OS nano"), "nano UI to render");
  await page.keyboard.type("saved via prompt", { delay: 20 });

  // Ctrl-X with unsaved changes → the save prompt appears.
  await page.keyboard.press("Control+x");
  await waitForLog(page, (l) => /Save modified buffer\?/.test(l), "save prompt to appear");

  // Answer Y → save + exit back to the shell.
  await page.keyboard.press("y");
  await waitForLog(page, (l) => l.trimEnd().endsWith("$"), "shell prompt after save+exit");

  const before = (await readLog(page)).length;
  await page.keyboard.type("cat /tmp/prompt.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  const log = await waitForLog(page, (l) => l.slice(before).includes("saved via prompt"), "cat to show prompt-saved content");
  expect(log.slice(before)).toContain("saved via prompt");
});

test("nano arrow keys move the cursor so an edit lands mid-line", async ({ page }) => {
  // Raw mode forwards the arrow keys' ESC sequences to nano (the cooked shell
  // discipline drops them). Typing "abc", moving left twice, then "X" must insert
  // between 'a' and 'b' → "aXbc", proving cursor motion + mid-line insert.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  await page.keyboard.type("nano /tmp/edit.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitForLog(page, (l) => l.includes("WASM_OS nano"), "nano UI to render");

  await page.keyboard.type("abc", { delay: 30 });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X", { delay: 30 });
  await page.keyboard.press("Control+o");
  await waitForLog(page, (l) => /\[ Wrote 1 line \]/.test(l), "save confirmation");
  await page.keyboard.press("Control+x");
  await waitForLog(page, (l) => l.trimEnd().endsWith("$"), "shell prompt after exit");

  const before = (await readLog(page)).length;
  await page.keyboard.type("cat /tmp/edit.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  const log = await waitForLog(page, (l) => l.slice(before).includes("aXbc") || /command not found/.test(l.slice(before)), "cat output");
  expect(log.slice(before)).toContain("aXbc");
});

test("killing nano mid-edit restores the terminal (raw mode never bricks it)", async ({ page }) => {
  // Robustness: a foreground program that dies while holding the terminal in raw
  // mode (no chance to call tty_set_raw(false)) must NOT leave the terminal
  // echo-less and swallowing keys. The kernel pops the foreground job and forces
  // cooked discipline on exit, so the shell beneath it is immediately usable.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  await page.keyboard.type("nano /tmp/brick.txt", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitForLog(page, (l) => l.includes("WASM_OS nano"), "nano UI to render");
  await page.keyboard.type("unsaved edits", { delay: 20 });

  const nanoPid = await pidByName(page, "nano");
  expect(nanoPid).toBeDefined();
  await page.evaluate((pid) => (window as unknown as W).__wasmos.control.kill(pid), nanoPid as number);
  await page.waitForTimeout(500);

  // The terminal is cooked again: a typed command echoes locally AND runs. "echo
  // RECOVERED" → "RECOVERED" appears twice (echoed input + command output).
  const before = (await readLog(page)).length;
  await page.keyboard.type("echo RECOVERED", { delay: 20 });
  await page.keyboard.press("Enter");
  const log = await waitForLog(
    page,
    (l) => (l.slice(before).match(/RECOVERED/g) || []).length >= 2,
    "terminal to recover after killing nano",
  );
  expect((log.slice(before).match(/RECOVERED/g) || []).length).toBeGreaterThanOrEqual(2);
});

test("interactive stdin reaches a foreground program through the terminal (grep)", async ({ page }) => {
  // The foreground-routing half of the in-terminal-editor work, on its own: the
  // terminal delivers keystrokes to the running program (not the shell, which is
  // parked in wait()). `grep` reads a typed line and echoes the match immediately.
  const errors = captureErrors(page);
  await page.goto("/");
  await waitReady(page, errors);

  await page.keyboard.type("grep HELLO", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  const before = (await readLog(page)).length;
  await page.keyboard.type("xxHELLOxx", { delay: 20 });
  await page.keyboard.press("Enter");
  // The matching line appears twice in cooked mode: the terminal's local echo of
  // the typed line, plus grep's own matched-line output.
  const log = await waitForLog(
    page,
    (l) => (l.slice(before).match(/xxHELLOxx/g) || []).length >= 2,
    "grep to echo the matched line",
  );
  expect((log.slice(before).match(/xxHELLOxx/g) || []).length).toBeGreaterThanOrEqual(2);

  // Clean up: kill the still-reading grep so the shell prompt returns.
  const gpid = await pidByName(page, "grep");
  if (gpid) await page.evaluate((pid) => (window as unknown as W).__wasmos.control.kill(pid), gpid);
});
