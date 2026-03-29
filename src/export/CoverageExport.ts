import type { CoverageData } from "../profiling/coverage/CoverageTypes.ts";

/** Resolved per-function execution count at a specific source line */
export interface LineCoverage {
  /** 1-indexed line number of the function start */
  startLine: number;
  /** Function name (empty string for anonymous top-level) */
  functionName: string;
  /** Number of times the function was invoked */
  count: number;
}

/** Map from source URL to per-function execution counts */
export type CoverageMap = Map<string, LineCoverage[]>;

/** Build array where index i = character offset where line (i+1) starts */
function buildLineOffsets(source: string): number[] {
  const offsets = [0]; // line 1 starts at offset 0
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Convert character offset to 1-indexed line number via binary search */
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

/** Build a coverage map from raw CDP/inspector coverage data and source texts.
 *  For each function, the first range's count is the invocation count. */
export function buildCoverageMap(
  coverage: CoverageData,
  sources: Record<string, string>,
): CoverageMap {
  const map: CoverageMap = new Map();

  for (const script of coverage.scripts) {
    const { url, functions } = script;
    if (!url) continue;
    const source = sources[url];
    if (!source) continue;

    const lineOffsets = buildLineOffsets(source);
    const entries: LineCoverage[] = [];

    for (const fn of functions) {
      // The first range is the enclosing range; its count = invocation count
      const range = fn.ranges[0];
      if (!range) continue;

      entries.push({
        startLine: offsetToLine(range.startOffset, lineOffsets),
        functionName: fn.functionName,
        count: range.count,
      });
    }

    if (entries.length > 0) {
      map.set(url, entries);
    }
  }

  return map;
}

/** Annotate speedscope frame names with execution counts from a coverage map.
 *  Appends " [N]" to each matched frame name. */
export function annotateFramesWithCounts(
  frames: { name: string; file?: string; line?: number }[],
  coverageMap: CoverageMap,
): void {
  for (const frame of frames) {
    if (!frame.file) continue;
    const entries = coverageMap.get(frame.file);
    if (!entries) continue;

    const count = findCount(frame.name, frame.line, entries);
    if (count !== undefined && count > 0) {
      frame.name = `${frame.name} [${formatCount(count)}]`;
    }
  }
}

/** Match a frame to a coverage entry by function name and approximate line.
 *  Named functions match by name; anonymous functions match by closest line. */
function findCount(
  frameName: string,
  frameLine: number | undefined,
  entries: LineCoverage[],
): number | undefined {
  // Strip "(anonymous ...)" location hint from frame name for matching
  const isAnonymous =
    frameName === "(anonymous)" || frameName.startsWith("(anonymous ");

  if (!isAnonymous) {
    // Named function: match by name, prefer closest line
    const byName = entries.filter(e => e.functionName === frameName);
    if (byName.length === 1) return byName[0].count;
    if (byName.length > 1 && frameLine) {
      return closestByLine(byName, frameLine)?.count;
    }
    if (byName.length > 1) return byName[0].count;
    return undefined;
  }

  // Anonymous function: match by closest line among anonymous entries
  if (!frameLine) return undefined;
  const anonymous = entries.filter(e => e.functionName === "");
  return closestByLine(anonymous, frameLine)?.count;
}

function closestByLine(
  entries: LineCoverage[],
  line: number,
): LineCoverage | undefined {
  let best: LineCoverage | undefined;
  let bestDist = Number.MAX_SAFE_INTEGER;
  for (const e of entries) {
    const dist = Math.abs(e.startLine - line);
    if (dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best;
}

/** Format a count for display: 1234 → "1.2K", 1234567 → "1.2M" */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
