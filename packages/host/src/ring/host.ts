/**
 * Kernel side of the SAB syscall ring (runs in the kernel worker).
 *
 * The kernel worker must stay responsive to many process rings + the control
 * proxy, so it **never blocks** — it multiplexes with `Atomics.waitAsync`
 * (Chrome + Firefox evergreen; a `postMessage`-wakeup fallback would slot in
 * here for browsers without `waitAsync`, but M2 is single-path).
 *
 * M1 used the `serve()` convenience loop (request → immediate response). M2
 * adds **deferred** completion via `nextRequest()` + `complete()`: a syscall
 * may park (no response written now) and be completed later when an event
 * wakes it (stdin, pipe, `wait`). `serve()` is kept as the immediate-response
 * wrapper for callers/tests that never park.
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
  /** Abort the loop cooperatively (checked after each wake). */
  signal?: AbortSignal;
}

export class RingServer {
  private readonly h: Int32Array;
  private readonly req: Uint8Array;
  private readonly resp: Uint8Array;
  /** Last-seen request doorbell value; `nextRequest` waits for it to advance. */
  private expected: number;

  constructor(sab: SharedArrayBuffer) {
    this.h = header(sab);
    this.req = reqRegion(sab);
    this.resp = respRegion(sab);
    this.expected = Atomics.load(this.h, REQ_SEQ);
  }

  /**
   * Wait for the next request and return its bytes WITHOUT completing it. The
   * caller decides whether to `complete()` now or defer (park). Returns `null`
   * if aborted.
   */
  async nextRequest(opts: ServeOptions = {}): Promise<Uint8Array | null> {
    for (;;) {
      if (opts.signal?.aborted) return null;
      const w = Atomics.waitAsync(this.h, REQ_SEQ, this.expected);
      if (w.async) {
        const res = await w.value;
        if (res === "timed-out") continue; // (no timeout passed; defensive)
      }
      if (opts.signal?.aborted) return null; // doorbell may have been a teardown wake
      this.expected = Atomics.load(this.h, REQ_SEQ);
      const opLen = Atomics.load(this.h, OPLEN);
      return this.req.slice(0, opLen);
    }
  }

  /** Write a response and ring the response doorbell — wakes the blocked guest. */
  complete(reply: Uint8Array): void {
    if (reply.length > this.resp.length) {
      throw new Error(`syscall response ${reply.length}B exceeds ring capacity ${this.resp.length}B`);
    }
    this.resp.set(reply);
    Atomics.store(this.h, RESPLEN, reply.length);
    Atomics.add(this.h, RESP_SEQ, 1);
    Atomics.notify(this.h, RESP_SEQ);
  }

  /**
   * Immediate-response convenience loop (M1 semantics): every request is
   * completed synchronously with `onRequest`'s return value. Used by callers
   * and tests that never park.
   */
  async serve(onRequest: RequestHandler, opts: ServeOptions = {}): Promise<void> {
    for (;;) {
      const req = await this.nextRequest(opts);
      if (req === null) return;
      this.complete(onRequest(req));
      if (opts.once) return;
    }
  }
}
