import { test, expect, type Page } from "@playwright/test";

// M1 exit criteria, exercised through the REAL system in a real browser:
// real Web Workers (one kworker + one process worker per process), a real
// SharedArrayBuffer syscall ring, real Atomics blocking, and stock Rust
// wasm32-wasip1 guests. No mocks anywhere on the path.

const GUESTS = "/packages/host/guests";

async function waitForBoot(page: Page, errors: string[]): Promise<void> {
  try {
    await page.waitForFunction(
      () => Boolean((window as unknown as { __wasmos?: unknown }).__wasmos),
      null,
      { timeout: 15_000 },
    );
  } catch {
    throw new Error("kernel did not reach ready. Browser errors:\n" + (errors.join("\n") || "(none)"));
  }
}

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });
  return errors;
}

test("spawns a Rust hello.wasm: writes to stdout via the syscall ring and exits 0", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  const r = await page.evaluate(async (base) => {
    const c = (window as any).__wasmos.control;
    const bytes = await (await fetch(`${base}/hello.wasm`)).arrayBuffer();
    const pid = await c.spawn(bytes, { name: "hello" });
    const exit = await c.wait(pid);
    const [stdout] = await c.takeCapture(pid);
    return {
      pid,
      exitCode: exit.exitCode,
      sharedMemory: exit.sharedMemory,
      stdout: new TextDecoder().decode(new Uint8Array(stdout)),
    };
  }, GUESTS);

  expect(r.pid).toBeGreaterThan(1); // init is pid 1
  expect(r.exitCode).toBe(0); // proc_exit(0) routed through the ring
  expect(r.stdout).toContain("hello from wasm_os"); // fd_write captured by the kernel
  expect(r.sharedMemory).toBe(false); // guest ran in its own non-shared memory
});

test("runs two processes concurrently with isolated, non-shared memory (FR-6)", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  const r = await page.evaluate(async (base) => {
    const c = (window as any).__wasmos.control;
    const bytes = await (await fetch(`${base}/hello.wasm`)).arrayBuffer();
    const [p1, p2] = await Promise.all([
      c.spawn(bytes, { name: "hello-a" }),
      c.spawn(bytes, { name: "hello-b" }),
    ]);
    const [e1, e2] = await Promise.all([c.wait(p1), c.wait(p2)]);
    const [o1] = await c.takeCapture(p1);
    const [o2] = await c.takeCapture(p2);
    const dec = new TextDecoder();
    return {
      p1,
      p2,
      e1,
      e2,
      o1: dec.decode(new Uint8Array(o1)),
      o2: dec.decode(new Uint8Array(o2)),
    };
  }, GUESTS);

  expect(r.p1).not.toBe(r.p2); // distinct PIDs, distinct workers
  expect(r.e1.exitCode).toBe(0);
  expect(r.e2.exitCode).toBe(0);
  // Each guest ran in its OWN non-shared WebAssembly.Memory — there is no shared
  // address space to cross-read (the structural isolation guarantee). The
  // capability-level proof (neither holds Shm) is the kcore unit test
  // `two_spawns_have_isolated_fd_tables_and_no_shm_cap`.
  expect(r.e1.sharedMemory).toBe(false);
  expect(r.e2.sharedMemory).toBe(false);
  expect(r.o1).toContain("hello from wasm_os"); // independent, correct output
  expect(r.o2).toContain("hello from wasm_os");
});

test("contains a trapping guest: the kernel and a peer process survive (FR-34)", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  const r = await page.evaluate(async (base) => {
    const c = (window as any).__wasmos.control;
    const crashBytes = await (await fetch(`${base}/crash.wasm`)).arrayBuffer();
    const helloBytes = await (await fetch(`${base}/hello.wasm`)).arrayBuffer();

    const crashPid = await c.spawn(crashBytes, { name: "crash" });
    const helloPid = await c.spawn(helloBytes, { name: "hello" });
    const crashExit = await c.wait(crashPid);
    const helloExit = await c.wait(helloPid);
    const [helloOut] = await c.takeCapture(helloPid);

    // The kernel/kworker must still be responsive after containing the trap.
    await c.fsWrite("/scratch-after-crash.txt", new TextEncoder().encode("alive"));
    const back = new TextDecoder().decode(new Uint8Array(await c.fsRead("/scratch-after-crash.txt")));

    const procs = await c.listProcs();
    const crashProc = procs.find((p: { pid: number }) => p.pid === crashPid);
    return {
      crashPid,
      crashCode: crashExit.exitCode,
      helloCode: helloExit.exitCode,
      helloOut: new TextDecoder().decode(new Uint8Array(helloOut)),
      crashState: crashProc?.state ?? "(absent)",
      back,
    };
  }, GUESTS);

  expect(r.crashCode).not.toBe(0); // trap → non-zero (contained, not clean exit)
  expect(r.crashState).toBe("zombie"); // crash process zombified in the table
  expect(r.helloCode).toBe(0); // peer process completed normally
  expect(r.helloOut).toContain("hello from wasm_os");
  expect(r.back).toBe("alive"); // kernel survived and still serves syscalls
});

test("a guest reads a host-written file via path_open + fd_read (syscall router → VFS)", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await waitForBoot(page, errors);

  const r = await page.evaluate(async (base) => {
    const c = (window as any).__wasmos.control;
    // Host writes the file through the kernel VFS; the guest reads it back.
    await c.fsWrite("/mnt/in.txt", new TextEncoder().encode("payload-from-host"));
    const bytes = await (await fetch(`${base}/catfile.wasm`)).arrayBuffer();
    const pid = await c.spawn(bytes, { name: "catfile", grantFsSubtree: "/mnt" });
    const exit = await c.wait(pid);
    const [stdout] = await c.takeCapture(pid);
    return { exitCode: exit.exitCode, stdout: new TextDecoder().decode(new Uint8Array(stdout)) };
  }, GUESTS);

  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("payload-from-host"); // path_open → fd_read returned the VFS bytes
});
