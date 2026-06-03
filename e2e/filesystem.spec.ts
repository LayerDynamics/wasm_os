import { test, expect, type Page } from "@playwright/test";

// Filesystem hierarchy (FHS). The VFS mounts a real Unix-like tree across storage
// tiers: system dirs (/etc, /var, /opt, …) persist to the sys OPFS store, /home to
// OPFS, /mnt to IndexedDB, and /tmp + /run are ephemeral tmpfs. This verifies the
// hierarchy is present and that persistence behaves per-tier across a reload.

type Win = {
  __wasmos: {
    control: { fsWrite(p: string, b: Uint8Array): Promise<void>; fsRead(p: string): Promise<Uint8Array>; fsList(p: string): Promise<string[]> };
    flush(): Promise<void>;
    shellPid: number;
    session: { launch(n: string): Promise<number | undefined> };
    term: { log(): string };
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

test("/proc is a live, real view of the process table (host + guest)", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: { control?: unknown } }).__wasmos?.control), null, {
    timeout: 20_000,
  });

  // /proc lists the live PIDs + global files.
  const proc = await page.evaluate(() => (window as unknown as Win).__wasmos.control.fsList("/proc"));
  expect(proc).toContain("/proc/mounts");
  expect(proc.some((p) => /\/proc\/\d+$/.test(p))).toBe(true); // at least one real pid

  // The shell's PID has a status generated from the real process entry.
  const shellPid = await page.evaluate(() => (window as unknown as Win).__wasmos.shellPid);
  const status = await page.evaluate(
    async (pid) => new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead(`/proc/${pid}/status`)),
    shellPid,
  );
  expect(status).toContain("Name:");
  expect(status).toContain(`Pid:\t${shellPid}`);

  // /proc/mounts reflects the real mount table.
  const mounts = await page.evaluate(async () =>
    new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/proc/mounts")),
  );
  expect(mounts).toContain("/home");
  expect(mounts).toContain("/etc");

  // Launching an app adds its PID to /proc (live, not a static snapshot).
  await page.evaluate(() => (window as unknown as Win).__wasmos.session.launch("editor"));
  await page.waitForTimeout(1500);
  const proc2 = await page.evaluate(() => (window as unknown as Win).__wasmos.control.fsList("/proc"));
  expect(proc2.length).toBeGreaterThan(proc.length);

  // And it's readable from INSIDE the OS: `cat /proc/mounts` runs as a guest (the
  // path goes through path_open + fd_read → procfs), printing the mount table.
  const readLog = () => page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
  await page.locator("#terminal").click();
  await page.keyboard.type("cat /proc/mounts", { delay: 20 });
  await page.keyboard.press("Enter");
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/opfs \/home/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toMatch(/opfs \/home/); // guest read of synthetic /proc worked

  // /proc is read-only: a write is rejected and does not shadow the generated file.
  const before = await page.evaluate(async () =>
    new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/proc/version")),
  );
  await page.keyboard.type("echo HACK > /proc/version", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const after = await page.evaluate(async () =>
    new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/proc/version")),
  );
  expect(after).toBe(before); // unchanged — the write was denied, not stored
  expect(after).not.toContain("HACK");
});

test("/dev exposes real device nodes with correct read/write semantics", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __wasmos?: { control?: unknown } }).__wasmos?.control), null, {
    timeout: 20_000,
  });

  // /dev lists the device nodes.
  const dev = await page.evaluate(() => (window as unknown as Win).__wasmos.control.fsList("/dev"));
  for (const n of ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty"]) {
    expect(dev).toContain(n);
  }

  // Read semantics (bounded host sample): null = EOF, zero = zeros, urandom = real
  // host-seeded entropy (not all zero).
  const read = (p: string) =>
    page.evaluate(async (path) => Array.from(await (window as unknown as Win).__wasmos.control.fsRead(path)), p);
  expect((await read("/dev/null")).length).toBe(0);
  expect((await read("/dev/zero")).every((b) => b === 0)).toBe(true);
  const rnd = await read("/dev/urandom");
  expect(rnd.length).toBe(64);
  expect(rnd.some((b) => b !== 0)).toBe(true); // seeded with real entropy

  // From inside the OS: `echo hi > /dev/null` is discarded and the shell keeps going.
  const readLog = () => page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
  await page.locator("#terminal").click();
  await page.keyboard.type("ls /dev", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("echo hi > /dev/null", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("echo AFTERNULL", { delay: 15 });
  await page.keyboard.press("Enter");
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/\nAFTERNULL/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toContain("urandom"); // `ls /dev` listed the nodes (guest readdir)
  expect(log).toMatch(/\nAFTERNULL/); // the /dev/null write didn't hang or error
});

test("/var/log has a real boot log and `mount` reads /proc/mounts", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => Boolean((window as unknown as { __wasmos?: { term?: { log(): string } } }).__wasmos?.term?.log().includes("wasmos:")),
    null,
    { timeout: 20_000 },
  );

  // /var/log/boot.log records this boot's real facts.
  const boot = await page.evaluate(async () =>
    new TextDecoder().decode(await (window as unknown as Win).__wasmos.control.fsRead("/var/log/boot.log")),
  );
  expect(boot).toContain("WASM_OS boot");
  expect(boot).toMatch(/shell pid: \d+/);

  // The `mount` admin tool (in /sbin) prints the real mount table from /proc/mounts.
  const readLog = () => page.evaluate(() => (window as unknown as Win).__wasmos.term.log());
  await page.locator("#terminal").click();
  await page.keyboard.type("mount", { delay: 20 });
  await page.keyboard.press("Enter");
  let log = "";
  for (let i = 0; i < 40; i++) {
    log = await readLog();
    if (/opfs on \/home type opfs/.test(log)) break;
    await page.waitForTimeout(150);
  }
  expect(log).toMatch(/opfs on \/home type opfs/);
});
