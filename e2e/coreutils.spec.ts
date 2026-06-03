import { test, expect, type Page } from "@playwright/test";

// M2 coreutils (FR-18): the full set running from the real shell against the
// hierarchical VFS. Input via control.stdin (not locally echoed), so the
// terminal log contains only command OUTPUT + prompts — assertions are
// output-based with unique marker strings.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      fsRead(path: string): Promise<Uint8Array>;
    };
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

test("tail prints the last N lines; env runs with an empty environment", async ({ page }) => {
  await ready(page);
  await run(page, "echo tl-first-AAA > /t2.txt");
  await run(page, "echo tl-second-BBB >> /t2.txt");
  await run(page, "echo tl-third-CCC >> /t2.txt");

  // tail -n 2 prints the last two lines only; the first line is dropped. All
  // lines were written via redirection, so they reach the terminal ONLY as
  // tail's output — the first line never appearing proves tail truncated it.
  await run(page, "tail -n 2 /t2.txt");
  await waitForLog(page, "tl-third-CCC");
  const out = await readLog(page);
  expect(out).toContain("tl-second-BBB");
  expect(out).toContain("tl-third-CCC");
  expect(out).not.toContain("tl-first-AAA");

  // env on WASM_OS prints the (empty) environment and exits 0. Proof it ran to
  // completion and the shell returned: a following marker command's output shows.
  await run(page, "env");
  await run(page, "echo ENV-RAN-7chk");
  await waitForLog(page, "ENV-RAN-7chk");
  expect(await readLog(page)).toContain("ENV-RAN-7chk");
});

test("the pwd binary reflects the working directory via $PWD, not wasi-libc cwd", async ({ page }) => {
  // `/bin/pwd` (the binary, distinct from the shell's `pwd` builtin) must report
  // the process's actual working directory. On wasm32-wasip1 std::env::current_dir
  // reads wasi-libc's cwd (always "/"); the kernel roots every preopen at "/" and
  // carries the real cwd in $PWD (inherited from the shell at spawn), so pwd reads
  // $PWD. We isolate pwd's stdout into a file (away from prompt noise) and read it
  // back to assert the exact bytes.
  await ready(page);
  await run(page, "mkdir /pwd_probe_dir");
  await run(page, "cd /pwd_probe_dir");
  await run(page, "/bin/pwd > /pwd_probe_dir/cwd.txt");
  await page.waitForTimeout(300);
  const bytes = await page.evaluate(() =>
    (window as unknown as Win).__wasmos.control.fsRead("/pwd_probe_dir/cwd.txt"),
  );
  expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe("/pwd_probe_dir\n");
});

test("commands work from a non-root cwd: relative paths and cross-directory access", async ({ page }) => {
  // Regression: a process's preopen used to be rooted at its cwd, so from /home a
  // command could not read /etc or /bin (absolute paths outside cwd) and a bare
  // `ls`/relative path failed ("ls: .: No such file or directory"). The kernel now
  // roots every preopen at "/", and guests chdir to $PWD, so the whole filesystem
  // is reachable AND relative paths resolve against the working directory.
  await ready(page);
  await run(page, "mkdir /work");
  await run(page, "cd /work");
  await run(page, "echo content-XYZ > rel.txt"); // relative file in the cwd

  // (1) a bare `ls` lists the CWD (resolves "." against /work), showing rel.txt.
  await run(page, "ls");
  await waitForLog(page, "rel.txt");
  // (2) a relative path reads back the file written in the cwd.
  await run(page, "cat rel.txt");
  await waitForLog(page, "content-XYZ");
  // (3) an absolute path OUTSIDE the cwd is reachable (was blocked by the old
  // cwd-rooted preopen): /etc/os-release is a real seeded file.
  await run(page, "cat /etc/os-release");
  await waitForLog(page, "WASM_OS");
  const log = await readLog(page);
  expect(log).not.toContain("ls: .: No such file or directory");
  expect(log).not.toContain("rel.txt: No such file or directory");
});
