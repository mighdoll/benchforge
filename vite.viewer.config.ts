import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Dev middleware: serve vendor/speedscope/ at /speedscope/ */
function serveSpeedscope(): Plugin {
  const dir = join(import.meta.dirname, "vendor/speedscope");
  return {
    name: "serve-speedscope",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/speedscope/")) return next();
        const rel = url.slice("/speedscope/".length) || "index.html";
        const file = join(dir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        const ext = file.split(".").pop() || "";
        const mimeTypes: Record<string, string> = {
          html: "text/html",
          js: "application/javascript",
          css: "text/css",
          json: "application/json",
          wasm: "application/wasm",
          woff2: "font/woff2",
          png: "image/png",
          ico: "image/x-icon",
          txt: "text/plain",
          map: "application/json",
        };
        res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

/** Build hook: copy vendor/speedscope/ into dist/viewer/speedscope/ */
function copySpeedscope(): Plugin {
  return {
    name: "copy-speedscope",
    closeBundle() {
      const src = join(import.meta.dirname, "vendor/speedscope");
      const dest = join(import.meta.dirname, "dist/viewer/speedscope");
      cpSync(src, dest, { recursive: true });
    },
  };
}

export default defineConfig({
  root: "src/viewer",
  build: {
    outDir: "../../dist/viewer",
    emptyOutDir: true,
  },
  server: { port: 5173 },
  plugins: [serveSpeedscope(), copySpeedscope()],
});
