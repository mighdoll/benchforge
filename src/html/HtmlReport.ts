import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { generateHtmlDocument } from "./HtmlTemplate.ts";
import type {
  HtmlReportOptions,
  HtmlReportResult,
  ReportData,
} from "./Types.ts";

/** Generate HTML report from prepared data and optionally open in browser */
export async function generateHtmlReport(
  data: ReportData,
  options: HtmlReportOptions,
): Promise<HtmlReportResult> {
  const html = generateHtmlDocument(data);

  const reportDir = options.outputPath || (await createReportDir());
  await mkdir(reportDir, { recursive: true });

  await writeFile(join(reportDir, "index.html"), html, "utf-8");
  const plots = await loadPlotsBundle();
  await writeFile(join(reportDir, "plots.js"), plots, "utf-8");
  await writeLatestRedirect(reportDir);

  let server: Server | undefined;
  let closeServer: (() => void) | undefined;

  if (options.openBrowser) {
    const baseDir = dirname(reportDir);
    const reportName = reportDir.split("/").pop();
    const result = await startReportServer(baseDir, 7979, 7978, 7977);
    server = result.server;
    closeServer = () => result.server.close();
    const openUrl = `http://localhost:${result.port}/${reportName}/`;
    await open(openUrl);
    console.log(`Report opened in browser: ${openUrl}`);
  } else {
    console.log(`Report saved to: ${reportDir}/`);
  }

  return { reportDir, server, closeServer };
}

/** Start HTTP server for report directory, trying fallback ports if needed */
async function startReportServer(
  baseDir: string,
  ...ports: number[]
): Promise<{ server: Server; port: number }> {
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
  };

  const server = createServer(async (req, res) => {
    const url = req.url || "/";
    const suffix = url.endsWith("/") ? url + "index.html" : url;
    const filePath = join(baseDir, suffix);
    try {
      const content = await readFile(filePath);
      const mime = mimeTypes[extname(filePath)] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });

  for (const port of ports) {
    try {
      return await tryListen(server, port);
    } catch {
      // Port in use, try next
    }
  }
  return tryListen(server, 0);
}

/** Listen on a port, resolving with the actual port or rejecting on error */
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

/** Create a timestamped report directory under ./bench-report/ */
async function createReportDir(): Promise<string> {
  const base = "./bench-report";
  await mkdir(base, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(base, `report-${ts}`);
}

/** Read the pre-built browser plots bundle from dist/ */
async function loadPlotsBundle(): Promise<string> {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const builtPath = join(thisDir, "browser/index.js");
  const devPath = join(thisDir, "../../dist/browser/index.js");
  try {
    return await readFile(builtPath, "utf-8");
  } catch {}
  return readFile(devPath, "utf-8");
}

/** Write an index.html in the parent dir that redirects to this report */
async function writeLatestRedirect(reportDir: string): Promise<void> {
  const baseDir = dirname(reportDir);
  const reportName = reportDir.split("/").pop();
  const html = `<!DOCTYPE html>
<html><head>
  <meta http-equiv="refresh" content="0; url=./${reportName}/">
  <script>location.href = "./${reportName}/";</script>
</head><body>
  <a href="./${reportName}/">Latest report</a>
</body></html>`;
  await writeFile(join(baseDir, "index.html"), html, "utf-8");
}
