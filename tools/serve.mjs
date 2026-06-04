import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8080);
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".ts": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
  ".css": "text/css", ".map": "application/json",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/packages/host/index.html";
    const file = normalize(join(ROOT, path));
    // Separator boundary so a sibling dir sharing ROOT's prefix can't slip through.
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      // cross-origin so the app can be embedded in a cross-origin iframe while
      // staying internally cross-origin isolated (matches tools/prod-server.mjs).
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
