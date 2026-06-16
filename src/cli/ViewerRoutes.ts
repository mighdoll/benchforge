import type { IncomingMessage, ServerResponse } from "node:http";
import type sirv from "sirv";
import {
  buildArchiveObject,
  collectProfileFrames,
  collectSources,
  defaultArchiveName,
  fetchSource,
} from "../export/ArchiveExport.ts";
import type { LineCoverage } from "../export/CoverageExport.ts";
import type { SpeedscopeFile } from "../export/SpeedscopeTypes.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import type { ViewerServerOptions } from "./ViewerServer.ts";

type RouteHandler = (
  res: ServerResponse,
  query: string,
  method: string,
) => Promise<void> | void;

/** Build HTTP request handler with API routes and static asset fallback. */
export function createRequestHandler(
  ctx: ViewerServerOptions,
  sourceCache: Map<string, string>,
  assets: ReturnType<typeof sirv>,
): (req: IncomingMessage, res: ServerResponse) => void {
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

/** Send pre-serialized JSON or 404 if data is absent. */
function sendJson(
  res: ServerResponse,
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
  res: ServerResponse,
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
  res: ServerResponse,
  ctx: ViewerServerOptions,
  sourceCache: Map<string, string>,
): Promise<void> {
  try {
    const profile = optionalParse<SpeedscopeFile>(ctx.profileData);
    const timeProfile = optionalParse<SpeedscopeFile>(ctx.timeProfileData);
    const coverage = optionalParse<Record<string, LineCoverage[]>>(
      ctx.coverageData,
    );
    const report = optionalParse<ReportData>(ctx.reportData);
    const allFrames = collectProfileFrames(profile, timeProfile);
    const sources = allFrames.length
      ? await collectSources(allFrames, sourceCache)
      : Object.fromEntries(sourceCache);
    const { archive, timestamp } = buildArchiveObject({
      allocProfile: profile,
      timeProfile,
      coverage,
      report,
      sources,
    });
    const body = JSON.stringify(archive);
    const filename = defaultArchiveName(profile, timestamp);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(body);
  } catch {
    res.statusCode = 500;
    res.end("Archive failed");
  }
}

/** Parse a JSON string if present, otherwise return undefined. */
function optionalParse<T = unknown>(s: string | undefined): T | undefined {
  return s ? (JSON.parse(s) as T) : undefined;
}
