import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import sirv from "sirv";
import {
  archiveFileName,
  collectSources,
  fetchSource,
} from "../export/AllocExport.ts";

export interface ViewerServerOptions {
  /** Speedscope JSON profile data (allocation) */
  profileData?: string;
  /** Speedscope JSON profile data (time/CPU) */
  timeProfileData?: string;
  /** HTML report JSON data */
  reportData?: string;
  /** Editor URI prefix for Cmd+Shift+click (e.g. "vscode://file") */
  editorUri?: string;
  /** Port to listen on (default 3939) */
  port?: number;
  /** Pre-loaded sources (e.g. from an archive) to seed the source cache */
  sources?: Record<string, string>;
}

/** Resolve the package root directory.
 *  In dev: src/viewer/ViewerServer.ts → dirname is "viewer" → up 2.
 *  In dist: dist/ViewerServer-*.mjs   → dirname is "dist"   → up 1. */
function packageRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const base = thisDir.split("/").pop() || "";
  if (base === "viewer") return join(thisDir, "../..");
  return join(thisDir, "..");
}

function viewerDistDir(): string {
  return join(packageRoot(), "dist/viewer");
}

/** Start the viewer server and open in browser */
export async function startViewerServer(
  options: ViewerServerOptions,
): Promise<{ server: Server; port: number; close: () => void }> {
  const { profileData, timeProfileData, reportData, editorUri } = options;
  const port = options.port ?? 3939;

  const sourceCache = new Map<string, string>();
  if (options.sources) {
    for (const [url, source] of Object.entries(options.sources)) {
      sourceCache.set(url, source);
    }
  }

  const assets = sirv(viewerDistDir(), { single: true });

  const server = createServer(async (req, res) => {
    const url = req.url || "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = qIdx >= 0 ? url.slice(qIdx + 1) : "";

    // Config API (editor URI, data availability)
    if (pathname === "/api/config") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        editorUri: editorUri || null,
        hasReport: !!reportData,
        hasProfile: !!profileData,
        hasTimeProfile: !!timeProfileData,
      }));
      return;
    }

    // Report data API
    if (pathname === "/api/report-data") {
      if (!reportData) {
        res.statusCode = 404;
        res.end("No report data");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(reportData);
      return;
    }

    // Allocation profile API
    if (pathname === "/api/profile" || pathname === "/api/profile/alloc") {
      if (!profileData) {
        res.statusCode = 404;
        res.end("No profile data");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(profileData);
      return;
    }

    // Time profile API
    if (pathname === "/api/profile/time") {
      if (!timeProfileData) {
        res.statusCode = 404;
        res.end("No time profile data");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(timeProfileData);
      return;
    }

    // Source fetch API
    if (pathname === "/api/source") {
      await handleSourceRequest(res, query, sourceCache);
      return;
    }

    // Archive API
    if (pathname === "/api/archive" && req.method === "POST") {
      await handleArchiveRequest(res, profileData, timeProfileData, reportData, sourceCache);
      return;
    }

    // All static files (viewer assets + speedscope) served by sirv
    assets(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });

  const result = await tryListen(server, port);
  const openUrl = `http://localhost:${result.port}`;
  await open(openUrl);
  console.log(`Viewer: ${openUrl}`);

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
  profileData: string | undefined,
  timeProfileData: string | undefined,
  reportData: string | undefined,
  sourceCache: Map<string, string>,
): Promise<void> {
  try {
    const profile = profileData ? JSON.parse(profileData) : null;
    const timeProfile = timeProfileData ? JSON.parse(timeProfileData) : null;
    const report = reportData ? JSON.parse(reportData) : null;
    const allFrames = [
      ...(profile?.shared?.frames ?? []),
      ...(timeProfile?.shared?.frames ?? []),
    ];
    const sources = allFrames.length
      ? await collectSources(allFrames, sourceCache)
      : Object.fromEntries(sourceCache);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = {
      schema: 1,
      profile,
      timeProfile,
      report,
      sources,
      metadata: {
        timestamp,
        benchforgeVersion: process.env.npm_package_version || "unknown",
      },
    };
    const body = JSON.stringify(archive);
    const filename = profile
      ? archiveFileName(profile, timestamp)
      : `benchforge-${timestamp}.benchforge`;
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

/** Open a .benchforge archive in the viewer */
export async function viewArchive(filePath: string): Promise<void> {
  const absPath = resolve(filePath);
  const content = await readFile(absPath, "utf-8");
  const archive = JSON.parse(content);

  const KNOWN_SCHEMA = 1;
  const schema = archive.schema ?? 0;
  if (schema > KNOWN_SCHEMA) {
    console.error(
      `Archive schema version ${schema} is newer than supported (${KNOWN_SCHEMA}). ` +
      `Please update benchforge to view this archive.`,
    );
    process.exit(1);
  }

  const profileData = archive.profile
    ? JSON.stringify(archive.profile)
    : undefined;
  const timeProfileData = archive.timeProfile
    ? JSON.stringify(archive.timeProfile)
    : undefined;
  const reportData = archive.report
    ? JSON.stringify(archive.report)
    : undefined;
  const sources = archive.sources as Record<string, string> | undefined;

  const { close } = await startViewerServer({
    profileData,
    timeProfileData,
    reportData,
    sources,
  });

  await new Promise<void>(resolve => {
    console.log("\nPress Ctrl+C to exit");
    process.on("SIGINT", () => {
      console.log();
      close();
      resolve();
    });
  });
}

function tryListen(
  server: Server,
  port: number,
  maxRetries = 10,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const listen = (p: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < maxRetries) {
          attempt++;
          listen(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, () => {
        server.removeAllListeners("error");
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : p;
        resolve({ server, port: actualPort });
      });
    };
    listen(port);
  });
}
