import { Session } from "node:inspector/promises";
import type { CoverageData, ScriptCoverage } from "./CoverageTypes.ts";

/** Run a function while collecting precise coverage, return execution counts.
 *  The returned session can be shared with TimeSampler to avoid
 *  Profiler.disable resetting coverage counters. */
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
    const { result: scripts } = await session.post(
      "Profiler.takePreciseCoverage",
    );
    return {
      result,
      coverage: { scripts: scripts as unknown as ScriptCoverage[] },
    };
  } finally {
    await session.post("Profiler.stopPreciseCoverage");
    await session.post("Profiler.disable");
    session.disconnect();
  }
}
