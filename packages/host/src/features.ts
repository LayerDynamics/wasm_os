/** Mirrors the WIT `feature-report` record (wit/control.wit). */
export interface FeatureReport {
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  opfs: boolean;
  jspi: boolean;
  tier: string;
}

export function detectFeatures(): FeatureReport {
  const hasSAB = typeof SharedArrayBuffer !== "undefined";
  const coi = typeof globalThis.crossOriginIsolated === "boolean" ? globalThis.crossOriginIsolated : false;
  const opfs = typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
  // JSPI: WebAssembly.promising indicates JS Promise Integration support.
  const jspi = typeof (WebAssembly as unknown as { promising?: unknown }).promising === "function";
  const tier = hasSAB && coi ? "A" : "B";
  return {
    sharedArrayBuffer: hasSAB,
    crossOriginIsolated: coi,
    opfs,
    jspi,
    tier,
  };
}
