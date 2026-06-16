import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import sirv from "sirv";
import { archiveSchemaError } from "../export/ArchiveFormat.ts";
import { createRequestHandler } from "./ViewerRoutes.ts";

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

/** Start the viewer HTTP server and open in browser. */
export async function startViewerServer(
  options: ViewerServerOptions,
): Promise<{ server: Server; port: number; close: () => void }> {
  const port = options.port ?? 3939;

  const sourceCache = new Map(Object.entries(options.sources ?? {}));

  const assets = sirv(join(packageRoot(), "dist/viewer"), { single: true });
  const handler = createRequestHandler(options, sourceCache, assets);
  const server = createServer(handler);

  const bound = await tryListen(server, port);
  const url = `http://localhost:${bound.port}`;
  if (options.open !== false) await open(url);
  console.log(`Viewer: ${url}`);

  const close = () => {
    bound.server.closeAllConnections();
    bound.server.close();
  };
  return { server: bound.server, port: bound.port, close };
}

/** Open a .benchforge archive in the viewer. */
export async function viewArchive(filePath: string): Promise<void> {
  const content = await readFile(resolve(filePath), "utf-8");
  const raw = JSON.parse(content);

  const schemaError = archiveSchemaError(raw.schema ?? 0);
  if (schemaError) {
    console.error(schemaError);
    process.exit(1);
  }

  const sources = raw.sources as Record<string, string> | undefined;
  const { close } = await startViewerServer({
    profileData: optionalJson(raw.allocProfile),
    timeProfileData: optionalJson(raw.timeProfile),
    coverageData: optionalJson(raw.coverage),
    reportData: optionalJson(raw.report),
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
    process.once("SIGINT", () => {
      console.log();
      resolve();
    });
  });
}

/** Resolve the package root (dev: src/cli/ ==> up 2, dist: dist/ ==> up 1). */
function packageRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  if (basename(thisDir) === "cli") return join(thisDir, "../..");
  return join(thisDir, "..");
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
        const listenPort = typeof addr === "object" && addr ? addr.port : p;
        resolve({ server, port: listenPort });
      });
    };
    listen(port);
  });
}
