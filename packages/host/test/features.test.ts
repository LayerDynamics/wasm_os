import { describe, it, expect, afterEach } from "vitest";
import { detectFeatures, isCrossOriginIsolated } from "../src/features.js";

describe("detectFeatures", () => {
  it("reports a tier and never throws", () => {
    const f = detectFeatures();
    expect(["A", "B"]).toContain(f.tier);
    expect(typeof f.opfs).toBe("boolean");
    expect(typeof f.jspi).toBe("boolean");
  });

  it("falls back to tier B when not cross-origin isolated", () => {
    const f = detectFeatures();
    if (!f.crossOriginIsolated) expect(f.tier).toBe("B");
  });
});

describe("isCrossOriginIsolated", () => {
  const realCOI = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const realSAB = globalThis.SharedArrayBuffer;
  afterEach(() => {
    if (realCOI) Object.defineProperty(globalThis, "crossOriginIsolated", realCOI);
    (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = realSAB;
  });

  it("is true only when SharedArrayBuffer exists AND the context is isolated", () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
    expect(isCrossOriginIsolated()).toBe(true);
  });

  it("is false when the context is not cross-origin isolated", () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: false, configurable: true });
    expect(isCrossOriginIsolated()).toBe(false);
  });

  it("is false when SharedArrayBuffer is undefined (e.g. an in-app webview)", () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
    delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
    expect(isCrossOriginIsolated()).toBe(false);
  });
});
