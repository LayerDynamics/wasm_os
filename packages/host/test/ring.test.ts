/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createRing } from "../src/ring/layout.js";
import { RingServer } from "../src/ring/host.js";

// The process worker blocks on Atomics.wait, which is forbidden on the main
// thread — so the real RingClient must run in a worker_thread. We bundle a tiny
// entry that imports the REAL RingClient (and layout) into a self-contained CJS
// string and run it with { eval: true }. This is a true cross-thread test
// against real SharedArrayBuffer + Atomics — no mocks, no duplicated protocol.
const ringSrcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ring");

let workerCode: string;
beforeAll(async () => {
  const res = await build({
    stdin: {
      contents: `
        const { parentPort, workerData } = require("node:worker_threads");
        import { RingClient } from "./guest.js";
        const client = new RingClient(workerData.sab);
        const out = workerData.requests.map((r) => Array.from(client.call(new Uint8Array(r))));
        parentPort.postMessage(out);
      `,
      resolveDir: ringSrcDir,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });
  const out = res.outputFiles[0];
  if (!out) throw new Error("esbuild produced no output for the ring client worker");
  workerCode = out.text;
});

function runClient(sab: SharedArrayBuffer, requests: number[][]): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerCode, { eval: true, workerData: { sab, requests } });
    w.on("message", (m: number[][]) => {
      resolve(m);
      void w.terminate();
    });
    w.on("error", reject);
  });
}

describe("SAB syscall ring", () => {
  it("round-trips a request cross-thread; the guest blocks until the kernel responds", async () => {
    const sab = createRing();
    const server = new RingServer(sab);
    // Handler reverses the bytes — the reversed result can only exist if the
    // server ran, proving the blocked client genuinely waited for servicing.
    const servePromise = server.serve((req) => Uint8Array.from(req).reverse(), { once: true });

    const [result] = await runClient(sab, [[1, 2, 3, 4, 5]]);
    await servePromise;

    expect(result).toEqual([5, 4, 3, 2, 1]);
  });

  it("re-arms and services multiple sequential requests on one ring", async () => {
    const sab = createRing();
    const server = new RingServer(sab);
    const ac = new AbortController();
    let serviced = 0;
    const servePromise = server.serve(
      (req) => {
        serviced += 1;
        // Transform: append the request's running index so each response is
        // distinct and proves the loop re-armed for each call.
        if (serviced >= 3) ac.abort(); // stop the loop after the 3rd service
        return Uint8Array.from([...req, serviced]);
      },
      { signal: ac.signal },
    );

    const results = await runClient(sab, [[10], [20], [30]]);
    await servePromise;

    expect(serviced).toBe(3);
    expect(results).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
  });

  // The M2 spine: a syscall can PARK — received now, completed later — while the
  // guest stays genuinely blocked in Atomics.wait. This is the deferred-response
  // capability stdin/pipes/wait all depend on.
  it("completes a PARKED request later (deferred fulfilment) across the real ring", async () => {
    const sab = createRing();
    const server = new RingServer(sab);

    // Client issues the request and blocks in Atomics.wait.
    const resultPromise = runClient(sab, [[7, 8, 9]]);

    // Server receives the request but does NOT complete it yet (park).
    const req = await server.nextRequest();
    expect(req).not.toBeNull();
    expect(Array.from(req as Uint8Array)).toEqual([7, 8, 9]);

    // Prove the client is still blocked: it cannot have produced a result while
    // the response doorbell has not been rung. Complete only after a real delay.
    let resolvedEarly = false;
    void resultPromise.then(() => {
      resolvedEarly = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolvedEarly).toBe(false); // still parked in Atomics.wait

    server.complete(Uint8Array.from([42, 43]));
    const [result] = await resultPromise;
    expect(result).toEqual([42, 43]); // the deferred reply reached the guest
  });
});
