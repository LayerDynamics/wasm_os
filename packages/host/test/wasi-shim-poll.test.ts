/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { makeWasiImports } from "../src/worker/wasi-shim.js";
import type { RingClient } from "../src/ring/guest.js";
import { OP } from "../src/ring/protocol.js";

// `poll_oneoff` is a REAL implementation now (it replaced a 0-events stub): clock
// subscriptions sleep host-side via Atomics.wait, and fd subscriptions ask the
// kernel for readiness over the ring. These tests prove both paths.

interface Poll {
  poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): number;
}

const SUCCESS = 0;

function writeClockSub(view: DataView, base: number, userdata: bigint, clockId: number, timeoutNs: bigint) {
  view.setBigUint64(base + 0, userdata, true);
  view.setUint8(base + 8, 0); // subscription tag: CLOCK
  view.setUint32(base + 16, clockId, true);
  view.setBigUint64(base + 24, timeoutNs, true); // relative timeout
  view.setUint16(base + 40, 0, true); // flags: relative (no ABSTIME)
}

describe("wasi-shim poll_oneoff (real)", () => {
  it("sleeps for a relative clock subscription and reports the timer event", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const ring = {
      call() {
        throw new Error("a clock-only poll must not touch the ring");
      },
    } as unknown as RingClient;
    const wasi = makeWasiImports(() => memory, ring) as unknown as Poll;
    const view = new DataView(memory.buffer);
    const inPtr = 0;
    const outPtr = 256;
    const nePtr = 512;
    writeClockSub(view, inPtr, 7n, 1 /* MONOTONIC */, 15_000_000n /* 15 ms */);

    const t0 = performance.now();
    const rc = wasi.poll_oneoff(inPtr, outPtr, 1, nePtr);
    const elapsed = performance.now() - t0;

    expect(rc).toBe(SUCCESS);
    const v = new DataView(memory.buffer);
    expect(v.getUint32(nePtr, true)).toBe(1); // one event
    expect(v.getBigUint64(outPtr + 0, true)).toBe(7n); // userdata echoed back
    expect(v.getUint16(outPtr + 8, true)).toBe(0); // no error
    expect(v.getUint8(outPtr + 10)).toBe(0); // EVENTTYPE_CLOCK
    expect(elapsed).toBeGreaterThanOrEqual(10); // actually waited (~15 ms), not a stub
  });

  it("reports a watched fd as ready using the kernel readiness query", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    // Mock the ring: any FD_READY request → ready=true, nbytes=42.
    const ring = {
      call(req: Uint8Array): Uint8Array {
        expect(req[0]).toBe(OP.FD_READY);
        const out: number[] = [0, 0, 1]; // errno=0 (u16), ready=1 (u8)
        const n = 42n;
        for (let i = 0; i < 8; i++) out.push(Number((n >> BigInt(i * 8)) & 0xffn));
        return Uint8Array.from(out);
      },
    } as unknown as RingClient;
    const wasi = makeWasiImports(() => memory, ring) as unknown as Poll;
    const view = new DataView(memory.buffer);
    const inPtr = 0;
    const outPtr = 256;
    const nePtr = 512;
    // One fd_read subscription on fd 5.
    view.setBigUint64(inPtr + 0, 99n, true); // userdata
    view.setUint8(inPtr + 8, 1); // subscription tag: FD_READ
    view.setUint32(inPtr + 16, 5, true); // fd

    const rc = wasi.poll_oneoff(inPtr, outPtr, 1, nePtr);

    expect(rc).toBe(SUCCESS);
    const v = new DataView(memory.buffer);
    expect(v.getUint32(nePtr, true)).toBe(1);
    expect(v.getBigUint64(outPtr + 0, true)).toBe(99n); // userdata
    expect(v.getUint8(outPtr + 10)).toBe(1); // EVENTTYPE_FD_READ
    expect(v.getBigUint64(outPtr + 16, true)).toBe(42n); // bytes available
  });

  it("returns zero events for an empty subscription set", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const ring = { call() { throw new Error("no ring use"); } } as unknown as RingClient;
    const wasi = makeWasiImports(() => memory, ring) as unknown as Poll;
    const nePtr = 64;
    expect(wasi.poll_oneoff(0, 128, 0, nePtr)).toBe(SUCCESS);
    expect(new DataView(memory.buffer).getUint32(nePtr, true)).toBe(0);
  });
});
