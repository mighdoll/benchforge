import { Session } from "node:inspector/promises";
import type { CoverageData, ScriptCoverage } from "./CoverageTypes.ts";

/** Run a function while collecting precise V8 coverage, return execution counts.
 *  The session passed to `fn` can be shared with TimeSampler to avoid resetting counters. */
export async function withCoverageProfiling<T>(
  fn: (session: Session) => Promise<T> | T,
): Promise<{ result: T; coverage: CoverageData }> {
  const session = new Session();
  session.connect();

  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true,
    });
    const result = await fn(session);
    const raw = await session.post("Profiler.takePreciseCoverage");
    const scripts = raw.result as unknown as ScriptCoverage[];
    return { result, coverage: { scripts } };
  } finally {
    await session.post("Profiler.stopPreciseCoverage");
    await session.post("Profiler.disable");
    session.disconnect();
  }
}
