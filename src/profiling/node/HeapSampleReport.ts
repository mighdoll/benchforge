import pc from "picocolors";

import { formatBytes } from "../../report/Formatters.ts";
import type { HeapProfile, HeapSample } from "./HeapSampler.ts";
import {
  type ResolvedFrame,
  type ResolvedProfile,
  resolveProfile,
} from "./ResolvedProfile.ts";

export interface CallFrame {
  fn: string;
  url: string;
  line: number; // 1-indexed for display
  col?: number; // 1-indexed for display
}

export interface HeapSite {
  fn: string;
  url: string;
  line: number; // 1-indexed for display
  col?: number;
  bytes: number;
  stack?: CallFrame[]; // call stack from root to this frame
  samples?: HeapSample[]; // individual allocation samples at this site
  callers?: { stack: CallFrame[]; bytes: number }[]; // distinct caller paths
}

export type UserCodeFilter = (site: CallFrame) => boolean;

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

/** Sum selfSize across all nodes in profile (before any filtering) */
export function totalProfileBytes(profile: HeapProfile): number {
  return resolveProfile(profile).totalBytes;
}

/** Flatten resolved profile into sorted list of allocation sites with call stacks.
 *  When raw samples are available, attaches them to corresponding sites. */
export function flattenProfile(resolved: ResolvedProfile): HeapSite[] {
  const sites: HeapSite[] = [];
  const nodeIdToSites = new Map<number, HeapSite[]>();

  for (const node of resolved.allocationNodes) {
    const frame = toCallFrame(node.frame);
    const stack = node.stack.map(toCallFrame);
    const site: HeapSite = { ...frame, bytes: node.selfSize, stack };
    sites.push(site);
    const bucket = nodeIdToSites.get(node.nodeId) ?? [];
    if (!bucket.length) nodeIdToSites.set(node.nodeId, bucket);
    bucket.push(site);
  }

  // Attach raw samples to their corresponding sites
  for (const sample of resolved.sortedSamples ?? []) {
    const matchingSites = nodeIdToSites.get(sample.nodeId);
    if (!matchingSites) continue;
    for (const site of matchingSites) {
      if (!site.samples) site.samples = [];
      site.samples.push(sample);
    }
  }

  return sites.sort((a, b) => b.bytes - a.bytes);
}

/** Return true if the call frame is user code (excludes node: and internal/ URLs) */
export function isNodeUserCode(site: CallFrame): boolean {
  const { url } = site;
  if (!url) return false;
  return (
    !url.startsWith("node:") &&
    !url.includes("(native)") &&
    !url.includes("internal/")
  );
}

/** Return true if the call frame is user code (excludes chrome-extension:// and devtools:// URLs) */
export function isBrowserUserCode(site: CallFrame): boolean {
  const { url } = site;
  if (!url) return false;
  return (
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("devtools://") &&
    !url.includes("(native)")
  );
}

/** Return only sites matching a user-code predicate (default: {@link isNodeUserCode}) */
export function filterSites(
  sites: HeapSite[],
  isUser: UserCodeFilter = isNodeUserCode,
): HeapSite[] {
  return sites.filter(isUser);
}

/** Aggregate sites by location (combine same file:line:col).
 *  Tracks distinct caller stacks with byte weights when merging. */
export function aggregateSites(sites: HeapSite[]): HeapSite[] {
  const byLocation = new Map<string, HeapSite>();

  for (const site of sites) {
    // When column is unknown, include fn name to avoid merging distinct sites
    const { url, line, col, fn } = site;
    const suffix = col != null ? `${col}` : `?:${fn}`;
    const key = `${url}:${line}:${suffix}`;
    const existing = byLocation.get(key);
    if (existing) {
      existing.bytes += site.bytes;
      addCaller(existing, site);
    } else {
      const callers = site.stack
        ? [{ stack: site.stack, bytes: site.bytes }]
        : undefined;
      byLocation.set(key, { ...site, callers });
    }
  }

  // Sort callers by bytes descending, use top caller as primary stack
  for (const site of byLocation.values()) {
    if (!site.callers || site.callers.length <= 1) continue;
    site.callers.sort((a, b) => b.bytes - a.bytes);
    site.stack = site.callers[0].stack;
  }

  return [...byLocation.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Format heap report for console output */
export function formatHeapReport(
  sites: HeapSite[],
  options: HeapReportOptions,
): string {
  const { topN, stackDepth = 3, verbose = false } = options;
  const { totalAll, totalUserCode, sampleCount } = options;
  const isUser = options.isUserCode ?? isNodeUserCode;
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

/** Sum bytes across all sites */
export function totalBytes(sites: HeapSite[]): number {
  return sites.reduce((sum, s) => sum + s.bytes, 0);
}

/** Format every raw sample as one line, ordered by ordinal (time).
 *  Output is tab-separated for easy piping/grep/diff. */
export function formatRawSamples(resolved: ResolvedProfile): string {
  const { sortedSamples, nodeMap } = resolved;
  if (!sortedSamples || sortedSamples.length === 0)
    return "No raw samples available.";

  const header = "ordinal\tsize\tfunction\tlocation";
  const rows = sortedSamples.map(s => {
    const f = nodeMap.get(s.nodeId)?.frame;
    const fn = f?.name || "(unknown)";
    const url = f?.url || "";
    const loc = url ? fmtLoc(url, f!.line, f!.col) : "(unknown)";
    return `${s.ordinal}\t${s.size}\t${fn}\t${loc}`;
  });
  return [header, ...rows].join("\n");
}

function toCallFrame(f: ResolvedFrame): CallFrame {
  return { fn: f.name, url: f.url, line: f.line, col: f.col };
}

/** Add a caller stack to an aggregated site, merging if the same path exists */
function addCaller(existing: HeapSite, site: HeapSite): void {
  if (!site.stack) return;
  if (!existing.callers) existing.callers = [];
  const key = callerKey(site.stack);
  const match = existing.callers.find(c => callerKey(c.stack) === key);
  if (match) match.bytes += site.bytes;
  else existing.callers.push({ stack: site.stack, bytes: site.bytes });
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
  const dim = isUser(site) ? (s: string) => s : pc.dim;
  lines.push(dim(`${bytes}  ${site.fn}  ${loc}`));

  for (const frame of callerFrames(site, stackDepth)) {
    if (!frame.url || !isUser(frame)) continue;
    const callerLoc = fmtLoc(frame.url, frame.line, frame.col);
    lines.push(dim(`            <- ${frame.fn}  ${callerLoc}`));
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
    .map(f => f.fn);
  const line = `${bytes}  ${[site.fn, ...callers].join(" <- ")}`;
  lines.push(isUser(site) ? line : pc.dim(line));
}

function fmtBytes(bytes: number): string {
  return formatBytes(bytes, { space: true }) ?? `${bytes} B`;
}

/** Format location, omitting column when unknown */
function fmtLoc(url: string, line: number, col?: number): string {
  return col != null ? `${url}:${line}:${col}` : `${url}:${line}`;
}

/** Serialize a call stack for dedup comparison */
function callerKey(stack: CallFrame[]): string {
  return stack.map(f => `${f.url}:${f.line}:${f.col}`).join("|");
}

/** Get caller frames (parent stack excluding self, reversed, truncated) */
function callerFrames(site: HeapSite, depth: number): CallFrame[] {
  if (!site.stack || site.stack.length <= 1) return [];
  return site.stack.slice(0, -1).reverse().slice(0, depth);
}
