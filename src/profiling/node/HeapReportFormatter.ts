import colors from "../../report/Colors.ts";
import { formatBytes } from "../../report/Formatters.ts";
import {
  type HeapReportOptions,
  type HeapSite,
  isNodeUserCode,
  type UserCodeFilter,
} from "./HeapSampleReport.ts";
import type { ResolvedFrame, ResolvedProfile } from "./ResolvedProfile.ts";

/** Format heap report for console output */
export function formatHeapReport(
  sites: HeapSite[],
  options: HeapReportOptions,
): string {
  const { topN, stackDepth = 3, verbose = false } = options;
  const { totalAll, totalUserCode, sampleCount, isUserCode } = options;
  const isUser = isUserCode ?? isNodeUserCode;
  const formatSite = verbose ? formatVerboseSite : formatCompactSite;
  const lines: string[] = [];
  lines.push(`Heap allocation sites (top ${topN}, garbage included):`);

  for (const site of sites.slice(0, topN)) {
    formatSite(lines, site, stackDepth, isUser);
  }

  lines.push("");
  if (totalAll !== undefined)
    lines.push(`Total (all):       ${fmtBytes(totalAll)}`);
  if (totalUserCode !== undefined)
    lines.push(`Total (user-code): ${fmtBytes(totalUserCode)}`);
  if (sampleCount !== undefined)
    lines.push(`Samples: ${sampleCount.toLocaleString()}`);

  return lines.join("\n");
}

/** Format every raw sample as one line, ordered by ordinal (time).
 *  Output is tab-separated for easy piping/grep/diff. */
export function formatRawSamples(resolved: ResolvedProfile): string {
  const { sortedSamples, nodeMap } = resolved;
  if (!sortedSamples || sortedSamples.length === 0)
    return "No raw samples available.";

  const header = "ordinal\tsize\tfunction\tlocation";
  const rows = sortedSamples.map(s => {
    const frame = nodeMap.get(s.nodeId)?.frame;
    const fn = frame?.name || "(unknown)";
    const url = frame?.url || "";
    const loc = url ? fmtLoc(url, frame!.line, frame!.col) : "(unknown)";
    return `${s.ordinal}\t${s.size}\t${fn}\t${loc}`;
  });
  return [header, ...rows].join("\n");
}

/** Verbose multi-line format with file:// paths and line numbers */
function formatVerboseSite(
  lines: string[],
  site: HeapSite,
  stackDepth: number,
  isUser: UserCodeFilter,
): void {
  const bytes = fmtBytes(site.bytes).padStart(10);
  const loc = site.url ? fmtLoc(site.url, site.line, site.col) : "(unknown)";
  const style = isUser(site) ? (s: string) => s : colors.dim;
  lines.push(style(`${bytes}  ${site.name}  ${loc}`));

  const userCallers = callerFrames(site, stackDepth).filter(
    f => f.url && isUser(f),
  );
  for (const frame of userCallers) {
    const loc = fmtLoc(frame.url, frame.line, frame.col);
    lines.push(style(`            <- ${frame.name}  ${loc}`));
  }
}

/** Compact single-line format: `49 MB  fn1 <- fn2 <- fn3` */
function formatCompactSite(
  lines: string[],
  site: HeapSite,
  stackDepth: number,
  isUser: UserCodeFilter,
): void {
  const bytes = fmtBytes(site.bytes).padStart(10);
  const callers = callerFrames(site, stackDepth)
    .filter(f => f.url && isUser(f))
    .map(f => f.name);
  const line = `${bytes}  ${[site.name, ...callers].join(" <- ")}`;
  lines.push(isUser(site) ? line : colors.dim(line));
}

/** Format bytes with a space separator, falling back to raw bytes */
function fmtBytes(bytes: number): string {
  return formatBytes(bytes, { space: true }) ?? `${bytes} B`;
}

/** Format location, omitting column when unknown */
function fmtLoc(url: string, line: number, col?: number): string {
  return col != null ? `${url}:${line}:${col}` : `${url}:${line}`;
}

/** Get caller frames (parent stack excluding self, reversed, truncated) */
function callerFrames(site: HeapSite, depth: number): ResolvedFrame[] {
  if (!site.stack || site.stack.length <= 1) return [];
  return site.stack.slice(0, -1).reverse().slice(0, depth);
}
