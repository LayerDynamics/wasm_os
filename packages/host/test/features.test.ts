import { describe, it, expect } from "vitest";
import { detectFeatures } from "../src/features.js";

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
