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
  type SpeedscopeFile,
  type SpeedscopeTimeProfile,
  speedscopeFile,
} from "./SpeedscopeTypes.ts";

/** Convert a TimeProfile to speedscope format */
export function timeProfileToSpeedscope(
  name: string,
  profile: TimeProfile,
): SpeedscopeFile {
  const ctx = frameContext();
  const p = buildTimeProfile(name, profile, ctx);
  return speedscopeFile(ctx, [p]);
}

/** Build a SpeedscopeFile from multiple named time profiles (shared frames). */
export function buildTimeSpeedscopeFile(
  entries: { name: string; profile: TimeProfile }[],
): SpeedscopeFile | undefined {
  if (entries.length === 0) return undefined;

  const ctx = frameContext();
  const profiles = entries.map(e => buildTimeProfile(e.name, e.profile, ctx));
  return speedscopeFile(ctx, profiles);
}

/** Build a speedscope profile from a V8 TimeProfile */
function buildTimeProfile(
  name: string,
  profile: TimeProfile,
  ctx: FrameContext,
): SpeedscopeTimeProfile {
  const { samples: sampleIds, timeDeltas, nodes } = profile;

  if (!sampleIds?.length || !timeDeltas) {
    return {
      type: "sampled",
      name,
      unit: "microseconds",
      startValue: 0,
      endValue: 0,
      samples: [],
      weights: [],
    };
  }

  const nodeMap = new Map<number, TimeProfileNode>(nodes.map(n => [n.id, n]));
  const parentMap = new Map<number, number>(); // childId -> parentId
  for (const node of nodes) {
    for (const childId of node.children ?? []) {
      parentMap.set(childId, node.id);
    }
  }

  const cache = new Map<number, number[]>();
  const resolve = (id: number) =>
    resolveStack(id, nodeMap, parentMap, cache, ctx);

  const samples = sampleIds.map(resolve);
  const total = timeDeltas.reduce((sum, w) => sum + w, 0);
  return {
    type: "sampled",
    name,
    unit: "microseconds",
    startValue: 0,
    endValue: total,
    samples,
    weights: timeDeltas,
  };
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
