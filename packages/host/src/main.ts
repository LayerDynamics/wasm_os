// Plain (non-React) entry point: boot WASM_OS into the static index.html's
// #desktop / #taskbar / #status. The React client (apps/web) imports `startDesktop`
// from ./index.ts directly instead of using this file, so the reusable boot logic
// has no import-time side effects.
import { startDesktop } from "./index.js";

startDesktop().catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  throw e;
});
