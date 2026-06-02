/** Heap profile export to Speedscope format. */

import {
  type ResolvedProfile,
  resolveProfile,
} from "../profiling/node/ResolvedProfile.ts";
import { groupReports, type ReportGroup } from "../report/BenchmarkReport.ts";
import {
  type FrameContext,
  frameContext,
  internFrame,
  type SpeedscopeFile,
  type SpeedscopeHeapProfile,
  speedscopeFile,
} from "./SpeedscopeTypes.ts";

/** Build SpeedscopeFile from report groups. Returns undefined if no profiles found. */
export function buildSpeedscopeFile(
  groups: ReportGroup[],
): SpeedscopeFile | undefined {
  const ctx = frameContext();
  const profiles: SpeedscopeHeapProfile[] = [];

  for (const group of groups) {
    for (const report of groupReports(group)) {
      const { heapProfile } = report.measuredResults;
      if (!heapProfile) continue;
      const resolved = resolveProfile(heapProfile);
      profiles.push(buildProfile(report.name, resolved, ctx));
    }
  }

  if (profiles.length === 0) return undefined;

  return speedscopeFile(ctx, profiles);
}

/** Build a single speedscope profile from a resolved heap profile. */
function buildProfile(
  name: string,
  resolved: ResolvedProfile,
  ctx: FrameContext,
): SpeedscopeHeapProfile {
  type Frame = { name: string; url: string; line: number; col?: number | null };
  const intern = (f: Frame) => internFrame(f.name, f.url, f.line, f.col, ctx);

  const nodeStacks = new Map(
    resolved.nodes.map(node => [node.nodeId, node.stack.map(intern)] as const),
  );

  if (!resolved.sortedSamples?.length) {
    console.error(
      `Speedscope export: no samples in heap profile for "${name}", skipping`,
    );
    return emptyProfile(name);
  }

  const samples: number[][] = [];
  const weights: number[] = [];
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

/** Placeholder profile with no samples (used when heap data is missing). */
function emptyProfile(name: string): SpeedscopeHeapProfile {
  return {
    type: "sampled",
    name,
    unit: "bytes",
    startValue: 0,
    endValue: 0,
    samples: [],
    weights: [],
  };
}
