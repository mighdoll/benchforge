/** CPU time profile conversion to Speedscope sampled format. */

import { resolveCallFrame } from "../profiling/node/ResolvedProfile.ts";
import type {
  TimeProfile,
  TimeProfileNode,
} from "../profiling/node/TimeSampler.ts";
import {
  type FrameContext,
  frameContext,
  internFrame,
  multiProfileFile,
  type SpeedscopeFile,
  type SpeedscopeTimeProfile,
  speedscopeFile,
} from "./SpeedscopeTypes.ts";

/** Convert a single TimeProfile to speedscope format */
export function timeProfileToSpeedscope(
  name: string,
  profile: TimeProfile,
): SpeedscopeFile {
  const ctx = frameContext();
  const p = buildMergedTimeProfile(name, [profile], ctx);
  return speedscopeFile(ctx, [p]);
}

/** Build a SpeedscopeFile from multiple named benchmarks, each pooling its own
 *  batch profiles into one flamegraph (frames shared across benchmarks). */
export function buildTimeSpeedscopeFile(
  entries: { name: string; profiles: TimeProfile[] }[],
): SpeedscopeFile | undefined {
  return multiProfileFile(entries, (e, ctx) =>
    buildMergedTimeProfile(e.name, e.profiles, ctx),
  );
}

/** Pool several V8 TimeProfiles (typically one per kept batch) into one sampled
 *  speedscope profile: concatenate resolved stacks and weights over a shared
 *  frame context, so the flamegraph reflects all sampled ticks rather than a
 *  single batch. */
function buildMergedTimeProfile(
  name: string,
  profiles: TimeProfile[],
  ctx: FrameContext,
): SpeedscopeTimeProfile {
  const samples: number[][] = [];
  const weights: number[] = [];
  for (const profile of profiles) appendSamples(profile, ctx, samples, weights);
  return {
    type: "sampled",
    name,
    unit: "microseconds",
    startValue: 0,
    endValue: weights.reduce((sum, w) => sum + w, 0),
    samples,
    weights,
  };
}

/** Resolve one profile's sampled stacks and append them (with weights) to the
 *  shared accumulators. Node ids are per-profile, so the maps/cache are local;
 *  only interned frames are shared via ctx. Sample-less profiles add nothing. */
function appendSamples(
  profile: TimeProfile,
  ctx: FrameContext,
  samples: number[][],
  weights: number[],
): void {
  const { samples: sampleIds, timeDeltas, nodes } = profile;
  if (!sampleIds?.length || !timeDeltas) return;

  const nodeMap = new Map<number, TimeProfileNode>(nodes.map(n => [n.id, n]));
  const parentMap = new Map<number, number>(); // childId -> parentId
  for (const node of nodes) {
    for (const childId of node.children ?? []) parentMap.set(childId, node.id);
  }

  const cache = new Map<number, number[]>();
  for (const id of sampleIds)
    samples.push(resolveStack(id, nodeMap, parentMap, cache, ctx));
  for (const w of timeDeltas) weights.push(w);
}

/** Walk from node to root, building a stack of frame indices (root-first) */
function resolveStack(
  nodeId: number,
  nodeMap: Map<number, TimeProfileNode>,
  parentMap: Map<number, number>,
  cache: Map<number, number[]>,
  ctx: FrameContext,
): number[] {
  const cached = cache.get(nodeId);
  if (cached) return cached;

  const path: number[] = [];
  let current: number | undefined = nodeId;
  while (current !== undefined) {
    path.push(current);
    current = parentMap.get(current);
  }

  // Reverse to root-first order
  const stack: number[] = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const node = nodeMap.get(path[i]);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    // Skip the synthetic (root) node
    if (!functionName && !url && lineNumber <= 0) continue;
    const frame = resolveCallFrame(node.callFrame);
    stack.push(internFrame(frame.name, frame.url, frame.line, frame.col, ctx));
  }

  cache.set(nodeId, stack);
  return stack;
}
