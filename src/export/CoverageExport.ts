/** Line-level coverage maps from V8/CDP coverage data and frame annotation with execution counts. */

import type { CoverageData } from "../profiling/node/CoverageTypes.ts";

/** Per-function execution count at a specific source line. */
export interface LineCoverage {
  /** 1-indexed line number of the function start */
  startLine: number;
  /** Function name (empty string for anonymous top-level) */
  functionName: string;
  /** Number of times the function was invoked */
  count: number;
}

/** Map from source URL to per-function execution counts. */
export type CoverageMap = Map<string, LineCoverage[]>;

/** Coverage data: per-URL entries and a name-only fallback lookup. */
export interface CoverageResult {
  /** Per-URL coverage entries (for frames with matching file URLs) */
  map: CoverageMap;
  /** Name ==> count lookup across all scripts (for frames without file URLs) */
  byName: Map<string, number>;
}

/** Build coverage data from raw CDP/inspector coverage and source texts. */
export function buildCoverageMap(
  coverage: CoverageData,
  sources: Record<string, string>,
): CoverageResult {
  const map: CoverageMap = new Map();
  const byName = new Map<string, number>();

  for (const script of coverage.scripts) {
    processScript(script, sources, map, byName);
  }

  return { map, byName };
}

/** Annotate speedscope frame names with execution counts (e.g. "fn [1.2K]"). */
export function annotateFramesWithCounts(
  frames: { name: string; file?: string; line?: number }[],
  coverage: CoverageResult,
): void {
  for (const frame of frames) {
    const entries = frame.file ? coverage.map.get(frame.file) : undefined;
    const count = entries && findCount(frame.name, frame.line, entries);
    const isAnon = frame.name.startsWith("(anonymous");
    const resolved =
      count ?? (isAnon ? undefined : coverage.byName.get(frame.name));
    if (resolved !== undefined && resolved > 0)
      frame.name = `${frame.name} [${formatCount(resolved)}]`;
  }
}

/** Extract per-function coverage entries from a single script. */
function processScript(
  script: CoverageData["scripts"][number],
  sources: Record<string, string>,
  map: CoverageMap,
  byName: Map<string, number>,
): void {
  const { url, functions } = script;
  const source = url ? sources[url] : undefined;
  const lineOffsets = source ? buildLineOffsets(source) : undefined;
  const entries: LineCoverage[] = [];

  for (const fn of functions) {
    const range = fn.ranges[0];
    if (!range) continue;

    if (lineOffsets && url) {
      entries.push({
        startLine: offsetToLine(range.startOffset, lineOffsets),
        functionName: fn.functionName,
        count: range.count,
      });
    }

    if (fn.functionName && range.count > 0) {
      const prev = byName.get(fn.functionName) ?? 0;
      byName.set(fn.functionName, prev + range.count);
    }
  }

  if (entries.length > 0 && url) map.set(url, entries);
}

/** Match a frame to a coverage entry by function name (or closest line for anonymous). */
function findCount(
  frameName: string,
  frameLine: number | undefined,
  entries: LineCoverage[],
): number | undefined {
  const isAnon =
    frameName === "(anonymous)" || frameName.startsWith("(anonymous ");

  if (isAnon) {
    if (!frameLine) return undefined;
    const anonymous = entries.filter(e => e.functionName === "");
    return closestByLine(anonymous, frameLine)?.count;
  }

  const nameMatches = entries.filter(e => e.functionName === frameName);
  if (nameMatches.length === 0) return undefined;
  if (nameMatches.length === 1) return nameMatches[0].count;
  if (frameLine) return closestByLine(nameMatches, frameLine)?.count;
  return nameMatches[0].count;
}

/** Format a count for display (e.g. 1234567 ==> "1.2M"). */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Build array where index i is the character offset where line (i+1) starts. */
function buildLineOffsets(source: string): number[] {
  const offsets = [0]; // line 1 starts at offset 0
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Convert character offset to 1-indexed line number via binary search. */
function offsetToLine(offset: number, lineOffsets: number[]): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-indexed
}

/** Find the entry whose startLine is closest to the given line. */
function closestByLine(
  entries: LineCoverage[],
  line: number,
): LineCoverage | undefined {
  if (!entries.length) return undefined;
  const dist = (e: LineCoverage) => Math.abs(e.startLine - line);
  return entries.reduce((best, e) => (dist(e) < dist(best) ? e : best));
}
