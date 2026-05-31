// Test-only entry: exposes the blockstore classes on `window.__stores` so the
// Playwright OPFS spec can exercise them directly in a real browser (Node has no
// OPFS). This is NOT part of the production bundle (index.ts) — it is built to
// dist/test-harness.js and loaded only by packages/host/test-harness.html.
import { OpfsBlockstore } from "./blockstore/opfs.js";
import { IdbBlockstore } from "./blockstore/idb.js";

(window as unknown as { __stores: unknown }).__stores = { OpfsBlockstore, IdbBlockstore };
window.dispatchEvent(new Event("harness:ready"));
