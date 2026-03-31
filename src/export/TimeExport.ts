import { resolveCallFrame } from "../profiling/node/ResolvedProfile.ts";
import type {
  TimeProfile,
  TimeProfileNode,
} from "../profiling/node/TimeSampler.ts";
import {
  internFrame,
  type SpeedscopeFile,
  type SpeedscopeFrame,
  type SpeedscopeTimeProfile,
  speedscopeFile,
} from "./SpeedscopeTypes.ts";

/** Convert a TimeProfile to speedscope format */
export function timeProfileToSpeedscope(
  name: string,
  profile: TimeProfile,
): SpeedscopeFile {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const p = buildTimeProfile(name, profile, frames, frameIndex);

  return speedscopeFile(frames, [p]);
}

/** Build a SpeedscopeFile from multiple named time profiles (shared frames). */
export function buildTimeSpeedscopeFile(
  entries: { name: string; profile: TimeProfile }[],
): SpeedscopeFile | undefined {
  if (entries.length === 0) return undefined;

  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const profiles = entries.map(e =>
    buildTimeProfile(e.name, e.profile, frames, frameIndex),
  );

  return speedscopeFile(frames, profiles);
}

/** Build a speedscope profile from a V8 TimeProfile */
function buildTimeProfile(
  name: string,
  profile: TimeProfile,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
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

  const stackCache = new Map<number, number[]>();
  const resolve = (id: number) =>
    resolveStack(id, nodeMap, parentMap, stackCache, sharedFrames, frameIndex);

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
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
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
    const f = resolveCallFrame(node.callFrame);
    const idx = internFrame(
      f.name,
      f.url,
      f.line,
      f.col,
      sharedFrames,
      frameIndex,
    );
    stack.push(idx);
  }

  cache.set(nodeId, stack);
  return stack;
}
