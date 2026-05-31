import { boot, type BootResult } from "./boot.js";

/** Boot result plus full cold-load timing measured from navigation start. */
export type ReadyState = BootResult & { coldLoadMillis: number };

declare global {
  interface Window { __wasmos?: ReadyState; }
}

async function main() {
  const result = await boot();
  // performance.now() in the page is measured from the navigation time origin,
  // so this captures the FULL cold load (HTML parse + script + wasm download +
  // kernel init), not just kernel init (which is result.bootMillis).
  const coldLoadMillis = Math.round(performance.now());
  const state: ReadyState = { ...result, coldLoadMillis };
  window.__wasmos = state;
  const el = document.getElementById("status");
  if (el) {
    el.textContent =
      `ready in ${coldLoadMillis}ms (kernel ${result.bootMillis}ms) · tier ${result.features.tier} · opfs=${result.features.opfs}`;
  }
  window.dispatchEvent(new CustomEvent("wasmos:ready", { detail: state }));
}

main().catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  // Re-throw so test harnesses observe the failure.
  throw e;
});
