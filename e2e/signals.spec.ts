import { test, expect, type Page } from "@playwright/test";

// M4-T5 — signals (FR-8/FR-34). Exercises the full userland signal path through
// the real shell: the `kill` builtin and the `/bin/kill` coreutil send SIGTERM
// (catchable — the target's sig_wait observes it and shuts down gracefully) and
// SIGKILL (uncatchable — the kernel forcefully reaps the worker). The sigdemo
// fixture writes a marker file only when it *handles* SIGTERM, so the file's
// presence (TERM) vs absence (KILL) proves the catchable/uncatchable distinction.

type Win = {
  __wasmos: {
    shellPid: number;
    term: { log(): string };
    control: {
      stdin(pid: number, bytes: Uint8Array): Promise<void>;
      spawn(b: ArrayBuffer, o?: { name?: string; grantFsSubtree?: string }): Promise<number>;
      fsRead(path: string): Promise<Uint8Array>;
      fsDelete(path: string): Promise<void>;
      listProcs(): Promise<Array<{ pid: number; name: string; state: string }>>;
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

async function spawnSigdemo(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const w = (window as unknown as Win).__wasmos;
    const bytes = await (await fetch("/packages/host/guests/sigdemo.wasm")).arrayBuffer();
    return w.control.spawn(bytes, { name: "sigdemo", grantFsSubtree: "/" });
  });
}

async function shell(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode(c + "\n"));
  }, cmd);
}

function readSigOut(page: Page): Promise<string> {
  return page.evaluate(async () => {
    try {
      return new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/sig-out.txt"));
    } catch {
      return "";
    }
  });
}

function procState(page: Page, pid: number): Promise<string> {
  return page.evaluate(async (p) => {
    const procs = await (window as unknown as Win).__wasmos.control.listProcs();
    return procs.find((x) => x.pid === p)?.state ?? "gone";
  }, pid);
}

test("kill builtin delivers a catchable SIGTERM the process handles gracefully", async ({ page }) => {
  await ready(page);
  const pid = await spawnSigdemo(page);
  expect(pid).toBeGreaterThan(0);

  // Default signal is SIGTERM; the shell's `kill` builtin uses its Signal cap.
  await shell(page, `kill ${pid}`);

  // sigdemo's sig_wait observed SIGTERM and wrote the marker before exiting.
  await expect.poll(() => readSigOut(page), { timeout: 20_000 }).toBe("TERMINATED-GRACEFULLY");
  await expect.poll(() => procState(page, pid), { timeout: 20_000 }).toMatch(/zombie|gone/);
});

test("kill -9 forcefully reaps a process — uncatchable, no graceful handler runs", async ({ page }) => {
  await ready(page);
  const pid = await spawnSigdemo(page);
  expect(pid).toBeGreaterThan(0);
  // It is alive and parked in sig_wait.
  await expect.poll(() => procState(page, pid), { timeout: 5_000 }).toMatch(/ready|running|blocked|new/);

  await shell(page, `kill -9 ${pid}`);

  // The kernel reaped it (zombie/gone) and — because SIGKILL is uncatchable —
  // the graceful handler never ran, so no marker file was written.
  await expect.poll(() => procState(page, pid), { timeout: 20_000 }).toMatch(/zombie|gone/);
  expect(await readSigOut(page)).toBe("");
});

test("/bin/kill coreutil (full path, not the builtin) signals via delegated Signal cap", async ({ page }) => {
  await ready(page);
  const pid = await spawnSigdemo(page);
  expect(pid).toBeGreaterThan(0);

  // Invoking by full path bypasses the builtin and runs the coreutil, which the
  // shell spawns with a delegated Signal capability (mirrors Gpu/Input delegation).
  await shell(page, `/bin/kill -TERM ${pid}`);

  await expect.poll(() => readSigOut(page), { timeout: 20_000 }).toBe("TERMINATED-GRACEFULLY");
});
