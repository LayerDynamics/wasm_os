import { test, expect, type Page } from "@playwright/test";

// M-BBS-3 (SPEC-2): a document saved by nano is a real byteblockstorage wasm
// object that survives a tab reload and re-opens to its content. Real stack, no
// mocks: keystrokes → xterm → terminal foreground stdin → nano (raw mode) →
// byteblockstorage::save → kernel VFS → OPFS/IndexedDB → reload → reread + reopen.
// Mirrors e2e/nano.spec.ts (the in-terminal editor) — nano is shell-launchable
// with argv, so the whole flow runs through the real shell, unlike the GUI editor.

type W = {
  __wasmos: {
    flush(): Promise<void>;
    term: { log(): string };
    control: { fsRead(path: string): Promise<Uint8Array> };
  };
};

const readLog = (page: Page) => page.evaluate(() => (window as unknown as W).__wasmos.term.log());

async function waitReady(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => (window as unknown as W).__wasmos.term.log().includes("wasmos:"), null, {
    timeout: 10_000,
  });
  await page.locator("#terminal").click();
}

async function waitForLog(page: Page, pred: (log: string) => boolean, what: string): Promise<string> {
  let log = "";
  for (let i = 0; i < 60; i++) {
    log = await readLog(page);
    if (pred(log)) return log;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${what}.\nlog tail=${JSON.stringify(log.slice(-400))}`);
}

async function readFile(page: Page, path: string): Promise<Uint8Array> {
  const arr = await page.evaluate(
    async (p) => Array.from(await (window as unknown as W).__wasmos.control.fsRead(p)),
    path,
  );
  return Uint8Array.from(arr);
}

/** Latin-1 decode so ASCII content embedded in the wasm bytes is searchable. */
function asLatin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const isWasm = (b: Uint8Array) => Array.from(b.slice(0, 4)).join(",") === "0,97,115,109"; // \0asm

test("a document saved by nano is a wasm object that survives reload and reopens to its content", async ({
  page,
}) => {
  await waitReady(page);

  // 1. New .wasm document → nano renders its raw-mode UI.
  await page.keyboard.type("nano /home/note.wasm", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitForLog(page, (l) => l.includes("WASM_OS nano") && l.includes("Write Out"), "nano UI to render");

  // 2. Type content, Ctrl-O to save (this mints + writes a wasm object), Ctrl-X.
  await page.keyboard.type("PERSIST", { delay: 15 });
  await waitForLog(page, (l) => l.includes("PERSIST"), "typed text to render");
  await page.keyboard.press("Control+o");
  await waitForLog(page, (l) => /\[ Wrote 1 line \]/.test(l), "save confirmation");
  await page.keyboard.press("Control+x");
  await waitForLog(page, (l) => l.trimEnd().endsWith("$"), "shell prompt after exit");

  // 3. The saved file is a real wasm object whose window holds the content.
  await page.evaluate(() => (window as unknown as W).__wasmos.flush());
  const saved = await readFile(page, "/home/note.wasm");
  expect(isWasm(saved)).toBe(true);
  expect(asLatin1(saved)).toContain("PERSIST");

  // 4. Reload the tab — the object must persist byte-for-byte.
  await page.reload();
  await waitReady(page);
  const afterReload = await readFile(page, "/home/note.wasm");
  expect(afterReload).toEqual(saved);

  // 5. Reopen in nano: it must re-read the existing content out of the object
  //    ("Read N line" + the text visible), proving the FR-12 load path.
  await page.keyboard.type("nano /home/note.wasm", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitForLog(page, (l) => l.includes("PERSIST") && /Read 1 line\b/.test(l), "existing object content to load");

  // 6. Append a second line, save (in-place rewrite), exit.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("TWO", { delay: 15 });
  await page.keyboard.press("Control+o");
  await waitForLog(page, (l) => /\[ Wrote 2 lines \]/.test(l), "save confirmation for 2 lines");
  await page.keyboard.press("Control+x");
  await waitForLog(page, (l) => l.trimEnd().endsWith("$"), "shell prompt after second exit");

  // 7. The file is still a wasm object holding both lines.
  await page.evaluate(() => (window as unknown as W).__wasmos.flush());
  const reopened = await readFile(page, "/home/note.wasm");
  expect(isWasm(reopened)).toBe(true);
  const text = asLatin1(reopened);
  expect(text).toContain("PERSIST");
  expect(text).toContain("TWO");
});
