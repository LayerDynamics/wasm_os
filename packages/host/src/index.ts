import { boot, type BootResult } from "./boot.js";

declare global {
  interface Window { __wasmos?: BootResult; }
}

async function main() {
  const result = await boot();
  window.__wasmos = result;
  const el = document.getElementById("status");
  if (el) {
    el.textContent = `ready in ${result.bootMillis}ms · tier ${result.features.tier} · opfs=${result.features.opfs}`;
  }
  window.dispatchEvent(new CustomEvent("wasmos:ready", { detail: result }));
}

main().catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  // Re-throw so test harnesses observe the failure.
  throw e;
});
