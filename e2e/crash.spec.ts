import { test, expect, type Page } from "@playwright/test";

// FR-34 — crash containment. A guest that traps (wasm `unreachable` via
// std::process::abort) must NOT take down the shell, the terminal, or the
// kworker. The proof is not "an error was printed" — it is that the shell
// PROCESSES THE NEXT COMMAND. So every case runs a crash, then a follow-up
// `echo <marker>` and asserts the marker reaches the terminal: that output can
// only appear if the prompt returned and the shell is still live.
//
// Input is delivered via control.stdin (keystroke path is terminal.spec.ts), so
// the log holds only command output + prompts — assertions key off markers.

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
  await page.waitForFunction(() => (window as unknown as Win).__wasmos.term.log().includes("wasmos:"), null, {
    timeout: 10_000,
  });
}

async function run(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(c + "\n"));
  }, cmd);
}

function readLog(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
}

async function waitForLog(page: Page, needle: string): Promise<void> {
  await page.waitForFunction((n) => (window as unknown as Win).__wasmos.term.log().includes(n), needle, {
    timeout: 10_000,
  });
}

/** Run `cmd`, then prove the shell is still alive by echoing a unique marker. */
async function survives(page: Page, cmd: string, marker: string): Promise<void> {
  await run(page, cmd);
  await page.waitForTimeout(200);
  await run(page, `echo ${marker}`);
  await waitForLog(page, marker); // only appears if the prompt returned
}

test("a normal pipeline returns the prompt (clean termination)", async ({ page }) => {
  // Baseline for FR-34: even without a crash, the last stage must reach EOF and
  // exit so the shell unblocks. (Before pipe ends were released on process exit,
  // the last stage parked forever and this follow-up never ran.)
  await ready(page);
  await page.evaluate(() =>
    (window as unknown as Win).__wasmos.control.fsWrite(
      "/p.txt",
      new TextEncoder().encode("alpha\nerror: boom\nbeta\n"),
    ),
  );
  await survives(page, "cat /p.txt | grep error", "AFTER-PIPELINE-9001");
  const out = await readLog(page);
  expect(out).toContain("error: boom");
  expect(out).toContain("AFTER-PIPELINE-9001");
});

test("a standalone crash is contained — shell survives", async ({ page }) => {
  await ready(page);
  await survives(page, "crash", "AFTER-CRASH-7777");
  const out = await readLog(page);
  // The shell names the aborted program (trap surfaces as exit code 134).
  expect(out).toContain("crash");
  expect(out).toContain("AFTER-CRASH-7777");
});

test("a crash at the HEAD of a pipeline is contained (crash | wc)", async ({ page }) => {
  // `crash` writes nothing then traps; its closed write end gives `wc` EOF, so wc
  // exits cleanly and the shell returns. The crash must not wedge the pipeline.
  await ready(page);
  await survives(page, "crash | wc", "AFTER-HEAD-CRASH-5150");
  expect(await readLog(page)).toContain("AFTER-HEAD-CRASH-5150");
});

test("a crash at the TAIL of a pipeline is contained (cat | crash)", async ({ page }) => {
  // `cat` feeds a pipe whose reader (`crash`) traps; cat's writes hit a reader-less
  // pipe (EPIPE) and it exits. Neither stage wedges; the shell returns.
  await ready(page);
  await page.evaluate(() =>
    (window as unknown as Win).__wasmos.control.fsWrite("/big.txt", new TextEncoder().encode("x\n".repeat(200))),
  );
  await survives(page, "cat /big.txt | crash", "AFTER-TAIL-CRASH-3141");
  expect(await readLog(page)).toContain("AFTER-TAIL-CRASH-3141");
});
