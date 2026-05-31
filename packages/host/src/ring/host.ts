/**
 * Kernel side of the SAB syscall ring (runs in the kernel worker).
 *
 * The kernel worker must stay responsive to many process rings + the control
 * proxy, so it **never blocks** — it multiplexes with `Atomics.waitAsync`
 * (Chrome + Firefox evergreen; a `postMessage`-wakeup fallback would slot in
 * here for browsers without `waitAsync`, but M1 is single-path).
 *
 * Lock-step protocol: a guest blocks until its response arrives, so at most one
 * request per ring is ever outstanding. `serve()` waits for REQ_SEQ to advance,
 * services exactly that request, bumps RESP_SEQ, and re-arms.
 */
import {
  header,
  reqRegion,
  respRegion,
  REQ_SEQ,
  RESP_SEQ,
  OPLEN,
  RESPLEN,
} from "./layout.js";

/** Handle one request's bytes and return the response bytes. */
export type RequestHandler = (request: Uint8Array) => Uint8Array;

export interface ServeOptions {
  /** Stop after servicing a single request (used in tests). */
  once?: boolean;
  /** Abort the serve loop cooperatively (checked after each service). */
  signal?: AbortSignal;
}

export class RingServer {
  private readonly h: Int32Array;
  private readonly req: Uint8Array;
  private readonly resp: Uint8Array;

  constructor(sab: SharedArrayBuffer) {
    this.h = header(sab);
    this.req = reqRegion(sab);
    this.resp = respRegion(sab);
  }

  /**
   * Service requests on this ring until aborted (or once, in tests). Returns a
   * promise that resolves when the loop stops. Does not block the event loop.
   */
  async serve(onRequest: RequestHandler, opts: ServeOptions = {}): Promise<void> {
    let expected = Atomics.load(this.h, REQ_SEQ);
    for (;;) {
      if (opts.signal?.aborted) return;
      // Wait for the guest to ring the request doorbell.
      const w = Atomics.waitAsync(this.h, REQ_SEQ, expected);
      if (w.async) {
        const res = await w.value;
        if (res === "timed-out") continue; // (no timeout passed; defensive)
      }
      // The doorbell may have been rung purely to wake us for teardown.
      if (opts.signal?.aborted) return;
      // REQ_SEQ has advanced — read and service the staged request.
      expected = Atomics.load(this.h, REQ_SEQ);
      const opLen = Atomics.load(this.h, OPLEN);
      const request = this.req.slice(0, opLen);

      const response = onRequest(request);
      if (response.length > this.resp.length) {
        throw new Error(`syscall response ${response.length}B exceeds ring capacity ${this.resp.length}B`);
      }
      this.resp.set(response);
      Atomics.store(this.h, RESPLEN, response.length);
      // Ring the response doorbell; the blocked guest wakes.
      Atomics.add(this.h, RESP_SEQ, 1);
      Atomics.notify(this.h, RESP_SEQ);

      if (opts.once) return;
    }
  }
}
