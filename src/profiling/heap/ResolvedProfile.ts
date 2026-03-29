import type { HeapProfile, HeapSample, ProfileNode } from "./HeapSampler.ts";

/** A call frame with display-ready 1-indexed source positions */
export interface ResolvedFrame {
  /** Function name, "(anonymous)" when empty */
  name: string;

  /** Script URL or file path, "" when unknown */
  url: string;

  /** 1-indexed line number */
  line: number;

  /** 1-indexed column number (undefined when unknown) */
  col?: number;
}

/** A profile node with its resolved call stack from root to this node */
export interface ResolvedNode {
  /** The call frame at this node */
  frame: ResolvedFrame;

  /** Call stack from root to this node (inclusive) */
  stack: ResolvedFrame[];

  /** Bytes allocated directly at this node */
  selfSize: number;

  /** V8 node ID, used to match {@link HeapSample.nodeId} */
  nodeId: number;
}

/** Pre-resolved heap profile: single tree walk produces all derived data */
export interface ResolvedProfile {
  /** All nodes from the profile tree, flattened */
  nodes: ResolvedNode[];

  /** nodeId -> ResolvedNode lookup */
  nodeMap: Map<number, ResolvedNode>;

  /** Nodes with selfSize > 0, sorted by selfSize descending */
  allocationNodes: ResolvedNode[];

  /** Samples sorted by ordinal (temporal order), if available */
  sortedSamples: HeapSample[] | undefined;

  /** Total bytes across all nodes (sum of selfSize) */
  totalBytes: number;
}

/** Walk a HeapProfile tree once, producing a fully resolved intermediate form */
export function resolveProfile(profile: HeapProfile): ResolvedProfile {
  const nodes: ResolvedNode[] = [];
  const nodeMap = new Map<number, ResolvedNode>();
  let totalBytes = 0;

  function walk(node: ProfileNode, parentStack: ResolvedFrame[]): void {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const frame: ResolvedFrame = {
      name: functionName || "(anonymous)",
      url: url || "",
      line: lineNumber + 1,
      col: columnNumber != null ? columnNumber + 1 : undefined,
    };
    const stack = [...parentStack, frame];
    const resolved: ResolvedNode = {
      frame,
      stack,
      selfSize: node.selfSize,
      nodeId: node.id,
    };
    nodes.push(resolved);
    nodeMap.set(node.id, resolved);
    totalBytes += node.selfSize;
    for (const child of node.children || []) walk(child, stack);
  }

  walk(profile.head, []);

  const allocationNodes = nodes
    .filter(n => n.selfSize > 0)
    .sort((a, b) => b.selfSize - a.selfSize);

  const sortedSamples = profile.samples
    ? [...profile.samples].sort((a, b) => a.ordinal - b.ordinal)
    : undefined;

  return { nodes, nodeMap, allocationNodes, sortedSamples, totalBytes };
}
