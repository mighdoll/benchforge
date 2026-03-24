import pc from "picocolors";
import type { HeapProfile, HeapSample, ProfileNode } from "./HeapSampler.ts";

/** Sum selfSize across all nodes in profile (before any filtering) */
export function totalProfileBytes(profile: HeapProfile): number {
  let total = 0;
  function walk(node: ProfileNode): void {
    total += node.selfSize;
    for (const child of node.children || []) walk(child);
  }
  walk(profile.head);
  return total;
}

export interface CallFrame {
  fn: string;
  url: string;
  line: number; // 1-indexed for display
  col: number;
}

export interface HeapSite {
  fn: string;
  url: string;
  line: number; // 1-indexed for display
  col: number;
  bytes: number;
  stack?: CallFrame[]; // call stack from root to this frame
  samples?: HeapSample[]; // individual allocation samples at this site
}

/** Flatten profile tree into sorted list of allocation sites with call stacks.
 *  When raw samples are available, attaches them to corresponding sites. */
export function flattenProfile(profile: HeapProfile): HeapSite[] {
  const sites: HeapSite[] = [];
  const nodeIdToSites = new Map<number, HeapSite[]>();

  function walk(node: ProfileNode, stack: CallFrame[]): void {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const fn = functionName || "(anonymous)";
    const col = columnNumber ?? -1;
    const frame: CallFrame = { fn, url: url || "", line: lineNumber + 1, col };
    const newStack = [...stack, frame];

    if (node.selfSize > 0) {
      const site: HeapSite = {
        ...frame,
        bytes: node.selfSize,
        stack: newStack,
      };
      sites.push(site);
      // Map node id to site for sample attachment
      const existing = nodeIdToSites.get(node.id);
      if (existing) existing.push(site);
      else nodeIdToSites.set(node.id, [site]);
    }
    for (const child of node.children || []) walk(child, newStack);
  }

  walk(profile.head, []);

  // Attach raw samples to their corresponding sites
  if (profile.samples) {
    for (const sample of profile.samples) {
      const matchingSites = nodeIdToSites.get(sample.nodeId);
      if (matchingSites) {
        for (const site of matchingSites) {
          if (!site.samples) site.samples = [];
          site.samples.push(sample);
        }
      }
    }
  }

  return sites.sort((a, b) => b.bytes - a.bytes);
}

export type UserCodeFilter = (site: CallFrame) => boolean;

/** Check if site is user code (not node internals) */
export function isNodeUserCode(site: CallFrame): boolean {
  if (!site.url) return false;
  if (site.url.startsWith("node:")) return false;
  if (site.url.includes("(native)")) return false;
  if (site.url.includes("internal/")) return false;
  return true;
}

/** Check if site is user code (not browser internals) */
export function isBrowserUserCode(site: CallFrame): boolean {
  if (!site.url) return false;
  if (site.url.startsWith("chrome-extension://")) return false;
  if (site.url.startsWith("devtools://")) return false;
  if (site.url.includes("(native)")) return false;
  return true;
}

/** Filter sites to user code only */
export function filterSites(
  sites: HeapSite[],
  isUser: UserCodeFilter = isNodeUserCode,
): HeapSite[] {
  return sites.filter(isUser);
}

