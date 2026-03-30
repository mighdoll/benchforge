import { Session } from "node:inspector/promises";

export interface HeapSampleOptions {
  /** Bytes between samples (default 32768) */
  samplingInterval?: number;

  /** Max stack frames (default 64) */
  stackDepth?: number;

  /** Keep objects collected by minor GC (default true) */
  includeMinorGC?: boolean;

  /** Keep objects collected by major GC (default true) */
  includeMajorGC?: boolean;
}

/** V8 call frame location within a profiled script */
export interface CallFrame {
  /** Function name (empty string for anonymous) */
  functionName: string;

  /** Script URL or file path */
  url: string;

  /** Zero-based line number */
  lineNumber: number;

  /** Zero-based column number */
  columnNumber?: number;
}

/** Node in the V8 sampling heap profile tree */
export interface ProfileNode {
  /** Call site for this allocation node */
  callFrame: CallFrame;

  /** Bytes allocated directly at this node (not children) */
  selfSize: number;

  /** Unique node ID, links to {@link HeapSample.nodeId} */
  id: number;

  /** Child nodes in the call tree */
  children?: ProfileNode[];
}

/** Individual heap allocation sample from V8's SamplingHeapProfiler */
export interface HeapSample {
  /** Links to {@link ProfileNode.id} for stack lookup */
  nodeId: number;

  /** Allocation size in bytes */
  size: number;

  /** Monotonically increasing, gives temporal ordering */
  ordinal: number;
}

/** V8 sampling heap profile tree with optional per-allocation samples */
export interface HeapProfile {
  /** Root of the profile call tree */
  head: ProfileNode;

  /** Per-allocation samples, if collected */
  samples?: HeapSample[];
}

const defaultOptions: Required<HeapSampleOptions> = {
  samplingInterval: 32768,
  stackDepth: 64,
  includeMinorGC: true,
  includeMajorGC: true,
};

/** Run a function while sampling heap allocations, return profile */
export async function withHeapSampling<T>(
  options: HeapSampleOptions,
  fn: () => Promise<T> | T,
): Promise<{ result: T; profile: HeapProfile }> {
  const opts = { ...defaultOptions, ...options };
  const session = new Session();
  session.connect();

  try {
    await startSampling(session, opts);
    const result = await fn();
    const profile = await stopSampling(session);
    return { result, profile };
  } finally {
    session.disconnect();
  }
}

/** Start heap sampling, falling back if include-collected params aren't supported */
async function startSampling(
  session: Session,
  opts: Required<HeapSampleOptions>,
): Promise<void> {
  const { samplingInterval, stackDepth } = opts;
  const base = { samplingInterval, stackDepth };
  const params = {
    ...base,
    includeObjectsCollectedByMinorGC: opts.includeMinorGC,
    includeObjectsCollectedByMajorGC: opts.includeMajorGC,
  };
  try {
    await session.post("HeapProfiler.startSampling", params);
  } catch {
    const msg =
      "HeapProfiler: include-collected params not supported, falling back";
    console.warn(msg);
    await session.post("HeapProfiler.startSampling", base);
  }
}

async function stopSampling(session: Session): Promise<HeapProfile> {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  // V8 returns id/samples fields not in @types/node's incomplete SamplingHeapProfile
  return profile as unknown as HeapProfile;
}
