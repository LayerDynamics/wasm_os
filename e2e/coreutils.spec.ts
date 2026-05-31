import { test, expect, type Page } from "@playwright/test";

// M2 coreutils (FR-18): the full set running from the real shell against the
// hierarchical VFS. Input via control.stdin (not locally echoed), so the
// terminal log contains only command OUTPUT + prompts — assertions are
// output-based with unique marker strings.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: { stdin(pid: number, bytes: Uint8Array): Promise<void> };
  };
};

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos), null, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => (window as unknown as Win).__wasmos.term.log().includes("wasmos:"), null, {
    timeout: 10_000,
  });
}

async function run(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(c + "\n"));
  }, cmd);
  await page.waitForTimeout(180);
}

function readLog(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
}

async function waitForLog(page: Page, needle: string): Promise<void> {
  await page.waitForFunction((n) => (window as unknown as Win).__wasmos.term.log().includes(n), needle, {
    timeout: 10_000,
  });
}

test("mkdir + ls show a real directory tree", async ({ page }) => {
  await ready(page);
  await run(page, "mkdir /proj");
  await run(page, "ls /");
  await waitForLog(page, "proj");
  expect(await readLog(page)).toContain("proj");
});

test("cp / mv / rm manipulate files in the VFS", async ({ page }) => {
  await ready(page);
  await run(page, "mkdir /work");
  await run(page, "echo COPYSRC-111 > /work/a.txt");
  // cp: the copy has the original content.
  await run(page, "cp /work/a.txt /work/b.txt");
  await run(page, "cat /work/b.txt");
  await waitForLog(page, "COPYSRC-111");

  // mv: a.txt → moved.txt keeps the content; cat moved.txt prints it.
  await run(page, "mv /work/a.txt /work/moved.txt");
  await run(page, "cat /work/moved.txt");
  await page.waitForTimeout(300);
  expect((await readLog(page)).match(/COPYSRC-111/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

  // rm: b.txt is removed; cat then errors with a "No such file" message.
  await run(page, "rm /work/b.txt");
  await run(page, "cat /work/b.txt");
  await waitForLog(page, "/work/b.txt: No such file");
  expect(await readLog(page)).toContain("/work/b.txt: No such file");
});

test("wc and head process file content", async ({ page }) => {
  await ready(page);
  await run(page, "echo line-one > /f.txt");
  await run(page, "echo line-two >> /f.txt");
  await run(page, "echo line-three >> /f.txt");

  // head -n 2: prints the first two lines only. The 3rd line was written to the
  // file via redirection, so it never reached the terminal at all.
  await run(page, "head -n 2 /f.txt");
  await waitForLog(page, "line-two");
  const out = await readLog(page);
  expect(out).toContain("line-one");
  expect(out).toContain("line-two");
  expect(out).not.toContain("line-three");

  // wc counts 3 lines (its output line is `<lines> <words> <bytes> /f.txt`).
  await run(page, "wc /f.txt");
  await waitForLog(page, "/f.txt");
  expect(await readLog(page)).toMatch(/\s+3\s+\d+\s+\d+\s+\/f\.txt/);
});
