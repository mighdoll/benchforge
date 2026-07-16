import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type sirv from "sirv";
import {
  blankToUndefined,
  buildArchiveObject,
  collectProfileFrames,
  collectSources,
  defaultArchiveName,
  fetchSource,
  saveArchiveNotes,
} from "../export/ArchiveExport.ts";
import type { LineCoverage } from "../export/CoverageExport.ts";
import type { SpeedscopeFile } from "../export/SpeedscopeTypes.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import type { ViewerServerOptions } from "./ViewerServer.ts";

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  query: string,
) => Promise<void> | void;

/** Build HTTP request handler with API routes and static asset fallback. */
export function createRequestHandler(
  ctx: ViewerServerOptions,
  sourceCache: Map<string, string>,
  assets: ReturnType<typeof sirv>,
): (req: IncomingMessage, res: ServerResponse) => void {
  // Serialize archive-file rewrites so two rapid note saves can't interleave.
  let notesWrite: Promise<void> = Promise.resolve();

  const routes: Record<string, RouteHandler> = {
    "/api/config": (_req, res) => {
      const config = {
        editorUri: ctx.editorUri || null,
        hasReport: !!ctx.reportData,
        hasProfile: !!ctx.profileData,
        hasTimeProfile: !!ctx.timeProfileData,
        hasCoverage: !!ctx.coverageData,
        notesFile: ctx.notesFile ? basename(ctx.notesFile) : null,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(config));
    },
    "/api/report-data": (_req, res) =>
      sendJson(res, ctx.reportData, "report data"),
    "/api/coverage": (_req, res) =>
      sendJson(res, ctx.coverageData, "coverage data"),
    "/api/profile": (_req, res) =>
      sendJson(res, ctx.profileData, "profile data", true),
    "/api/profile/alloc": (_req, res) =>
      sendJson(res, ctx.profileData, "profile data", true),
    "/api/profile/time": (_req, res) =>
      sendJson(res, ctx.timeProfileData, "time profile data", true),
    "/api/source": (_req, res, query) =>
      handleSourceRequest(res, query, sourceCache),
    "/api/notes": (req, res) => {
      if (req.method !== "PUT") return sendNotes(res, ctx);
      notesWrite = notesWrite.then(() => storeNotes(req, res, ctx));
      return notesWrite;
    },
    "/api/archive": (req, res) => {
      if (req.method !== "POST") {
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
      await handler(req, res, query);
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

/** Send the current notes as JSON (empty string when unset). */
function sendNotes(res: ServerResponse, ctx: ViewerServerOptions): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ notes: ctx.notes ?? "" }));
}

/** Accept edited notes: keep them on the options bag for the archive build, and
 *  write them back to the archive file when one is open. */
async function storeNotes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ViewerServerOptions,
): Promise<void> {
  try {
    const { notes } = JSON.parse(await readBody(req)) as { notes?: string };
    const text = notes ?? "";
    ctx.notes = blankToUndefined(text);
    if (ctx.notesFile) await saveArchiveNotes(ctx.notesFile, text);
    res.statusCode = 204;
    res.end();
  } catch (err) {
    res.statusCode = (err as Error).message === bodyTooLarge ? 413 : 500;
    res.end("Notes save failed");
  }
}

const bodyTooLarge = "Body too large";
const maxBodyBytes = 1_000_000;

/** Read a request body as UTF-8 text, rejecting oversized bodies. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBodyBytes) reject(new Error(bodyTooLarge));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
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
      notes: ctx.notes,
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
