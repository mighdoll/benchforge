import { Session } from "node:inspector/promises";
import type { CallFrame } from "./HeapSampler.ts";

/** V8 CPU profile node (flat array element, not tree) */
export interface TimeProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  /** Child node IDs */
  children?: number[];
}

/** V8 CPU profile returned by Profiler.stop */
export interface TimeProfile {
  nodes: TimeProfileNode[];
  /** Microseconds */
  startTime: number;
  /** Microseconds */
  endTime: number;
  /** Node IDs sampled at each tick */
  samples?: number[];
  /** Microseconds between samples */
  timeDeltas?: number[];
}

export interface TimeProfileOptions {
  /** Sampling interval in microseconds (default 1000 = 1ms) */
  interval?: number;
  /** External session to use (shares Profiler domain, caller manages enable/disable) */
  session?: Session;
}

/** Run a function while sampling CPU time, return profile */
export async function withTimeProfiling<T>(
  options: TimeProfileOptions,
  fn: () => Promise<T> | T,
): Promise<{ result: T; profile: TimeProfile }> {
  const ownSession = !options.session;
  const session = options.session ?? new Session();
  if (ownSession) session.connect();

  try {
    if (ownSession) await session.post("Profiler.enable");
    if (options.interval) {
      await session.post("Profiler.setSamplingInterval", {
        interval: options.interval,
      });
    }
    await session.post("Profiler.start");
    const result = await fn();
    const { profile } = await session.post("Profiler.stop");
    return { result, profile: profile as unknown as TimeProfile };
  } finally {
    if (ownSession) {
      await session.post("Profiler.disable");
      session.disconnect();
    }
  }
}
