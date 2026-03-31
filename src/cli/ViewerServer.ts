import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import sirv from "sirv";
import {
  archiveFileName,
  buildArchiveObject,
  collectSources,
  fetchSource,
} from "../export/AllocExport.ts";

export interface ViewerServerOptions {
  /** Speedscope JSON profile data (allocation) */
  profileData?: string;
  /** Speedscope JSON profile data (time/CPU) */
  timeProfileData?: string;
  /** Per-function coverage data (JSON-serialized Record<url, LineCoverage[]>) */
  coverageData?: string;
  /** HTML report JSON data */
  reportData?: string;
  /** Editor URI prefix for Cmd+Shift+click (e.g. "vscode://file") */
  editorUri?: string;
  /** Port to listen on (default 3939) */
  port?: number;
  /** Open browser on start (default true) */
  open?: boolean;
  /** Pre-loaded sources (e.g. from an archive) to seed the source cache */
  sources?: Record<string, string>;
}

type Res = import("node:http").ServerResponse;
type RouteHandler = (
  res: Res,
  query: string,
  method: string,
) => Promise<void> | void;

/** Start the viewer HTTP server and open in browser. */
export async function startViewerServer(
  options: ViewerServerOptions,
): Promise<{ server: Server; port: number; close: () => void }> {
  const port = options.port ?? 3939;

  const sourceCache = new Map(Object.entries(options.sources ?? {}));

  const assets = sirv(join(packageRoot(), "dist/viewer"), { single: true });
  const handler = createRequestHandler(options, sourceCache, assets);
  const server = createServer(handler);

  const { server: srv, port: actualPort } = await tryListen(server, port);
  const url = `http://localhost:${actualPort}`;
  if (options.open !== false && !process.env.BENCHFORGE_NO_OPEN)
    await open(url);
  console.log(`Viewer: ${url}`);

  return { server: srv, port: actualPort, close: () => srv.close() };
}

/** Open a .benchforge archive in the viewer. */
export async function viewArchive(filePath: string): Promise<void> {
  const absPath = resolve(filePath);
  const content = await readFile(absPath, "utf-8");
  const archive = JSON.parse(content);

  const schema = archive.schema ?? 0;
  if (schema > 1) {
    const msg = `Archive schema version ${schema} is newer than supported (1).`;
    console.error(`${msg} Please update benchforge to view this archive.`);
    process.exit(1);
  }

  const sources = archive.sources as Record<string, string> | undefined;
  const { close } = await startViewerServer({
    profileData: optionalJson(archive.profile),
    timeProfileData: optionalJson(archive.timeProfile),
    coverageData: optionalJson(archive.coverage),
    reportData: optionalJson(archive.report),
    sources,
  });

  await waitForCtrlC();
  close();
}

/** Serialize a value to JSON if truthy, otherwise return undefined. */
export function optionalJson(v: unknown): string | undefined {
  return v ? JSON.stringify(v) : undefined;
}

/** Wait for Ctrl+C (SIGINT) before resolving. */
export function waitForCtrlC(): Promise<void> {
  return new Promise(resolve => {
    console.log("\nPress Ctrl+C to exit");
    process.on("SIGINT", () => {
      console.log();
      resolve();
    });
  });
}

/** Resolve the package root directory.
 *
 *  Dev: src/cli/ -> up 2. Dist: dist/ -> up 1. */
function packageRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const base = thisDir.split("/").pop() || "";
  if (base === "cli") return join(thisDir, "../..");
  return join(thisDir, "..");
}

/** Build HTTP request handler with API routes and static asset fallback. */
function createRequestHandler(
  ctx: ViewerServerOptions,
  sourceCache: Map<string, string>,
  assets: ReturnType<typeof sirv>,
): (req: import("node:http").IncomingMessage, res: Res) => void {
  const routes: Record<string, RouteHandler> = {
    "/api/config": res => {
      const config = {
        editorUri: ctx.editorUri || null,
        hasReport: !!ctx.reportData,
        hasProfile: !!ctx.profileData,
        hasTimeProfile: !!ctx.timeProfileData,
        hasCoverage: !!ctx.coverageData,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(config));
    },
    "/api/report-data": res => sendJson(res, ctx.reportData, "report data"),
    "/api/coverage": res => sendJson(res, ctx.coverageData, "coverage data"),
    "/api/profile": res => sendJson(res, ctx.profileData, "profile data", true),
    "/api/profile/alloc": res =>
      sendJson(res, ctx.profileData, "profile data", true),
    "/api/profile/time": res =>
      sendJson(res, ctx.timeProfileData, "time profile data", true),
    "/api/source": (res, query) => handleSourceRequest(res, query, sourceCache),
    "/api/archive": (res, _q, method) => {
      if (method !== "POST") {
        res.statusCode = 405;
        return void res.end("Method not allowed");
      }
      return handleArchiveRequest(res, ctx, sourceCache);
    },
  };

  return async (req, res) => {
    const url = req.url || "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = qIdx >= 0 ? url.slice(qIdx + 1) : "";

    const handler = routes[pathname];
    if (handler) {
      await handler(res, query, req.method || "GET");
      return;
    }

    assets(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  };
}

/** Listen on port, retrying on next port if EADDRINUSE. */
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
        const boundPort = typeof addr === "object" && addr ? addr.port : p;
        resolve({ server, port: boundPort });
      });
    };
    listen(port);
  });
}

/** Send pre-serialized JSON or 404 if data is absent. */
function sendJson(
  res: Res,
  data: string | undefined,
  label: string,
  cors = false,
): void {
  if (!data) {
    res.statusCode = 404;
    res.end(`No ${label}`);
    return;
  }
  res.setHeader("Content-Type", "application/json");
  if (cors) res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(data);
}

/** Fetch source text by URL query param, caching for subsequent requests. */
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

/** Build a .benchforge archive from current session data and send as download. */
async function handleArchiveRequest(
  res: Res,
  ctx: ViewerServerOptions,
  sourceCache: Map<string, string>,
): Promise<void> {
  try {
    const parse = (s?: string) => (s ? JSON.parse(s) : null);
    const profile = parse(ctx.profileData);
    const timeProfile = parse(ctx.timeProfileData);
    const coverage = parse(ctx.coverageData);
    const report = parse(ctx.reportData);
    const allFrames = [
      ...(profile?.shared?.frames ?? []),
      ...(timeProfile?.shared?.frames ?? []),
    ];
    const sources = allFrames.length
      ? await collectSources(allFrames, sourceCache)
      : Object.fromEntries(sourceCache);
    const { archive, timestamp } = buildArchiveObject({
      profile,
      timeProfile,
      coverage,
      report,
      sources,
    });
    const body = JSON.stringify(archive);
    const filename = profile
      ? archiveFileName(profile, timestamp)
      : `benchforge-${timestamp}.benchforge`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(body);
  } catch {
    res.statusCode = 500;
    res.end("Archive failed");
  }
}