/** Aggregate sites by location (combine same file:line:col) */
export function aggregateSites(sites: HeapSite[]): HeapSite[] {
  const byLocation = new Map<string, HeapSite>();

  for (const site of sites) {
    // When column is unknown (-1), include fn name to avoid merging distinct sites
    const key = site.col >= 0
      ? `${site.url}:${site.line}:${site.col}`
      : `${site.url}:${site.line}:?:${site.fn}`;
    const existing = byLocation.get(key);
    if (existing) {
      existing.bytes += site.bytes;
    } else {
      byLocation.set(key, { ...site });
    }
  }

  return [...byLocation.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Format location, omitting column when unknown (-1) */
function fmtLoc(url: string, line: number, col: number): string {
  return col >= 0 ? `${url}:${line}:${col}` : `${url}:${line}`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export interface HeapReportOptions {
  topN: number;
  stackDepth?: number;
  verbose?: boolean;
  raw?: boolean; // dump every raw sample
  userOnly?: boolean; // filter to user code only (hide node internals)
  isUserCode?: UserCodeFilter; // predicate for user vs internal code
  totalAll?: number; // total across all nodes (before filtering)
  totalUserCode?: number; // total for user code only
  sampleCount?: number; // number of samples taken
}

/** Format heap report for console output */
export function formatHeapReport(
  sites: HeapSite[],
  options: HeapReportOptions,
): string {
  const { topN, stackDepth = 3, verbose = false } = options;
  const { totalAll, totalUserCode, sampleCount } = options;
  const isUser = options.isUserCode ?? isNodeUserCode;
  const lines: string[] = [];
  lines.push(`Heap allocation sites (top ${topN}, garbage included):`);

  for (const site of sites.slice(0, topN)) {
    if (verbose) {
      formatVerboseSite(lines, site, stackDepth, isUser);
    } else {
      formatCompactSite(lines, site, stackDepth, isUser);
    }
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

/** Compact single-line format: `49 MB  fn1 <- fn2 <- fn3` */
function formatCompactSite(
  lines: string[],
  site: HeapSite,
  stackDepth: number,
  isUser: UserCodeFilter,
): void {
  const bytes = fmtBytes(site.bytes).padStart(10);
  const fns = [site.fn];

  if (site.stack && site.stack.length > 1) {
    const callers = site.stack.slice(0, -1).reverse().slice(0, stackDepth);
    for (const frame of callers) {
      if (!frame.url || !isUser(frame)) continue;
      fns.push(frame.fn);
    }
  }

  const line = `${bytes}  ${fns.join(" <- ")}`;
  lines.push(isUser(site) ? line : pc.dim(line));
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
  const dimFn = isUser(site) ? (s: string) => s : pc.dim;

  lines.push(dimFn(`${bytes}  ${site.fn}  ${loc}`));

  if (site.stack && site.stack.length > 1) {
    const callers = site.stack.slice(0, -1).reverse().slice(0, stackDepth);
    for (const frame of callers) {
      if (!frame.url || !isUser(frame)) continue;
      const callerLoc = fmtLoc(frame.url, frame.line, frame.col);
      lines.push(dimFn(`            <- ${frame.fn}  ${callerLoc}`));
    }
  }

  if (site.samples && site.samples.length > 0) {
    lines.push(dimFn(`            ${formatSampleSummary(site.samples)}`));
  }
}

/** Summarize raw samples for a site: count, largest, median */
function formatSampleSummary(samples: HeapSample[]): string {
  const n = samples.length;
  if (n === 1) return `Samples: 1x ${fmtBytes(samples[0].size)}`;
  const sorted = samples.map(s => s.size).sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const largest = sorted[n - 1];
  return `Samples: ${n}x, largest ${fmtBytes(largest)}, median ${fmtBytes(median)}`;
}

/** Get total bytes from sites */
export function totalBytes(sites: HeapSite[]): number {
  return sites.reduce((sum, s) => sum + s.bytes, 0);
}

/** Format every raw sample as one line, ordered by ordinal (time).
 *  Output is tab-separated for easy piping/grep/diff. */
export function formatRawSamples(profile: HeapProfile): string {
  if (!profile.samples || profile.samples.length === 0) {
    return "No raw samples available.";
  }

  // Build id → node lookup from tree
  const nodeMap = new Map<number, ProfileNode>();
  function walk(node: ProfileNode): void {
    nodeMap.set(node.id, node);
    for (const child of node.children || []) walk(child);
  }
  walk(profile.head);

  const sorted = [...profile.samples].sort((a, b) => a.ordinal - b.ordinal);
  const lines: string[] = ["ordinal\tsize\tfunction\tlocation"];
  for (const s of sorted) {
    const node = nodeMap.get(s.nodeId);
    const fn = node?.callFrame.functionName || "(unknown)";
    const url = node?.callFrame.url || "";
    const line = node ? node.callFrame.lineNumber + 1 : 0;
    const col = node?.callFrame.columnNumber ?? -1;
    const loc = url ? fmtLoc(url, line, col) : "(unknown)";
    lines.push(`${s.ordinal}\t${s.size}\t${fn}\t${loc}`);
  }
  return lines.join("\n");
}
