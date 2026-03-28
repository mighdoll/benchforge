import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import {
  archiveFileName,
  collectSources,
  fetchSource,
} from "../export/AllocExport.ts";

export interface ViewerServerOptions {
  /** Speedscope JSON profile data */
  profileData: string;
  /** Editor URI prefix for Cmd+Shift+click (e.g. "vscode://file") */
  editorUri?: string;
  /** Port to listen on (default 3939) */
  port?: number;
}

const speedscopeDir = join(homedir(), "lib/speedscope/dist/release");

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".map": "application/json",
  ".md": "text/plain",
};

/** Resolve the viewer shell directory (works from dist/ and src/) */
function viewerDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // In dist: dist/viewer/ViewerServer.js → shell files are siblings
  // In src (dev): src/viewer/ViewerServer.ts → shell files are siblings
  return thisDir;
}

/** Start the allocation viewer server and open in browser */
export async function startViewerServer(
  options: ViewerServerOptions,
): Promise<{ server: Server; port: number; close: () => void }> {
  const { profileData, editorUri } = options;
  const port = options.port ?? 3939;
  const shellDir = viewerDir();

  const sourceCache = new Map<string, string>();

  const server = createServer(async (req, res) => {
    const url = req.url || "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = qIdx >= 0 ? url.slice(qIdx + 1) : "";

    // Viewer shell at root
    if (pathname === "/") {
      await serveFile(res, join(shellDir, "shell.html"));
      return;
    }

    // Viewer static files (shell.css, shell.js)
    if (pathname.startsWith("/viewer/")) {
      const relPath = pathname.slice("/viewer/".length);
      await serveFile(res, join(shellDir, relPath));
      return;
    }

    // Config API (editor URI, etc.)
    if (pathname === "/api/config") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ editorUri: editorUri || null }));
      return;
    }

    // Profile API
    if (pathname === "/api/profile") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(profileData);
      return;
    }

    // Source fetch API
    if (pathname === "/api/source") {
      await handleSourceRequest(res, query, sourceCache);
      return;
    }

    // Archive API
    if (pathname === "/api/archive" && req.method === "POST") {
      await handleArchiveRequest(res, profileData, sourceCache);
      return;
    }

    // Speedscope static files
    if (pathname.startsWith("/speedscope/")) {
      const relPath = pathname.slice("/speedscope/".length) || "index.html";
      await serveFile(res, join(speedscopeDir, relPath));
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  const result = await tryListen(server, port);
  const openUrl = `http://localhost:${result.port}`;
  await open(openUrl);
  console.log(`Allocation viewer: ${openUrl}`);

  return {
    server: result.server,
    port: result.port,
    close: () => result.server.close(),
  };
}

type Res = import("node:http").ServerResponse;

async function handleSourceRequest(
  res: Res,
  query: string,
  cache: Map<string, string>,
): Promise<void> {
  const params = new URLSearchParams(query);
  const sourceUrl = params.get("url");
  if (!sourceUrl) {
    res.statusCode = 400;
    res.end("Missing url parameter");
    return;
  }
  try {
    let source = cache.get(sourceUrl);
    if (source === undefined) {
      source = await fetchSource(sourceUrl);
      if (source === undefined) throw new Error("not found");
      cache.set(sourceUrl, source);
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(source);
  } catch {
    res.statusCode = 404;
    res.end("Source unavailable");
  }
}

async function handleArchiveRequest(
  res: Res,
  profileData: string,
  sourceCache: Map<string, string>,
): Promise<void> {
  try {
    const parsed = JSON.parse(profileData);
    const sources = await collectSources(parsed.shared.frames, sourceCache);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = {
      profile: parsed,
      sources,
      metadata: {
        timestamp,
        benchforgeVersion: process.env.npm_package_version || "unknown",
      },
    };
    const body = JSON.stringify(archive);
    const filename = archiveFileName(parsed, timestamp);
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.end(body);
  } catch {
    res.statusCode = 500;
    res.end("Archive failed");
  }
}

async function serveFile(
  res: Res,
  filePath: string,
): Promise<void> {
  try {
    const content = await readFile(filePath);
    const mime = mimeTypes[extname(filePath)] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

function tryListen(
  server: Server,
  port: number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actualPort });
    });
  });
}
