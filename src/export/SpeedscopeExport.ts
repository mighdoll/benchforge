import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { groupReports, type ReportGroup } from "../BenchmarkReport.ts";
import type { HeapProfile } from "../heap-sample/HeapSampler.ts";
import {
  type ResolvedFrame,
  type ResolvedProfile,
  resolveProfile,
} from "../heap-sample/ResolvedProfile.ts";

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
 *  Creates one speedscope profile per benchmark that has a heapProfile.
 *  @returns resolved output path, or undefined if no profiles were found */
export function exportSpeedscope(
  groups: ReportGroup[],
  outputPath: string,
): string | undefined {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const profiles: SpeedscopeProfile[] = [];

  for (const group of groups) {
    for (const report of groupReports(group)) {
      const { heapProfile } = report.measuredResults;
      if (!heapProfile) continue;
      const resolved = resolveProfile(heapProfile);
      profiles.push(buildProfile(report.name, resolved, frames, frameIndex));
    }
  }

  if (profiles.length === 0) {
    console.log("No heap profiles to export.");
    return undefined;
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
  return absPath;
}

/** Export to a temp file and open in speedscope via npx */
export function exportAndLaunchSpeedscope(groups: ReportGroup[]): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(tmpdir(), `benchforge-${timestamp}.speedscope.json`);
  const absPath = exportSpeedscope(groups, outputPath);
  if (absPath) {
    launchSpeedscope(absPath);
  }
}

/** Launch speedscope viewer on a file via npx */
export function launchSpeedscope(filePath: string): void {
  console.log("Opening speedscope...");
  const child = spawn("npx", ["speedscope", filePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {
    console.error(
      `Failed to launch speedscope. Run manually:\n  npx speedscope ${filePath}`,
    );
  });
}

/** Convert a single HeapProfile to speedscope format (for standalone use) */
export function heapProfileToSpeedscope(
  name: string,
  profile: HeapProfile,
): SpeedscopeFile {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const resolved = resolveProfile(profile);
  const p = buildProfile(name, resolved, frames, frameIndex);

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles: [p],
    exporter: "benchforge",
  };
}

/** Build a single speedscope profile from a resolved heap profile */
function buildProfile(
  name: string,
  resolved: ResolvedProfile,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): SpeedscopeProfile {
  // Build nodeId -> stack of frame indices
  const nodeStacks = new Map<number, number[]>();
  for (const node of resolved.nodes) {
    const stack = node.stack.map(f => internFrame(f, sharedFrames, frameIndex));
    nodeStacks.set(node.nodeId, stack);
  }

  const samples: number[][] = [];
  const weights: number[] = [];

  if (!resolved.sortedSamples || resolved.sortedSamples.length === 0) {
    console.error(
      `Speedscope export: no samples in heap profile for "${name}", skipping`,
    );
    return {
      type: "sampled",
      name,
      unit: "bytes",
      startValue: 0,
      endValue: 0,
      samples,
      weights,
    };
  }

  for (const sample of resolved.sortedSamples) {
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

/** Intern a call frame, returning its index in the shared frames array */
function internFrame(
  frame: ResolvedFrame,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): number {
  const { name, url, line, col } = frame;
  const key = `${name}\0${url}\0${line}\0${col}`;

  let idx = frameIndex.get(key);
  if (idx === undefined) {
    idx = sharedFrames.length;
    // Match speedscope's convention: anonymous functions include location in name
    const shortFile = url ? url.split("/").pop() : undefined;
    const displayName =
      name !== "(anonymous)"
        ? name
        : shortFile
          ? `(anonymous ${shortFile}:${line})`
          : "(anonymous)";
    const entry: SpeedscopeFrame = { name: displayName };
    if (url) entry.file = url;
    if (line > 0) entry.line = line;
    if (col != null) entry.col = col;
    sharedFrames.push(entry);
    frameIndex.set(key, idx);
  }
  return idx;
}
