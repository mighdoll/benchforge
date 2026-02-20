import { Session } from "node:inspector/promises";

export interface HeapSampleOptions {
  samplingInterval?: number; // bytes between samples, default 32768
  stackDepth?: number; // max stack frames, default 64
  includeMinorGC?: boolean; // keep objects collected by minor GC, default true
  includeMajorGC?: boolean; // keep objects collected by major GC, default true
}

export interface ProfileNode {
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber?: number;
  };
  selfSize: number;
  children?: ProfileNode[];
}

export interface HeapProfile {
  head: ProfileNode;
  samples?: number[]; // sample IDs (length = number of samples taken)
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
    console.warn(
      "HeapProfiler: include-collected params not supported, falling back",
    );
    await session.post("HeapProfiler.startSampling", base);
  }
}

async function stopSampling(session: Session): Promise<HeapProfile> {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  return profile as HeapProfile;
}
