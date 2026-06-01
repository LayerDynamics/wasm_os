/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { makeWasiImports } from "../src/worker/wasi-shim.js";
import type { RingClient } from "../src/ring/guest.js";

// `clock_time_get` and `random_get` are serviced entirely host-side in the WASI
// shim now (real `performance` time + `crypto` entropy), NOT routed to the
// deterministic kernel. These tests prove they are REAL — time advances and
// entropy varies — rather than the old frozen constant / length-seeded LCG.

interface ClockRandom {
  clock_time_get(clockId: number, precision: bigint, timePtr: number): number;
  random_get(buf: number, bufLen: number): number;
}

function setup() {
  const memory = new WebAssembly.Memory({ initial: 4 }); // 256 KiB
  // The ring must NOT be touched by clock/random — a throwing stub proves it.
  const ring = {
    call() {
      throw new Error("clock_time_get / random_get must be host-local, not routed to the ring");
    },
  } as unknown as RingClient;
  const wasi = makeWasiImports(() => memory, ring) as unknown as ClockRandom;
  const dv = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  return { memory, wasi, dv, u8 };
}

const SUCCESS = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("wasi-shim clock + entropy (host-sourced, real)", () => {
  it("clock_time_get(REALTIME) returns a real epoch time that advances", async () => {
    const { wasi, dv } = setup();
    expect(wasi.clock_time_get(0, 0n, 0)).toBe(SUCCESS);
    const t1 = dv().getBigUint64(0, true);
    // Real ns since the Unix epoch: after 2020-01-01, before 2100-01-01.
    expect(t1).toBeGreaterThan(1_577_836_800_000_000_000n);
    expect(t1).toBeLessThan(4_102_444_800_000_000_000n);
    await sleep(5);
    wasi.clock_time_get(0, 0n, 0);
    const t2 = dv().getBigUint64(0, true);
    expect(t2).toBeGreaterThan(t1); // not a frozen constant
  });

  it("clock_time_get(MONOTONIC) is non-decreasing across calls", async () => {
    const { wasi, dv } = setup();
    wasi.clock_time_get(1, 0n, 0);
    const a = dv().getBigUint64(0, true);
    await sleep(5);
    wasi.clock_time_get(1, 0n, 0);
    const b = dv().getBigUint64(0, true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("random_get fills the buffer with entropy that varies between calls", () => {
    const { wasi, u8 } = setup();
    const n = 32;
    wasi.random_get(0, n);
    const a = Uint8Array.from(u8().subarray(0, n));
    wasi.random_get(0, n);
    const b = Uint8Array.from(u8().subarray(0, n));
    // A frozen/length-seeded stub would produce identical draws; real entropy differs.
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
    expect(a.some((x) => x !== 0)).toBe(true);
  });

  it("random_get fills a request larger than the 65536-byte crypto chunk", () => {
    const { wasi, u8 } = setup();
    const n = 70_000; // > one getRandomValues chunk → exercises the chunk loop
    expect(wasi.random_get(0, n)).toBe(SUCCESS);
    // The tail (past the first 65536-byte chunk) must be filled too, not left zero.
    const tail = u8().subarray(65_536, n);
    expect(tail.some((x) => x !== 0)).toBe(true);
  });
});
