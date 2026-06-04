import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The repo root, two levels up from apps/web.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The kernel component bindings, the esbuild-bundled workers, the guest .wasm
// binaries, and the emulator assets are produced by the Rust/esbuild pipeline and
// referenced by absolute URL from the host runtime. Serve them from the repo root.
const ASSET_PREFIXES = ["/dist/", "/packages/", "/third_party/", "/assets/", "/wit/", "/guests/"];
const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
  ".map": "application/json",
  ".bin": "application/octet-stream",
};

// Cross-origin isolation (required for SharedArrayBuffer / the SAB syscall ring).
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // cross-origin so the document itself can be embedded in a cross-origin iframe
  // while staying internally isolated (matches tools/prod-server.mjs).
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/** Serve the repo-root build artifacts (kernel bindings, workers, guests, emulator
 * images) with the right MIME + CORP, so the host runtime can fetch them. */
function repoAssets(): Plugin {
  const handler = async (
    req: { url?: string },
    res: { statusCode: number; setHeader(k: string, v: string): void; end(b?: unknown): void },
    next: () => void,
  ) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (!ASSET_PREFIXES.some((p) => url.startsWith(p))) return next();
    try {
      const file = normalize(join(ROOT, decodeURIComponent(url)));
      // Separator boundary so a sibling dir sharing ROOT's prefix can't slip through.
      if (file !== ROOT && !file.startsWith(ROOT + sep)) {
        res.statusCode = 403;
        return res.end("forbidden");
      }
      const body = await readFile(file);
      res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
      // Module workers (kernel-worker etc.) created in a COEP:require-corp document
      // require the worker SCRIPT response to carry COEP+CORP too — not just CORP —
      // else the browser blocks it (ERR_BLOCKED_BY_RESPONSE). Mirror serve.mjs.
      // CORP cross-origin allows cross-origin iframe embedding (the app stays
      // internally isolated via COOP/COEP). Mirrors tools/prod-server.mjs.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    } catch {
      next();
    }
  };
  return {
    name: "wasmos-repo-assets",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), repoAssets()],
  // The built SPA's own bundle MUST NOT live under /assets/ — that path is the
  // repo-root prefix serving the riscv64 guest image. Emit it under /spa-assets/.
  build: { assetsDir: "spa-assets" },
  // Let Vite import the @wasmos/host TypeScript source (+ its CSS) from the repo.
  server: { headers: ISOLATION_HEADERS, fs: { allow: [ROOT] } },
  preview: { headers: ISOLATION_HEADERS },
});
