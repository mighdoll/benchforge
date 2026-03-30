import type {
  TimeProfile,
  TimeProfileNode,
} from "../profiling/node/TimeSampler.ts";

/** speedscope file format (https://www.speedscope.app/file-format-schema.json) */
interface SpeedscopeFile {
  $schema: "https://www.speedscope.app/file-format-schema.json";
  shared: { frames: SpeedscopeFrame[] };
  profiles: SpeedscopeTimeProfile[];
  name?: string;
  exporter?: string;
}

interface SpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

interface SpeedscopeTimeProfile {
  type: "sampled";
  name: string;
  unit: "microseconds";
  startValue: number;
  endValue: number;
  samples: number[][]; // each sample is stack of frame indices
  weights: number[]; // microseconds per sample
}

/** Convert a TimeProfile to speedscope format */
export function timeProfileToSpeedscope(
  name: string,
  profile: TimeProfile,
): SpeedscopeFile {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const p = buildTimeProfile(name, profile, frames, frameIndex);

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles: [p],
    exporter: "benchforge",
  };
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

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles,
    exporter: "benchforge",
  };
}

/** Build a speedscope profile from a V8 TimeProfile */
function buildTimeProfile(
  name: string,
  profile: TimeProfile,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): SpeedscopeTimeProfile {
  const { samples: sampleIds, timeDeltas, nodes } = profile;

  if (!sampleIds || !timeDeltas || sampleIds.length === 0) {
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

  // Build node lookup and parent map for stack resolution
  const nodeMap = new Map<number, TimeProfileNode>();
  const parentMap = new Map<number, number>(); // childId -> parentId
  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (node.children) {
      for (const childId of node.children) {
        parentMap.set(childId, node.id);
      }
    }
  }

  // Cache resolved stacks per node ID
  const stackCache = new Map<number, number[]>();

  const samples: number[][] = [];
  const weights: number[] = [];

  for (let i = 0; i < sampleIds.length; i++) {
    const nodeId = sampleIds[i];
    const stack = resolveStack(
      nodeId,
      nodeMap,
      parentMap,
      stackCache,
      sharedFrames,
      frameIndex,
    );
    samples.push(stack);
    weights.push(timeDeltas[i]);
  }

  const totalMicroseconds = weights.reduce((sum, w) => sum + w, 0);

  return {
    type: "sampled",
    name,
    unit: "microseconds",
    startValue: 0,
    endValue: totalMicroseconds,
    samples,
    weights,
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

  // Walk up to root, collecting node IDs
  const path: number[] = [];
  let current: number | undefined = nodeId;
  while (current !== undefined) {
    path.push(current);
    current = parentMap.get(current);
  }

  // Reverse to get root-first order, intern frames
  const stack: number[] = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const node = nodeMap.get(path[i]);
    if (!node) continue;
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    // Skip the synthetic (root) node
    if (!functionName && !url && lineNumber <= 0) continue;
    stack.push(
      internFrame(
        functionName,
        url,
        lineNumber,
        columnNumber,
        sharedFrames,
        frameIndex,
      ),
    );
  }

  cache.set(nodeId, stack);
  return stack;
}

/** Display name for a frame: named functions use their name, anonymous get a location hint */
function displayName(name: string, url: string, line: number): string {
  if (name !== "(anonymous)") return name;
  const shortFile = url ? url.split("/").pop() : undefined;
  return shortFile ? `(anonymous ${shortFile}:${line})` : "(anonymous)";
}

/** Intern a call frame, returning its index in the shared frames array */
function internFrame(
  functionName: string,
  url: string,
  lineNumber: number,
  columnNumber: number | undefined,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): number {
  const name = functionName || "(anonymous)";
  const line = lineNumber + 1; // V8 is 0-indexed
  const col = columnNumber != null ? columnNumber + 1 : undefined;
  const key = `${name}\0${url}\0${line}\0${col}`;

  let idx = frameIndex.get(key);
  if (idx === undefined) {
    idx = sharedFrames.length;
    const entry: SpeedscopeFrame = { name: displayName(name, url, line) };
    if (url) entry.file = url;
    if (line > 0) entry.line = line;
    if (col != null) entry.col = col;
    sharedFrames.push(entry);
    frameIndex.set(key, idx);
  }
  return idx;
}
