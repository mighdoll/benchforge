import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReportGroup } from "../BenchmarkReport.ts";
import type { HeapProfile, ProfileNode } from "../heap-sample/HeapSampler.ts";

/** speedscope file format (https://www.speedscope.app/file-format-schema.json) */
interface SpeedscopeFile {
  $schema: "https://www.speedscope.app/file-format-schema.json";
  shared: { frames: SpeedscopeFrame[] };
  profiles: SpeedscopeProfile[];
  name?: string;
  exporter?: string;
}

interface SpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

interface SpeedscopeProfile {
  type: "sampled";
  name: string;
  unit: "bytes";
  startValue: number;
  endValue: number;
  samples: number[][]; // each sample is stack of frame indices
  weights: number[]; // bytes per sample
}

/** Export heap profiles from benchmark results to speedscope JSON format.
 *  Creates one speedscope profile per benchmark that has a heapProfile. */
export function exportSpeedscope(
  groups: ReportGroup[],
  outputPath: string,
): void {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const profiles: SpeedscopeProfile[] = [];

  for (const group of groups) {
    const allReports = group.baseline
      ? [...group.reports, group.baseline]
      : group.reports;

    for (const report of allReports) {
      const { heapProfile } = report.measuredResults;
      if (!heapProfile) continue;
      profiles.push(buildProfile(report.name, heapProfile, frames, frameIndex));
    }
  }

  if (profiles.length === 0) {
    console.log("No heap profiles to export.");
    return;
  }

  const file: SpeedscopeFile = {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles,
    exporter: "benchforge",
  };

  const absPath = resolve(outputPath);
  writeFileSync(absPath, JSON.stringify(file));
  console.log(`Speedscope profile exported to: ${outputPath}`);
}

/** Build a single speedscope profile from a HeapProfile */
function buildProfile(
  name: string,
  profile: HeapProfile,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): SpeedscopeProfile {
  // Build nodeId → stack (array of frame indices from root to node)
  const nodeStacks = new Map<number, number[]>();
  walkTree(profile.head, [], sharedFrames, frameIndex, nodeStacks);

  const samples: number[][] = [];
  const weights: number[] = [];

  if (!profile.samples || profile.samples.length === 0) {
    console.error(
      `Speedscope export: no samples in heap profile for "${name}", skipping`,
    );
    return { type: "sampled", name, unit: "bytes", startValue: 0, endValue: 0, samples, weights };
  }

  // Use raw samples ordered by ordinal for temporal view
  const sorted = [...profile.samples].sort((a, b) => a.ordinal - b.ordinal);
  for (const sample of sorted) {
    const stack = nodeStacks.get(sample.nodeId);
    if (stack) {
      samples.push(stack);
      weights.push(sample.size);
    }
  }

  const totalBytes = weights.reduce((sum, w) => sum + w, 0);

  return {
    type: "sampled",
    name,
    unit: "bytes",
    startValue: 0,
    endValue: totalBytes,
    samples,
    weights,
  };
}

/** Recursively walk the profile tree, building nodeId → frame-index stack map */
function walkTree(
  node: ProfileNode,
  parentStack: number[],
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
  nodeStacks: Map<number, number[]>,
): void {
  const idx = internFrame(node, sharedFrames, frameIndex);
  const stack = [...parentStack, idx];
  nodeStacks.set(node.id, stack);
  for (const child of node.children || []) {
    walkTree(child, stack, sharedFrames, frameIndex, nodeStacks);
  }
}

/** Intern a call frame, returning its index in the shared frames array */
function internFrame(
  node: ProfileNode,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): number {
  const { functionName, url, lineNumber, columnNumber } = node.callFrame;
  const col = columnNumber ?? -1;
  // Key uses raw V8 values (0-indexed) for correct deduplication
  const key = `${functionName}\0${url}\0${lineNumber}\0${col}`;

  let idx = frameIndex.get(key);
  if (idx === undefined) {
    idx = sharedFrames.length;
    const line1 = lineNumber + 1; // 0-indexed → 1-indexed
    const col1 = col >= 0 ? col + 1 : -1; // 0-indexed → 1-indexed
    // Match speedscope's convention: anonymous functions include location in name
    const shortFile = url ? url.split("/").pop() : undefined;
    const name =
      functionName ||
      (shortFile ? `(anonymous ${shortFile}:${line1})` : "(anonymous)");
    const frame: SpeedscopeFrame = { name };
    if (url) frame.file = url;
    if (lineNumber >= 0) frame.line = line1;
    if (col1 >= 0) frame.col = col1;
    sharedFrames.push(frame);
    frameIndex.set(key, idx);
  }
  return idx;
}

/** Convert a single HeapProfile to speedscope format (for standalone use) */
export function heapProfileToSpeedscope(
  name: string,
  profile: HeapProfile,
): SpeedscopeFile {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const p = buildProfile(name, profile, frames, frameIndex);

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles: [p],
    exporter: "benchforge",
  };
}
