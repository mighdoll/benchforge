import type { ViewerCoverageData, ViewerSpeedscopeFile } from "./Providers.ts";

/** Per-line profiling metrics for source gutter display. */
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

/** Format byte count for gutter display, scaling to KB/MB as appropriate. */
export function formatGutterBytes(bytes: number | undefined): string {
  if (!bytes) return "";
  return formatDecimalBytes(bytes);
}

/** Format bytes using decimal (SI) units: KB = 1000, MB = 1e6, GB = 1e9. */
export function formatDecimalBytes(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return bytes + " B";
}

/** Format microsecond duration for gutter display, scaling to ms/s as appropriate. */
export function formatGutterTime(us: number | undefined): string {
  if (!us) return "";
  if (us >= 1_000_000) return (us / 1_000_000).toFixed(1) + " s";
  if (us >= 1_000) return (us / 1_000).toFixed(1) + " ms";
  return us.toFixed(0) + " us";
}

/** Format large counts with K/M suffixes (e.g. 1234567 ==> "1.2M"). */
export function formatCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toLocaleString();
}

/** Format a call count for gutter display, scaling to K/M as appropriate. */
export function formatGutterCount(count: number | undefined): string {
  if (!count) return "";
  return formatCount(count);
}

/** Accumulate weight for the deepest (self) frame matching `file` in each sample. */
function aggregateSelf(
  file: string,
  profile: ViewerSpeedscopeFile | null,
): Map<number, number> {
  const result = new Map<number, number>();
  if (!profile) return result;

  const { frames } = profile.shared;

  const fileFrames = new Map<number, number>(); // frameIndex -> line
  frames.forEach((frame, i) => {
    if (frame.line && frame.file && fileMatches(frame.file, file))
      fileFrames.set(i, frame.line);
  });
  if (fileFrames.size === 0) return result;

  for (const p of profile.profiles) {
    for (let i = 0; i < p.samples.length; i++) {
      const leaf = p.samples[i].at(-1)!;
      const line = fileFrames.get(leaf);
      if (line !== undefined)
        result.set(line, (result.get(line) || 0) + p.weights[i]);
    }
  }
  return result;
}

/** Extract per-function call counts from coverage data for a file. */
function extractCallCounts(
  file: string,
  coverage: ViewerCoverageData | null,
): Map<number, number> {
  const result = new Map<number, number>();
  if (!coverage) return result;

  const entries = coverage[file] ?? findCoverageEntries(file, coverage);
  if (!entries) return result;

  for (const entry of entries) {
    if (entry.count <= 0) continue;
    const prev = result.get(entry.startLine) || 0;
    if (entry.count > prev) result.set(entry.startLine, entry.count);
  }
  return result;
}

/** Check if a frame's file URL matches the target file path. */
function fileMatches(frameFile: string, target: string): boolean {
  if (frameFile === target) return true;
  // Frame files may be full URLs while target is a bare path, or vice versa
  try {
    if (new URL(frameFile).pathname === target) return true;
  } catch {}
  return frameFile.endsWith(target) || target.endsWith(frameFile);
}

/** Find coverage entries by URL matching when exact key lookup fails. */
function findCoverageEntries(file: string, coverage: ViewerCoverageData) {
  const matchingUrl = Object.keys(coverage).find(url => fileMatches(url, file));
  return matchingUrl ? coverage[matchingUrl] : undefined;
}
