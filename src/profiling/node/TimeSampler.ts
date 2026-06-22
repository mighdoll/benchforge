import type { Session } from "node:inspector/promises";
import type { ProfileBoundary } from "../../runners/BenchRunner.ts";
import type { CallFrame } from "./HeapSampler.ts";
import { withSession } from "./InspectorSession.ts";

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

/** Sample CPU time across the window `fn` brackets with `boundary.start`/`stop`,
 *  then return the profile. Letting the caller place the boundary keeps warmup
 *  iterations out of the profile. */
export async function withTimeProfiling<T>(
  options: TimeProfileOptions,
  fn: (boundary: ProfileBoundary) => Promise<T> | T,
): Promise<{ result: T; profile: TimeProfile }> {
  const { interval } = options;
  const owned = !options.session;
  return withSession(options.session, async session => {
    let profile: TimeProfile | undefined;
    let started = false;
    const start = async () => {
      await session.post("Profiler.start");
      started = true;
    };
    const stop = async () => {
      if (!started || profile) return;
      const r = await session.post("Profiler.stop");
      profile = r.profile as unknown as TimeProfile;
    };
    try {
      if (owned) await session.post("Profiler.enable");
      if (interval)
        await session.post("Profiler.setSamplingInterval", { interval });
      const result = await fn({ start, stop });
      await stop();
      if (!profile)
        throw new Error("withTimeProfiling: boundary never started");
      return { result, profile };
    } finally {
      if (owned) await session.post("Profiler.disable");
    }
  });
}
