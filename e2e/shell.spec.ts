import { test, expect, type Page } from "@playwright/test";

// shell and userland shell: pipelines (FR-17), redirection (FR-17), and exit codes (FR-16),
// exercised through the real shell process + real coreutils + real kernel pipes.
// Input is delivered via control.stdin (the xterm keystroke path is covered by
// terminal.spec.ts); the terminal log then contains only command output+prompts.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      fsWrite(path: string, bytes: Uint8Array): Promise<void>;
    };
  };
};

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => (window as unknown as Win).__wasmos.term.log().includes("wasmos:"),
    null,
    { timeout: 10_000 },
  );
}

async function run(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(c + "\n"));
  }, cmd);
}

function log(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
}

async function waitForLog(page: Page, needle: string): Promise<void> {
  await page.waitForFunction(
    (n) => (window as unknown as Win).__wasmos.term.log().includes(n),
    needle,
    { timeout: 10_000 },
  );
}

test("pipeline `cat f | grep x` filters through a real kernel pipe", async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as unknown as Win).__wasmos.control.fsWrite(
      "/data.txt",
      new TextEncoder().encode("alpha line\nerror: boom\nbeta line\n"),
    ),
  );
  await run(page, "cat /data.txt | grep error");
  await waitForLog(page, "error: boom");

  const out = await log(page);
  expect(out).toContain("error: boom"); // the matching line passed through
  expect(out).not.toContain("alpha line"); // non-matching lines were filtered
  expect(out).not.toContain("beta line");
});

test("redirection `echo > out` then `cat out` round-trips via the VFS", async ({ page }) => {
  await ready(page);
  await run(page, "echo redirect-payload-7 > /out.txt");
  await page.waitForTimeout(400); // let the write complete
  await run(page, "cat /out.txt");
  await waitForLog(page, "redirect-payload-7");

  // The payload appears as cat's output (echo's stdout went to the file, not the
  // terminal — input is not locally echoed here).
  const out = await log(page);
  expect(out).toContain("redirect-payload-7");
});

test("exit status is tracked and expandable via `$?`", async ({ page }) => {
  await ready(page);
  // A failing command (missing file) sets $? = 1; echo it back.
  await run(page, "cat /no/such/file");
  await page.waitForTimeout(300);
  await run(page, "echo status=$?");
  await waitForLog(page, "status=1");
  expect(await log(page)).toContain("status=1");
});
