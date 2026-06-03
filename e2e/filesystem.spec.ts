import { test, expect, type Page } from "@playwright/test";

// Filesystem hierarchy (FHS). The VFS mounts a real Unix-like tree across storage
// tiers: system dirs (/etc, /var, /opt, …) persist to the sys OPFS store, /home to
// OPFS, /mnt to IndexedDB, and /tmp + /run are ephemeral tmpfs. This verifies the
// hierarchy is present and that persistence behaves per-tier across a reload.

type Win = {
  __wasmos: {
    control: { fsWrite(p: string, b: Uint8Array): Promise<void>; fsRead(p: string): Promise<Uint8Array>; fsList(p: string): Promise<string[]> };
    flush(): Promise<void>;
  };
};

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: { control?: unknown } }).__wasmos?.control), null, {
    timeout: 20_000,
  });
}

test("the FHS is present and persistence is per-tier across a reload", async ({ page }) => {
  await page.goto("/");
  await ready(page);

  // The standard hierarchy is mounted at root.
  const root = await page.evaluate(() => (window as unknown as Win).__wasmos.control.fsList("/"));
  for (const d of ["/bin", "/etc", "/usr", "/var", "/tmp", "/opt", "/srv", "/home", "/mnt", "/root", "/Volumes", "/proc", "/dev"].filter(
    (x) => !["/proc", "/dev"].includes(x), // /proc and /dev arrive in later phases
  )) {
    expect(root, `/ should contain ${d}`).toContain(d);
  }
  // Nested dirs exist too.
  expect(await page.evaluate(() => (window as unknown as Win).__wasmos.control.fsList("/usr"))).toContain("/usr/bin");
  expect(await page.evaluate(() => (window as unknown as Win).__wasmos.control.fsList("/var"))).toContain("/var/log");

  // Write to persistent (sys: /etc, /opt) and ephemeral (tmpfs: /tmp) tiers, flush,
  // then reload the same context (OPFS/IndexedDB survive a reload; tmpfs does not).
  await page.evaluate(async () => {
    const c = (window as unknown as Win).__wasmos.control;
    await c.fsWrite("/etc/persist-test", new TextEncoder().encode("ETC-OK"));
    await c.fsWrite("/opt/persist-test", new TextEncoder().encode("OPT-OK"));
    await c.fsWrite("/tmp/ephemeral-test", new TextEncoder().encode("TMP-GONE"));
    await (window as unknown as Win).__wasmos.flush();
  });
  await page.reload();
  await ready(page);

  const after = await page.evaluate(async () => {
    const c = (window as unknown as Win).__wasmos.control;
    const dec = new TextDecoder();
    const read = async (p: string) => {
      try {
        return dec.decode(await c.fsRead(p));
      } catch {
        return null;
      }
    };
    return { etc: await read("/etc/persist-test"), opt: await read("/opt/persist-test"), tmp: await read("/tmp/ephemeral-test") };
  });
  expect(after.etc).toBe("ETC-OK"); // sys store persisted across reload
  expect(after.opt).toBe("OPT-OK"); // sys store persisted across reload
  expect(after.tmp).toBeNull(); // tmpfs is ephemeral — gone after reload
});

test("/etc is real, consumed config: motd banner, os-release, and PATH spanning /usr/bin", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => Boolean((window as unknown as { __wasmos?: { term?: { log(): string } } }).__wasmos?.term?.log().includes("wasmos:")),
    null,
    { timeout: 20_000 },
  );
  const readLog = () => page.evaluate(() => (window as unknown as { __wasmos: { term: { log(): string } } }).__wasmos.term.log());

  // The shell printed /etc/motd as its login banner.
  expect(await readLog()).toContain("Welcome to WASM_OS");

  // /etc/os-release is real, readable config.
  const osr = await page.evaluate(async () =>
    new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/etc/os-release")),
  );
  expect(osr).toContain("ID=wasmos");

  // Binaries are in /usr/bin and a bare command resolves through PATH (sourced from
  // /etc/profile). `ls /usr/bin` runs `ls` (found via PATH) and lists the coreutils.
  await page.locator("#terminal").click();
  await page.keyboard.type("ls /usr/bin", { delay: 20 });
  await page.keyboard.press("Enter");
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/\/usr\/bin\/editor\b/.test(log) || /\beditor\b/.test(log.split("ls /usr/bin")[1] ?? "")) break;
    await page.waitForTimeout(150);
  }
  expect(log).toContain("editor"); // /usr/bin is populated and `ls` resolved via PATH
});
