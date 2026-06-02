// Production static server for WASM_OS (the Railway runtime).
//
// Serves two things, both under cross-origin isolation (COOP same-origin + COEP
// require-corp) which the SAB syscall ring / SharedArrayBuffer REQUIRE:
//   1. The built React web client (apps/web/dist) as the app shell.
//   2. The repo-root build artifacts the host runtime fetches by absolute URL —
//      the esbuild workers (/dist/), kernel bindings (/packages/abi/generated/),
//      guest wasm (/packages/host/guests/), the MIT TinyEMU core (/third_party/
//      tinyemu/), and the riscv64 guest image (/assets/).
//
// Every response carries COOP+COEP+CORP: module workers created in a
// COEP:require-corp document need the worker SCRIPT response to carry them too,
// else the browser blocks it (ERR_BLOCKED_BY_RESPONSE). Listens on $PORT (Railway).
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SPA_DIR = join(ROOT, "apps", "web", "dist");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

// Repo-root prefixes served verbatim from ROOT (mirrors apps/web/vite.config.ts).
const ASSET_PREFIXES = ["/dist/", "/packages/", "/third_party/", "/assets/", "/wit/", "/guests/"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".bin": "application/octet-stream",
  ".cfg": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function setBaseHeaders(res, contentType) {
  res.setHeader("Content-Type", contentType);
  // Cross-origin isolation — required for SharedArrayBuffer in every document/worker.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

/** Resolve a request URL to an on-disk file, or null if it escapes its base/404s. */
async function resolveFile(base, urlPath) {
  const file = normalize(join(base, decodeURIComponent(urlPath)));
  if (!file.startsWith(base)) return null; // path traversal guard
  try {
    const st = await stat(file);
    if (st.isDirectory()) return null;
    return { file, size: st.size };
  } catch {
    return null;
  }
}

/** Stream a file with the right MIME, COOP/COEP/CORP, caching, and HTTP Range. */
function send(req, res, file, size, { immutable = false } = {}) {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  setBaseHeaders(res, type);
  res.setHeader("Accept-Ranges", "bytes");
  // Hashed SPA bundles + the immutable vendored binaries cache hard; HTML/config don't.
  res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[2] && m[1] ? Number(m[2]) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    if (req.method === "HEAD") return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }

  res.setHeader("Content-Length", String(size));
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = (req.url ?? "/").split("?")[0];

    // Lightweight liveness probe for the Railway healthcheck.
    if (urlPath === "/healthz") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      return res.end("ok");
    }

    // 1) Repo-root build artifacts (workers, bindings, guests, emulator, image).
    if (ASSET_PREFIXES.some((p) => urlPath.startsWith(p))) {
      const hit = await resolveFile(ROOT, urlPath);
      if (hit) return send(req, res, hit.file, hit.size, { immutable: true });
      res.statusCode = 404;
      setBaseHeaders(res, "text/plain");
      return res.end("not found");
    }

    // 2) The built SPA. Serve the requested file, or fall back to index.html so the
    //    single-page app handles its own routing.
    const spaHit = await resolveFile(SPA_DIR, urlPath === "/" ? "/index.html" : urlPath);
    if (spaHit) {
      // Vite emits hashed bundles under /spa-assets/ — those are safe to cache hard.
      const immutable = urlPath.startsWith("/spa-assets/");
      return send(req, res, spaHit.file, spaHit.size, { immutable });
    }
    const index = await resolveFile(SPA_DIR, "/index.html");
    if (index) return send(req, res, index.file, index.size);

    res.statusCode = 404;
    setBaseHeaders(res, "text/plain");
    res.end("not found");
  } catch (err) {
    res.statusCode = 500;
    res.end("internal error");
    console.error("[prod-server]", err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WASM_OS serving ${ROOT} on http://${HOST}:${PORT} (cross-origin isolated)`);
});
