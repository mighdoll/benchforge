import type { HeapSample } from "./HeapSampler.ts";
import type { ResolvedFrame, ResolvedProfile } from "./ResolvedProfile.ts";

/** An allocation site with byte totals, call stack, and optional raw samples */
export interface HeapSite {
  name: string;
  url: string;
  /** 1-indexed */
  line: number;
  col?: number;
  bytes: number;
  /** Call stack from root to this frame */
  stack?: ResolvedFrame[];
  /** Individual allocation samples at this site */
  samples?: HeapSample[];
  /** Distinct caller paths with byte weights (populated by {@link aggregateSites}) */
  callers?: { stack: ResolvedFrame[]; bytes: number }[];
}

/** Predicate that returns true for user code (vs. runtime internals) */
export type UserCodeFilter = (site: ResolvedFrame) => boolean;

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

/** Flatten resolved profile into sorted list of allocation sites with call stacks.
 *  When raw samples are available, attaches them to corresponding sites. */
export function flattenProfile(resolved: ResolvedProfile): HeapSite[] {
  const sites: HeapSite[] = [];
  const nodeIdToSites = new Map<number, HeapSite[]>();

  for (const node of resolved.allocationNodes) {
    const site: HeapSite = {
      ...node.frame,
      bytes: node.selfSize,
      stack: node.stack,
    };
    sites.push(site);
    const bucket = nodeIdToSites.get(node.nodeId) ?? [];
    if (!bucket.length) nodeIdToSites.set(node.nodeId, bucket);
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
export function isNodeUserCode(site: ResolvedFrame): boolean {
  const { url } = site;
  return (
    !!url &&
    !url.startsWith("node:") &&
    !url.includes("(native)") &&
    !url.includes("internal/")
  );
}

/** Return true if the call frame is user code (excludes chrome-extension:// and devtools:// URLs) */
export function isBrowserUserCode(site: ResolvedFrame): boolean {
  const { url } = site;
  return (
    !!url &&
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
    // When column is unknown, include name to avoid merging distinct sites
    const colKey = site.col != null ? `${site.col}` : `?:${site.name}`;
    const key = `${site.url}:${site.line}:${colKey}`;
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

/** Sum bytes across all sites */
export function totalBytes(sites: HeapSite[]): number {
  return sites.reduce((sum, s) => sum + s.bytes, 0);
}

/** Add a caller stack to an aggregated site, merging if the same path exists */
function addCaller(existing: HeapSite, site: HeapSite): void {
  if (!site.stack) return;
  existing.callers ??= [];
  const key = callerKey(site.stack);
  const match = existing.callers.find(c => callerKey(c.stack) === key);
  if (match) match.bytes += site.bytes;
  else existing.callers.push({ stack: site.stack, bytes: site.bytes });
}

/** Serialize a call stack for dedup comparison */
function callerKey(stack: ResolvedFrame[]): string {
  return stack.map(f => `${f.url}:${f.line}:${f.col}`).join("|");
}
