import pc from "picocolors";

import { formatBytes } from "../../report/Formatters.ts";
import type { HeapProfile, HeapSample } from "./HeapSampler.ts";
import {
  type ResolvedFrame,
  type ResolvedProfile,
  resolveProfile,
} from "./ResolvedProfile.ts";

/** A resolved call frame with display-ready source positions */
export interface CallFrame {
  fn: string;
  url: string;
  /** 1-indexed */
  line: number;
  /** 1-indexed */
  col?: number;
}

/** An allocation site with byte totals, call stack, and optional raw samples */
export interface HeapSite {
  fn: string;
  url: string;
  /** 1-indexed */
  line: number;
  col?: number;
  bytes: number;
  /** Call stack from root to this frame */
  stack?: CallFrame[];
  /** Individual allocation samples at this site */
  samples?: HeapSample[];
  /** Distinct caller paths with byte weights (populated by {@link aggregateSites}) */
  callers?: { stack: CallFrame[]; bytes: number }[];
}

/** Predicate that returns true for user code (vs. runtime internals) */
export type UserCodeFilter = (site: CallFrame) => boolean;

/** Options for {@link formatHeapReport} */
export interface HeapReportOptions {
  /** Max sites to display */
  topN: number;
  /** Caller stack frames to show per site (default 3) */
  stackDepth?: number;
  /** Multi-line format with file paths (default false) */
  verbose?: boolean;
  /** Dump every raw sample */
  raw?: boolean;
  /** Filter to user code only, hiding runtime internals */
  userOnly?: boolean;
  /** Predicate for user vs internal code (default {@link isNodeUserCode}) */
  isUserCode?: UserCodeFilter;
  /** Total bytes across all nodes (before filtering) */
  totalAll?: number;
  /** Total bytes for user code only */
  totalUserCode?: number;
  /** Number of samples taken */
  sampleCount?: number;
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
    let bucket = nodeIdToSites.get(node.nodeId);
    if (!bucket) {
      bucket = [];
      nodeIdToSites.set(node.nodeId, bucket);
    }
    bucket.push(site);
  }

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
    const colKey = col != null ? `${col}` : `?:${fn}`;
    const key = `${url}:${line}:${colKey}`;
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
    const frame = nodeMap.get(s.nodeId)?.frame;
    const fn = frame?.name || "(unknown)";
    const url = frame?.url || "";
    const loc = url ? fmtLoc(url, frame!.line, frame!.col) : "(unknown)";
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

  callerFrames(site, stackDepth)
    .filter(frame => frame.url && isUser(frame))
    .forEach(frame => {
      const callerLoc = fmtLoc(frame.url, frame.line, frame.col);
      lines.push(dim(`            <- ${frame.fn}  ${callerLoc}`));
    });
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
