// Plain (non-React) entry point: boot WASM_OS into the static index.html's
// #desktop / #taskbar / #status. The React client (apps/web) imports `startDesktop`
// from ./index.ts directly instead of using this file, so the reusable boot logic
// has no import-time side effects.
import { startDesktop } from "./index.js";

// The Welcome guide auto-opens only for the real React client; the harness keeps
// it off for determinism. `?welcomeOnLoad=1` re-enables it so the E2E suite can
// exercise the real open-until-dismissed flow against this same boot path.
const welcomeOnLoad = new URLSearchParams(location.search).get("welcomeOnLoad") === "1";

startDesktop({ welcomeOnLoad }).catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  throw e;
});
