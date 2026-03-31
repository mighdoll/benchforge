import type { ViewerCoverageData, ViewerSpeedscopeFile } from "./Providers.ts";

export interface LineGutterData {
  allocBytes: Map<number, number>;
  selfTimeUs: Map<number, number>;
  callCounts: Map<number, number>;
}

/** Aggregate per-line profiling data for a source file from speedscope profiles. */
export function computeLineData(
  file: string,
  allocProfile: ViewerSpeedscopeFile | null,
  timeProfile: ViewerSpeedscopeFile | null,
  coverage: ViewerCoverageData | null,
): LineGutterData {
  return {
    allocBytes: aggregateSelf(file, allocProfile),
    selfTimeUs: aggregateSelf(file, timeProfile),
    callCounts: extractCallCounts(file, coverage),
  };
}

export function formatGutterBytes(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + " MB";
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + " KB";
  return bytes + " B";
}

export function formatGutterTime(us: number | undefined): string {
  if (!us) return "";
  if (us >= 1_000_000) return (us / 1_000_000).toFixed(1) + " s";
  if (us >= 1_000) return (us / 1_000).toFixed(1) + " ms";
  return us.toFixed(0) + " us";
}

export function formatGutterCount(count: number | undefined): string {
  if (!count) return "";
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + "M";
  if (count >= 1_000) return (count / 1_000).toFixed(1) + "K";
  return String(count);
}

/**
 * For each sample, find the deepest frame matching `file` and accumulate its weight.
 * This gives "self" attribution — the innermost call site in this file.
 */
function aggregateSelf(
  file: string,
  profile: ViewerSpeedscopeFile | null,
): Map<number, number> {
  const result = new Map<number, number>();
  if (!profile) return result;

  const { frames } = profile.shared;

  // Build set of frame indices that belong to this file
  const fileFrames = new Map<number, number>(); // frameIndex -> line
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.line && f.file && fileMatches(f.file, file)) {
      fileFrames.set(i, f.line);
    }
  }
  if (fileFrames.size === 0) return result;

  for (const p of profile.profiles) {
    for (let i = 0; i < p.samples.length; i++) {
      const stack = p.samples[i];
      const weight = p.weights[i];
      // True self: only attribute weight when the leaf frame is in this file
      const leaf = stack[stack.length - 1];
      const line = fileFrames.get(leaf);
      if (line !== undefined) {
        result.set(line, (result.get(line) || 0) + weight);
      }
    }
  }
  return result;
}

/** Extract per-function call counts from coverage data for the given file. */
function extractCallCounts(
  file: string,
  coverage: ViewerCoverageData | null,
): Map<number, number> {
  const result = new Map<number, number>();
  if (!coverage) return result;

  // Try exact match first, then URL-based matching
  const entries = coverage[file] ?? findCoverageEntries(file, coverage);
  if (!entries) return result;

  for (const entry of entries) {
    if (entry.count > 0) {
      const prev = result.get(entry.startLine) || 0;
      if (entry.count > prev) result.set(entry.startLine, entry.count);
    }
  }
  return result;
}

/** Check if a frame's file URL matches the target file path. */
function fileMatches(frameFile: string, target: string): boolean {
  if (frameFile === target) return true;
  // Frame files may be full URLs (file:///...) while target is a path
  try {
    if (new URL(frameFile).pathname === target) return true;
  } catch {}
  // Or vice versa
  return frameFile.endsWith(target) || target.endsWith(frameFile);
}

/** Find coverage entries by URL matching when exact key lookup fails. */
function findCoverageEntries(file: string, coverage: ViewerCoverageData) {
  for (const url of Object.keys(coverage)) {
    if (fileMatches(url, file)) return coverage[url];
  }
  return undefined;
}
