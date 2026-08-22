import { test, expect, type Page } from "@playwright/test";

// network broker — brokered networking (the Net capability, OQ-2). WASM_OS processes are
// sandboxed and cannot open sockets; the `fetch` coreutil calls the net_request
// syscall, which the kernel gates on the Net capability and the host performs as a
// real fetch (parking the caller until it resolves). The shell delegates Net to
// `fetch` (like it delegates Signal to `kill`). Default-deny is covered by a kernel
// unit test; this exercises the full userland path end to end.

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

test("the fetch coreutil retrieves a URL via the kernel net broker (OQ-2)", async ({ page }) => {
  await ready(page);

  // Redirect fetch's output into the VFS, exercising net_request → host fetch →
  // park/resume → the body returned over the ring → the shell's `>` to a file.
  await page.evaluate(() => {
    const w = (window as unknown as Win).__wasmos;
    void w.control.stdin(w.shellPid, new TextEncoder().encode("fetch /assets/net-fixture.txt > /home/got.txt\n"));
  });

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          try {
            return new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/home/got.txt"));
          } catch {
            return "";
          }
        }),
      { timeout: 10_000 },
    )
    .toBe("NET-BROKER-OK-7");
});
