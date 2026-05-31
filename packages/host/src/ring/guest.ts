/**
 * Guest side of the SAB syscall ring (runs in a process worker).
 *
 * `call()` is **synchronous and blocks** the process worker via `Atomics.wait`
 * — that is exactly the Tier-A WASI semantic: a guest syscall blocks the guest
 * until the kernel services it. Only a process worker may call this (the main
 * thread is forbidden from `Atomics.wait`).
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

export class RingClient {
  private readonly h: Int32Array;
  private readonly req: Uint8Array;
  private readonly resp: Uint8Array;

  constructor(sab: SharedArrayBuffer) {
    this.h = header(sab);
    this.req = reqRegion(sab);
    this.resp = respRegion(sab);
  }

  /**
   * Send one request and block until the kernel writes the response. Returns a
   * copy of the response bytes.
   */
  call(request: Uint8Array): Uint8Array {
    if (request.length > this.req.length) {
      throw new Error(`syscall request ${request.length}B exceeds ring capacity ${this.req.length}B`);
    }
    // 1. stage the request bytes + length.
    this.req.set(request);
    Atomics.store(this.h, OPLEN, request.length);
    // 2. snapshot the response counter, then ring the request doorbell.
    const respSeen = Atomics.load(this.h, RESP_SEQ);
    Atomics.add(this.h, REQ_SEQ, 1);
    Atomics.notify(this.h, REQ_SEQ);
    // 3. block until the kernel bumps RESP_SEQ past what we saw. If it already
    //    bumped (too-fast kernel), `wait` returns "not-equal" immediately.
    Atomics.wait(this.h, RESP_SEQ, respSeen);
    // 4. read the response.
    const len = Atomics.load(this.h, RESPLEN);
    return this.resp.slice(0, len);
  }
}
