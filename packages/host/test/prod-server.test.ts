// Regression coverage for tools/prod-server.mjs — the server actually shipped to
// production (Railway). The Playwright E2E boots tools/serve.mjs against the dev
// harness layout, so the prod server's cross-origin-isolation headers, HTTP Range,
// ETag/304 revalidation, and path-traversal guard were previously untested. Getting
// the COOP/COEP headers wrong silently breaks SharedArrayBuffer and the entire OS,
// so they are asserted here against the real server process.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER = join(ROOT, "tools", "prod-server.mjs");
const PORT = 8137; // unlikely to collide with the dev/E2E server (8080)
const BASE = `http://127.0.0.1:${PORT}`;
// A repo-root file always present (served via the "/wit/" asset prefix), so the
// test needs no prior build of apps/web/dist.
const STABLE_PATH = "/wit/control.wit";

let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn("node", [SERVER], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  // Wait for the server to accept connections via its liveness probe.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("prod-server did not start in time");
    await new Promise((res) => setTimeout(res, 100));
  }
});

afterAll(() => {
  proc?.kill();
});

function assertIsolationHeaders(r: Response): void {
  expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(r.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
}

describe("prod-server.mjs", () => {
  it("serves /healthz for the platform healthcheck", async () => {
    const r = await fetch(`${BASE}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("carries COOP/COEP/CORP on a served asset (SharedArrayBuffer requirement)", async () => {
    const r = await fetch(`${BASE}${STABLE_PATH}`);
    expect(r.status).toBe(200);
    assertIsolationHeaders(r);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
  });

  it("carries COOP/COEP/CORP even on a 404 (worker scripts must not be blocked)", async () => {
    const r = await fetch(`${BASE}/packages/does-not-exist.js`);
    expect(r.status).toBe(404);
    assertIsolationHeaders(r);
  });

  it("revalidates with an ETag and returns 304 on a match", async () => {
    const first = await fetch(`${BASE}${STABLE_PATH}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const second = await fetch(`${BASE}${STABLE_PATH}`, { headers: { "If-None-Match": etag! } });
    expect(second.status).toBe(304);
  });

  it("uses the SPA index mtime in its validator so deploys cannot reuse an old shell", async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[1-9][0-9a-f]*"$/);
  });

  it("honours HTTP Range requests with a 206 + Content-Range", async () => {
    const r = await fetch(`${BASE}${STABLE_PATH}`, { headers: { Range: "bytes=0-3" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toMatch(/^bytes 0-3\/\d+$/);
    expect(r.headers.get("content-length")).toBe("4");
    expect((await r.arrayBuffer()).byteLength).toBe(4);
  });

  it("blocks path traversal outside the asset base", async () => {
    // Fully percent-encode the `..` AND its slash (%2f) so fetch's URL parser does
    // not collapse the dot-segment before sending — the literal `%2e%2e%2f` reaches
    // the server, which decodes it to `../`. Without the guard this resolves to the
    // real repo-root package.json (200); the guard must turn it into a 404.
    const r = await fetch(`${BASE}/wit/%2e%2e%2fpackage.json`);
    expect(r.status).toBe(404);
  });
});
