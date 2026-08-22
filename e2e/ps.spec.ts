import { test, expect, type Page } from "@playwright/test";

// process-table tools — ps / top (FR-33). The CLI process-table tools run from the real shell
// and read the live table via the proc_list syscall. `ps` lists every process by
// PID; `top` adds a summary header and orders by CPU activity. Assertions are on
// the terminal output (the tools print to stdout, streamed to xterm).

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
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

async function shell(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(c + "\n"));
  }, cmd);
}

async function waitForLog(page: Page, needle: string): Promise<void> {
  await page.waitForFunction((n) => (window as unknown as Win).__wasmos.term.log().includes(n), needle, {
    timeout: 10_000,
  });
}

function log(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
}

test("ps lists the live process table; top summarises it by CPU (FR-33)", async ({ page }) => {
  await ready(page);

  // A distinctively-named long-lived process so the table has a known entry.
  await page.evaluate(async () => {
    const w = (window as unknown as Win).__wasmos;
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    await w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
  });

  await shell(page, "ps");
  await waitForLog(page, "PID");
  const psOut = await log(page);
  // The header + the always-present kernel/shell processes + our spawned one.
  expect(psOut).toContain("PID");
  expect(psOut).toContain("init");
  expect(psOut).toContain("sigdemo");

  await shell(page, "top");
  await waitForLog(page, "top -");
  const topOut = await log(page);
  // top's distinguishing summary header (process count + runnable + total CPU).
  expect(topOut).toMatch(/top - \d+ processes, \d+ runnable, \d+ total CPU ticks/);
  expect(topOut).toContain("sigdemo");
});
